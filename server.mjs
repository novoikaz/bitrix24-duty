import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const port = Number(process.env.PORT || 3000);
const db = new DatabaseSync(process.env.DATABASE_PATH || './duty.sqlite');
db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS employees (id INTEGER PRIMARY KEY, name TEXT NOT NULL, avatar TEXT, is_admin INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS duties (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL CHECK(kind IN ('office','support','holiday')), starts_on TEXT NOT NULL, ends_on TEXT NOT NULL, employee_id INTEGER NOT NULL, hours INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'scheduled', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(employee_id) REFERENCES employees(id));
  CREATE TABLE IF NOT EXISTS absences (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL, occurred_on TEXT NOT NULL, hours INTEGER NOT NULL CHECK(hours > 0), note TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(employee_id) REFERENCES employees(id));
  CREATE TABLE IF NOT EXISTS ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL, occurred_on TEXT NOT NULL, hours INTEGER NOT NULL, kind TEXT NOT NULL, reference_id INTEGER, note TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(employee_id) REFERENCES employees(id));
  CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS portals (member_id TEXT PRIMARY KEY, domain TEXT NOT NULL, access_token TEXT, refresh_token TEXT, expires_at INTEGER);
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

if (!db.prepare('SELECT count(*) AS n FROM employees').get().n) {
  const add = db.prepare('INSERT INTO employees (id,name,avatar,is_admin) VALUES (?,?,?,?)');
  add.run(1, 'Алексей Ковалёв', '', 1); add.run(2, 'Дарья Сергеева', '', 0); add.run(3, 'Михаил Петров', '', 0);
  const duty = db.prepare('INSERT INTO duties (kind,starts_on,ends_on,employee_id,hours) VALUES (?,?,?,?,?)');
  duty.run('office','2026-08-07','2026-08-07',2,0); duty.run('support','2026-08-08','2026-08-09',3,4);
  db.prepare('INSERT INTO absences (employee_id,occurred_on,hours,note) VALUES (?,?,?,?)').run(1,'2026-08-03',4,'Личное отсутствие');
  db.prepare('INSERT INTO ledger (employee_id,occurred_on,hours,kind,note) VALUES (?,?,?,?,?)').run(1,'2026-08-03',4,'absence','Отсутствие');
}

