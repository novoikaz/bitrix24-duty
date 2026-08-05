(()=>{
  let headers={};
  const get=async path=>{const response=await fetch(path,{headers});const data=await response.json();if(!response.ok)throw new Error(data.error||'Не удалось загрузить данные');return data};
  const post=async(path,data={})=>{const response=await fetch(path,{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(data)});const result=await response.json();if(!response.ok)throw new Error(result.error||'Не удалось сохранить данные');return result};
  const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const hours=list=>list.reduce((sum,item)=>sum+Number(item.hours||0),0);
  function page(title,content){document.querySelector('.main').innerHTML=`<header class="top"><div><div class="eyebrow">novoi.bitrix24.kz</div><h1>${title}</h1></div></header><section class="card" style="margin-top:20px">${content}</section><p><button onclick="location.reload()">← К календарю</button></p>`}
  async function balance(){
    const data=await get('/api/bootstrap');const employee=data.employees.find(item=>item.id===data.currentEmployeeId)||data.employees[0];const amount=data.balances.find(item=>item.id===employee?.id)?.hours||0;
    const absences=data.absences.filter(item=>item.employee_id===employee?.id);
    const duties=data.duties.filter(item=>item.employee_id===employee?.id);
    page('Мой баланс',`<h2 style="font-size:30px">${amount} ч к компенсации</h2><p class="sub">Каждый час отсутствия в рабочее время увеличивает баланс. После подтверждения дежурства поддержки баланс уменьшается: суббота — на 2 ч, выходные — на 4 ч.</p><h2 style="margin-top:24px">Мои отсутствия</h2>${absences.length?`<table><tr><th>Дата</th><th>Часы</th><th>Комментарий</th></tr>${absences.map(item=>`<tr><td>${esc(item.occurred_on)}</td><td>${item.hours} ч</td><td>${esc(item.note||'—')}</td></tr>`).join('')}</table>`:'<p class="sub">Отсутствия ещё не зафиксированы.</p>'}<h2 style="margin-top:24px">Мои дежурства</h2>${duties.length?`<table><tr><th>Тип</th><th>Период</th><th>Статус</th></tr>${duties.map(item=>`<tr><td>${item.kind==='office'?'Офис':'Поддержка'}</td><td>${item.starts_on} — ${item.ends_on}</td><td>${item.status==='confirmed'?'Подтверждено':'Назначено'}</td></tr>`).join('')}</table>`:'<p class="sub">Назначений пока нет.</p>'}`);
  }
  async function employees(){
    const data=await get('/api/bootstrap');
    const rows=data.employees.map(employee=>{const absence=data.absences.filter(item=>item.employee_id===employee.id);const duties=data.duties.filter(item=>item.employee_id===employee.id);const confirmed=duties.filter(item=>item.status==='confirmed');return `<tr><td><div class="person"><span class="ava">${esc(employee.name.slice(0,1))}</span><b>${esc(employee.name)}</b></div></td><td>${hours(absence)} ч</td><td>${confirmed.length}</td><td>${data.balances.find(item=>item.id===employee.id)?.hours||0} ч</td></tr>`}).join('');
    page('Сотрудники',`<p class="sub">Сводка по зафиксированным отсутствиям и подтверждённым дежурствам.</p><table><tr><th>Сотрудник</th><th>Отсутствия</th><th>Подтв. дежурства</th><th>Баланс</th></tr>${rows}</table>`);
  }
  async function settings(){
    const data=await get('/api/bootstrap');
    if(!data.permissions.canEdit){page('Настройки',`<p>Настройки и учёт отсутствий доступны только администратору портала.</p>`);return}
    const options=data.employees.map(item=>`<option value="${item.id}">${esc(item.name)}</option>`).join('');
    const pending=data.duties.filter(item=>item.status==='scheduled'&&item.kind!=='office');
    page('Настройки и учёт',`<p class="sub">Офисное дежурство по пятницам не списывает баланс. Поддержка: один выходной — 2 ч, оба выходных — 4 ч.</p><h2 style="margin-top:24px">Зафиксировать отсутствие</h2><form id="absenceForm"><div class="field"><label>Сотрудник</label><select name="employee_id">${options}</select></div><div class="field"><label>Дата</label><input required type="date" name="occurred_on" value="${new Date().toISOString().slice(0,10)}"></div><div class="field"><label>Отсутствовал, часов</label><input required name="hours" type="number" min="0.5" max="8" step="0.5" placeholder="Например, 2"></div><div class="field"><label>Комментарий</label><input name="note" placeholder="Причина или договорённость"></div><div class="actions"><button class="primary">Сохранить отсутствие</button></div></form><h2 style="margin-top:28px">Ожидают подтверждения</h2>${pending.length?`<table><tr><th>Сотрудник</th><th>Период</th><th>Списание</th><th></th></tr>${pending.map(item=>`<tr><td>${esc(item.name)}</td><td>${item.starts_on} — ${item.ends_on}</td><td>${item.hours} ч</td><td><button data-confirm="${item.id}">Подтвердить</button></td></tr>`).join('')}</table>`:'<p class="sub">Нет назначенных дежурств поддержки, ожидающих подтверждения.</p>'}`);
    document.querySelector('#absenceForm').onsubmit=async event=>{event.preventDefault();try{await post('/api/absences',Object.fromEntries(new FormData(event.currentTarget)));alert('Отсутствие зафиксировано. Баланс сотрудника обновлён.');settings()}catch(error){alert(error.message)}};
    document.querySelectorAll('[data-confirm]').forEach(button=>button.onclick=async()=>{if(!confirm('Подтвердить, что сотрудник выполнил дежурство? Баланс будет списан.'))return;try{await post(`/api/duties/${button.dataset.confirm}/confirm`);alert('Дежурство подтверждено. Баланс обновлён.');settings()}catch(error){alert(error.message)}});
  }
  function bind(){
    if(window.BX24){const auth=BX24.getAuth?.();if(auth)headers={'x-b24-token':auth.access_token,'x-b24-domain':auth.domain}}
    const nav=[...document.querySelectorAll('.nav span')];if(nav.length<4)return;
    nav[1].onclick=()=>balance().catch(error=>alert(error.message));nav[2].onclick=()=>employees().catch(error=>alert(error.message));nav[3].onclick=()=>settings().catch(error=>alert(error.message));
  }
  if(window.BX24) BX24.init(bind); else window.addEventListener('load',bind);
})();
