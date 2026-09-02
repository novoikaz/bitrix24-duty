import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const port = Number(process.env.PORT || 3000);
const db = new DatabaseSync(process.env.DATABASE_PATH || './duty.sqlite');
db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS employees (id INTEGER PRIMARY KEY, name TEXT NOT NULL, avatar TEXT, is_admin INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1, is_eligible INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE IF NOT EXISTS duties (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL CHECK(kind IN ('office','support','holiday')), starts_on TEXT NOT NULL, ends_on TEXT NOT NULL, employee_id INTEGER NOT NULL, hours INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'scheduled', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(employee_id) REFERENCES employees(id));
  CREATE TABLE IF NOT EXISTS absences (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL, occurred_on TEXT NOT NULL, hours INTEGER NOT NULL CHECK(hours > 0), note TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(employee_id) REFERENCES employees(id));
  CREATE TABLE IF NOT EXISTS ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL, occurred_on TEXT NOT NULL, hours INTEGER NOT NULL, kind TEXT NOT NULL, reference_id INTEGER, note TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(employee_id) REFERENCES employees(id));
  CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS swap_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, duty_id INTEGER NOT NULL, from_employee_id INTEGER NOT NULL, to_employee_id INTEGER NOT NULL, note TEXT, status TEXT NOT NULL DEFAULT 'pending_target', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(duty_id) REFERENCES duties(id), FOREIGN KEY(from_employee_id) REFERENCES employees(id), FOREIGN KEY(to_employee_id) REFERENCES employees(id));
  CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, duty_id INTEGER NOT NULL, type TEXT NOT NULL, sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(duty_id,type), FOREIGN KEY(duty_id) REFERENCES duties(id));
  CREATE TABLE IF NOT EXISTS duty_checklist (duty_id INTEGER NOT NULL, item_key TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(duty_id,item_key), FOREIGN KEY(duty_id) REFERENCES duties(id));
  CREATE TABLE IF NOT EXISTS portals (member_id TEXT PRIMARY KEY, domain TEXT NOT NULL, access_token TEXT, refresh_token TEXT, expires_at INTEGER);
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);
if (!db.prepare('PRAGMA table_info(duties)').all().some(column=>column.name==='accounting_mode')) db.exec("ALTER TABLE duties ADD COLUMN accounting_mode TEXT NOT NULL DEFAULT 'schedule'");
if (!db.prepare('PRAGMA table_info(duties)').all().some(column=>column.name==='office_status')) db.exec("ALTER TABLE duties ADD COLUMN office_status TEXT NOT NULL DEFAULT 'scheduled'");
if (!db.prepare('PRAGMA table_info(absences)').all().some(column=>column.name==='absence_type')) db.exec("ALTER TABLE absences ADD COLUMN absence_type TEXT NOT NULL DEFAULT 'personal'");
if (!db.prepare('PRAGMA table_info(absences)').all().some(column=>column.name==='compensable')) db.exec('ALTER TABLE absences ADD COLUMN compensable INTEGER NOT NULL DEFAULT 1');
if (!db.prepare('PRAGMA table_info(absences)').all().some(column=>column.name==='bitrix_event_id')) db.exec('ALTER TABLE absences ADD COLUMN bitrix_event_id INTEGER');
if (!db.prepare('PRAGMA table_info(absences)').all().some(column=>column.name==='bitrix_list_element_id')) db.exec('ALTER TABLE absences ADD COLUMN bitrix_list_element_id INTEGER');
if (!db.prepare('PRAGMA table_info(absences)').all().some(column=>column.name==='bitrix_sync_error')) db.exec('ALTER TABLE absences ADD COLUMN bitrix_sync_error TEXT');
if (!db.prepare('PRAGMA table_info(employees)').all().some(column=>column.name==='is_active')) db.exec('ALTER TABLE employees ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1');
if (!db.prepare('PRAGMA table_info(employees)').all().some(column=>column.name==='is_eligible')) db.exec('ALTER TABLE employees ADD COLUMN is_eligible INTEGER NOT NULL DEFAULT 1');
if (!db.prepare('PRAGMA table_info(employees)').all().some(column=>column.name==='is_editor')) db.exec('ALTER TABLE employees ADD COLUMN is_editor INTEGER NOT NULL DEFAULT 0');

