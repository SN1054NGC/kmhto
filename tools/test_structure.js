const fs = require('fs');
const vm = require('vm');
const html = fs.readFileSync('app_kmhto.html', 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const js = scripts[scripts.length - 1];

// ---------- mock-таблица как в SheetJS ----------
function colName(c) { let s = ''; c++; while (c > 0) { const r = (c - 1) % 26; s = String.fromCharCode(65 + r) + s; c = Math.floor((c - 1) / 26); } return s; }
function addr(r, c) { return colName(c) + (r + 1); }
function makeSheet(aoa, merges) {
  const sh = { '!merges': merges || [] };
  aoa.forEach((row, r) => row.forEach((v, c) => { if (v !== '' && v !== null && v !== undefined) sh[addr(r, c)] = { t: typeof v === 'number' ? 'n' : 's', v: v }; }));
  return sh;
}
const XLSX = {
  utils: {
    encode_cell: (o) => addr(o.r, o.c),
    sheet_to_json: (sh) => {
      let maxR = 0, maxC = 0;
      Object.keys(sh).forEach(k => { if (k[0] === '!') return; const m = k.match(/^([A-Z]+)(\d+)$/); if (!m) return; const r = +m[2] - 1; let c = 0; for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64); maxR = Math.max(maxR, r); maxC = Math.max(maxC, c - 1); });
      const out = [];
      for (let r = 0; r <= maxR; r++) { const row = []; for (let c = 0; c <= maxC; c++) { const cell = sh[addr(r, c)]; row.push(cell ? cell.v : ''); } out.push(row); }
      return out;
    },
    book_new: () => ({}), aoa_to_sheet: (a) => ({ a }), book_append_sheet: () => {}, writeFile: () => {},
  },
  read: () => ({}), write: () => '',
};

function stub(id) {
  return { id, innerHTML: '', textContent: '', value: '', checked: true, disabled: false, style: {}, dataset: {}, className: '', classList: { add(){}, remove(){}, toggle(){} }, querySelectorAll: () => [], querySelector: () => null, appendChild(){}, addEventListener(){}, onclick: null };
}
const store = {};
const ctx = {
  console, XLSX, setTimeout, clearTimeout, Math, Date, JSON, RegExp, String, Number, Array, Object, parseInt, parseFloat, isNaN, Set, Map, Blob: function(){}, URL: { createObjectURL: () => '', revokeObjectURL: () => {} }, alert: () => {},
  localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
  document: { _els: {}, getElementById(id) { return this._els[id] || (this._els[id] = stub(id)); }, querySelectorAll: () => [], querySelector: () => null, addEventListener(){}, createElement: () => stub('tmp'), body: { appendChild(){}, removeChild(){}, style: {} } },
  window: { innerWidth: 1200, innerHeight: 800 },
  FileReader: function(){},
};
ctx.globalThis = ctx;
ctx.makeSheet = makeSheet;
ctx.addr = addr;
vm.createContext(ctx);
vm.runInContext(js, ctx, { filename: 'app.js' });

