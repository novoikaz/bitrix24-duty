let state;
let b24Headers={};
let viewDate=new Date();
viewDate.setDate(1);

const $=selector=>document.querySelector(selector);
const esc=value=>String(value||'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const pad=value=>String(value).padStart(2,'0');
const dateKey=date=>`${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`;
const monthName=new Intl.DateTimeFormat('ru-RU',{month:'long',year:'numeric'});

async function api(path,options={}){return fetch(path,{...options,headers:{...b24Headers,...(options.headers||{})}})}
async function load(){state=await api('/api/bootstrap').then(response=>response.json());render()}
function initials(name){return name.split(' ').map(part=>part[0]).join('').slice(0,2)}
function ava(employee){return employee?.avatar?`<img class="ava" src="${esc(employee.avatar)}" alt="">`:`<span class="ava">${initials(employee?.name||'?')}</span>`}
function person(duty){return duty?`<div class="person">${ava(duty)}<div><b>${esc(duty.name)}</b><br><span class="sub">${duty.starts_on}–${duty.ends_on}</span></div><span class="right">${duty.hours?`${duty.hours} ч`:'офис'}</span></div>`:'<span class="sub">Не назначен</span>'}
const officeChecklistItems=[['trash','Убрать мусор'],['surfaces','Протереть поверхности'],['equipment','Выключить технику и свет'],['windows','Проверить окна и двери']];
function renderOfficeChecklist(duty){
  const card=document.querySelector('.ops .card:first-child'); if(!card)return;
  if(!duty||duty.kind!=='office'){card.innerHTML='<h2>Чек-лист офиса</h2><div class="sub">Появится для назначенного сотрудника в день офисного дежурства.</div>';return}
  const checks=state.officeChecklist||[],done=new Set(checks.filter(item=>item.duty_id===duty.id&&Number(item.done)).map(item=>item.item_key)),count=done.size;
  const mine=Number(duty.employee_id)===Number(state.currentEmployeeId),admin=state.permissions.canEdit,canEdit=mine&&['scheduled','acknowledged'].includes(duty.office_status);
  const note=canEdit?'Отмечайте задачи по мере выполнения. Результат сохранится автоматически.':admin?'Прогресс дежурного доступен для проверки.':`Чек-лист доступен ${esc(duty.name)} — назначенному сотруднику.`;
  card.innerHTML=`<h2>Чек-лист офиса</h2><div class="check-progress"><b>${count} из ${officeChecklistItems.length}</b> выполнено</div><div class="sub" style="margin:4px 0 8px">${note}</div>${officeChecklistItems.map(([key,label])=>`<label class="check task-check"><input type="checkbox" data-check-item="${key}" ${done.has(key)?'checked':''} ${canEdit?'':'disabled'}><span>${label}</span></label>`).join('')}`;
  card.querySelectorAll('[data-check-item]').forEach(input=>input.onchange=async()=>{const response=await api(`/api/duties/${duty.id}/checklist`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({item_key:input.dataset.checkItem,done:input.checked})}),data=await response.json();if(!response.ok){toast(data.error||'Не удалось сохранить пункт');input.checked=!input.checked;return}state=data;render()});
}

function addCalendarToolbar(){
  if($('#monthTitle'))return;
  const style=document.createElement('style');
  style.textContent=`.calendarbar{display:flex;align-items:center;justify-content:space-between;margin:18px 0 10px}.calendarbar h2{margin:0;font-size:17px}.calnav{display:flex;gap:7px}.day.empty{background:#fcfdff}.day.current-week{background:#f4f7ff;box-shadow:inset 0 2px #b8cbef,inset 0 -2px #b8cbef}.delete{margin-left:auto;border:0;background:transparent;color:inherit;padding:0 2px;font-size:16px;line-height:1}.event.admin-event{cursor:pointer}.event.absence{background:#fff0dc;color:#995e0e}.ops{grid-template-columns:repeat(3,1fr);align-items:stretch}.ops .card{height:282px;overflow:hidden}.ops #audit{height:215px;overflow-y:auto;padding-right:7px}.ops #audit::-webkit-scrollbar{width:6px}.ops #audit::-webkit-scrollbar-thumb{background:#d5dceb;border-radius:8px}.office-actions{display:flex;gap:7px;flex-wrap:wrap;margin-top:10px}.office-actions button{font-size:11px;padding:6px 8px}.office-actions .ack{background:#3268e9;color:#fff;border-color:#3268e9}.office-actions .decline{color:#a13b3b}table{border-collapse:collapse;width:100%;margin-top:12px}th,td{text-align:left;border-bottom:1px solid #e7ecf4;padding:9px;font-size:13px}`;
  document.head.append(style);
  $('#notice').remove();
  const bar=document.createElement('section');
  bar.className='calendarbar';
  bar.innerHTML='<h2 id="monthTitle"></h2><div class="calnav"><button id="prevMonth" aria-label="Предыдущий месяц">‹</button><button id="today">Сегодня</button><button id="nextMonth" aria-label="Следующий месяц">›</button></div>';
  $('#calendar').before(bar);
  $('#prevMonth').onclick=()=>{viewDate.setMonth(viewDate.getMonth()-1);render()};
  $('#nextMonth').onclick=()=>{viewDate.setMonth(viewDate.getMonth()+1);render()};
  $('#today').onclick=()=>{viewDate=new Date();viewDate.setDate(1);render()};
}

