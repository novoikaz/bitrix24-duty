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

function addCalendarToolbar(){
  if($('#monthTitle'))return;
  const style=document.createElement('style');
  style.textContent=`.calendarbar{display:flex;align-items:center;justify-content:space-between;margin:18px 0 10px}.calendarbar h2{margin:0;font-size:17px}.calnav{display:flex;gap:7px}.day.empty{background:#fcfdff}.day.current-week{background:#f4f7ff;box-shadow:inset 0 2px #b8cbef,inset 0 -2px #b8cbef}.delete{margin-left:auto;border:0;background:transparent;color:inherit;padding:0 2px;font-size:16px;line-height:1}.event.admin-event{cursor:pointer}.ops{align-items:stretch}.ops .card{height:282px;overflow:hidden}.ops #audit{height:215px;overflow-y:auto;padding-right:7px}.ops #audit::-webkit-scrollbar{width:6px}.ops #audit::-webkit-scrollbar-thumb{background:#d5dceb;border-radius:8px}table{border-collapse:collapse;width:100%;margin-top:12px}th,td{text-align:left;border-bottom:1px solid #e7ecf4;padding:9px;font-size:13px}`;
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
  const weekDuties=state.duties.filter(duty=>duty.starts_on<=weekEndKey&&duty.ends_on>=weekStartKey);
  const office=weekDuties.find(duty=>duty.kind==='office');
  const support=weekDuties.find(duty=>duty.kind==='support'||duty.kind==='holiday');
  const daysOfWeek=['ПН','ВТ','СР','ЧТ','ПТ','СБ','ВС'];
  const year=viewDate.getFullYear(),month=viewDate.getMonth(),daysInMonth=new Date(year,month+1,0).getDate();
  const offset=(new Date(year,month,1).getDay()+6)%7,prefix=`${year}-${pad(month+1)}`;
  let html=daysOfWeek.map(day=>`<div class="dow">${day}</div>`).join('');
  for(let cell=0;cell<offset;cell++)html+='<div class="day empty"></div>';
  for(let day=1;day<=daysInMonth;day++){
    const date=`${prefix}-${pad(day)}`,list=state.duties.filter(duty=>duty.starts_on===date);
    const current=isCurrentMonth&&date>=weekStartKey&&date<=weekEndKey?' current-week':'';
    html+=`<div class="day${current}"><span class="date">${day}</span>${list.map(duty=>`<div class="event ${duty.kind} ${state.permissions.canEdit?'admin-event':''}">${ava(duty)}${esc(duty.name)}<b>${duty.kind==='office'?'офис':`${duty.hours} ч`}</b>${state.permissions.canEdit?`<button class="delete" title="Удалить" data-id="${duty.id}">×</button>`:''}</div>`).join('')}</div>`;
  }
  $('#calendar').innerHTML=html;
  document.querySelectorAll('.delete').forEach(button=>button.onclick=async event=>{event.stopPropagation();if(!confirm('Удалить это дежурство?'))return;const response=await api(`/api/duties/${button.dataset.id}/delete`,{method:'POST'}),data=await response.json();if(!response.ok)return toast(data.error);state=data;toast('Дежурство удалено');render()});
  const me=state.balances.find(item=>item.id===state.currentEmployeeId)||state.balances[0];
  $('#balance').innerHTML=`${me?me.hours:'0'} ч <span class="sub">к компенсации</span>`;
  $('#office').innerHTML=person(office||state.duties.find(item=>item.kind==='office'));
  $('#support').innerHTML=person(support||state.duties.find(item=>item.kind==='support'||item.kind==='holiday'));
  $('#audit').innerHTML=state.audit.length?state.audit.map(item=>`<div class="line"><strong>${esc(item.action)}</strong>${esc(item.detail)}<br>${item.occurred_at}</div>`).join(''):'Пока нет изменений';
  const admin=state.permissions.canEdit;$('#mode').textContent=admin?'Администратор портала':'Режим просмотра';
  document.querySelectorAll('.admin').forEach(item=>item.style.display=admin?'inline-block':'none');
  $('#employee').innerHTML=state.employees.map(item=>`<option value="${item.id}">${esc(item.name)}</option>`).join('');
}

function toast(text){$('#toast').textContent=text;$('#toast').classList.add('on');setTimeout(()=>$('#toast').classList.remove('on'),2600)}
$('#newDuty').onclick=()=>{$('[name=starts_on]').value=dateKey(viewDate);$('[name=ends_on]').value=dateKey(viewDate);$('#modal').classList.add('open')};
$('#close').onclick=()=>$('#modal').classList.remove('open');
$('#form').onsubmit=async event=>{event.preventDefault();const value=Object.fromEntries(new FormData(event.target));const response=await api('/api/duties',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)}),data=await response.json();if(!response.ok)return toast(data.error);state=data;$('#modal').classList.remove('open');toast('Дежурство назначено');render()};
document.querySelectorAll('.check i').forEach(item=>item.onclick=()=>item.classList.toggle('ok'));
function start(){if(!window.BX24)return load();BX24.init(async()=>{const auth=BX24.getAuth();if(auth?.access_token){b24Headers={'x-b24-token':auth.access_token,'x-b24-domain':auth.domain};await api('/api/bitrix/sync',{method:'POST'})}load()})}
start();
