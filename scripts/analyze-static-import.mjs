import fs from 'node:fs';

const [exportPath, elementsPath, outputPath] = process.argv.slice(2);
if (!exportPath || !elementsPath || !outputPath) {
  throw new Error('Usage: node scripts/analyze-static-import.mjs EXPORT ELEMENTS OUTPUT');
}

const payload = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
const elements = JSON.parse(fs.readFileSync(elementsPath, 'utf8'));
const employeeNames = new Map((payload.employees || []).map(item => [Number(item.id), item.name]));
const employeeName = id => employeeNames.get(Number(id)) || 'Сотрудник';

const propertyIds = {
  record_type: 448,
  employee_id: 450,
  target_employee_id: 452,
  start_date: 454,
  end_date: 456,
  hours: 458,
  status: 460,
  kind: 462,
  mode: 464,
  compensable: 466,
  office_status: 470,
  note: 472,
  extra: 474
};

function unwrap(value) {
  if (value && typeof value === 'object') return Object.values(value)[0] ?? '';
  return value ?? '';
}

function normalizeNumber(value) {
  if (value === '' || value == null) return '';
  const number = Number(value);
  return Number.isFinite(number) ? number : value;
}

function canonical(record) {
  const normalized = {
    name: String(record.name || ''),
    record_type: String(record.record_type || ''),
    employee_id: normalizeNumber(record.employee_id),
    target_employee_id: normalizeNumber(record.target_employee_id),
    start_date: String(record.start_date || ''),
    end_date: String(record.end_date || ''),
    hours: normalizeNumber(record.hours),
    status: String(record.status || ''),
    kind: String(record.kind || ''),
    mode: String(record.mode || ''),
    compensable: normalizeNumber(record.compensable),
    office_status: String(record.office_status || ''),
    note: String(record.note || ''),
    extra: String(record.extra || '')
  };
  return JSON.stringify(normalized);
}

function currentRecord(row) {
  const record = { name: row.NAME || '' };
  for (const [key, id] of Object.entries(propertyIds)) record[key] = unwrap(row[`PROPERTY_${id}`]);
  return record;
}

function addExpected(list, record) {
  list.push({ ...record });
}