if (!db.prepare('SELECT count(*) AS n FROM employees').get().n) {
  const add = db.prepare('INSERT INTO employees (id,name,avatar,is_admin) VALUES (?,?,?,?)');
  add.run(1, 'Алексей Ковалёв', '', 1); add.run(2, 'Дарья Сергеева', '', 0); add.run(3, 'Михаил Петров', '', 0);
  const duty = db.prepare('INSERT INTO duties (kind,starts_on,ends_on,employee_id,hours) VALUES (?,?,?,?,?)');
  duty.run('office','2026-08-07','2026-08-07',2,0); duty.run('support','2026-08-08','2026-08-09',3,4);
  db.prepare('INSERT INTO absences (employee_id,occurred_on,hours,note) VALUES (?,?,?,?)').run(1,'2026-08-03',4,'Личное отсутствие');
  db.prepare('INSERT INTO ledger (employee_id,occurred_on,hours,kind,note) VALUES (?,?,?,?,?)').run(1,'2026-08-03',4,'absence','Отсутствие');
}
// Переход к правилу «отрицательный баланс = долг по дежурству».
// Старые записи сохраняются, а разовая корректировка начинает новый учёт с нуля.
if (!db.prepare("SELECT 1 FROM meta WHERE key='negative_balance_v1'").get()) {
  const employees=db.prepare('SELECT id FROM employees').all();
  const current=db.prepare('SELECT COALESCE(SUM(hours),0) AS hours FROM ledger WHERE employee_id=?');
  const adjust=db.prepare('INSERT INTO ledger(employee_id,occurred_on,hours,kind,note) VALUES (?,?,?,?,?)');
  for(const employee of employees){const value=Number(current.get(employee.id).hours);if(value)adjust.run(employee.id,new Date().toISOString().slice(0,10),-value,'opening_reset','Стартовая корректировка баланса: 0 ч');}
  db.prepare("INSERT INTO meta(key,value) VALUES ('negative_balance_v1','1')").run();
}
// Ранее отдельные суббота и воскресенье сохранялись как 4 часа каждое.
// По действующему правилу один выходной равен 2 часам, весь уикенд — 4 часам.
if (!db.prepare("SELECT 1 FROM meta WHERE key='single_support_day_two_hours_v1'").get()) {
  db.exec("UPDATE duties SET hours=2 WHERE kind IN ('support','holiday') AND starts_on=ends_on AND hours>2");
  db.exec("UPDATE ledger SET hours=2 WHERE kind='support' AND hours>2 AND reference_id IN (SELECT id FROM duties WHERE kind IN ('support','holiday') AND starts_on=ends_on)");
  db.prepare("INSERT INTO meta(key,value) VALUES ('single_support_day_two_hours_v1','1')").run();
}
// Историческая миграция старого правила. Ниже новая миграция пересчитает эти
// записи по действующему правилу «компенсация только до нуля».
if (!db.prepare("SELECT 1 FROM meta WHERE key='positive_compensation_balance_v1'").get()) {
  db.exec('BEGIN');
  try {
    db.exec(`UPDATE ledger
      SET hours=(SELECT d.hours FROM duties d WHERE d.id=ledger.reference_id)
      WHERE kind='support' AND reference_id IN (
        SELECT id FROM duties WHERE status='confirmed' AND accounting_mode='compensate' AND kind!='office'
      )`);
    db.exec(`INSERT INTO ledger(employee_id,occurred_on,hours,kind,reference_id,note)
      SELECT d.employee_id,d.ends_on,d.hours,'support',d.id,'Подтверждённое компенсирующее дежурство'
      FROM duties d
      WHERE d.status='confirmed' AND d.accounting_mode='compensate' AND d.kind!='office'
        AND NOT EXISTS (SELECT 1 FROM ledger l WHERE l.kind='support' AND l.reference_id=d.id)`);
    db.prepare("INSERT INTO meta(key,value) VALUES ('positive_compensation_balance_v1','1')").run();
    db.exec('COMMIT');
  } catch(error) {
    db.exec('ROLLBACK');
    throw error;
  }
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
async function bitrixCall(req,method,params={}){
  const token=String(req.headers['x-b24-token']||''),domain=String(req.headers['x-b24-domain']||'').toLowerCase();
  const allowed=String(process.env.BITRIX_DOMAIN||'novoi.bitrix24.kz').toLowerCase();
  if(!token||domain!==allowed)throw new Error('Нет авторизации Битрикс24 для синхронизации');
  const response=await fetch(`https://${domain}/rest/${method}.json?auth=${encodeURIComponent(token)}`,{method:'POST',headers:{'content-type':'application/json','accept':'application/json'},body:JSON.stringify(params)});
  const raw=await response.text();let data;
  try{data=JSON.parse(raw)}catch{throw new Error(`Битрикс24 вернул некорректный ответ (HTTP ${response.status})`)}
  if(!response.ok||data.error)throw new Error(data.error_description||data.error||`Ошибка Битрикс24 (HTTP ${response.status})`);
  return data.result;
}
const isAdmin = async req => Boolean((await b24User(req))?.IS_ADMIN === true || (await b24User(req))?.IS_ADMIN === 'Y');
const canEdit = user => Boolean(user?.app_admin || db.prepare('SELECT is_editor FROM employees WHERE id=?').get(Number(user?.ID||0))?.is_editor);
const audit = (actor, action, detail) => db.prepare('INSERT INTO audit_log(actor,action,detail) VALUES (?,?,?)').run(actor||'Администратор', action, detail);
const balance = id => Math.min(0,Number(db.prepare('SELECT COALESCE(SUM(hours),0) AS hours FROM ledger WHERE employee_id=?').get(id).hours));
const dutyHoursLimit = duty => duty.kind==='office'?0:(duty.starts_on===duty.ends_on?2:4);
function reconcileEmployeeDutyCredits(employeeId){
  db.prepare("DELETE FROM ledger WHERE employee_id=? AND kind='support'").run(employeeId);
  let debt=Math.max(0,-Number(balance(employeeId)));
  const duties=db.prepare("SELECT * FROM duties WHERE employee_id=? AND status='confirmed' AND kind!='office' AND accounting_mode='compensate' ORDER BY ends_on,id").all(employeeId);
  const add=db.prepare('INSERT INTO ledger (employee_id,occurred_on,hours,kind,reference_id,note) VALUES (?,?,?,?,?,?)');
  for(const duty of duties){const credited=Math.min(Number(duty.hours),debt);if(credited>0)add.run(employeeId,duty.ends_on,credited,'support',duty.id,'Компенсация долга подтверждённым дежурством');debt-=credited;if(debt<=0)break;}
}
function reconcileDutyCredit(duty){
  reconcileEmployeeDutyCredits(duty.employee_id);
  return Number(db.prepare("SELECT COALESCE(SUM(hours),0) AS hours FROM ledger WHERE employee_id=? AND reference_id=? AND kind='support'").get(duty.employee_id,duty.id).hours);
}
if (!db.prepare("SELECT 1 FROM meta WHERE key='no_positive_duty_balance_v1'").get()) {
  for(const employee of db.prepare('SELECT id FROM employees').all())reconcileEmployeeDutyCredits(employee.id);
  db.prepare("INSERT INTO meta(key,value) VALUES ('no_positive_duty_balance_v1','1')").run();
}
const employeeName = id => db.prepare('SELECT name FROM employees WHERE id=?').get(Number(id))?.name || 'Сотрудник';
const absenceName = type => ({vacation:'Отпуск',sick_leave:'Больничный',time_off:'Отгул',business_trip:'Командировка',personal:'Личное отсутствие',unpaid_leave:'Без содержания',other:'Отсутствие'}[type]||'Отсутствие');
const absenceCalendarParams = (absence,autoDetect=false) => ({type:'user',ownerId:Number(absence.employee_id),name:absenceName(absence.absence_type),description:[absence.note,'Добавлено из приложения «Дежурства»'].filter(Boolean).join('\n'),from:absence.occurred_on,to:absence.occurred_on,skip_time:'Y',...(autoDetect?{auto_detect_section:'Y'}:{}),accessibility:'absent',importance:'normal',is_meeting:'N',private_event:'N'});
async function createBitrixAbsence(req,absence){
  const eventId=Number(await bitrixCall(req,'calendar.event.add',absenceCalendarParams(absence,true)));
  if(!eventId)throw new Error('Битрикс24 не вернул номер события календаря');
  db.prepare('UPDATE absences SET bitrix_event_id=?,bitrix_sync_error=NULL WHERE id=?').run(eventId,absence.id);
  return eventId;
}
async function createBitrixAbsenceWorkflowRecord(req,absence){
  const listId=Number(process.env.BITRIX_ABSENCE_LIST_ID||128);
  if(!listId)throw new Error('Не задан BITRIX_ABSENCE_LIST_ID');
  const elementId=Number(await bitrixCall(req,'lists.element.add',{
    IBLOCK_TYPE_ID:'lists',
    IBLOCK_ID:listId,
    ELEMENT_CODE:`duty_absence_${Date.now()}_${Number(absence.employee_id)}`,
    FIELDS:{
      NAME:`${absenceName(absence.absence_type)} — ${employeeName(absence.employee_id)} — ${friendlyPeriodRu(absence.starts_on,absence.ends_on)}`,
      PROPERTY_404:Number(absence.employee_id),
      PROPERTY_406:absence.starts_on,
      PROPERTY_408:absence.ends_on,
      PROPERTY_410:Number(absence.hours)
    }
  }));
  if(!elementId)throw new Error('Битрикс24 не вернул номер записи списка');
  return elementId;
}
async function updateBitrixAbsence(req,previous,current){
  if(previous.bitrix_event_id&&Number(previous.employee_id)===Number(current.employee_id)){
    await bitrixCall(req,'calendar.event.update',{id:Number(previous.bitrix_event_id),...absenceCalendarParams(current)});
    db.prepare('UPDATE absences SET bitrix_event_id=?,bitrix_sync_error=NULL WHERE id=?').run(Number(previous.bitrix_event_id),current.id);
    return Number(previous.bitrix_event_id);
  }
  if(previous.bitrix_event_id)await bitrixCall(req,'calendar.event.delete',{id:Number(previous.bitrix_event_id)});
  return createBitrixAbsence(req,current);
}
const friendlyPeriodRu = (start,end=start) => {
  const months=['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
  const parse=value=>{const [year,month,day]=String(value||'').split('-').map(Number);return {year,month,day}};
  const from=parse(start),to=parse(end);
  if(!from.year||!from.month||!from.day)return `${start||''}${end&&end!==start?`–${end}`:''}`;
  if(from.year===to.year&&from.month===to.month&&from.day===to.day)return `${from.day} ${months[from.month-1]}`;
  if(from.year===to.year&&from.month===to.month)return `${from.day}–${to.day} ${months[from.month-1]}`;
  if(from.year===to.year)return `${from.day} ${months[from.month-1]} – ${to.day} ${months[to.month-1]}`;
  return `${from.day} ${months[from.month-1]} ${from.year} – ${to.day} ${months[to.month-1]} ${to.year}`;
};
const dutyMessage = duty => duty.kind==='office'
  ? `Напоминание: сегодня с 17:00 до 18:00 ваше офисное дежурство. Откройте «Дежурства» и подтвердите готовность.`
  : `Напоминание: сегодня с 09:00 до 18:00 ваше дежурство поддержки. Проверьте обращения клиентов в Bitrix24.`;
// В уведомлениях Bitrix24 ссылка открывает приложение сразу на экране подтверждения обмена.
// При смене адреса приложения его можно задать в Render через BITRIX_APP_URL.
const dutyAppUrl = () => String(process.env.BITRIX_APP_URL || `https://${process.env.BITRIX_DOMAIN || 'novoi.bitrix24.kz'}/marketplace/app/286/`).replace(/\/$/, '') + '/';
const swapApprover = () => {
  const configuredId=Number(process.env.SWAP_APPROVER_ID || 0);
  if(configuredId) return db.prepare('SELECT id,name FROM employees WHERE id=? AND is_active=1').get(configuredId);
  return db.prepare("SELECT id,name FROM employees WHERE is_active=1 AND name LIKE ? LIMIT 1").get('%Алдияр Байгабулов%');
};
async function notifyByWebhook(employeeId,message) {
  const base=String(process.env.BITRIX_IM_WEBHOOK||'').replace(/\/$/,'');
  if(!base) throw new Error('В Render не задан BITRIX_IM_WEBHOOK для отправки уведомлений');
  const response=await fetch(`${base}/im.notify.personal.add`,{method:'POST',headers:{'content-type':'application/json','accept':'application/json'},body:JSON.stringify({USER_ID:Number(employeeId),MESSAGE:message})});
  const raw=await response.text(); let data;
  try{data=JSON.parse(raw)}catch{throw new Error(`Bitrix24 вернул не ответ API (HTTP ${response.status}). Проверьте URL вебхука в Render и право «Чат и уведомления».`)}
  if(!response.ok||data.error) throw new Error(data.error_description||data.error||'Bitrix24 не принял уведомление');
}
function almatyNow(){const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Almaty',year:'numeric',month:'2-digit',day:'2-digit',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});const values=Object.fromEntries(formatter.formatToParts(new Date()).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));return {date:`${values.year}-${values.month}-${values.day}`,weekday:values.weekday,hour:Number(values.hour),minute:Number(values.minute)};}
function absenceDates(startsOn,endsOn){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(startsOn)||!/^\d{4}-\d{2}-\d{2}$/.test(endsOn)) return [];
  const start=new Date(`${startsOn}T00:00:00Z`),end=new Date(`${endsOn}T00:00:00Z`);
  if(!Number.isFinite(start.getTime())||!Number.isFinite(end.getTime())||end<start)return [];
  const dates=[];
  for(let date=start,days=0;date<=end;date=new Date(date.getTime()+86_400_000),days++){
    if(days>=366)return [];
    const weekday=date.getUTCDay();
    if(weekday>=1&&weekday<=5)dates.push(date.toISOString().slice(0,10));
  }
  return dates;
}
async function sendDueReminders(kind,now=almatyNow()){
  const scheduledHour=kind==='office'?14:6;
  const startHour=kind==='office'?17:9;
  // Если Render проснулся не ровно в минуту отправки, напоминание всё равно уйдёт до начала дежурства.
  if(now.hour<scheduledHour||now.hour>=startHour) return 0;
  const duties=db.prepare("SELECT * FROM duties WHERE starts_on=? AND status='scheduled' AND (kind=? OR (?='support' AND kind='holiday'))").all(now.date,kind,kind); let sent=0;
  for(const duty of duties){if(db.prepare('SELECT 1 FROM notifications WHERE duty_id=? AND type=?').get(duty.id,'three_hours'))continue;await notifyByWebhook(duty.employee_id,dutyMessage(duty));db.prepare('INSERT INTO notifications(duty_id,type) VALUES (?,?)').run(duty.id,'three_hours');sent++;}
  if(sent)audit('Автоматическое напоминание','Отправлены напоминания',`${kind}: ${sent}`); return sent;
}
async function reminderTick(){try{const now=almatyNow();if(now.weekday==='Fri')await sendDueReminders('office',now);if(now.weekday==='Sat')await sendDueReminders('support',now)}catch(error){console.error('Reminder error:',error.message)}}
function snapshot(user=null) {
  return {
    employees: db.prepare('SELECT * FROM employees WHERE is_active=1 AND is_eligible=1 ORDER BY name').all(),
    allEmployees: canEdit(user) ? db.prepare('SELECT * FROM employees WHERE is_active=1 ORDER BY name').all() : [],
    editors: user?.app_admin ? db.prepare('SELECT id,name,avatar,is_editor FROM employees WHERE is_active=1 ORDER BY name').all() : [],
    duties: db.prepare(`SELECT d.*, e.name, e.avatar FROM duties d JOIN employees e ON e.id=d.employee_id WHERE d.status NOT IN ('cancelled','rejected') ORDER BY d.starts_on`).all(),
    absences: db.prepare(`SELECT a.*, e.name, e.avatar FROM absences a JOIN employees e ON e.id=a.employee_id ORDER BY occurred_on DESC`).all(),
    balances: db.prepare('SELECT id,name,avatar FROM employees WHERE is_active=1 AND is_eligible=1').all().map(e=>({...e, hours:balance(e.id)})),
    ledger: user ? (canEdit(user)
      ? db.prepare('SELECT l.*,e.name,e.avatar FROM ledger l JOIN employees e ON e.id=l.employee_id ORDER BY l.occurred_on,l.id').all()
      : db.prepare('SELECT l.*,e.name,e.avatar FROM ledger l JOIN employees e ON e.id=l.employee_id WHERE l.employee_id=? ORDER BY l.occurred_on,l.id').all(Number(user.ID))) : [],
    audit: db.prepare('SELECT a.*, e.id AS actor_id, e.name AS actor_name, e.avatar AS actor_avatar FROM audit_log a LEFT JOIN employees e ON e.name=a.actor ORDER BY a.id DESC LIMIT 15').all(),
    officeChecklist: db.prepare('SELECT duty_id,item_key,done,updated_at FROM duty_checklist').all(),
    swapRequests: db.prepare(`SELECT s.*, d.kind, d.starts_on, d.ends_on, d.hours, f.name AS from_name, t.name AS to_name FROM swap_requests s JOIN duties d ON d.id=s.duty_id JOIN employees f ON f.id=s.from_employee_id JOIN employees t ON t.id=s.to_employee_id WHERE s.status NOT IN ('rejected','cancelled') ORDER BY s.id DESC`).all(),
    permissions: { canEdit: canEdit(user), canManageEditors: Boolean(user?.app_admin) },
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
  db.prepare('UPDATE employees SET is_active=0').run();
  const save=db.prepare('INSERT INTO employees(id,name,avatar,is_admin,is_active) VALUES (?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET name=excluded.name,avatar=excluded.avatar,is_admin=excluded.is_admin,is_active=1');
  for(const e of users.filter(x=>x.ACTIVE!==false && x.ACTIVE!=='N')) save.run(Number(e.ID),`${e.NAME||''} ${e.LAST_NAME||''}`.trim()||e.LOGIN,e.PERSONAL_PHOTO||'',Number(e.ID)===Number(user.ID)&&user.app_admin?1:0);
  return user;
}
async function api(req,res,url) {
  if (req.method==='POST' && url.pathname==='/api/bitrix/sync') { const user=await syncEmployees(req); return json(res,200,snapshot(user)); }
  if (req.method==='GET' && url.pathname==='/api/bootstrap') { const user=await b24User(req); return json(res,200,snapshot(user)); }
  const editorMatch=url.pathname.match(/^\/api\/employees\/(\d+)\/editor$/);
  if(req.method==='PATCH'&&editorMatch){
    const actor=await b24User(req); if(!actor?.app_admin) return json(res,403,{error:'Выдавать права редактора может только администратор портала'});
    const employee=db.prepare('SELECT * FROM employees WHERE id=?').get(Number(editorMatch[1])); if(!employee) return json(res,404,{error:'Сотрудник не найден'});
    const value=await body(req), enabled=value.enabled===true||value.enabled==='true';
    db.prepare('UPDATE employees SET is_editor=? WHERE id=?').run(enabled?1:0,employee.id);
    audit(`${actor.NAME||''} ${actor.LAST_NAME||''}`.trim(),'Изменены права редактора',`${employee.name}: ${enabled?'редактор':'просмотр'}`); return json(res,200,snapshot(actor));
  }
  const eligibilityMatch=url.pathname.match(/^\/api\/employees\/(\d+)\/eligibility$/);
  if(req.method==='PATCH'&&eligibilityMatch){
    const actor=await b24User(req); if(!canEdit(actor)) return json(res,403,{error:'Недостаточно прав для изменения графика'});
    const employee=db.prepare('SELECT * FROM employees WHERE id=?').get(Number(eligibilityMatch[1])); if(!employee) return json(res,404,{error:'Сотрудник не найден'});
    const v=await body(req), eligible=v.eligible===true||v.eligible==='true'||v.eligible==='on';
    db.prepare('UPDATE employees SET is_eligible=? WHERE id=?').run(eligible?1:0,employee.id);
    audit(`${actor.NAME||''} ${actor.LAST_NAME||''}`.trim(),'Изменён состав графика',`${employee.name}: ${eligible?'участвует':'исключён'}`); return json(res,200,snapshot(actor));
  }
  if (req.method==='POST' && url.pathname==='/api/duties') {
    const actor=await b24User(req); if(!canEdit(actor)) return json(res,403,{error:'Недостаточно прав для изменения графика'});
    const v=await body(req); if(!['office','support','holiday'].includes(v.kind)||!v.starts_on||!v.ends_on||!Number(v.employee_id)||!['schedule','compensate'].includes(v.accounting_mode||'schedule')||!db.prepare('SELECT 1 FROM employees WHERE id=? AND is_active=1 AND is_eligible=1').get(Number(v.employee_id))) return json(res,422,{error:'Выберите действующего сотрудника из состава графика'});
    const accountingMode=v.kind==='office'?'schedule':(v.accounting_mode||'schedule');
    const limit=dutyHoursLimit(v),defaultHours=limit;
    const hours=v.kind==='office'?0:(v.hours===undefined||v.hours===''?defaultHours:Number(v.hours));
    if(!Number.isFinite(hours)||hours<0||hours>limit||(v.kind!=='office'&&hours<=0)) return json(res,422,{error:`Один выходной компенсирует до 2 ч, оба выходных — до 4 ч`});
    const r=db.prepare('INSERT INTO duties (kind,starts_on,ends_on,employee_id,hours,accounting_mode) VALUES (?,?,?,?,?,?)').run(v.kind,v.starts_on,v.ends_on,Number(v.employee_id),hours,accountingMode);
    audit(`${actor.NAME||''} ${actor.LAST_NAME||''}`.trim(),'Назначено дежурство', `${v.kind==='office'?'Офис':'Поддержка'} · ${employeeName(v.employee_id)} · ${v.starts_on}–${v.ends_on} · ${accountingMode==='compensate'?'компенсация':'по графику'}`); return json(res,201,snapshot(actor));
  }
  const updateMatch=url.pathname.match(/^\/api\/duties\/(\d+)$/);
  if (req.method==='PATCH' && updateMatch) {
    const actor=await b24User(req); if(!canEdit(actor)) return json(res,403,{error:'Недостаточно прав для редактирования'});
    const duty=db.prepare('SELECT * FROM duties WHERE id=?').get(Number(updateMatch[1])); if(!duty) return json(res,404,{error:'Дежурство не найдено'});
    if(!['scheduled','confirmed'].includes(duty.status)) return json(res,409,{error:'Это дежурство нельзя редактировать'});
    const v=await body(req); const hours=duty.kind==='office'?0:Number(v.hours), accountingMode=v.accounting_mode||duty.accounting_mode;
    if(!Number.isFinite(hours)||hours<0||hours>dutyHoursLimit(duty)||(duty.kind!=='office'&&hours<=0)) return json(res,422,{error:'Один выходной компенсирует до 2 ч, оба выходных — до 4 ч'});
    if(!['schedule','compensate'].includes(accountingMode)) return json(res,422,{error:'Выберите корректный режим дежурства'});
    db.prepare('UPDATE duties SET hours=?, accounting_mode=? WHERE id=?').run(hours,accountingMode,duty.id);
    const updated=db.prepare('SELECT * FROM duties WHERE id=?').get(duty.id),credited=reconcileDutyCredit(updated);
    audit(`${actor.NAME||''} ${actor.LAST_NAME||''}`.trim(),'Изменено дежурство', `${duty.starts_on}–${duty.ends_on}: ${hours} ч · ${accountingMode==='compensate'?`компенсация ${credited} ч`:'по графику'}`); return json(res,200,{...snapshot(actor),creditApplied:credited});
  }
  const rejectMatch=url.pathname.match(/^\/api\/duties\/(\d+)\/reject$/);
  if (req.method==='POST' && rejectMatch) {
    const actor=await b24User(req); if(!canEdit(actor)) return json(res,403,{error:'Недостаточно прав для редактирования'});
    const duty=db.prepare('SELECT * FROM duties WHERE id=?').get(Number(rejectMatch[1])); if(!duty) return json(res,404,{error:'Дежурство не найдено'});
    if(duty.status!=='scheduled') return json(res,409,{error:'Можно отклонить только неподтверждённое дежурство'});
    db.prepare('UPDATE duties SET status=? WHERE id=?').run('rejected',duty.id);
    audit(`${actor.NAME||''} ${actor.LAST_NAME||''}`.trim(),'Отклонено дежурство', `${duty.starts_on}–${duty.ends_on}`); return json(res,200,snapshot(actor));
  }
  const confirmMatch=url.pathname.match(/^\/api\/duties\/(\d+)\/confirm$/);
  if (req.method==='POST' && confirmMatch) {
    const actor=await b24User(req); if(!canEdit(actor)) return json(res,403,{error:'Недостаточно прав для подтверждения'});
    const duty=db.prepare('SELECT * FROM duties WHERE id=?').get(Number(confirmMatch[1])); if(!duty) return json(res,404,{error:'Дежурство не найдено'});
    if(duty.status==='confirmed') return json(res,409,{error:'Дежурство уже подтверждено'});
    db.prepare('UPDATE duties SET status=? WHERE id=?').run('confirmed',duty.id);
    const confirmed={...duty,status:'confirmed'},credited=reconcileDutyCredit(confirmed);
    audit(`${actor.NAME||''} ${actor.LAST_NAME||''}`.trim(),'Подтверждено дежурство', `${duty.kind==='office'?'Офис':'Поддержка'} · ${employeeName(duty.employee_id)} · ${duty.starts_on}–${duty.ends_on} · возвращено ${credited} ч`); return json(res,200,{...snapshot(actor),creditApplied:credited});
  }
  const deleteMatch=url.pathname.match(/^\/api\/duties\/(\d+)\/delete$/);
  if (req.method==='POST' && deleteMatch) {
    const actor=await b24User(req); if(!canEdit(actor)) return json(res,403,{error:'Недостаточно прав для редактирования'});
    const duty=db.prepare('SELECT * FROM duties WHERE id=?').get(Number(deleteMatch[1])); if(!duty) return json(res,404,{error:'Дежурство не найдено'});
    db.prepare('DELETE FROM duties WHERE id=?').run(duty.id); reconcileEmployeeDutyCredits(duty.employee_id);
    audit(`${actor.NAME||''} ${actor.LAST_NAME||''}`.trim(),'Удалено дежурство', `${duty.starts_on}–${duty.ends_on}`); return json(res,200,snapshot(actor));
  }
  if (req.method==='POST' && url.pathname==='/api/absences') {
    const actor=await b24User(req); if(!canEdit(actor)) return json(res,403,{error:'Недостаточно прав для редактирования'});
    const v=await body(req); const hours=Number(v.hours), absenceType=String(v.absence_type||'personal'),dates=absenceDates(String(v.occurred_on||''),String(v.ends_on||v.occurred_on||''));
    if(!Number(v.employee_id)||!db.prepare('SELECT 1 FROM employees WHERE id=? AND is_active=1 AND is_eligible=1').get(Number(v.employee_id))||!dates.length||!hours||hours>24||!['vacation','sick_leave','time_off','business_trip','personal','unpaid_leave','other'].includes(absenceType)) return json(res,422,{error:'Выберите сотрудника, корректный период до 366 дней и часы отсутствия за один день'});
    const compensable=v.compensable===true||v.compensable==='true'||v.compensable==='on';
    const addAbsence=db.prepare('INSERT INTO absences (employee_id,occurred_on,hours,note,absence_type,compensable) VALUES (?,?,?,?,?,?)');
    const addLedger=db.prepare('INSERT INTO ledger (employee_id,occurred_on,hours,kind,reference_id,note) VALUES (?,?,?,?,?,?)');
    const createdIds=[];
    db.exec('BEGIN');
    try{
      for(const date of dates){const r=addAbsence.run(Number(v.employee_id),date,hours,v.note||'',absenceType,compensable?1:0);createdIds.push(Number(r.lastInsertRowid));if(compensable)addLedger.run(Number(v.employee_id),date,-hours,'absence',r.lastInsertRowid,v.note||'Отсутствие');}
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error}
    reconcileEmployeeDutyCredits(Number(v.employee_id));
    const syncErrors=[];
    try{
      const listElementId=await createBitrixAbsenceWorkflowRecord(req,{employee_id:Number(v.employee_id),starts_on:String(v.occurred_on),ends_on:String(v.ends_on||v.occurred_on),hours,absence_type:absenceType,note:v.note||''});
      for(const id of createdIds)db.prepare('UPDATE absences SET bitrix_list_element_id=?,bitrix_sync_error=NULL WHERE id=?').run(listElementId,id);
    }catch(error){
      const message=String(error.message||'Ошибка синхронизации');
      for(const id of createdIds)db.prepare('UPDATE absences SET bitrix_sync_error=? WHERE id=?').run(message,id);
      syncErrors.push(message);
    }
    const period=dates.length===1?dates[0]:`${dates[0]}–${dates.at(-1)}`;
    audit(`${actor.NAME||''} ${actor.LAST_NAME||''}`.trim(),'Добавлено отсутствие', `${absenceType} · ${hours} ч/день · ${period}${compensable?' · учтено в отработке':''}${syncErrors.length?' · график отсутствий Битрикс24: ошибка':' · добавлено в график отсутствий Битрикс24'}`);
    const result=snapshot(actor);if(syncErrors.length)result.syncWarning=`Отсутствие сохранено, но не добавлено в график Битрикс24: ${syncErrors[0]}`;return json(res,201,result);
  }
  const absenceEditMatch=url.pathname.match(/^\/api\/absences\/(\d+)$/);
  if(req.method==='PATCH'&&absenceEditMatch){
    const actor=await b24User(req);if(!canEdit(actor))return json(res,403,{error:'Недостаточно прав для редактирования отсутствия'});
    const absence=db.prepare('SELECT * FROM absences WHERE id=?').get(Number(absenceEditMatch[1]));if(!absence)return json(res,404,{error:'Запись об отсутствии не найдена'});
    const v=await body(req),employeeId=Number(v.employee_id),hours=Number(v.hours),absenceType=String(v.absence_type||'personal'),dates=absenceDates(String(v.occurred_on||''),String(v.occurred_on||''));
    if(!employeeId||!db.prepare('SELECT 1 FROM employees WHERE id=? AND is_active=1 AND is_eligible=1').get(employeeId)||dates.length!==1||!hours||hours>24||!['vacation','sick_leave','time_off','business_trip','personal','unpaid_leave','other'].includes(absenceType))return json(res,422,{error:'Проверьте сотрудника, рабочую дату и часы отсутствия'});
    const compensable=v.compensable===true||v.compensable==='true'||v.compensable==='on';
    db.exec('BEGIN');
    try{
      db.prepare('DELETE FROM ledger WHERE reference_id=? AND kind=?').run(absence.id,'absence');
      db.prepare('UPDATE absences SET employee_id=?,occurred_on=?,hours=?,note=?,absence_type=?,compensable=? WHERE id=?').run(employeeId,dates[0],hours,v.note||'',absenceType,compensable?1:0,absence.id);
      if(compensable)db.prepare('INSERT INTO ledger (employee_id,occurred_on,hours,kind,reference_id,note) VALUES (?,?,?,?,?,?)').run(employeeId,dates[0],-hours,'absence',absence.id,v.note||'Отсутствие');
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error}
    reconcileEmployeeDutyCredits(absence.employee_id);if(employeeId!==absence.employee_id)reconcileEmployeeDutyCredits(employeeId);
    const current=db.prepare('SELECT * FROM absences WHERE id=?').get(absence.id);let syncWarning='';
    try{await updateBitrixAbsence(req,absence,current)}catch(error){syncWarning=`Отсутствие изменено, но график Битрикс24 не обновлён: ${error.message}`;db.prepare('UPDATE absences SET bitrix_sync_error=? WHERE id=?').run(String(error.message||'Ошибка синхронизации'),absence.id)}
    audit(`${actor.NAME||''} ${actor.LAST_NAME||''}`.trim(),'Изменено отсутствие',`${employeeName(employeeId)} · ${dates[0]} · ${hours} ч`);
    const result=snapshot(actor);if(syncWarning)result.syncWarning=syncWarning;return json(res,200,result);
  }
  const absenceDeleteMatch=url.pathname.match(/^\/api\/absences\/(\d+)\/delete$/);
  if(req.method==='POST' && absenceDeleteMatch){
    const actor=await b24User(req); if(!canEdit(actor)) return json(res,403,{error:'Недостаточно прав для удаления отсутствия'});
    const absence=db.prepare('SELECT * FROM absences WHERE id=?').get(Number(absenceDeleteMatch[1])); if(!absence) return json(res,404,{error:'Запись об отсутствии не найдена'});
    if(absence.bitrix_event_id){try{await bitrixCall(req,'calendar.event.delete',{id:Number(absence.bitrix_event_id)})}catch(error){return json(res,502,{error:`Не удалось удалить связанную запись из графика Битрикс24: ${error.message}. Запись в приложении сохранена.`})}}
    db.prepare('DELETE FROM ledger WHERE reference_id=? AND kind=?').run(absence.id,'absence');
    db.prepare('DELETE FROM absences WHERE id=?').run(absence.id);
    reconcileEmployeeDutyCredits(absence.employee_id);
    audit(`${actor.NAME||''} ${actor.LAST_NAME||''}`.trim(),'Удалено отсутствие', `${employeeName(absence.employee_id)} · ${absence.occurred_on} · ${absence.hours} ч`);
    return json(res,200,snapshot(actor));
  }
  const checklistMatch=url.pathname.match(/^\/api\/duties\/(\d+)\/checklist$/);
  if(req.method==='PATCH' && checklistMatch){
    const actor=await b24User(req); if(!actor) return json(res,401,{error:'Не удалось определить пользователя Bitrix24'});
    const duty=db.prepare('SELECT * FROM duties WHERE id=?').get(Number(checklistMatch[1]));
    const v=await body(req), allowed=['trash','surfaces','equipment','windows'];
    if(!duty||duty.kind!=='office'||duty.employee_id!==Number(actor.ID)||!['scheduled','acknowledged'].includes(duty.office_status)||!allowed.includes(v.item_key)) return json(res,403,{error:'Изменять чек-лист может только назначенный офисный дежурный'});
    db.prepare("INSERT INTO duty_checklist(duty_id,item_key,done,updated_at) VALUES (?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(duty_id,item_key) DO UPDATE SET done=excluded.done,updated_at=CURRENT_TIMESTAMP").run(duty.id,v.item_key,v.done?1:0);
    audit(`${actor.NAME||''} ${actor.LAST_NAME||''}`.trim(),'Обновлён чек-лист офиса', `${employeeName(duty.employee_id)} · ${duty.starts_on} · ${v.item_key}: ${v.done?'выполнено':'не выполнено'}`);
    return json(res,200,snapshot(actor));
  }
  const officeAction=url.pathname.match(/^\/api\/duties\/(\d+)\/office\/(acknowledge|decline|complete)$/);
  if(req.method==='POST' && officeAction){
    const actor=await b24User(req); if(!actor) return json(res,401,{error:'Не удалось определить пользователя Bitrix24'});
    const duty=db.prepare('SELECT * FROM duties WHERE id=?').get(Number(officeAction[1])); if(!duty||duty.kind!=='office') return json(res,404,{error:'Офисное дежурство не найдено'});
    const action=officeAction[2], actorName=`${actor.NAME||''} ${actor.LAST_NAME||''}`.trim();
    if(action==='acknowledge'){if(Number(actor.ID)!==duty.employee_id||duty.office_status!=='scheduled') return json(res,403,{error:'Подтвердить готовность может назначенный сотрудник'});db.prepare('UPDATE duties SET office_status=? WHERE id=?').run('acknowledged',duty.id);audit(actorName,'Сотрудник подтвердил офисное дежурство',duty.starts_on);return json(res,200,snapshot(actor));}
    if(action==='decline'){if(Number(actor.ID)!==duty.employee_id||!['scheduled','acknowledged'].includes(duty.office_status)) return json(res,403,{error:'Отказаться может назначенный сотрудник'});const v=await body(req);db.prepare('UPDATE duties SET office_status=? WHERE id=?').run('declined',duty.id);audit(actorName,'Сотрудник не может дежурить в офисе',`${duty.starts_on}${v.note?` · ${v.note}`:''}`);return json(res,200,snapshot(actor));}
    if(!canEdit(actor)||duty.office_status!=='acknowledged') return json(res,403,{error:'Выполнение подтверждает редактор после подтверждения сотрудника'});db.prepare('UPDATE duties SET office_status=? WHERE id=?').run('completed',duty.id);audit(actorName,'Подтверждено выполнение офисного дежурства',duty.starts_on);return json(res,200,snapshot(actor));
  }
  if (req.method==='POST' && url.pathname==='/api/swaps') {
    const actor=await b24User(req); if(!actor) return json(res,401,{error:'Не удалось определить пользователя Bitrix24'});
    const v=await body(req), currentId=Number(actor.ID), dutyId=Number(v.duty_id), targetId=Number(v.to_employee_id);
    const duty=db.prepare('SELECT * FROM duties WHERE id=?').get(dutyId); if(!duty||!['scheduled','confirmed'].includes(duty.status)) return json(res,422,{error:'Для этого дежурства обмен уже недоступен'});
    if(duty.employee_id!==currentId) return json(res,403,{error:'Можно предложить обмен только своего дежурства'});
    if(!targetId||targetId===currentId||!db.prepare('SELECT 1 FROM employees WHERE id=? AND is_active=1 AND is_eligible=1').get(targetId)) return json(res,422,{error:'Выберите действующего сотрудника из состава графика'});
    if(db.prepare("SELECT 1 FROM swap_requests WHERE duty_id=? AND status IN ('pending_target','pending_admin')").get(dutyId)) return json(res,409,{error:'По этому дежурству уже есть активная заявка на обмен'});
    db.prepare('INSERT INTO swap_requests(duty_id,from_employee_id,to_employee_id,note) VALUES (?,?,?,?)').run(dutyId,currentId,targetId,String(v.note||''));
    const actorName=`${actor.NAME||''} ${actor.LAST_NAME||''}`.trim()||'Сотрудник';
    const dutyKind=duty.kind==='office'?'офисное дежурство':'дежурство поддержки';
    await notifyByWebhook(targetId,`${actorName} предлагает вам заменить его на ${dutyKind}: ${friendlyPeriodRu(duty.starts_on,duty.ends_on)}.${v.note?` Комментарий: ${String(v.note)}`:''} Откройте «Дежурства», чтобы согласиться или отклонить предложение.`);
    audit(actorName,'Предложен обмен дежурством', `${duty.starts_on}–${duty.ends_on}`); return json(res,201,snapshot(actor));
  }
  const swapAction=url.pathname.match(/^\/api\/swaps\/(\d+)\/(accept|reject|approve)$/);
  if (req.method==='POST' && swapAction) {
    const actor=await b24User(req); if(!actor) return json(res,401,{error:'Не удалось определить пользователя Bitrix24'});
    const request=db.prepare('SELECT s.*,d.hours,d.kind,d.starts_on,d.ends_on FROM swap_requests s JOIN duties d ON d.id=s.duty_id WHERE s.id=?').get(Number(swapAction[1]));
    if(!request) return json(res,404,{error:'Заявка на обмен не найдена'}); const action=swapAction[2], actorId=Number(actor.ID);
    if(action==='accept') {
      if(actorId!==request.to_employee_id||request.status!=='pending_target') return json(res,403,{error:'Эта заявка недоступна для подтверждения'});
      db.prepare('UPDATE swap_requests SET status=? WHERE id=?').run('pending_admin',request.id);
      const actorName=`${actor.NAME||''} ${actor.LAST_NAME||''}`.trim()||'Сотрудник';
      await notifyByWebhook(request.from_employee_id,`${actorName} согласился заменить вас на дежурстве: ${friendlyPeriodRu(request.starts_on,request.ends_on)}. Заявка передана редактору на окончательное подтверждение.`);
      const approver=swapApprover();
      if(approver) {
        const fromName=employeeName(request.from_employee_id), toName=employeeName(request.to_employee_id);
        const kind=request.kind==='office'?'офисного дежурства':'дежурства поддержки';
        await notifyByWebhook(approver.id,`Требуется подтверждение обмена ${kind}: ${fromName} → ${toName}, ${friendlyPeriodRu(request.starts_on,request.ends_on)}. [URL=${dutyAppUrl()}]Открыть «Дежурства» и подтвердить[/URL]`);
        audit(actorName,'Обмен передан руководителю на подтверждение', `${fromName} → ${toName} · ${request.starts_on}–${request.ends_on} · ${approver.name}`);
      } else audit(actorName,'Обмен ожидает подтверждения редактора', `${request.starts_on}–${request.ends_on} · руководитель Алдияр Байгабулов не найден`);
      audit(actorName,'Сотрудник согласился на обмен', `${request.starts_on}–${request.ends_on}`);
      return json(res,200,snapshot(actor));
    }
    if(action==='reject') { if(actorId!==request.to_employee_id&&!actor.app_admin) return json(res,403,{error:'Отклонить заявку может получатель или администратор'}); db.prepare('UPDATE swap_requests SET status=? WHERE id=?').run('rejected',request.id); audit(`${actor.NAME||''} ${actor.LAST_NAME||''}`.trim(),'Отклонён обмен дежурством', `${request.starts_on}–${request.ends_on}`); return json(res,200,snapshot(actor)); }
    if(!canEdit(actor)||request.status!=='pending_admin') return json(res,403,{error:'Подтверждать обмен может только редактор после согласия сотрудника'});
    // Если смена уже подтверждена как компенсирующая, переносим её учёт с прежнего сотрудника на нового.
    const duty=db.prepare('SELECT * FROM duties WHERE id=?').get(request.duty_id);
    db.prepare('UPDATE duties SET employee_id=? WHERE id=?').run(request.to_employee_id,request.duty_id);
    reconcileEmployeeDutyCredits(duty.employee_id);
    reconcileDutyCredit({...duty,employee_id:request.to_employee_id});
    db.prepare('UPDATE swap_requests SET status=? WHERE id=?').run('approved',request.id);
    audit(`${actor.NAME||''} ${actor.LAST_NAME||''}`.trim(),'Подтверждён обмен дежурством', `${request.starts_on}–${request.ends_on}`); return json(res,200,snapshot(actor));
  }
  const remindMatch=url.pathname.match(/^\/api\/duties\/(\d+)\/remind$/);
  if(req.method==='POST' && remindMatch) {
    const actor=await b24User(req); if(!canEdit(actor)) return json(res,403,{error:'Недостаточно прав для отправки напоминаний'});
    const duty=db.prepare('SELECT * FROM duties WHERE id=?').get(Number(remindMatch[1])); if(!duty) return json(res,404,{error:'Дежурство не найдено'});
    await notifyByWebhook(duty.employee_id,dutyMessage(duty)); audit(`${actor.NAME||''} ${actor.LAST_NAME||''}`.trim(),'Отправлено напоминание', `${duty.starts_on}–${duty.ends_on}`); return json(res,200,{ok:true});
  }
  if (req.method==='POST' && url.pathname==='/install') {
    // Bitrix24 local-app handler: persist tokens per portal. Encrypt these columns with KMS in production.
    const raw=await new Promise(resolve=>{let s='';req.on('data',x=>s+=x);req.on('end',()=>resolve(Object.fromEntries(new URLSearchParams(s))))});
    const memberId=raw.member_id||raw['auth[member_id]']; const domain=raw.DOMAIN||raw.domain||raw['auth[domain]'];
    const accessToken=raw.AUTH_ID||raw['auth[access_token]']; const refreshToken=raw.REFRESH_ID||raw['auth[refresh_token]']; const expires=raw.AUTH_EXPIRES||raw['auth[expires_in]'];
    if(memberId && domain) db.prepare('INSERT OR REPLACE INTO portals(member_id,domain,access_token,refresh_token,expires_at) VALUES (?,?,?,?,?)').run(memberId,domain,accessToken||null,refreshToken||null,Date.now()+Number(expires||0)*1000);
    const installPage=await readFile(join(process.cwd(),'public','install.html'));
    res.writeHead(200,{'content-type':'text/html; charset=utf-8'}); return res.end(installPage);
  }
  return json(res,404,{error:'Не найдено'});
}
const mime={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'};
const server=http.createServer(async(req,res)=>{ try {
  const url=new URL(req.url,`http://${req.headers.host}`); if(url.pathname.startsWith('/api/') || (url.pathname==='/install' && req.method!=='GET')) return api(req,res,url);
  const file=url.pathname==='/'?'index.html':url.pathname==='/install'?'install.html':url.pathname.replace(/^\//,''); const path=join(process.cwd(),'public',file);
  if(!path.startsWith(join(process.cwd(),'public')) || !existsSync(path)) return json(res,404,{error:'Страница не найдена'});
  res.writeHead(200,{'content-type':mime[extname(path)]||'application/octet-stream'}); const content=await readFile(path); res.end(content);
} catch(e) { console.error(e); json(res,500,{error:e.message||'Внутренняя ошибка'}); }});
server.listen(port, process.env.HOST || '0.0.0.0', ()=>{console.log(`Дежурства: http://localhost:${port}`); reminderTick(); setInterval(reminderTick,60_000);});
