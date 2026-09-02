let state;
let b24Headers={};
let viewDate=new Date();
viewDate.setDate(1);
let calendarEmployeeFilter='';

const $=selector=>document.querySelector(selector);
// До получения ответа Bitrix24 запрещаем открывать форму добавления: права ещё не подтверждены.
$('#newDuty').style.display='none';
const esc=value=>String(value||'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const pad=value=>String(value).padStart(2,'0');
const dateKey=date=>`${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`;
const monthName=new Intl.DateTimeFormat('ru-RU',{month:'long',year:'numeric'});

async function api(path,options={}){return fetch(path,{...options,headers:{...b24Headers,...(options.headers||{})}})}
async function load(){state=await api('/api/bootstrap').then(response=>response.json());render()}
function initials(name){return name.split(' ').map(part=>part[0]).join('').slice(0,2)}
function ava(employee){return employee?.avatar?`<img class="ava" src="${esc(employee.avatar)}" alt="">`:`<span class="ava">${initials(employee?.name||'?')}</span>`}
function shortName(name){return String(name||'Сотрудник').trim().split(/\s+/)[0]}
function calendarDutyHours(duty){return duty.kind==='office'?0:Math.min(Number(duty.hours||0),duty.starts_on===duty.ends_on?2:4)}
function groupExact(items,key){
  const groups=new Map();
  items.forEach(item=>{const value=key(item),group=groups.get(value);if(group)group._ids.push(item.id);else groups.set(value,{...item,_ids:[item.id]})});
  return [...groups.values()].map(item=>({...item,_count:item._ids.length}));
}
function friendlyPeriod(start,end){
  const months=['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
  const parse=value=>{const [year,month,day]=String(value||'').split('-').map(Number);return {year,month,day}};
  const from=parse(start),to=parse(end||start);
  if(!from.year||!from.month||!from.day)return `${start||''}${end&&end!==start?`–${end}`:''}`;
  if(from.year===to.year&&from.month===to.month&&from.day===to.day)return `${from.day} ${months[from.month-1]}`;
  if(from.year===to.year&&from.month===to.month)return `${from.day}–${to.day} ${months[from.month-1]}`;
  if(from.year===to.year)return `${from.day} ${months[from.month-1]} – ${to.day} ${months[to.month-1]}`;
  return `${from.day} ${months[from.month-1]} ${from.year} – ${to.day} ${months[to.month-1]} ${to.year}`;
}
function friendlyDateTime(value){
  const match=String(value||'').match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))/);
  return match?`${friendlyPeriod(match[1],match[1])}, ${match[2]}`:friendlyPeriod(value,value);
}
function friendlyTextDates(value){
  return String(value||'').replace(/(\d{4}-\d{2}-\d{2})\s*[–—]\s*(\d{4}-\d{2}-\d{2})/g,(_,start,end)=>friendlyPeriod(start,end)).replace(/\d{4}-\d{2}-\d{2}/g,date=>friendlyPeriod(date,date));
}
function person(duty){return duty?`<div class="person">${ava(duty)}<div><b>${esc(duty.name)}</b><br><span class="sub">${friendlyPeriod(duty.starts_on,duty.ends_on)}</span></div><span class="right">${duty.hours?`${duty.hours} ч`:'офис'}</span></div>`:'<span class="sub">Не назначен</span>'}
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
  style.textContent=`.layout{width:100%;max-width:100%;grid-template-columns:220px minmax(0,1fr)!important;overflow-x:hidden}.main{min-width:0;max-width:100%!important}.grid{min-width:0;grid-template-columns:repeat(7,minmax(0,1fr))!important}.day,.dow{min-width:0}.day{position:relative}.day-events{display:grid;gap:3px;margin-top:5px}.event{min-width:0;min-height:25px;margin-top:0!important;position:relative;padding:3px 22px 3px 4px!important;gap:4px!important;border-radius:7px!important}.event .ava{width:18px;height:18px;font-size:7px}.event-name{min-width:0;overflow:hidden;text-overflow:ellipsis;font-weight:650}.event-kind{flex:none;font-size:9px;opacity:.82}.event-count{flex:none;display:grid;place-items:center;min-width:17px;height:17px;padding:0 4px;border-radius:99px;background:#ffffffb8;font-size:9px;font-weight:800}.event .delete{position:absolute;right:3px;top:50%;transform:translateY(-50%);margin:0;background:transparent;z-index:2}.day-events>.event:nth-child(n+4){display:none}.day.expanded{z-index:20}.day.expanded .day-events{position:absolute;left:5px;right:5px;top:25px;padding:6px;background:#fff;border:1px solid #dce5f2;border-radius:10px;box-shadow:0 12px 30px #263a6528;z-index:5}.day.current-week.expanded .day-events{background:#f8faff}.day.expanded .day-events>.event{display:flex}.more-events{width:100%;padding:3px 7px!important;border:0!important;background:#edf2fa!important;color:#536783!important;font-size:10px!important;text-align:left}.calendarbar{display:flex;align-items:center;justify-content:space-between;margin:18px 0 10px}.calendarbar h2{margin:0;font-size:17px}.calendar-actions,.calnav{display:flex;align-items:center;gap:7px}.calendar-filter{height:38px;max-width:250px;border:1px solid #dce5f2;border-radius:10px;background:#fff;color:#40516d;padding:0 34px 0 12px;font:600 13px/1 system-ui;cursor:pointer}.calendar-filter:focus{outline:0;border-color:#75a0ef;box-shadow:0 0 0 3px #3268e918}.day.empty{background:#fcfdff}.day.current-week{background:#f4f7ff;box-shadow:inset 0 2px #b8cbef,inset 0 -2px #b8cbef}.delete{margin-left:auto;border:0;background:transparent;color:inherit;padding:0 2px;font-size:16px;line-height:1}.event.admin-event{cursor:pointer}.event.absence{background:#fff0dc;color:#995e0e}.ops{display:none!important}.office-actions{display:flex;gap:7px;flex-wrap:wrap;margin-top:10px}.office-actions button{font-size:11px;padding:6px 8px}.office-actions .ack{background:#3268e9;color:#fff;border-color:#3268e9}.office-actions .decline{color:#a13b3b}table{border-collapse:collapse;width:100%;margin-top:12px}th,td{text-align:left;border-bottom:1px solid #e7ecf4;padding:9px;font-size:13px}@media(max-width:1100px){.main{padding-left:22px!important;padding-right:22px!important}.event{padding-left:3px!important;padding-right:20px!important}.event-kind{display:none}}@media(max-width:720px){.layout{grid-template-columns:1fr!important}.calendarbar{align-items:flex-start;gap:10px}.calendar-actions{flex-wrap:wrap;justify-content:flex-end}.calendar-filter{max-width:180px}}`;
  document.head.append(style);
  const modalStyle=document.createElement('style');modalStyle.textContent='.modalback{z-index:1000!important}.modal{position:relative;z-index:1001;max-height:calc(100vh - 40px);overflow-y:auto}';document.head.append(modalStyle);
  $('#notice').remove();
  const bar=document.createElement('section');
  bar.className='calendarbar';
  bar.innerHTML='<h2 id="monthTitle"></h2><div class="calendar-actions"><select id="calendarEmployeeFilter" class="calendar-filter" aria-label="Фильтр по сотруднику"></select><div class="calnav"><button id="prevMonth" aria-label="Предыдущий месяц">‹</button><button id="today">Сегодня</button><button id="nextMonth" aria-label="Следующий месяц">›</button></div></div>';
  $('#calendar').before(bar);
  $('#prevMonth').onclick=()=>{viewDate.setMonth(viewDate.getMonth()-1);render()};
  $('#nextMonth').onclick=()=>{viewDate.setMonth(viewDate.getMonth()+1);render()};
  $('#today').onclick=()=>{viewDate=new Date();viewDate.setDate(1);render()};
  $('#calendarEmployeeFilter').onchange=event=>{calendarEmployeeFilter=event.target.value;render()};
}

