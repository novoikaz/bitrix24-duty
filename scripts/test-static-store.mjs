import assert from 'node:assert/strict';

const users = [
  { ID: '1', NAME: 'Администратор', LAST_NAME: 'Портала', ACTIVE: true, PERSONAL_PHOTO: '' },
  { ID: '2', NAME: 'Анна', LAST_NAME: 'Сотрудник', ACTIVE: true, PERSONAL_PHOTO: '' }
];
let list = null;
let nextFieldId = 400;
let nextElementId = 1;
const listFields = [];
const elements = [];

function answer(data, error = null) {
  return {
    data: () => data,
    error: () => error,
    error_description: () => error,
    more: () => false,
    next: () => {}
  };
}

globalThis.window = globalThis;
globalThis.BX24 = {
  callMethod(method, params, callback) {
    try {
      let data;
      if (method === 'user.current') data = users[0];
      else if (method === 'user.admin') data = true;
      else if (method === 'user.get') data = users;
      else if (method === 'lists.get') data = list && (!params.IBLOCK_CODE || params.IBLOCK_CODE === list.CODE) ? [list] : [];
      else if (method === 'lists.add') { list = { ID: 100, CODE: params.IBLOCK_CODE, ...params.FIELDS }; data = list.ID; }
      else if (method === 'lists.field.get') data = listFields;
      else if (method === 'lists.field.add') { const field = { ID: String(nextFieldId++), ...params.FIELDS }; listFields.push(field); data = field.ID; }
      else if (method === 'lists.element.get') data = elements.filter(item => Number(item.IBLOCK_ID) === Number(params.IBLOCK_ID));
      else if (method === 'lists.element.add') { const item = { ID: nextElementId++, IBLOCK_ID: params.IBLOCK_ID, CODE: params.ELEMENT_CODE, DATE_CREATE: new Date().toISOString(), ...params.FIELDS }; elements.push(item); data = item.ID; }
      else if (method === 'lists.element.update') { const item = elements.find(row => row.ID === Number(params.ELEMENT_ID)); if (!item) throw new Error('Element missing'); Object.assign(item, params.FIELDS); data = true; }
      else if (method === 'lists.element.delete') { const index = elements.findIndex(row => row.ID === Number(params.ELEMENT_ID)); if (index >= 0) elements.splice(index, 1); data = true; }
      else if (method === 'im.notify.personal.add') data = 1;
      else throw new Error(`Unsupported mock method: ${method}`);
      callback(answer(data));
    } catch (error) {
      callback(answer(null, error.message));
    }
  }
};

await import('../static-app-src/bitrix-static.js');
await DutyStaticStore.install();
assert.ok(listFields.every(field => /^DUTY_[A-Z_]+$/.test(field.CODE)), 'Every custom list field must have a Bitrix24 code');
assert.equal(new Set(listFields.map(field => field.CODE)).size, listFields.length, 'Field codes must be unique');
await DutyStaticStore.init();

let state = await DutyStaticStore.api('/api/bootstrap');
assert.equal(state.storage.type, 'bitrix_lists');
assert.equal(state.employees.length, 2);
assert.equal(state.permissions.canEdit, true);

state = await DutyStaticStore.api('/api/absences', {
  method: 'POST',
  body: JSON.stringify({ employee_id: 2, occurred_on: '2026-11-09', ends_on: '2026-11-09', hours: .5, absence_type: 'personal', compensable: 'on', note: 'Тест' })
});
assert.equal(state.balances.find(item => item.id === 2).hours, -.5);

state = await DutyStaticStore.api('/api/duties', {
  method: 'POST',
  body: JSON.stringify({ employee_id: 2, starts_on: '2026-11-14', ends_on: '2026-11-14', hours: 2, kind: 'support', accounting_mode: 'compensate' })
});
const duty = state.duties.find(item => item.employee_id === 2);
state = await DutyStaticStore.api(`/api/duties/${duty.id}/confirm`, { method: 'POST' });
assert.equal(state.balances.find(item => item.id === 2).hours, 0);

state = await DutyStaticStore.api('/api/bonuses', {
  method: 'POST',
  body: JSON.stringify({ employee_id: 2, occurred_on: '2026-11-15', hours: 2, note: 'Переработка' })
});
assert.equal(state.balances.find(item => item.id === 2).hours, 2);
assert.ok(elements.length > 0);

elements.splice(0, elements.length);
await DutyStaticStore.refresh();
state = await DutyStaticStore.importData({
  version: 1,
  employees: [{ id: 1, is_eligible: 1, is_editor: 0 }, { id: 2, is_eligible: 1, is_editor: 0 }],
  duties: [{ id: 10, employee_id: 2, starts_on: '2026-10-10', ends_on: '2026-10-11', hours: 4, kind: 'support', status: 'confirmed', accounting_mode: 'schedule' }],
  absences: [{ id: 20, employee_id: 2, occurred_on: '2026-10-12', hours: .5, absence_type: 'personal', compensable: 1, note: 'Тестовый импорт' }],
  ledger: [
    { id: 30, employee_id: 2, occurred_on: '2026-10-12', hours: -.5, kind: 'absence', reference_id: 20, note: 'Тестовый импорт' },
    { id: 31, employee_id: 2, occurred_on: '2026-10-13', hours: 2, kind: 'bonus', reference_id: null, note: 'Бонус' }
  ],
  audit: [],
  swapRequests: []
});
assert.equal(state.balances.find(item => item.id === 2).hours, 1.5);
assert.equal(state.absences.length, 1);
assert.equal(state.duties.length, 1);

console.log('static store: ok');