const hook = String.raw`
var __r = [];
function ok(n, c, x) { __r.push((c ? 'OK   ' : 'FAIL ') + n + (x !== undefined ? ' [' + x + ']' : '')); }
var M = MONTH_FULL ? MONTH_FULL : ['январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'];

// --- 1. распознавание месяца в заголовке ---
ok('детект "январь" -> 1', detectMonthFromHeader('январь') === 1);
ok('детект "янв." -> 1', detectMonthFromHeader('янв.') === 1);
ok('детект "март" -> 3', detectMonthFromHeader('март') === 3);
ok('детект "маркировка" -> 0', detectMonthFromHeader('маркировка') === 0);
ok('детект "01.2026" -> 1', detectMonthFromHeader('01.2026') === 1);
ok('детект "дек 2026" -> 12', detectMonthFromHeader('дек 2026') === 12);

// --- 2. реальная структура листа ТО ---
currentYear = 2026;
var head = ['№ п/п', 'Код СИ/ оборудования', 'Наименование СИ и оборудования', 'Место установки'].concat(M);
var toAoa = [
  head,
  [1, 7, 'Оборудование A', 'ВАЫФА № 1321', 'ТО-3 (20)', 'ТО-1 (2)', 'ТО-1 (13)', '', '', 'ТО-3(10)', 'ТО-2 (14)', '', '', '', '', '', ''],
  [2, 8, 'Оборудование B', 'УЗ-12', 'ТО-3 (20)', 'ТО-1 (8)', '', '', '', 'ТО-3 (10)', '', '', '', '', '', '', ''],
];
var toSheet = makeSheet(toAoa, []);
lastWorkbook = { SheetNames: ['1', '3', 'data'], Sheets: { '1': toSheet, '3': toSheet, 'data': toSheet } };

var lay = detectSheetLayout(toSheet);
ok('шапка найдена в строке 1', lay.headerRow === 1, lay.headerRow);
ok('12 месяцев найдено', lay.months === 12, lay.months);
ok('первый месяц = колонка 4 (E)', lay.firstMonthCol === 4, lay.firstMonthCol);
ok('колонки: код=1 имя=2 место=3', lay.cols.code === 1 && lay.cols.name === 2 && lay.cols.location === 3, JSON.stringify(lay.cols));

resetParseIssues();
var items = parseSheet(lastWorkbook, { sheetName: '1', headerRow: 1, dataStart: 2, colId: 0, colCode: 1, colLocation: 3, colName: 2, monthStart: 4 }, 'to', 2026);
ok('распарсено 2 единицы', items.length === 2, items.length);
ok('имя и место не перепутаны', items[0].name === 'Оборудование A' && items[0].location === 'ВАЫФА № 1321', items[0].name + ' / ' + items[0].location);
ok('январь = ТО-3 (20)', items[0].monthData['январь'] && items[0].monthData['январь'].type === 'ТО-3' && items[0].monthData['январь'].day === 20);
ok('июнь = ТО-3(10)', items[0].monthData['июнь'] && items[0].monthData['июнь'].day === 10, JSON.stringify(items[0].monthData['июнь']));
ok('декабрь пуст (нет ложного месяца)', items[0].monthData['декабрь'] === undefined);

// --- 3. КМХ-дни ---
var kmhAoa = [head, [1, 7, 'Оборудование A', 'ВАЫФА', '14,\n20,\n2', '12,22 27 ', '', '', '', '', '', '', '', '', '', '', '']];
lastWorkbook.Sheets['3'] = makeSheet(kmhAoa, []);
var kItems = parseSheet(lastWorkbook, { sheetName: '3', headerRow: 1, dataStart: 2, colId: 0, colCode: 1, colLocation: 3, colName: 2, monthStart: 4 }, 'kmh', 2026);
ok('КМХ январь дни [2,14,20]', JSON.stringify(kItems[0].monthData['январь']) === '[2,14,20]', JSON.stringify(kItems[0].monthData['январь']));
ok('КМХ февраль дни [12,22,27]', JSON.stringify(kItems[0].monthData['февраль']) === '[12,22,27]', JSON.stringify(kItems[0].monthData['февраль']));

// --- 4. merged-ячейки ---
var mAoa = [head,
  [1, 7, 'Оборудование A', 'ВАЫФА', 'ТО-1 (5)', '', '', '', '', '', '', '', '', '', '', '', ''],
  ['', 8, '', 'УЗ-12', 'ТО-1 (6)', '', '', '', '', '', '', '', '', '', '', '', '']];
// C2:C3 объединена по вертикали (номер п/п и имя)
var mSheet = makeSheet(mAoa, [{ s: { r: 1, c: 0 }, e: { r: 2, c: 0 } }, { s: { r: 1, c: 2 }, e: { r: 2, c: 2 } }]);
lastWorkbook.Sheets['1'] = mSheet;
var mItems = parseSheet(lastWorkbook, { sheetName: '1', headerRow: 1, dataStart: 2, colId: 0, colCode: 1, colLocation: 3, colName: 2, monthStart: 4 }, 'to', 2026);
ok('merged: восстановлены 2 строки', mItems.length === 2, mItems.length);
ok('merged: имя протянуто во 2-ю строку', mItems[1] && mItems[1].name === 'Оборудование A', mItems[1] && mItems[1].name);
ok('merged: № п/п протянут во 2-ю строку', mItems[1] && mItems[1].originalId === '1', mItems[1] && mItems[1].originalId);

// --- 5. широкий формат норм (лист data) + дубль ТО-2 вместо ТО-3 ---
var normHead = ['код оборудования', 'Наименование СИ и оборудования',
  'Работы при ТО-1', 'Количество ТО-1 в год должно быть',
  'Работы при ТО-2', 'Количество ТО-2 в год должно быть',
  'Работы при ТО-3', 'Количество ТО-2 в год должно быть',
  'Количество КМХ в году сколько должно быть'];
var normAoa = [normHead, [7, 'Оборудование A', '', 11, '', 2, '', 1, 11], [8, 'Оборудование B', '', 8, '', 3, '', 0, 8]];
lastWorkbook.Sheets['data'] = makeSheet(normAoa, []);
var norms = parseNormData();
ok('нормы: 2 единицы', norms && Object.keys(norms).length === 2, norms && Object.keys(norms).join(','));
ok('нормы ТО-1 = 11', norms['7'] && norms['7'].types['ТО-1'] && norms['7'].types['ТО-1'].count === 11, norms['7'] && JSON.stringify(norms['7'].types['ТО-1']));
ok('нормы ТО-3 = 1 (из дубля заголовка)', norms['7'] && norms['7'].types['ТО-3'] && norms['7'].types['ТО-3'].count === 1, norms['7'] && JSON.stringify(norms['7'].types['ТО-3']));
ok('нормы КМХ = 11', norms['7'] && norms['7'].types['КМХ'] && norms['7'].types['КМХ'].count === 11);
ok('нормы ТО-2 = 2', norms['7'] && norms['7'].types['ТО-2'] && norms['7'].types['ТО-2'].count === 2);

// --- 6. допуск ± дней: сдвиг с субботы на рабочий ---
var sn = snapDayWithinMonth(2026, 'январь', 3, 2); // 03.01.2026 — суббота
ok('сдвиг с субботы в пределах допуска', sn === 2 || sn === 5, sn);
ok('нулевой допуск не меняет дату', snapDayWithinMonth(2026, 'январь', 3, 0) === 3);

// --- 7. многострочная шапка реального файла: строки 1) названия 2) месяцы 3) «(число)» ---
var hdrNames = ['№ п/п', 'Код СИ/ обору- дования', 'Место установки', 'Наименование СИ и оборудования',
  'Место установки', 'Вид (ТО-1, ТО-2, ТО-3) технического обслуживания'];
while (hdrNames.length < 17) hdrNames.push('');
var hdrMonths = ['', '', '', '', ''];
for (var mi = 0; mi < 12; mi++) hdrMonths.push(M[mi]);
var hdrNumbers = ['', '', '', '', ''];
for (var mi2 = 0; mi2 < 12; mi2++) hdrNumbers.push('(число)');
var dataRow = ['1', '7', 'Объект  № 101', 'Преобразователь расхода', 'Объект  № 101',
  'ТО-3 (20)', 'ТО-1 (18)', 'ТО-1 (13)', 'ТО-1 (16)', 'ТО-1 (14)', 'ТО-1 (30)', 'ТО-3 (10)',
  'ТО-2 (14)', 'ТО-1 (13)', 'ТО-1 (13)', 'ТО-1 (13)', 'ТО-1 (13)'];

var realSheet = makeSheet([hdrNames, hdrMonths, hdrNumbers, dataRow], []);
lastWorkbook = { SheetNames: ['1'], Sheets: { '1': realSheet } };
var layReal = detectSheetLayout(realSheet);
ok('многострочная шапка: месяцы в строке 2', layReal.headerRow === 2, layReal.headerRow);
ok('многострочная шапка: данные с 4-й строки', layReal.dataStart === 4, layReal.dataStart);
ok('многострочная шапка: имя=D(3), место=C(2)', layReal.cols.name === 3 && layReal.cols.location === 2, JSON.stringify(layReal.cols));
ok('многострочная шапка: первый месяц = F(5)', layReal.firstMonthCol === 5, layReal.firstMonthCol);
var realItems = parseSheet(lastWorkbook, {
  sheetName: '1', headerRow: layReal.headerRow, dataStart: layReal.dataStart,
  colId: layReal.cols.id, colCode: layReal.cols.code, colName: layReal.cols.name,
  colLocation: layReal.cols.location, monthStart: layReal.firstMonthCol
}, 'to', 2026);
ok('многострочная шапка: разобрана 1 единица', realItems.length === 1, realItems.length);
ok('многострочная шапка: имя и место НЕ перепутаны',
   realItems[0] && realItems[0].name === 'Преобразователь расхода' && realItems[0].location === 'Объект  № 101',
   realItems[0] && (realItems[0].name + ' / ' + realItems[0].location));
ok('многострочная шапка: январь = ТО-3 (20)', realItems[0] && realItems[0].monthData['январь'] && realItems[0].monthData['январь'].day === 20);

// --- 8. узкий формат норм: «Вид ТО» + «Кол-во» + «Годовые» (лист «коды») ---
var normHead2 = ['Код СИ/ оборудования)', 'Наименование оборудования', 'Вид ТО', 'Кол-во ТО',
  'Нормы времени на одно ТО  ВСЕГО', 'Нормы времени на одно ТО  ВСЕГО', 'Годовые нормы времени по видам ТО',
  'Ссылка на Технологическую карту'];
var normAoa2 = [normHead2,
  ['', '', '', 'в год', '', '', '', ''],
  ['1', 'Шкаф электроники', 'ТО-1', 11, 1, 1, 11, 'TK-1.pdf'],
  ['1', 'Шкаф электроники', 'ТО-3', 1, 20.4, 20.4, 20.4, 'TK-1.pdf'],
  ['7', 'Преобразователь расхода', 'КМХ', 11, 2.2, 2.2, 24.2, 'https://example.org/tk7']];
lastWorkbook.Sheets['коды'] = makeSheet(normAoa2, []);
document.getElementById('settingNormSheet').value = 'коды';
var norms2 = parseNormData();
ok('узкий формат норм: 2 кода', norms2 && Object.keys(norms2).length === 2, norms2 && Object.keys(norms2).join(','));
ok('узкий формат норм: «Годовые» не перебил «Вид ТО»', norms2['1'] && !!norms2['1'].types['ТО-1'], norms2['1'] && Object.keys(norms2['1'].types).join(','));
ok('узкий формат норм: кол-во ТО-1 = 11', norms2['1'] && norms2['1'].types['ТО-1'] && norms2['1'].types['ТО-1'].count === 11, norms2['1'] && JSON.stringify(norms2['1'].types['ТО-1']));
ok('узкий формат норм: годы по ТО-1 = 11', norms2['1'] && norms2['1'].types['ТО-1'] && norms2['1'].types['ТО-1'].yearTime === 11, norms2['1'] && norms2['1'].types['ТО-1'] && norms2['1'].types['ТО-1'].yearTime);
ok('ссылка на технологическую карту прочитана', norms2['1'] && norms2['1'].tk === 'TK-1.pdf', norms2['1'] && norms2['1'].tk);
ok('ссылка на ТК может быть URL', norms2['7'] && /^https:/.test(norms2['7'].tk), norms2['7'] && norms2['7'].tk);

__r;
`;
const res = vm.runInContext(hook, ctx, { filename: 'hook.js' });
console.log(res.join('\n'));
const fails = res.filter(x => x.indexOf('FAIL') === 0).length;
console.log('');
console.log(fails === 0 ? '!!! СТРУКТУРА, MERGED, НОРМЫ, ДОПУСК — ВСЁ ОК !!!' : ('!!! ПРОВАЛОВ: ' + fails + ' !!!'));
process.exit(fails === 0 ? 0 : 1);
