(function () {
  'use strict';

  const LIST_CODE = 'duty_roster_data_v2';
  const LIST_TYPE = 'lists';
  const LEGACY_ABSENCE_LIST_ID = 128;
  const FIELD_DEFS = [
    ['record_type', 'Тип записи', 'S'],
    ['employee_id', 'Сотрудник ID', 'N'],
    ['target_employee_id', 'Второй сотрудник ID', 'N'],
    ['start_date', 'Дата начала', 'S'],
    ['end_date', 'Дата окончания', 'S'],
    ['hours', 'Часы', 'N'],
    ['status', 'Статус', 'S'],
    ['kind', 'Вид', 'S'],
    ['mode', 'Режим учёта', 'S'],
    ['compensable', 'Учитывать в балансе', 'N'],
    ['reference_id', 'Связанная запись ID', 'N'],
    ['office_status', 'Статус офиса', 'S'],
    ['note', 'Комментарий', 'S'],
    ['extra', 'Служебные данные', 'S']
  ];

  let listId = 0;
  let fields = {};
  let currentUser = null;
  let currentIsAdmin = false;
  let cachedUsers = [];
  let cachedRecords = [];

  const asArray = value => Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value) : value == null ? [] : [value];
  const unwrap = value => {
    if (value == null) return '';
    if (Array.isArray(value)) return unwrap(value[0]);
    if (typeof value === 'object') {
      if ('TEXT' in value) return value.TEXT;
      const first = Object.values(value)[0];
      return unwrap(first);
    }
    return value;
  };
  const number = value => Number(unwrap(value) || 0);
  const text = value => String(unwrap(value) || '');
  const bool = value => ['1', 'true', 'Y', 'on'].includes(String(value));
  const pad = value => String(value).padStart(2, '0');
  const today = () => {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Almaty', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const values = Object.fromEntries(parts.filter(item => item.type !== 'literal').map(item => [item.type, item.value]));
    return `${values.year}-${values.month}-${values.day}`;
  };
  const actorName = () => `${currentUser?.NAME || ''} ${currentUser?.LAST_NAME || ''}`.trim() || 'Сотрудник';
  const employeeName = id => cachedUsers.find(item => Number(item.id) === Number(id))?.name || 'Сотрудник';
  const parseBody = options => {
    if (!options?.body) return {};
    if (typeof options.body === 'string') return JSON.parse(options.body || '{}');
    return options.body;
  };
  const httpError = (message, status = 400) => Object.assign(new Error(message), { status });

  function call(method, params = {}) {
    return new Promise((resolve, reject) => {
      BX24.callMethod(method, params, result => {
        if (result.error()) reject(new Error(result.error_description() || result.error()));
        else resolve(result.data());
      });
    });
  }

  function callAll(method, params = {}) {
    return new Promise((resolve, reject) => {
      const rows = [];
      const receive = result => {
        if (result.error()) return reject(new Error(result.error_description() || result.error()));
        rows.push(...asArray(result.data()));
        if (result.more()) result.next(receive);
        else resolve(rows);
      };
      BX24.callMethod(method, params, receive);
    });
  }

  async function discoverSchema() {
    const lists = await callAll('lists.get', { IBLOCK_TYPE_ID: LIST_TYPE, IBLOCK_CODE: LIST_CODE });
    const list = lists.find(item => String(item.CODE || item.IBLOCK_CODE || '') === LIST_CODE) || lists[0];
    if (!list) throw new Error('Хранилище приложения не установлено. Переустановите локальное приложение от имени администратора.');
    listId = Number(list.ID || list.IBLOCK_ID || 0);
    const rows = await call('lists.field.get', { IBLOCK_TYPE_ID: LIST_TYPE, IBLOCK_ID: listId });
    const listFields = asArray(rows);
    fields = {};
    for (const [key, name] of FIELD_DEFS) {
      const field = listFields.find(item => item.NAME === name);
      if (field) fields[key] = String(field.ID).replace(/^PROPERTY_/, '');
    }
    const missing = FIELD_DEFS.filter(([key]) => !fields[key]);
    if (missing.length) throw new Error(`В хранилище не хватает полей: ${missing.map(([, name]) => name).join(', ')}. Переустановите приложение.`);
  }

  async function install() {
    const me = await call('user.current');
    const admin = await call('user.admin');
    if (!(admin === true || admin === 'Y')) throw new Error('Первую установку должен выполнить администратор Битрикс24.');
    const existing = await callAll('lists.get', { IBLOCK_TYPE_ID: LIST_TYPE, IBLOCK_CODE: LIST_CODE });
    const found = existing.find(item => String(item.CODE || item.IBLOCK_CODE || '') === LIST_CODE) || existing[0];
    if (found) listId = Number(found.ID || found.IBLOCK_ID || 0);
    else {
      listId = Number(await call('lists.add', {
        IBLOCK_TYPE_ID: LIST_TYPE,
        IBLOCK_CODE: LIST_CODE,
        FIELDS: {
          NAME: 'Дежурства — данные приложения',
          DESCRIPTION: 'Служебное хранилище приложения «Дежурства». Не изменяйте записи вручную.',
          SORT: 500,
          BIZPROC: 'Y'
        },
        MESSAGES: {
          ELEMENTS_NAME: 'Записи', ELEMENT_NAME: 'Запись', ELEMENT_ADD: 'Добавить запись',
          ELEMENT_EDIT: 'Изменить запись', ELEMENT_DELETE: 'Удалить запись',
          SECTIONS_NAME: 'Разделы', SECTION_NAME: 'Раздел', SECTION_ADD: 'Добавить раздел',
          SECTION_EDIT: 'Изменить раздел', SECTION_DELETE: 'Удалить раздел'
        },
        RIGHTS: { [`U${Number(me.ID)}`]: 'X', '*': 'W' }
      }));
    }
    const existingFields = asArray(await call('lists.field.get', { IBLOCK_TYPE_ID: LIST_TYPE, IBLOCK_ID: listId }));
    for (const [key, name, type] of FIELD_DEFS) {
      if (existingFields.some(item => item.NAME === name)) continue;
      await call('lists.field.add', {
        IBLOCK_TYPE_ID: LIST_TYPE,
        IBLOCK_ID: listId,
        FIELDS: {
          NAME: name,
          CODE: `DUTY_${key.toUpperCase()}`,
          TYPE: type,
          IS_REQUIRED: 'N',
          MULTIPLE: 'N',
          SORT: 500
        }
      });
    }
    await discoverSchema();
    return { listId };
  }

  async function loadUsers() {
    const rows = await callAll('user.get', { FILTER: { ACTIVE: true } });
    cachedUsers = rows.filter(item => item.ACTIVE !== false && item.ACTIVE !== 'N').map(item => ({
      id: Number(item.ID),
      name: `${item.NAME || ''} ${item.LAST_NAME || ''}`.trim() || item.LOGIN || `Сотрудник ${item.ID}`,
      avatar: item.PERSONAL_PHOTO || '',
      is_admin: Number(item.ID) === Number(currentUser?.ID) && currentIsAdmin ? 1 : 0,
      is_active: 1,
      is_eligible: 1,
      is_editor: 0
    })).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }

  function propertyKey(key) { return `PROPERTY_${fields[key]}`; }
  function recordFields(record) {
    const result = { NAME: record.name || `${record.record_type || 'Запись'} · ${Date.now()}` };
    for (const [key] of FIELD_DEFS) {
      if (!(key in record)) continue;
      const value = record[key];
      result[propertyKey(key)] = ['note', 'extra'].includes(key) ? String(value || '').slice(0, 250) : value;
    }
    return result;
  }
  function normalizeRecord(row) {
    const record = { id: Number(row.ID), name: row.NAME || '', created_at: row.DATE_CREATE || '' };
    for (const [key] of FIELD_DEFS) record[key] = unwrap(row[propertyKey(key)]);
    for (const key of ['employee_id', 'target_employee_id', 'hours', 'compensable', 'reference_id']) record[key] = number(record[key]);
    return record;
  }

  async function loadRecords() {
    const rows = await callAll('lists.element.get', { IBLOCK_TYPE_ID: LIST_TYPE, IBLOCK_ID: listId });
    cachedRecords = rows.map(normalizeRecord);
  }

  async function addRecord(record) {
    const id = Number(await call('lists.element.add', {
      IBLOCK_TYPE_ID: LIST_TYPE,
      IBLOCK_ID: listId,
      ELEMENT_CODE: `duty_${record.record_type || 'record'}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      FIELDS: recordFields(record)
    }));
    return id;
  }
  async function updateRecord(id, patch) {
    await call('lists.element.update', {
      IBLOCK_TYPE_ID: LIST_TYPE,
      IBLOCK_ID: listId,
      ELEMENT_ID: Number(id),
      FIELDS: recordFields({ ...cachedRecords.find(item => item.id === Number(id)), ...patch })
    });
  }
  async function deleteRecord(id) {
    await call('lists.element.delete', { IBLOCK_TYPE_ID: LIST_TYPE, IBLOCK_ID: listId, ELEMENT_ID: Number(id) });
  }

  function settingFor(employeeId) {
    return cachedRecords.find(item => item.record_type === 'employee' && Number(item.employee_id) === Number(employeeId));
  }
  async function saveEmployeeSetting(employeeId, patch) {
    const existing = settingFor(employeeId);
    if (existing) await updateRecord(existing.id, patch);
    else await addRecord({ record_type: 'employee', employee_id: Number(employeeId), status: 'eligible', kind: 'viewer', ...patch, name: `Настройки · ${employeeName(employeeId)}` });
  }
  function canEdit() {
    return currentIsAdmin || settingFor(currentUser?.ID)?.kind === 'editor';
  }
  function requireEditor(message = 'Недостаточно прав для изменения графика') {
    if (!canEdit()) throw httpError(message, 403);
  }
  function requireAdmin() {
    if (!currentIsAdmin) throw httpError('Это действие доступно только администратору портала', 403);
  }
  function activeEmployee(id) {
    const user = cachedUsers.find(item => Number(item.id) === Number(id));
    const setting = settingFor(id);
    return user && setting?.status !== 'ineligible' ? user : null;
  }
  async function audit(action, detail) {
    await addRecord({ record_type: 'audit', employee_id: Number(currentUser?.ID || 0), kind: action, note: detail, start_date: today(), name: `${action} · ${actorName()}` });
  }
  async function notify(employeeId, message) {
    try {
      await call('im.notify.personal.add', { USER_ID: Number(employeeId), MESSAGE: message });
      return '';
    } catch (error) {
      return `Изменение сохранено, но уведомление не отправлено: ${error.message}`;
    }
  }

  function isWeekendDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
    const day = new Date(`${value}T00:00:00Z`).getUTCDay();
    return day === 0 || day === 6;
  }
  function validSupportPeriod(start, end) {
    if (!isWeekendDate(start) || !isWeekendDate(end)) return false;
    const from = new Date(`${start}T00:00:00Z`), to = new Date(`${end}T00:00:00Z`);
    return to >= from && to - from <= 86_400_000;
  }
  function absenceDates(start, end) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return [];
    const from = new Date(`${start}T00:00:00Z`), to = new Date(`${end}T00:00:00Z`), result = [];
    for (let date = from, guard = 0; date <= to && guard < 366; date = new Date(date.getTime() + 86_400_000), guard++) {
      const weekday = date.getUTCDay();
      if (weekday >= 1 && weekday <= 5) result.push(date.toISOString().slice(0, 10));
    }
    return result;
  }
  function dutyHoursLimit(duty) { return duty.kind === 'office' ? 0 : duty.start_date === duty.end_date ? 2 : 4; }

  function ledgerFor(employeeId) {
    const events = [];
    for (const stored of cachedRecords.filter(item => item.record_type === 'ledger' && Number(item.employee_id) === Number(employeeId))) {
      events.push({ id: stored.id, employee_id: Number(employeeId), occurred_on: stored.start_date, hours: Number(stored.hours), kind: stored.kind || 'adjustment', reference_id: Number(stored.reference_id || 0), note: stored.note || stored.kind || 'Корректировка', order: 0, stored: true });
    }
    for (const absence of cachedRecords.filter(item => item.record_type === 'absence' && item.extra !== 'legacy' && Number(item.employee_id) === Number(employeeId) && bool(item.compensable))) {
      events.push({ id: absence.id, employee_id: Number(employeeId), occurred_on: absence.start_date, hours: -Number(absence.hours), kind: 'absence', reference_id: absence.id, note: absence.note || 'Отсутствие', order: 0 });
    }
    for (const bonus of cachedRecords.filter(item => item.record_type === 'bonus' && item.extra !== 'legacy' && Number(item.employee_id) === Number(employeeId))) {
      events.push({ id: bonus.id, employee_id: Number(employeeId), occurred_on: bonus.start_date, hours: Number(bonus.hours), kind: 'bonus', reference_id: bonus.id, note: bonus.note || 'Бонус за переработку', order: 0 });
    }
    for (const duty of cachedRecords.filter(item => item.record_type === 'duty' && item.extra !== 'legacy' && Number(item.employee_id) === Number(employeeId) && item.kind !== 'office' && item.status === 'confirmed' && item.mode === 'compensate')) {
      events.push({ id: duty.id, employee_id: Number(employeeId), occurred_on: duty.end_date, hours: Number(duty.hours), kind: 'support_candidate', reference_id: duty.id, note: 'Компенсация существующего долга подтверждённым дежурством', order: 1 });
    }
    events.sort((a, b) => a.occurred_on.localeCompare(b.occurred_on) || a.order - b.order || a.id - b.id);
    const ledger = [];
    let running = 0;
    for (const event of events) {
      if (event.kind === 'support_candidate') {
        const credited = Math.min(Number(event.hours), Math.max(0, -running));
        if (credited > 0) {
          running += credited;
          ledger.push({ ...event, kind: 'support', hours: credited });
        }
      } else if (event.stored && event.kind !== 'bonus' && Number(event.hours) > 0) {
        if (running < 0) running = Math.min(0, running + Number(event.hours));
        ledger.push(event);
      } else {
        running += Number(event.hours);
        ledger.push(event);
      }
    }
    return { ledger, balance: Number(running.toFixed(2)) };
  }

  function snapshot() {
    const settings = new Map(cachedRecords.filter(item => item.record_type === 'employee').map(item => [Number(item.employee_id), item]));
    const withSettings = cachedUsers.map(item => ({ ...item, is_eligible: settings.get(item.id)?.status === 'ineligible' ? 0 : 1, is_editor: settings.get(item.id)?.kind === 'editor' ? 1 : 0 }));
    const eligible = withSettings.filter(item => item.is_eligible);
    const usersById = new Map(withSettings.map(item => [Number(item.id), item]));
    const duties = cachedRecords.filter(item => item.record_type === 'duty' && !['cancelled', 'rejected'].includes(item.status)).map(item => ({
      id: item.id, kind: item.kind, starts_on: item.start_date, ends_on: item.end_date, employee_id: Number(item.employee_id), hours: Number(item.hours), status: item.status || 'scheduled', accounting_mode: item.mode || 'schedule', office_status: item.office_status || 'scheduled', name: usersById.get(Number(item.employee_id))?.name || 'Сотрудник', avatar: usersById.get(Number(item.employee_id))?.avatar || ''
    })).sort((a, b) => a.starts_on.localeCompare(b.starts_on));
    const absences = cachedRecords.filter(item => item.record_type === 'absence').map(item => ({
      id: item.id, employee_id: Number(item.employee_id), occurred_on: item.start_date, ends_on: item.end_date || item.start_date, hours: Number(item.hours), note: item.note || '', absence_type: item.kind || 'personal', compensable: bool(item.compensable) ? 1 : 0, name: usersById.get(Number(item.employee_id))?.name || 'Сотрудник', avatar: usersById.get(Number(item.employee_id))?.avatar || ''
    })).sort((a, b) => b.occurred_on.localeCompare(a.occurred_on));
    const allLedger = eligible.flatMap(employee => ledgerFor(employee.id).ledger.map(item => ({ ...item, name: employee.name, avatar: employee.avatar })));
    const balances = eligible.map(employee => ({ id: employee.id, name: employee.name, avatar: employee.avatar, hours: ledgerFor(employee.id).balance }));
    const dutyMap = new Map(duties.map(item => [Number(item.id), item]));
    const swapRequests = cachedRecords.filter(item => item.record_type === 'swap' && !['rejected', 'cancelled'].includes(item.status)).map(item => {
      const duty = dutyMap.get(Number(item.reference_id)) || {};
      return { id: item.id, duty_id: Number(item.reference_id), from_employee_id: Number(item.employee_id), to_employee_id: Number(item.target_employee_id), note: item.note || '', status: item.status, kind: duty.kind, starts_on: duty.starts_on, ends_on: duty.ends_on, hours: duty.hours, from_name: usersById.get(Number(item.employee_id))?.name || 'Сотрудник', to_name: usersById.get(Number(item.target_employee_id))?.name || 'Сотрудник' };
    }).sort((a, b) => b.id - a.id);
    const auditRows = cachedRecords.filter(item => item.record_type === 'audit').sort((a, b) => b.id - a.id).slice(0, 15).map(item => ({ id: item.id, occurred_at: item.created_at || item.start_date, actor: employeeName(item.employee_id), actor_name: employeeName(item.employee_id), actor_avatar: usersById.get(Number(item.employee_id))?.avatar || '', action: item.kind, detail: item.note }));
    return {
      employees: eligible,
      allEmployees: canEdit() ? withSettings : [],
      editors: currentIsAdmin ? withSettings : [],
      duties,
      absences,
      balances,
      ledger: canEdit() ? allLedger : allLedger.filter(item => Number(item.employee_id) === Number(currentUser?.ID)),
      audit: auditRows,
      officeChecklist: [],
      swapRequests,
      permissions: { canEdit: canEdit(), canManageEditors: currentIsAdmin },
      currentEmployeeId: Number(currentUser?.ID || 0),
      storage: { type: 'bitrix_lists', listId }
    };
  }

  async function refresh() {
    await loadUsers();
    await loadRecords();
    return snapshot();
  }

  async function syncLegacyAbsence(value) {
    try {
      await call('lists.element.add', {
        IBLOCK_TYPE_ID: 'lists',
        IBLOCK_ID: LEGACY_ABSENCE_LIST_ID,
        ELEMENT_CODE: `duty_absence_${Date.now()}_${Number(value.employee_id)}`,
        FIELDS: {
          NAME: `${value.absence_type || 'Отсутствие'} — ${employeeName(value.employee_id)} — ${value.occurred_on}${value.ends_on && value.ends_on !== value.occurred_on ? `–${value.ends_on}` : ''}`,
          PROPERTY_404: Number(value.employee_id),
          PROPERTY_406: value.occurred_on,
          PROPERTY_408: value.ends_on || value.occurred_on,
          PROPERTY_410: Number(value.hours)
        }
      });
      return '';
    } catch (error) {
      return `Отсутствие сохранено, но действующий бизнес-процесс «График отсутствий» не запущен: ${error.message}`;
    }
  }

  async function route(path, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const value = parseBody(options);
    if ((method === 'GET' && path === '/api/bootstrap') || (method === 'POST' && path === '/api/bitrix/sync')) return refresh();

    let match = path.match(/^\/api\/employees\/(\d+)\/editor$/);
    if (method === 'PATCH' && match) {
      requireAdmin();
      const employeeId = Number(match[1]);
      if (!cachedUsers.some(item => item.id === employeeId)) throw httpError('Сотрудник не найден', 404);
      await saveEmployeeSetting(employeeId, { kind: bool(value.enabled) ? 'editor' : 'viewer' });
      await audit('Изменены права редактора', `${employeeName(employeeId)}: ${bool(value.enabled) ? 'редактор' : 'просмотр'}`);
      return refresh();
    }
    match = path.match(/^\/api\/employees\/(\d+)\/eligibility$/);
    if (method === 'PATCH' && match) {
      requireEditor();
      const employeeId = Number(match[1]);
      await saveEmployeeSetting(employeeId, { status: bool(value.eligible) ? 'eligible' : 'ineligible' });
      await audit('Изменён состав графика', `${employeeName(employeeId)}: ${bool(value.eligible) ? 'участвует' : 'исключён'}`);
      return refresh();
    }

    if (method === 'POST' && path === '/api/duties') {
      requireEditor();
      const employeeId = Number(value.employee_id), kind = String(value.kind || ''), start = String(value.starts_on || ''), end = String(value.ends_on || '');
      if (!activeEmployee(employeeId) || !['office', 'support', 'holiday'].includes(kind) || !start || !end || end < start) throw httpError('Выберите действующего сотрудника, тип и корректный период');
      if (kind === 'support' && !validSupportPeriod(start, end)) throw httpError('Дежурство поддержки можно назначить только на субботу, воскресенье или оба выходных дня');
      const draft = { kind, start_date: start, end_date: end };
      const limit = dutyHoursLimit(draft), hours = kind === 'office' ? 0 : Number(value.hours || limit), mode = kind === 'office' ? 'schedule' : String(value.accounting_mode || 'schedule');
      if (!Number.isFinite(hours) || hours < 0 || hours > limit || (kind !== 'office' && hours <= 0)) throw httpError('Один выходной компенсирует до 2 ч, оба выходных — до 4 ч');
      await addRecord({ record_type: 'duty', employee_id: employeeId, start_date: start, end_date: end, hours, status: 'scheduled', kind, mode, office_status: 'scheduled', name: `${kind === 'office' ? 'Офис' : 'Поддержка'} · ${employeeName(employeeId)} · ${start}` });
      await audit('Назначено дежурство', `${employeeName(employeeId)} · ${start}–${end}`);
      return refresh();
    }
    match = path.match(/^\/api\/duties\/(\d+)$/);
    if (method === 'PATCH' && match) {
      requireEditor('Недостаточно прав для редактирования');
      const duty = cachedRecords.find(item => item.record_type === 'duty' && item.id === Number(match[1]));
      if (!duty) throw httpError('Дежурство не найдено', 404);
      const kind = String(value.kind || duty.kind), employeeId = Number(value.employee_id || duty.employee_id), start = String(value.starts_on || duty.start_date), end = String(value.ends_on || duty.end_date), mode = kind === 'office' ? 'schedule' : String(value.accounting_mode || duty.mode || 'schedule');
      if (!activeEmployee(employeeId) || !['office', 'support', 'holiday'].includes(kind) || end < start) throw httpError('Проверьте тип, сотрудника и период дежурства');
      if (kind === 'support' && !validSupportPeriod(start, end)) throw httpError('Дежурство поддержки можно назначить только на субботу, воскресенье или оба выходных дня');
      const limit = dutyHoursLimit({ kind, start_date: start, end_date: end }), hours = kind === 'office' ? 0 : Number(value.hours ?? duty.hours);
      if (!Number.isFinite(hours) || hours <= 0 && kind !== 'office' || hours > limit) throw httpError('Один выходной компенсирует до 2 ч, оба выходных — до 4 ч');
      if (duty.extra === 'legacy') for (const row of cachedRecords.filter(item => item.record_type === 'ledger' && Number(item.reference_id) === duty.id)) await deleteRecord(row.id);
      await updateRecord(duty.id, { employee_id: employeeId, start_date: start, end_date: end, hours, kind, mode, extra: '' });
      await audit('Изменено дежурство', `${employeeName(employeeId)} · ${start}–${end}`);
      return refresh();
    }
    match = path.match(/^\/api\/duties\/(\d+)\/(confirm|reject)$/);
    if (method === 'POST' && match) {
      requireEditor();
      const duty = cachedRecords.find(item => item.record_type === 'duty' && item.id === Number(match[1]));
      if (!duty) throw httpError('Дежурство не найдено', 404);
      if (duty.extra === 'legacy') for (const row of cachedRecords.filter(item => item.record_type === 'ledger' && Number(item.reference_id) === duty.id)) await deleteRecord(row.id);
      await updateRecord(duty.id, { status: match[2] === 'confirm' ? 'confirmed' : 'rejected', extra: '' });
      await audit(match[2] === 'confirm' ? 'Подтверждено дежурство' : 'Отклонено дежурство', `${employeeName(duty.employee_id)} · ${duty.start_date}–${duty.end_date}`);
      return refresh();
    }
    match = path.match(/^\/api\/duties\/(\d+)\/delete$/);
    if (method === 'POST' && match) {
      requireEditor();
      const duty = cachedRecords.find(item => item.record_type === 'duty' && item.id === Number(match[1]));
      if (!duty) throw httpError('Дежурство не найдено', 404);
      for (const swap of cachedRecords.filter(item => item.record_type === 'swap' && Number(item.reference_id) === duty.id)) await deleteRecord(swap.id);
      for (const row of cachedRecords.filter(item => item.record_type === 'ledger' && Number(item.reference_id) === duty.id)) await deleteRecord(row.id);
      await deleteRecord(duty.id);
      await audit('Удалено дежурство', `${employeeName(duty.employee_id)} · ${duty.start_date}–${duty.end_date}`);
      return refresh();
    }

    if (method === 'POST' && path === '/api/bonuses') {
      requireEditor('Недостаточно прав для начисления бонуса');
      const employeeId = Number(value.employee_id), hours = Number(value.hours), date = String(value.occurred_on || ''), note = String(value.note || '').trim();
      if (!activeEmployee(employeeId) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(hours) || hours < .5 || hours > 100 || Math.abs(hours * 2 - Math.round(hours * 2)) > 1e-9) throw httpError('Выберите сотрудника, дату и бонус от 0,5 до 100 часов с шагом 0,5');
      await addRecord({ record_type: 'bonus', employee_id: employeeId, start_date: date, end_date: date, hours, note: note || 'Бонус за переработку', name: `Бонус +${hours} ч · ${employeeName(employeeId)}` });
      await audit('Начислен бонус', `${employeeName(employeeId)} · +${hours} ч · ${date}`);
      return refresh();
    }
    match = path.match(/^\/api\/bonuses\/(\d+)\/delete$/);
    if (method === 'POST' && match) {
      requireEditor('Недостаточно прав для удаления бонуса');
      const requestedId = Number(match[1]);
      const ledgerRow = cachedRecords.find(item => item.record_type === 'ledger' && item.id === requestedId && item.kind === 'bonus');
      const bonus = cachedRecords.find(item => item.record_type === 'bonus' && item.id === (ledgerRow ? Number(ledgerRow.reference_id) : requestedId));
      if (!bonus) throw httpError('Бонус не найден', 404);
      for (const row of cachedRecords.filter(item => item.record_type === 'ledger' && (item.id === requestedId || Number(item.reference_id) === bonus.id))) await deleteRecord(row.id);
      await deleteRecord(bonus.id);
      await audit('Удалён бонус', `${employeeName(bonus.employee_id)} · ${bonus.hours} ч · ${bonus.start_date}`);
      return refresh();
    }

    if (method === 'POST' && path === '/api/absences') {
      requireEditor();
      const employeeId = Number(value.employee_id), hours = Number(value.hours), type = String(value.absence_type || 'personal'), start = String(value.occurred_on || ''), end = String(value.ends_on || start), dates = absenceDates(start, end), compensable = bool(value.compensable);
      if (!activeEmployee(employeeId) || !dates.length || !hours || hours > 24 || !['vacation', 'sick_leave', 'time_off', 'business_trip', 'personal', 'unpaid_leave', 'other'].includes(type)) throw httpError('Выберите сотрудника, корректный период и часы отсутствия за день');
      for (const date of dates) await addRecord({ record_type: 'absence', employee_id: employeeId, start_date: date, end_date: date, hours, kind: type, compensable: compensable ? 1 : 0, note: value.note || '', name: `${type} · ${employeeName(employeeId)} · ${date}` });
      const syncWarning = await syncLegacyAbsence({ ...value, employee_id: employeeId, hours, absence_type: type, occurred_on: start, ends_on: end });
      await audit('Добавлено отсутствие', `${employeeName(employeeId)} · ${start}–${end} · ${hours} ч/день`);
      const result = await refresh();
      if (syncWarning) result.syncWarning = syncWarning;
      return result;
    }
    match = path.match(/^\/api\/absences\/(\d+)$/);
    if (method === 'PATCH' && match) {
      requireEditor('Недостаточно прав для редактирования отсутствия');
      const absence = cachedRecords.find(item => item.record_type === 'absence' && item.id === Number(match[1]));
      if (!absence) throw httpError('Запись об отсутствии не найдена', 404);
      const employeeId = Number(value.employee_id), hours = Number(value.hours), type = String(value.absence_type || 'personal'), date = String(value.occurred_on || '');
      if (!activeEmployee(employeeId) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !hours || hours > 24) throw httpError('Проверьте сотрудника, дату и часы отсутствия');
      if (absence.extra === 'legacy') {
        const linked = cachedRecords.filter(item => item.record_type === 'ledger' && Number(item.reference_id) === absence.id && item.kind === 'absence');
        for (const row of linked) await deleteRecord(row.id);
      }
      await updateRecord(absence.id, { employee_id: employeeId, start_date: date, end_date: date, hours, kind: type, compensable: bool(value.compensable) ? 1 : 0, note: value.note || '', extra: '' });
      await audit('Изменено отсутствие', `${employeeName(employeeId)} · ${date} · ${hours} ч`);
      return refresh();
    }
    match = path.match(/^\/api\/absences\/(\d+)\/delete$/);
    if (method === 'POST' && match) {
      requireEditor('Недостаточно прав для удаления отсутствия');
      const absence = cachedRecords.find(item => item.record_type === 'absence' && item.id === Number(match[1]));
      if (!absence) throw httpError('Запись об отсутствии не найдена', 404);
      for (const row of cachedRecords.filter(item => item.record_type === 'ledger' && Number(item.reference_id) === absence.id)) await deleteRecord(row.id);
      await deleteRecord(absence.id);
      await audit('Удалено отсутствие', `${employeeName(absence.employee_id)} · ${absence.start_date} · ${absence.hours} ч`);
      return refresh();
    }

    match = path.match(/^\/api\/duties\/(\d+)\/office\/(acknowledge|decline|complete)$/);
    if (method === 'POST' && match) {
      const duty = cachedRecords.find(item => item.record_type === 'duty' && item.id === Number(match[1]) && item.kind === 'office');
      if (!duty) throw httpError('Офисное дежурство не найдено', 404);
      const action = match[2];
      if (action === 'complete') requireEditor('Выполнение подтверждает редактор');
      else if (Number(duty.employee_id) !== Number(currentUser.ID)) throw httpError('Решение может принять назначенный сотрудник', 403);
      const next = action === 'acknowledge' ? 'acknowledged' : action === 'decline' ? 'declined' : 'completed';
      await updateRecord(duty.id, { office_status: next });
      await audit(action === 'complete' ? 'Подтверждено выполнение офисного дежурства' : action === 'decline' ? 'Сотрудник не может дежурить в офисе' : 'Сотрудник подтвердил офисное дежурство', `${duty.start_date}${value.note ? ` · ${value.note}` : ''}`);
      return refresh();
    }

    if (method === 'POST' && path === '/api/swaps') {
      const duty = cachedRecords.find(item => item.record_type === 'duty' && item.id === Number(value.duty_id));
      const targetId = Number(value.to_employee_id), me = Number(currentUser.ID);
      if (!duty || Number(duty.employee_id) !== me || !activeEmployee(targetId) || targetId === me) throw httpError('Выберите своё дежурство и действующего сотрудника');
      if (cachedRecords.some(item => item.record_type === 'swap' && Number(item.reference_id) === duty.id && ['pending_target', 'pending_admin'].includes(item.status))) throw httpError('По этому дежурству уже есть активная заявка');
      await addRecord({ record_type: 'swap', employee_id: me, target_employee_id: targetId, reference_id: duty.id, status: 'pending_target', note: value.note || '', start_date: duty.start_date, end_date: duty.end_date, kind: duty.kind, name: `Обмен · ${employeeName(me)} → ${employeeName(targetId)}` });
      const warning = await notify(targetId, `${actorName()} предлагает заменить его на дежурстве ${duty.start_date}–${duty.end_date}. Откройте приложение «Дежурства», чтобы ответить.`);
      await audit('Предложен обмен дежурством', `${employeeName(me)} → ${employeeName(targetId)} · ${duty.start_date}–${duty.end_date}`);
      const result = await refresh();
      if (warning) result.notificationWarning = warning;
      return result;
    }
    match = path.match(/^\/api\/swaps\/(\d+)\/(accept|reject|approve)$/);
    if (method === 'POST' && match) {
      const swap = cachedRecords.find(item => item.record_type === 'swap' && item.id === Number(match[1]));
      if (!swap) throw httpError('Заявка на обмен не найдена', 404);
      const action = match[2], me = Number(currentUser.ID), duty = cachedRecords.find(item => item.record_type === 'duty' && item.id === Number(swap.reference_id));
      let warning = '';
      if (action === 'accept') {
        if (me !== Number(swap.target_employee_id) || swap.status !== 'pending_target') throw httpError('Эта заявка недоступна для подтверждения', 403);
        await updateRecord(swap.id, { status: 'pending_admin' });
        const approver = cachedUsers.find(item => item.name.includes('Алдияр Байгабулов')) || cachedUsers.find(item => settingFor(item.id)?.kind === 'editor');
        warning = approver ? await notify(approver.id, `Требуется подтвердить обмен: ${employeeName(swap.employee_id)} → ${employeeName(swap.target_employee_id)}, ${swap.start_date}–${swap.end_date}.`) : 'Заявка принята, но редактор для уведомления не найден.';
      } else if (action === 'reject') {
        if (me !== Number(swap.target_employee_id) && !canEdit()) throw httpError('Отклонить заявку может получатель или редактор', 403);
        await updateRecord(swap.id, { status: 'rejected' });
        warning = await notify(swap.employee_id, `${actorName()} отклонил обмен дежурством ${swap.start_date}–${swap.end_date}.`);
      } else {
        requireEditor('Подтверждать обмен может только редактор');
        if (swap.status !== 'pending_admin' || !duty) throw httpError('Обмен ещё не согласован сотрудником');
        await updateRecord(duty.id, { employee_id: Number(swap.target_employee_id) });
        await updateRecord(swap.id, { status: 'approved' });
        const message = `${actorName()} подтвердил обмен ${swap.start_date}–${swap.end_date}. В графике назначен ${employeeName(swap.target_employee_id)}.`;
        const warnings = await Promise.all([notify(swap.employee_id, message), notify(swap.target_employee_id, message)]);
        warning = warnings.find(Boolean) || '';
      }
      await audit(action === 'approve' ? 'Подтверждён обмен дежурством' : action === 'accept' ? 'Сотрудник согласился на обмен' : 'Отклонён обмен дежурством', `${swap.start_date}–${swap.end_date}`);
      const result = await refresh();
      if (warning) result.notificationWarning = warning;
      return result;
    }

    match = path.match(/^\/api\/duties\/(\d+)\/remind$/);
    if (method === 'POST' && match) {
      requireEditor('Недостаточно прав для отправки напоминания');
      const duty = cachedRecords.find(item => item.record_type === 'duty' && item.id === Number(match[1]));
      if (!duty) throw httpError('Дежурство не найдено', 404);
      const warning = await notify(duty.employee_id, `Напоминание о дежурстве: ${duty.start_date}–${duty.end_date}. Откройте приложение «Дежурства».`);
      if (warning) throw httpError(warning);
      return { ok: true };
    }

    throw httpError('Действие пока не поддерживается статичной версией приложения', 404);
  }

  async function init() {
    if (!window.BX24) throw new Error('Приложение нужно открыть внутри Битрикс24.');
    currentUser = await call('user.current');
    const admin = await call('user.admin');
    currentIsAdmin = admin === true || admin === 'Y';
    await discoverSchema();
  }

  let importInProgress = false;

  async function importData(payload) {
    requireAdmin();
    if (!payload || Number(payload.version) !== 1) throw new Error('Выбран файл неподдерживаемого формата.');
    if (importInProgress) throw new Error('Перенос уже выполняется. Дождитесь его завершения.');
    importInProgress = true;
    try {
      await loadRecords();
      const existingBusinessRows = cachedRecords.filter(item => !['employee', 'audit'].includes(item.record_type));
      if (existingBusinessRows.length) throw new Error('Хранилище уже содержит рабочие данные. Импорт разрешён только в пустое приложение.');
      const dutyIds = new Map(), absenceIds = new Map(), bonusIds = new Map();
      for (const employee of payload.employees || []) {
        if (!cachedUsers.some(item => Number(item.id) === Number(employee.id))) continue;
        await saveEmployeeSetting(employee.id, { status: employee.is_eligible === 0 ? 'ineligible' : 'eligible', kind: employee.is_editor ? 'editor' : 'viewer' });
      }
      for (const duty of payload.duties || []) {
        const id = await addRecord({ record_type: 'duty', employee_id: Number(duty.employee_id), start_date: duty.starts_on, end_date: duty.ends_on, hours: Number(duty.hours || 0), status: duty.status || 'scheduled', kind: duty.kind || 'support', mode: duty.accounting_mode || 'schedule', office_status: duty.office_status || 'scheduled', extra: 'legacy', name: `${duty.kind === 'office' ? 'Офис' : 'Поддержка'} · ${employeeName(duty.employee_id)} · ${duty.starts_on}` });
        dutyIds.set(Number(duty.id), id);
      }
      for (const absence of payload.absences || []) {
        const id = await addRecord({ record_type: 'absence', employee_id: Number(absence.employee_id), start_date: absence.occurred_on, end_date: absence.occurred_on, hours: Number(absence.hours), kind: absence.absence_type || 'personal', compensable: Number(absence.compensable || 0), note: absence.note || '', extra: 'legacy', name: `${absence.absence_type || 'Отсутствие'} · ${employeeName(absence.employee_id)} · ${absence.occurred_on}` });
        absenceIds.set(Number(absence.id), id);
      }
      for (const row of payload.ledger || []) {
        let referenceId = Number(row.reference_id || 0);
        if (row.kind === 'bonus') {
          const bonusId = await addRecord({ record_type: 'bonus', employee_id: Number(row.employee_id), start_date: row.occurred_on, end_date: row.occurred_on, hours: Number(row.hours), note: row.note || 'Бонус за переработку', extra: 'legacy', name: `Бонус +${row.hours} ч · ${employeeName(row.employee_id)}` });
          bonusIds.set(Number(row.id), bonusId);
          referenceId = bonusId;
        } else if (row.kind === 'absence') referenceId = absenceIds.get(referenceId) || 0;
        else if (row.kind === 'support') referenceId = dutyIds.get(referenceId) || 0;
        await addRecord({ record_type: 'ledger', employee_id: Number(row.employee_id), start_date: row.occurred_on, end_date: row.occurred_on, hours: Number(row.hours), kind: row.kind || 'adjustment', reference_id: referenceId, note: row.note || '', extra: 'legacy', name: `Баланс · ${employeeName(row.employee_id)} · ${row.occurred_on}` });
      }
      for (const swap of payload.swapRequests || []) {
        const dutyId = dutyIds.get(Number(swap.duty_id));
        if (!dutyId) continue;
        await addRecord({ record_type: 'swap', employee_id: Number(swap.from_employee_id), target_employee_id: Number(swap.to_employee_id), reference_id: dutyId, status: swap.status || 'pending_target', note: swap.note || '', start_date: swap.starts_on || '', end_date: swap.ends_on || '', kind: swap.kind || '', extra: 'legacy', name: `Обмен · ${employeeName(swap.from_employee_id)} → ${employeeName(swap.to_employee_id)}` });
      }
      for (const row of (payload.audit || []).slice(-100)) await addRecord({ record_type: 'audit', employee_id: Number(row.actor_id || currentUser.ID), start_date: String(row.occurred_at || today()).slice(0, 10), kind: row.action || 'Импортированное действие', note: row.detail || '', extra: 'legacy', name: `${row.action || 'История'} · ${row.actor_name || row.actor || ''}` });
      await audit('Перенос данных завершён', `Импортировано: ${payload.duties?.length || 0} дежурств, ${payload.absences?.length || 0} отсутствий, ${payload.ledger?.length || 0} операций баланса`);
      return refresh();
    } finally {
      importInProgress = false;
    }
  }

  function repairSignature(record) {
    const numeric = new Set(['employee_id', 'target_employee_id', 'hours', 'compensable']);
    const value = { name: String(record.name || '') };
    for (const [key] of FIELD_DEFS) {
      if (key === 'reference_id') continue;
      value[key] = numeric.has(key) ? Number(record[key] || 0) : String(record[key] || '');
    }
    return JSON.stringify(value);
  }

  async function repairImport(payload) {
    requireAdmin();
    if (!payload || Number(payload.version) !== 1 || payload.kind !== 'duty-static-repair') {
      throw new Error('Выбран файл неподдерживаемого формата восстановления.');
    }
    const deleteIds = [...new Set((payload.duplicateIds || []).map(Number).filter(Number.isInteger))];
    const missing = Array.isArray(payload.missing) ? payload.missing : [];
    if (!deleteIds.length && !missing.length) throw new Error('В файле нет операций восстановления.');
    if (deleteIds.length > 500 || missing.length > 200) throw new Error('Файл восстановления превышает безопасный лимит.');
    if (missing.some(item => item?.record?.record_type !== 'audit' || !Number.isInteger(Number(item.expectedCount)))) {
      throw new Error('Файл восстановления содержит недопустимые записи.');
    }

    await loadRecords();
    const existingIds = new Set(cachedRecords.map(item => item.id));
    let deleted = 0;
    for (const id of deleteIds) {
      if (!existingIds.has(id)) continue;
      await call('lists.element.delete', { IBLOCK_TYPE_ID: LIST_TYPE, IBLOCK_ID: listId, ELEMENT_ID: id });
      deleted += 1;
    }

    await loadRecords();
    let added = 0;
    for (const item of missing) {
      const targetCount = Number(item.expectedCount);
      const signature = repairSignature(item.record);
      let currentCount = cachedRecords.filter(record => repairSignature(record) === signature).length;
      while (currentCount < targetCount) {
        await addRecord(item.record);
        currentCount += 1;
        added += 1;
      }
    }

    const result = await refresh();
    result.repairResult = { deleted, added, total: cachedRecords.length, expectedTotal: Number(payload.expectedTotal || 0) };
    return result;
  }

  window.DutyStaticStore = { init, install, importData, repairImport, api: route, refresh, call };
})();
