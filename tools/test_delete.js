const fs = require('fs');
// Тест удаления записи: пункт в меню ПКМ, диалог с причиной, сама операция
// delete_work (причина уходит в комментарий, то есть в журнал изменений).
const html = fs.readFileSync('app_kmhto.html', 'utf8');
const js = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function extract(name) {
  const re = new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const mm = re.exec(js);
  if (!mm) return null;
  let i = mm.index, depth = 0, j = js.indexOf('{', i);
  for (; j < js.length; j++) {
    if (js[j] === '{') depth++;
    else if (js[j] === '}') { depth--; if (depth === 0) { j++; break; } }
  }
  return js.slice(i, j);
}

const prelude = `
let equipmentData = [];
const ops = [];
function commitOp(d, m) { if (m) m(); ops.push(d); return { ok: true, op: d }; }
function showNotification(x) { console.log('  NOTIFY:', x); }
`;

let code = prelude + '\n' + (extract('removeWorkForDay') || '/* MISSING removeWorkForDay */') + '\n';
code += `
let fails = 0;
function assert(name, cond) { if (!cond) fails++; console.log((cond ? '  OK   ' : '  FAIL ') + name); }

console.log('=== Пункт меню и диалог ===');
assert('в контекстном меню есть удаление', html.indexOf('data-act="remove"') !== -1);
assert('обработчик ведёт в диалог удаления', /case 'remove': openDeleteRecordDialog\\(t\\)/.test(js));
assert('диалог удаления существует', /function openDeleteRecordDialog/.test(js));
assert('причина обязательна', /Причина удаления \\(обязательна\\)/.test(js));
assert('редактор записи тоже передаёт причину', /removeWorkForDay\\(t, reason\\)/.test(js));

console.log('=== Удаление записи ===');
equipmentData = [{
  id: 'e1', name: 'E1',
  toSchedule: { 'январь': [{ type: 'ТО-1', day: 5 }, { type: 'ТО-2', day: 5 }], 'февраль': [{ type: 'ТО-1', day: 7 }] },
  kmhSchedule: { 'январь': [9] }, hasKmh: true
}];
removeWorkForDay({ eqId: 'e1', eqName: 'E1', day: 5, type: 'ТО-1', dateStr: '2026-01-05' }, 'ошибочная запись');
assert('операция delete_work', ops.length === 1 && ops[0].kind === 'delete_work');
assert('причина ушла в комментарий', ops[0].comment === 'ошибочная запись');
assert('удалена только ТО-1', !equipmentData[0].toSchedule['январь'].some(function (w) { return w.type === 'ТО-1'; }));
assert('ТО-2 того же дня осталась', equipmentData[0].toSchedule['январь'].some(function (w) { return w.type === 'ТО-2' && w.day === 5; }));

ops.length = 0;
removeWorkForDay({ eqId: 'e1', eqName: 'E1', day: 9, type: 'КМХ', dateStr: '2026-01-09' }, 'нет поверки');
assert('КМХ удалён', equipmentData[0].kmhSchedule['январь'] === undefined);
assert('пустой месяц КМХ не хранится', !('январь' in equipmentData[0].kmhSchedule));

ops.length = 0;
removeWorkForDay({ eqId: 'e1', eqName: 'E1', day: 7, type: 'ТО-1', dateStr: '2026-02-07' }, 'дубль');
assert('последняя запись месяца удалена', equipmentData[0].toSchedule['февраль'] === undefined);

ops.length = 0;
removeWorkForDay({ eqId: 'e1', eqName: 'E1', day: 7, type: 'ТО-1', dateStr: '' }, 'без даты');
assert('без даты операция не создаётся', ops.length === 0);

console.log('');
console.log(fails === 0 ? '!!! УДАЛЕНИЕ ЗАПИСЕЙ: ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ !!!' : ('!!! ПРОВАЛОВ: ' + fails + ' !!!'));
process.exit(fails === 0 ? 0 : 1);
`;

new Function('html', 'js', 'console', 'process', code)(html, js, console, process);