function render(){
  addCalendarToolbar();
  const title=monthName.format(viewDate);
  $('#monthTitle').textContent=title[0].toUpperCase()+title.slice(1);
  const now=new Date();now.setHours(0,0,0,0);
  const weekStart=new Date(now);weekStart.setDate(now.getDate()-((now.getDay()+6)%7));
  const weekEnd=new Date(weekStart);weekEnd.setDate(weekStart.getDate()+6);
  const weekStartKey=dateKey(weekStart),weekEndKey=dateKey(weekEnd);
  const isCurrentMonth=viewDate.getFullYear()===now.getFullYear()&&viewDate.getMonth()===now.getMonth();
  const weekDuties=state.duties.filter(duty=>duty.starts_on<=weekEndKey&&duty.ends_on>=dateKey(now));
  const office=weekDuties.find(duty=>duty.kind==='office');
  const support=weekDuties.find(duty=>duty.kind==='support'||duty.kind==='holiday');
  const daysOfWeek=['ПН','ВТ','СР','ЧТ','ПТ','СБ','ВС'];
  const year=viewDate.getFullYear(),month=viewDate.getMonth(),daysInMonth=new Date(year,month+1,0).getDate();
  const offset=(new Date(year,month,1).getDay()+6)%7,prefix=`${year}-${pad(month+1)}`;
  let html=daysOfWeek.map(day=>`<div class="dow">${day}</div>`).join('');
  for(let cell=0;cell<offset;cell++)html+='<div class="day empty"></div>';
  for(let day=1;day<=daysInMonth;day++){
    const date=`${prefix}-${pad(day)}`,list=state.duties.filter(duty=>duty.starts_on===date),absenceList=state.absences.filter(absence=>absence.occurred_on===date);
    const current=isCurrentMonth&&date>=weekStartKey&&date<=weekEndKey?' current-week':'';
    html+=`<div class="day${current}"><span class="date">${day}</span>${list.map(duty=>`<div class="event ${duty.kind} ${state.permissions.canEdit?'admin-event':''}">${ava(duty)}${esc(duty.name)}<b>${duty.kind==='office'?'офис':`${duty.hours} ч`}</b>${state.permissions.canEdit?`<button class="delete" title="Удалить" data-id="${duty.id}">×</button>`:''}</div>`).join('')}${absenceList.map(absence=>`<div class="event absence" title="${esc(absence.note||'Отсутствие')}"><span class="ava">${initials(absence.name||'?')}</span>${esc(absence.name)}<b>${esc(({vacation:'отпуск',sick_leave:'больничный',time_off:'отгул',business_trip:'командировка',personal:'отсутствие',other:'другое'})[absence.absence_type]||'отсутствие')} · ${absence.hours} ч</b></div>`).join('')}</div>`;
  }
  $('#calendar').innerHTML=html;
  document.querySelectorAll('.delete').forEach(button=>button.onclick=async event=>{event.stopPropagation();if(!confirm('Удалить это дежурство?'))return;const response=await api(`/api/duties/${button.dataset.id}/delete`,{method:'POST'}),data=await response.json();if(!response.ok)return toast(data.error);state=data;toast('Дежурство удалено');render()});
  const me=state.balances.find(item=>item.id===state.currentEmployeeId)||state.balances[0];
  $('#balance').innerHTML=`${me?me.hours:'0'} ч <span class="sub">к отработке</span>`;
  $('#balance').parentElement.querySelector(':scope > .sub').textContent='Отрицательное число — часы, которые нужно отдежурить.';
  const nextOffice=state.duties.find(item=>item.kind==='office'&&item.ends_on>=dateKey(now));
  const nextSupport=state.duties.find(item=>(item.kind==='support'||item.kind==='holiday')&&item.ends_on>=dateKey(now));
  const shownOffice=office||nextOffice;
  $('#office').innerHTML=person(shownOffice);
  if(shownOffice?.kind==='office'){
    const mine=shownOffice.employee_id===state.currentEmployeeId, admin=state.permissions.canEdit;
    const labels={scheduled:'Ожидается подтверждение сотрудника',acknowledged:'Сотрудник подтвердил готовность',declined:'Сотрудник не может дежурить',completed:'Выполнено'};
    let actions=`<div class="sub" style="margin-top:7px">${labels[shownOffice.office_status]||labels.scheduled}</div>`;
    if(mine&&shownOffice.office_status==='scheduled')actions+=`<div class="office-actions"><button class="ack" data-office-action="acknowledge">Подтверждаю</button><button class="decline" data-office-action="decline">Не могу</button></div>`;
    if(admin&&shownOffice.office_status==='acknowledged')actions+=`<div class="office-actions"><button class="ack" data-office-action="complete">Подтвердить выполнение</button></div>`;
    $('#office').insertAdjacentHTML('beforeend',actions);
    document.querySelectorAll('[data-office-action]').forEach(button=>button.onclick=async()=>{const action=button.dataset.officeAction,note=action==='decline'?prompt('Коротко укажите причину (необязательно):')||'':'';const response=await api(`/api/duties/${shownOffice.id}/office/${action}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({note})}),data=await response.json();if(!response.ok)return toast(data.error);state=data;toast(action==='acknowledge'?'Готовность подтверждена':action==='decline'?'Администратор увидит отказ':'Выполнение подтверждено');render()});
  }
  $('#support').innerHTML=person(support||nextSupport);
  renderOfficeChecklist(shownOffice);
  $('#audit').innerHTML=state.audit.length?state.audit.map(item=>{const author={name:item.actor_name||item.actor||'Система',avatar:item.actor_avatar||''};return `<div class="audit-entry">${ava(author)}<div><strong>${esc(item.action)}</strong><span class="audit-author">Автор: ${esc(author.name)}</span><span class="audit-detail">${esc(item.detail)}</span><small>${esc(item.occurred_at)}</small></div></div>`}).join(''):'Пока нет изменений';
  const admin=state.permissions.canEdit;$('#mode').textContent=admin?'Администратор портала':'Режим просмотра';
  document.querySelectorAll('.admin').forEach(item=>item.style.display=admin?'inline-block':'none');
  const employeeOptions=state.employees.map(item=>`<option value="${item.id}">${esc(item.name)}</option>`).join('');
  $('#employee').innerHTML=employeeOptions;
  $('#absenceEmployee').innerHTML=employeeOptions;
  const showEmployeePreview=(selectId,previewId)=>{const employee=state.employees.find(item=>String(item.id)===String($(selectId).value));$(previewId).innerHTML=employee?`${ava(employee)}<span>Выбран: ${esc(employee.name)}</span>`:''};
  $('#employee').onchange=()=>showEmployeePreview('#employee','#dutyEmployeePreview');
  $('#absenceEmployee').onchange=()=>showEmployeePreview('#absenceEmployee','#absenceEmployeePreview');
  showEmployeePreview('#employee','#dutyEmployeePreview');
  showEmployeePreview('#absenceEmployee','#absenceEmployeePreview');
}

function toast(text){$('#toast').textContent=text;$('#toast').classList.add('on');setTimeout(()=>$('#toast').classList.remove('on'),2600)}
let addMode='duty';
function setAddMode(mode){
  addMode=mode;
  const duty=mode==='duty', dutyPanel=$('#dutyFields'), absencePanel=$('#absenceFields');
  dutyPanel.hidden=!duty; absencePanel.hidden=duty;
  dutyPanel.querySelectorAll('input,select,textarea').forEach(control=>control.disabled=!duty);
  absencePanel.querySelectorAll('input,select,textarea').forEach(control=>control.disabled=duty);
  dutyPanel.querySelector('[name=starts_on]').required=duty;
  dutyPanel.querySelector('[name=ends_on]').required=duty;
  absencePanel.querySelector('[name=occurred_on]').required=!duty;
  absencePanel.querySelector('[name=hours]').required=!duty;
  document.querySelectorAll('[data-add-mode]').forEach(button=>button.classList.toggle('on',button.dataset.addMode===mode));
  $('#addTitle').textContent=duty?'Добавить дежурство':'Добавить отсутствие';
  $('#addIntro').textContent=duty?'Назначьте сотрудника в график. Режим «Списать долг» применяется после подтверждения выполнения.':'Зафиксируйте отсутствие: при включённом учёте часы попадут в долг по дежурствам.';
  $('#addSubmit').textContent=duty?'Добавить дежурство':'Сохранить отсутствие';
}
$('#newDuty').onclick=()=>{const value=dateKey(viewDate);$('#dutyFields [name=starts_on]').value=value;$('#dutyFields [name=ends_on]').value=value;$('#absenceFields [name=occurred_on]').value=value;setAddMode('duty');$('#modal').classList.add('open')};
$('#close').onclick=()=>$('#modal').classList.remove('open');
document.querySelectorAll('[data-add-mode]').forEach(button=>button.onclick=()=>setAddMode(button.dataset.addMode));
$('#absenceFields [name=absence_type]').onchange=event=>{$('#absenceFields [name=compensable]').checked=!['vacation','sick_leave','business_trip'].includes(event.target.value)};
$('#form').onsubmit=async event=>{event.preventDefault();const value=Object.fromEntries(new FormData(event.target));const path=addMode==='duty'?'/api/duties':'/api/absences';const response=await api(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)}),data=await response.json();if(!response.ok)return toast(data.error);state=data;$('#modal').classList.remove('open');toast(addMode==='duty'?'Дежурство добавлено':'Отсутствие зафиксировано');render()};
setAddMode('duty');
document.querySelectorAll('.check i').forEach(item=>item.onclick=()=>item.classList.toggle('ok'));
function start(){if(!window.BX24)return load();BX24.init(async()=>{const auth=BX24.getAuth();if(auth?.access_token){b24Headers={'x-b24-token':auth.access_token,'x-b24-domain':auth.domain};await api('/api/bitrix/sync',{method:'POST'})}load()})}
start();