function render(){
  addCalendarToolbar();
  const title=monthName.format(viewDate);
  $('#monthTitle').textContent=title[0].toUpperCase()+title.slice(1);
  const filter=$('#calendarEmployeeFilter');
  const people=[...state.employees,...state.absences.map(item=>({id:item.employee_id,name:item.name}))].filter((item,index,list)=>list.findIndex(other=>String(other.id)===String(item.id))===index).sort((a,b)=>a.name.localeCompare(b.name,'ru'));
  filter.innerHTML=`<option value="">Все сотрудники</option>${people.map(item=>`<option value="${item.id}">${esc(item.name)}</option>`).join('')}`;
  filter.value=calendarEmployeeFilter;
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
    const date=`${prefix}-${pad(day)}`,list=groupExact(state.duties.filter(duty=>duty.starts_on===date&&(!calendarEmployeeFilter||String(duty.employee_id)===calendarEmployeeFilter)),duty=>`${duty.employee_id}|${duty.kind}|${duty.starts_on}|${duty.ends_on}|${duty.hours}`),absenceList=groupExact(state.absences.filter(absence=>absence.occurred_on===date&&(!calendarEmployeeFilter||String(absence.employee_id)===calendarEmployeeFilter)),absence=>`${absence.employee_id}|${absence.absence_type}|${absence.occurred_on}|${absence.hours}|${absence.note||''}`);
    const current=isCurrentMonth&&date>=weekStartKey&&date<=weekEndKey?' current-week':'';
    const absenceLabels={vacation:'отпуск',sick_leave:'больничный',time_off:'отгул',business_trip:'командировка',personal:'отсутствие',unpaid_leave:'без содержания',other:'другое'};
    const events=[...list.map(duty=>`<div class="event ${duty.kind} ${state.permissions.canEdit?'admin-event':''}" title="${esc(duty.name)} · ${duty.kind==='office'?'офисное дежурство':`поддержка, ${calendarDutyHours(duty)} ч за ${duty.starts_on===duty.ends_on?'день':'выходные'}`}">${ava(duty)}<span class="event-name">${esc(shortName(duty.name))}</span><b class="event-kind">${duty.kind==='office'?'офис':`${calendarDutyHours(duty)} ч`}</b>${duty._count>1?`<span class="event-count" title="${duty._count} одинаковые записи">×${duty._count}</span>`:''}${state.permissions.canEdit?`<button class="delete" title="Удалить${duty._count>1?' одинаковые записи':''}" data-duty-ids="${duty._ids.join(',')}">×</button>`:''}</div>`),...absenceList.map(absence=>`<div class="event absence ${state.permissions.canEdit?'admin-event':''}" ${state.permissions.canEdit?`data-edit-absence="${absence.id}"`:''} title="${esc(absence.name)} · ${esc(absenceLabels[absence.absence_type]||'отсутствие')} · ${absence.hours} ч${absence.note?` · ${esc(absence.note)}`:''}">${ava(absence)}<span class="event-name">${esc(shortName(absence.name))}</span><b class="event-kind">${esc(absenceLabels[absence.absence_type]||'отсутствие')} · ${absence.hours} ч</b>${absence._count>1?`<span class="event-count" title="${absence._count} одинаковые записи">×${absence._count}</span>`:''}${state.permissions.canEdit?`<button class="delete" title="Удалить отсутствие${absence._count>1?' и его дубли':''}" data-absence-ids="${absence._ids.join(',')}">×</button>`:''}</div>`)].join('');
    const total=list.length+absenceList.length;
    html+=`<div class="day${current}"><span class="date">${day}</span><div class="day-events">${events}${total>3?`<button type="button" class="more-events" data-more-events>Ещё ${total-3} ${total-3===1?'событие':'события'} ↓</button>`:''}</div></div>`;
  }
  $('#calendar').innerHTML=html;
  document.querySelectorAll('[data-more-events]').forEach(button=>button.onclick=event=>{event.stopPropagation();const day=button.closest('.day'),expanded=day.classList.toggle('expanded');button.textContent=expanded?'Свернуть ↑':`Ещё ${day.querySelectorAll('.event').length-3} события ↓`});
  document.querySelectorAll('[data-duty-ids]').forEach(button=>button.onclick=async event=>{event.stopPropagation();const ids=button.dataset.dutyIds.split(',');if(!confirm(ids.length>1?`Удалить ${ids.length} одинаковые записи дежурства?`:'Удалить это дежурство?'))return;for(const id of ids){const response=await api(`/api/duties/${id}/delete`,{method:'POST'}),data=await response.json();if(!response.ok)return toast(data.error);state=data}toast(ids.length>1?'Дубли дежурства удалены':'Дежурство удалено');render()});
  document.querySelectorAll('[data-absence-ids]').forEach(button=>button.onclick=async event=>{event.stopPropagation();const ids=button.dataset.absenceIds.split(',');if(!confirm(ids.length>1?`Удалить ${ids.length} одинаковые записи об отсутствии? Баланс будет пересчитан.`:'Удалить запись об отсутствии? Баланс сотрудника будет пересчитан.'))return;for(const id of ids){const response=await api(`/api/absences/${id}/delete`,{method:'POST'}),data=await response.json();if(!response.ok)return toast(data.error);state=data}toast(ids.length>1?'Дубли отсутствия удалены':'Отсутствие удалено');render()});
  document.querySelectorAll('[data-edit-absence]').forEach(event=>event.onclick=()=>openAbsenceEditor(Number(event.dataset.editAbsence)));
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
  $('#audit').innerHTML=state.audit.length?state.audit.map(item=>{const author={name:item.actor_name||item.actor||'Система',avatar:item.actor_avatar||''};return `<div class="audit-entry">${ava(author)}<div><strong>${esc(item.action)}</strong><span class="audit-author">Автор: ${esc(author.name)}</span><span class="audit-detail">${esc(friendlyTextDates(item.detail))}</span><small>${esc(friendlyDateTime(item.occurred_at))}</small></div></div>`}).join(''):'Пока нет изменений';
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
let editingAbsenceId=null;
function setAddMode(mode){
  addMode=mode;
  const duty=mode==='duty', dutyPanel=$('#dutyFields'), absencePanel=$('#absenceFields');
  dutyPanel.hidden=!duty; absencePanel.hidden=duty;
  dutyPanel.querySelectorAll('input,select,textarea').forEach(control=>control.disabled=!duty);
  absencePanel.querySelectorAll('input,select,textarea').forEach(control=>control.disabled=duty);
  dutyPanel.querySelector('[name=starts_on]').required=duty;
  dutyPanel.querySelector('[name=ends_on]').required=duty;
  absencePanel.querySelector('[name=occurred_on]').required=!duty;
  absencePanel.querySelector('[name=ends_on]').required=!duty;
  absencePanel.querySelector('[name=hours]').required=!duty;
  document.querySelectorAll('[data-add-mode]').forEach(button=>button.classList.toggle('on',button.dataset.addMode===mode));
  $('#addTitle').textContent=duty?'Добавить дежурство':'Добавить отсутствие';
  $('#addIntro').textContent=duty?'Назначьте сотрудника в график. Режим «Списать долг» применяется после подтверждения выполнения.':'Зафиксируйте отсутствие: при включённом учёте часы попадут в долг по дежурствам.';
  $('#addSubmit').textContent=duty?'Добавить дежурство':'Сохранить отсутствие';
}
function addAbsencePeriodField(){
  const start=$('#absenceFields [name=occurred_on]'),field=start.closest('.field');
  field.querySelector('label').textContent='Начало отсутствия';
  $('#absenceFields [name=hours]').closest('.field').querySelector('label').textContent='Часов отсутствия в день';
  const endField=document.createElement('div');endField.className='field';
  endField.innerHTML='<label>Окончание отсутствия</label><input type="date" name="ends_on" disabled>';
  field.after(endField);
  start.addEventListener('change',()=>{const end=endField.querySelector('input');if(!end.value||end.value<start.value)end.value=start.value});
}
addAbsencePeriodField();
function openAbsenceEditor(id){
  const absence=state.absences.find(item=>Number(item.id)===Number(id));if(!absence)return;
  editingAbsenceId=absence.id;setAddMode('absence');
  $('#absenceEmployee').value=absence.employee_id;
  $('#absenceFields [name=absence_type]').value=absence.absence_type||'personal';
  $('#absenceFields [name=occurred_on]').value=absence.occurred_on;
  $('#absenceFields [name=ends_on]').value=absence.occurred_on;
  $('#absenceFields [name=ends_on]').disabled=true;
  $('#absenceFields [name=hours]').value=absence.hours;
  $('#absenceFields [name=note]').value=absence.note||'';
  $('#absenceFields [name=compensable]').checked=Boolean(absence.compensable);
  $('#absenceEmployee').dispatchEvent(new Event('change'));
  $('#addTitle').textContent='Редактировать отсутствие';
  $('#addIntro').textContent='Изменения применятся к выбранному рабочему дню и сразу пересчитают баланс сотрудника.';
  $('#addSubmit').textContent='Сохранить изменения';
  $('#modal').classList.add('open');
}
$('#newDuty').onclick=()=>{editingAbsenceId=null;const value=dateKey(viewDate);$('#dutyFields [name=starts_on]').value=value;$('#dutyFields [name=ends_on]').value=value;$('#absenceFields [name=occurred_on]').value=value;$('#absenceFields [name=ends_on]').value=value;setAddMode('duty');$('#modal').classList.add('open')};
$('#close').onclick=()=>$('#modal').classList.remove('open');
document.querySelectorAll('[data-add-mode]').forEach(button=>button.onclick=()=>{editingAbsenceId=null;setAddMode(button.dataset.addMode)});
$('#absenceFields [name=absence_type]').onchange=event=>{const reportOnly=['vacation','sick_leave','business_trip','unpaid_leave'].includes(event.target.value);$('#absenceFields [name=compensable]').checked=!reportOnly;if(reportOnly)$('#absenceFields [name=hours]').value=8};
$('#form').onsubmit=async event=>{event.preventDefault();const value=Object.fromEntries(new FormData(event.target));if(addMode==='absence'&&!editingAbsenceId&&value.ends_on<value.occurred_on)return toast('Дата окончания не может быть раньше даты начала');const editing=addMode==='absence'&&editingAbsenceId,path=editing?`/api/absences/${editingAbsenceId}`:addMode==='duty'?'/api/duties':'/api/absences',method=editing?'PATCH':'POST';const response=await api(path,{method,headers:{'content-type':'application/json'},body:JSON.stringify(value)}),data=await response.json();if(!response.ok)return toast(data.error);state=data;$('#modal').classList.remove('open');toast(data.syncWarning|| (editing?'Отсутствие изменено':addMode==='duty'?'Дежурство добавлено':value.ends_on!==value.occurred_on?'Период отсутствия добавлен в приложение и Битрикс24':'Отсутствие добавлено в приложение и Битрикс24'));editingAbsenceId=null;render()};
setAddMode('duty');
document.querySelectorAll('.check i').forEach(item=>item.onclick=()=>item.classList.toggle('ok'));
function start(){if(!window.BX24)return load();BX24.init(async()=>{const auth=BX24.getAuth();if(auth?.access_token){b24Headers={'x-b24-token':auth.access_token,'x-b24-domain':auth.domain};await api('/api/bitrix/sync',{method:'POST'})}load()})}
start();