const json = (res, status, value) => { res.writeHead(status, {'content-type':'application/json; charset=utf-8'}); res.end(JSON.stringify(value)); };
const body = req => new Promise((resolve,reject) => { let s=''; req.on('data', x=>s+=x); req.on('end',()=>{try{resolve(s?JSON.parse(s):{})}catch{reject(new Error('Некорректный JSON'))}}); });
const authCache = new Map();
async function b24User(req) {
  const token=req.headers['x-b24-token'], domain=String(req.headers['x-b24-domain']||'').toLowerCase();
  const allowed=String(process.env.BITRIX_DOMAIN||'novoi.bitrix24.kz').toLowerCase();
  if(!token || domain!==allowed) return null;
  const cached=authCache.get(token); if(cached && cached.until>Date.now()) return cached.user;
  const [profileReply, adminReply]=await Promise.all([
    fetch(`https://${domain}/rest/user.current.json?auth=${encodeURIComponent(token)}`),
    fetch(`https://${domain}/rest/user.admin.json?auth=${encodeURIComponent(token)}`)
  ]);
  const profile=await profileReply.json(), admin=await adminReply.json(); const user=profile.result;
  if(!user?.ID) return null; user.app_admin=admin.result===true; authCache.set(token,{user,until:Date.now()+60_000}); return user;
}
const isAdmin = async req => Boolean((await b24User(req))?.IS_ADMIN === true || (await b24User(req))?.IS_ADMIN === 'Y');
const audit = (actor, action, detail) => db.prepare('INSERT INTO audit_log(actor,action,detail) VALUES (?,?,?)').run(actor||'Администратор', action, detail);
const balance = id => db.prepare('SELECT COALESCE(SUM(hours),0) AS hours FROM ledger WHERE employee_id=?').get(id).hours;
function snapshot(user=null) {
  return {
    employees: db.prepare('SELECT * FROM employees ORDER BY name').all(),
    duties: db.prepare(`SELECT d.*, e.name, e.avatar FROM duties d JOIN employees e ON e.id=d.employee_id WHERE d.status='scheduled' ORDER BY d.starts_on`).all(),
    absences: db.prepare(`SELECT a.*, e.name FROM absences a JOIN employees e ON e.id=a.employee_id ORDER BY occurred_on DESC`).all(),
    balances: db.prepare('SELECT id,name,avatar FROM employees').all().map(e=>({...e, hours:balance(e.id)})),
    audit: db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 15').all(),
    permissions: { canEdit: Boolean(user?.app_admin) },
    currentEmployeeId: user ? Number(user.ID) : null
  };
}
async function syncEmployees(req) {
  const user=await b24User(req); if(!user) throw new Error('Не удалось подтвердить пользователя Bitrix24');
  const domain=req.headers['x-b24-domain'], token=req.headers['x-b24-token']; let start=0, users=[], total=Infinity;
  while(start<total) { const reply=await fetch(`https://${domain}/rest/user.get.json?auth=${encodeURIComponent(token)}&ADMIN_MODE=Y&start=${start}`); const data=await reply.json(); const page=data.result||[]; users.push(...page); total=Number(data.total||page.length); start+=50; }
  if(!users.length) users=[user];
  if(!db.prepare("SELECT 1 FROM meta WHERE key='bitrix_synced'").get()) {
    db.exec('DELETE FROM ledger; DELETE FROM absences; DELETE FROM duties; DELETE FROM employees;');
    db.prepare("INSERT INTO meta(key,value) VALUES ('bitrix_synced','1')").run();
  }
  const save=db.prepare('INSERT INTO employees(id,name,avatar,is_admin) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,avatar=excluded.avatar,is_admin=excluded.is_admin');
  for(const e of users.filter(x=>x.ACTIVE!==false && x.ACTIVE!=='N')) save.run(Number(e.ID),`${e.NAME||''} ${e.LAST_NAME||''}`.trim()||e.LOGIN,e.PERSONAL_PHOTO||'',Number(e.ID)===Number(user.ID)&&user.app_admin?1:0);
  return user;
}
async function api(req,res,url) {
  if (req.method==='POST' && url.pathname==='/api/bitrix/sync') { const user=await syncEmployees(req); return json(res,200,snapshot(user)); }
  if (req.method==='GET' && url.pathname==='/api/bootstrap') { const user=await b24User(req); return json(res,200,snapshot(user)); }
  if (req.method==='POST' && url.pathname==='/api/duties') {
    const actor=await b24User(req); if(!actor?.app_admin) return json(res,403,{error:'Изменять график может только администратор портала'});
    const v=await body(req); if(!['office','support','holiday'].includes(v.kind)||!v.starts_on||!v.ends_on||!Number(v.employee_id)) return json(res,422,{error:'Заполните тип, сотрудника и даты'});
    const hours=v.kind==='office'?0:(v.kind==='holiday'||v.starts_on===v.ends_on?2:4);
    const r=db.prepare('INSERT INTO duties (kind,starts_on,ends_on,employee_id,hours) VALUES (?,?,?,?,?)').run(v.kind,v.starts_on,v.ends_on,Number(v.employee_id),hours);
    if(hours) db.prepare('INSERT INTO ledger (employee_id,occurred_on,hours,kind,reference_id,note) VALUES (?,?,?,?,?,?)').run(Number(v.employee_id),v.starts_on,-hours,'support',r.lastInsertRowid,'Зачтено дежурством поддержки');
    audit(`${actor.NAME||''} ${actor.LAST_NAME||''}`.trim(),'Назначено дежурство', `${v.kind}: ${v.starts_on}–${v.ends_on}`); return json(res,201,snapshot(actor));
  }
  const deleteMatch=url.pathname.match(/^\/api\/duties\/(\d+)\/delete$/);
  if (req.method==='POST' && deleteMatch) {
    const actor=await b24User(req); if(!actor?.app_admin) return json(res,403,{error:'Удалять назначения может только администратор портала'});
    const duty=db.prepare('SELECT * FROM duties WHERE id=?').get(Number(deleteMatch[1])); if(!duty) return json(res,404,{error:'Дежурство не найдено'});
    db.prepare('DELETE FROM ledger WHERE reference_id=? AND kind=?').run(duty.id,'support'); db.prepare('DELETE FROM duties WHERE id=?').run(duty.id);
    audit(`${actor.NAME||''} ${actor.LAST_NAME||''}`.trim(),'Удалено дежурство', `${duty.starts_on}–${duty.ends_on}`); return json(res,200,snapshot(actor));
  }
  if (req.method==='POST' && url.pathname==='/api/absences') {
    const actor=await b24User(req); if(!actor?.app_admin) return json(res,403,{error:'Вносить отсутствие может только администратор портала'});
    const v=await body(req); const hours=Number(v.hours); if(!Number(v.employee_id)||!v.occurred_on||!hours||hours>24) return json(res,422,{error:'Проверьте данные отсутствия'});
    const r=db.prepare('INSERT INTO absences (employee_id,occurred_on,hours,note) VALUES (?,?,?,?)').run(Number(v.employee_id),v.occurred_on,hours,v.note||'');
    db.prepare('INSERT INTO ledger (employee_id,occurred_on,hours,kind,reference_id,note) VALUES (?,?,?,?,?,?)').run(Number(v.employee_id),v.occurred_on,hours,'absence',r.lastInsertRowid,v.note||'Отсутствие');
    audit(`${actor.NAME||''} ${actor.LAST_NAME||''}`.trim(),'Добавлено отсутствие', `${hours} ч · ${v.occurred_on}`); return json(res,201,snapshot(actor));
  }
  if (req.method==='POST' && url.pathname==='/install') {
    // Bitrix24 local-app handler: persist tokens per portal. Encrypt these columns with KMS in production.
    const raw=await new Promise(resolve=>{let s='';req.on('data',x=>s+=x);req.on('end',()=>resolve(Object.fromEntries(new URLSearchParams(s))))});
    const memberId=raw.member_id||raw['auth[member_id]']; const domain=raw.DOMAIN||raw.domain||raw['auth[domain]'];
    const accessToken=raw.AUTH_ID||raw['auth[access_token]']; const refreshToken=raw.REFRESH_ID||raw['auth[refresh_token]']; const expires=raw.AUTH_EXPIRES||raw['auth[expires_in]'];
    if(memberId && domain) db.prepare('INSERT OR REPLACE INTO portals(member_id,domain,access_token,refresh_token,expires_at) VALUES (?,?,?,?,?)').run(memberId,domain,accessToken||null,refreshToken||null,Date.now()+Number(expires||0)*1000);
    res.writeHead(302,{location:'/'}); return res.end();
  }
  return json(res,404,{error:'Не найдено'});
}
const mime={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'};
const server=http.createServer(async(req,res)=>{ try {
  const url=new URL(req.url,`http://${req.headers.host}`); if(url.pathname.startsWith('/api/') || (url.pathname==='/install' && req.method!=='GET')) return api(req,res,url);
  const file=url.pathname==='/'?'index.html':url.pathname==='/install'?'install.html':url.pathname.replace(/^\//,''); const path=join(process.cwd(),'public',file);
  if(!path.startsWith(join(process.cwd(),'public')) || !existsSync(path)) return json(res,404,{error:'Страница не найдена'});
  res.writeHead(200,{'content-type':mime[extname(path)]||'application/octet-stream'}); const content=await readFile(path); res.end(file==='index.html'?String(content).replace('</body>','<script src="/ui-clean.js"></script></body>'):content);
} catch(e) { console.error(e); json(res,500,{error:e.message||'Внутренняя ошибка'}); }});
server.listen(port, process.env.HOST || '0.0.0.0', ()=>console.log(`Дежурства: http://localhost:${port}`));
