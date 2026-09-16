const fs = require('fs');
const vm = require('vm');
const html = fs.readFileSync('app_kmhto.html', 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const js = scripts[scripts.length - 1];

const XLSX = {
  utils: {
    encode_cell: (o) => 'cell', sheet_to_json: () => [], book_new: () => ({}),
    aoa_to_sheet: () => ({}), book_append_sheet: () => {}, writeFile: () => {},
  },
  read: () => ({}), write: () => '',
};
function stub(id) {
  return { id, innerHTML: '', textContent: '', value: '', checked: true, disabled: false, style: {}, dataset: {}, className: '', classList: { add(){}, remove(){}, toggle(){} }, querySelectorAll: () => [], querySelector: () => null, appendChild(){}, insertBefore(){}, removeChild(){}, addEventListener(){}, onclick: null, childNodes: [], firstChild: null, lastChild: null };
}
const store = {};
const ctx = {
  console, XLSX, setTimeout, clearTimeout, Math, Date, JSON, RegExp, String, Number, Array, Object, parseInt, parseFloat, isNaN, Set, Map,
  Blob: function(){}, URL: { createObjectURL: () => '', revokeObjectURL: () => {} }, alert: () => {},
  localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
  document: { _els: {}, getElementById(id) { return this._els[id] || (this._els[id] = stub(id)); }, querySelectorAll: () => [], querySelector: () => null, addEventListener(){}, createElement: () => stub('tmp'), body: { appendChild(){}, removeChild(){}, style: {} } },
  window: { innerWidth: 1200, innerHeight: 800 },
  FileReader: function(){},
};
ctx.globalThis = ctx;
ctx.store = store;
vm.createContext(ctx);
vm.runInContext(js, ctx, { filename: 'app.js' });

const hook = String.raw`
var __r = [];
function ok(n, c, x) { __r.push((c ? 'OK   ' : 'FAIL ') + n + (x !== undefined ? ' [' + x + ']' : '')); }
function item(originalId, code, serial, name) {
  return { originalId: originalId, code: code, serialNumber: serial, name: name, location: 'МЕСТО ' + originalId, section: 'СЕК', type: 'Тип', sheetType: 'to', monthData: {} };
}
currentYear = 2026;

// --- 1. Стабильные id ---
ok('id зависит от кода+зав.№, а не от № п/п',
   buildEquipmentId('7', '4234234', '1') === buildEquipmentId('7', '4234234', '3'),
   buildEquipmentId('7', '4234234', '1'));
ok('без зав.№ id опирается на № п/п',
   buildEquipmentId('7', '', '1') !== buildEquipmentId('7', '', '2'));
ok('разный код -> разный id',
   buildEquipmentId('7', 'SN1', '1') !== buildEquipmentId('8', 'SN1', '1'));

var A = aggregateData([item('1','7','SN1','Имя A'), item('2','8','SN2','Имя B')]);
var B = aggregateData([item('2','8','SN2','Имя B'), item('1','7','SN1','Имя A')]);
ok('id не зависят от порядка строк', A.map(function(e){return e.id;}).sort().join(',') === B.map(function(e){return e.id;}).sort().join(','), A.map(function(e){return e.id;}).sort().join(','));
ok('сохранён legacyId', A[0].legacyId === 'eq_1_7', A[0].legacyId);
ok('версия стартует с 0', A[0].version === 0);

// --- 2. Миграция меток / доп. данных / линий ---
equipmentData = A;
var eqA = A[0];
localStorage.setItem('moved_marks', JSON.stringify({ 'Имя A|2026-01-05': { reason: 'старая метка' } }));
localStorage.setItem('to_kmh_additional_data', JSON.stringify({ version: 2, byYear: { '2026': {} } }));
var add0 = JSON.parse(localStorage.getItem('to_kmh_additional_data'));
add0.byYear['2026'][eqA.legacyId] = { K: 'значение' };
localStorage.setItem('to_kmh_additional_data', JSON.stringify(add0));
localStorage.setItem('kmhto_dnd_arrows', JSON.stringify([{ eqId: eqA.legacyId, fromDay: 1, fromMonth: 1, toDay: 2, toMonth: 2 }]));

migrateLocalState();

var marks = JSON.parse(localStorage.getItem('moved_marks'));
ok('метка перенесена на id', !!marks[eqA.id + '|2026-01-05'], Object.keys(marks).join(','));
var add1 = JSON.parse(localStorage.getItem('to_kmh_additional_data'));
ok('доп.данные перенесены на id', !!add1.byYear['2026'][eqA.id], Object.keys(add1.byYear['2026']).join(','));
var arrows = JSON.parse(localStorage.getItem('kmhto_dnd_arrows'));
ok('линия перестановки перенесена на id', arrows[0].eqId === eqA.id, arrows[0].eqId);

// --- 3. commitOp: журнал и версии ---
var r1 = commitOp({ kind: 'move_work', eqId: eqA.id, from: { month: 'январь', day: 5 }, to: { date: '2026-02-10' }, comment: 'тест' }, function() {
  eqA.toSchedule['февраль'] = [{ type: 'ТО-1', day: 10 }];
});
ok('commitOp вернул ok', r1 && r1.ok === true);
ok('версия оборудования выросла', findEquipment(eqA.id).version === 1, findEquipment(eqA.id).version);
var log = getOpLog();
ok('операция записана в журнал', log.length === 1, log.length);
var op = log[0];
ok('в операции есть opId и автор', !!op.opId && op.authorId === 'local', op.opId);
ok('baseVersion зафиксирован', op.baseVersion[eqA.id] === 0, JSON.stringify(op.baseVersion));
ok('версия операции = 1', op.versions[eqA.id] === 1, JSON.stringify(op.versions));
ok('сохранён комментарий', op.comment === 'тест');
ok('правка сохранена в расписании', JSON.stringify(eqA.toSchedule['февраль']) === JSON.stringify([{ type: 'ТО-1', day: 10 }]));

commitOp({ kind: 'add_work', eqId: eqA.id, to: { month: 'март', day: 3, type: 'ТО-3' } }, function(){});
ok('вторая операция: версия 2', findEquipment(eqA.id).version === 2, findEquipment(eqA.id).version);
ok('в журнале 2 операции', getOpLog().length === 2, getOpLog().length);

// --- 4. документная операция (праздник) ---
var v0 = getDocVersion();
commitOp({ kind: 'holiday', eqId: null, to: { date: '2026-01-07', holiday: true } }, function(){});
ok('документная версия выросла', getDocVersion() === v0 + 1, getDocVersion());

// --- 5. ошибка в mutate не ломает версии ---
var vB = findEquipment(eqA.id).version;
var bad = commitOp({ kind: 'move_work', eqId: eqA.id }, function(){ throw new Error('сломалось'); });
ok('ошибка mutate -> ok:false', bad && bad.ok === false, bad && bad.reason);
ok('версия не выросла при ошибке', findEquipment(eqA.id).version === vB, findEquipment(eqA.id).version);

// --- 6. лимит журнала ---
OPLOG_LIMIT = 3;
for (var i = 0; i < 5; i++) commitOp({ kind: 'add_work', eqId: eqA.id }, function(){});
ok('журнал обрезается по лимиту', getOpLog().length === 3, getOpLog().length);

// --- 7. merge по legacyId ---
localStorage.removeItem('kmhto_equipment_data');
equipmentData = aggregateData([item('1','7','SN1','Имя A')]);
equipmentData[0].toSchedule = {};
saveEquipmentData();
// подменяем сохранённую запись на «старую» (id прежней схемы)
var pl = JSON.parse(localStorage.getItem('kmhto_equipment_data'));
pl.data[0].id = equipmentData[0].legacyId;
pl.data[0].toSchedule = { 'январь': [{ type: 'ТО-2', day: 9 }] };
pl.data[0].version = 7;
localStorage.setItem('kmhto_equipment_data', JSON.stringify(pl));
mergeSavedSchedule();
ok('merge по legacyId вернул расписание', JSON.stringify(equipmentData[0].toSchedule) === JSON.stringify({ 'январь': [{ type: 'ТО-2', day: 9 }] }));
ok('версия подхвачена из сохранения', equipmentData[0].version === 7, equipmentData[0].version);

__r;
`;
const res = vm.runInContext(hook, ctx, { filename: 'hook_ops.js' });
console.log(res.join('\n'));
const fails = res.filter(x => x.indexOf('FAIL') === 0).length;
console.log('');
console.log(fails === 0 ? '!!! ЭТАП 0: ID, МИГРАЦИИ, ОПЕРАЦИИ — ВСЁ ОК !!!' : ('!!! ПРОВАЛОВ: ' + fails + ' !!!'));
process.exit(fails === 0 ? 0 : 1);