const expected = [];
for (const employee of payload.employees || []) {
  addExpected(expected, {
    record_type: 'employee', employee_id: Number(employee.id),
    status: employee.is_eligible === 0 ? 'ineligible' : 'eligible',
    kind: employee.is_editor ? 'editor' : 'viewer',
    name: `Настройки · ${employeeName(employee.id)}`
  });
}
for (const duty of payload.duties || []) {
  addExpected(expected, {
    record_type: 'duty', employee_id: Number(duty.employee_id), start_date: duty.starts_on,
    end_date: duty.ends_on, hours: Number(duty.hours || 0), status: duty.status || 'scheduled',
    kind: duty.kind || 'support', mode: duty.accounting_mode || 'schedule',
    office_status: duty.office_status || 'scheduled', extra: 'legacy',
    name: `${duty.kind === 'office' ? 'Офис' : 'Поддержка'} · ${employeeName(duty.employee_id)} · ${duty.starts_on}`
  });
}
for (const absence of payload.absences || []) {
  addExpected(expected, {
    record_type: 'absence', employee_id: Number(absence.employee_id), start_date: absence.occurred_on,
    end_date: absence.occurred_on, hours: Number(absence.hours), kind: absence.absence_type || 'personal',
    compensable: Number(absence.compensable || 0), note: absence.note || '', extra: 'legacy',
    name: `${absence.absence_type || 'Отсутствие'} · ${employeeName(absence.employee_id)} · ${absence.occurred_on}`
  });
}
for (const row of payload.ledger || []) {
  if (row.kind === 'bonus') {
    addExpected(expected, {
      record_type: 'bonus', employee_id: Number(row.employee_id), start_date: row.occurred_on,
      end_date: row.occurred_on, hours: Number(row.hours), note: row.note || 'Бонус за переработку',
      extra: 'legacy', name: `Бонус +${row.hours} ч · ${employeeName(row.employee_id)}`
    });
  }
  addExpected(expected, {
    record_type: 'ledger', employee_id: Number(row.employee_id), start_date: row.occurred_on,
    end_date: row.occurred_on, hours: Number(row.hours), kind: row.kind || 'adjustment',
    note: row.note || '', extra: 'legacy', name: `Баланс · ${employeeName(row.employee_id)} · ${row.occurred_on}`
  });
}
const sourceDutyIds = new Set((payload.duties || []).map(item => Number(item.id)));
for (const swap of payload.swapRequests || []) {
  if (!sourceDutyIds.has(Number(swap.duty_id))) continue;
  addExpected(expected, {
    record_type: 'swap', employee_id: Number(swap.from_employee_id),
    target_employee_id: Number(swap.to_employee_id), status: swap.status || 'pending_target',
    note: swap.note || '', start_date: swap.starts_on || '', end_date: swap.ends_on || '',
    kind: swap.kind || '', extra: 'legacy',
    name: `Обмен · ${employeeName(swap.from_employee_id)} → ${employeeName(swap.to_employee_id)}`
  });
}
for (const row of (payload.audit || []).slice(-100)) {
  addExpected(expected, {
    record_type: 'audit', employee_id: Number(row.actor_id || 1),
    start_date: String(row.occurred_at || '2026-11-08').slice(0, 10),
    kind: row.action || 'Импортированное действие', note: row.detail || '', extra: 'legacy',
    name: `${row.action || 'История'} · ${row.actor_name || row.actor || ''}`
  });
}
addExpected(expected, {
  record_type: 'audit', employee_id: 1, start_date: '2026-11-08',
  kind: 'Перенос данных завершён',
  note: `Импортировано: ${payload.duties?.length || 0} дежурств, ${payload.absences?.length || 0} отсутствий, ${payload.ledger?.length || 0} операций баланса`,
  name: 'Перенос данных завершён · Ильям Пудовкин'
});

const expectedByKey = new Map();
for (const record of expected) {
  const key = canonical(record);
  expectedByKey.set(key, (expectedByKey.get(key) || 0) + 1);
}

const currentByKey = new Map();
for (const row of elements) {
  const record = currentRecord(row);
  const key = canonical(record);
  if (!currentByKey.has(key)) currentByKey.set(key, []);
  currentByKey.get(key).push({ id: Number(row.ID), record });
}
for (const rows of currentByKey.values()) rows.sort((a, b) => a.id - b.id);

const duplicateIds = [];
const missing = [];
const unexpected = [];
for (const [key, rows] of currentByKey) {
  const expectedCount = expectedByKey.get(key) || 0;
  if (!expectedCount) unexpected.push(...rows);
  if (rows.length > expectedCount) duplicateIds.push(...rows.slice(expectedCount).map(item => item.id));
}
for (const [key, expectedCount] of expectedByKey) {
  const rows = currentByKey.get(key) || [];
  if (rows.length < expectedCount) {
    const record = JSON.parse(key);
    missing.push({ count: expectedCount - rows.length, expectedCount, currentCount: rows.length, record });
  }
}

const countByType = records => records.reduce((result, record) => {
  const type = record.record?.record_type || record.record_type || 'unknown';
  result[type] = (result[type] || 0) + (record.count || 1);
  return result;
}, {});

const result = {
  version: 1,
  kind: 'duty-static-repair',
  expectedTotal: expected.length,
  currentTotal: elements.length,
  duplicateCount: duplicateIds.length,
  duplicateIds,
  missingCount: missing.reduce((sum, item) => sum + item.count, 0),
  missingByType: countByType(missing),
  missing,
  unexpectedCount: unexpected.length,
  unexpectedByType: countByType(unexpected),
  unexpected
};
fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify({
  expectedTotal: result.expectedTotal,
  currentTotal: result.currentTotal,
  duplicateCount: result.duplicateCount,
  missingCount: result.missingCount,
  missingByType: result.missingByType,
  unexpectedCount: result.unexpectedCount,
  unexpectedByType: result.unexpectedByType
}, null, 2));
