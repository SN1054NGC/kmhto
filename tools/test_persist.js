const fs = require('fs');

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
let currentYear = 2026;
let equipmentData = [];
let allWorksCache = [];
let lastFileName = 'test.xlsx';
const store = {};
const localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; }
};
function alert(x){ console.log('  ALERT:', x); }
function showNotification(x){ console.log('  NOTIFY:', x); }
function renderScheduleTableFromData(){ }
function updateDataStatus(){ }
function forceParse(){ }
function confirm(){ return true; }
function commitOp(d, m){ if (m) m(); if (typeof commitChanges === 'function') commitChanges(); return { ok: true, op: {} }; }
`;

const wanted = ['loadMovedMarks','saveMovedMarks','markMoved','unmarkMoved','dateKeyFromMonthDay',
                'applyMove','applySwapByRef','applyPlan','clearMovedMarks',
                'saveEquipmentData','loadEquipmentData','clearEquipmentData','hasSavedEquipmentData',
                'mergeSavedSchedule','commitChanges','getExtraHolidays','isDayOff'];
let code = prelude + '\n';
for (const w of wanted) code += (extract(w) || ('// MISSING ' + w)) + '\n';

// EQ_DATA_KEY определена как var в теле скрипта — добавим вручную
code = 'var EQ_DATA_KEY = "kmhto_equipment_data";\n' + code;

code += `
let fails = 0;
function assert(name, cond) { if(!cond) fails++; console.log((cond?'  OK   ':'  FAIL ') + name); }

console.log('=== ПЕРСИСТЕНЦИЯ: сохранение/загрузка ===');
equipmentData = [{ name:'EQ1', id:'eq1', code:'1', toSchedule:{ 'январь':[{type:'ТО-1',day:5}] }, kmhSchedule:{}, hasKmh:false }];
saveEquipmentData();
assert('данные сохранены в localStorage', hasSavedEquipmentData());

// эмулируем перезагрузку: обнуляем и грузим
equipmentData = [];
var loaded = loadEquipmentData();
assert('loadEquipmentData вернул true', loaded === true);
assert('данные восстановлены (1 ед.)', equipmentData.length === 1);
assert('расписание восстановлено', JSON.stringify(equipmentData[0].toSchedule) === JSON.stringify({ 'январь':[{type:'ТО-1',day:5}] }));

console.log('=== commitChanges сохраняет ===');
localStorage.removeItem('kmhto_equipment_data');
equipmentData = [{ name:'EQ2', id:'eq2', code:'2', toSchedule:{}, kmhSchedule:{}, hasKmh:false }];
commitChanges();
assert('commitChanges сохранил', hasSavedEquipmentData());

console.log('=== merge: сохранённое накладывается по имени ===');
localStorage.removeItem('kmhto_equipment_data');
// сохранённые данные с расписанием
equipmentData = [{ name:'EQ1', id:'eq1', code:'1', toSchedule:{ 'январь':[{type:'ТО-1',day:5}] }, kmhSchedule:{}, hasKmh:false }];
saveEquipmentData();
// теперь "второй парсинг" дал ПУСТОЕ расписание
equipmentData = [{ name:'EQ1', id:'eq1', code:'1', toSchedule:{}, kmhSchedule:{}, hasKmh:false }];
mergeSavedSchedule();
assert('merge вернул расписание', JSON.stringify(equipmentData[0].toSchedule) === JSON.stringify({ 'январь':[{type:'ТО-1',day:5}] }));

console.log('=== выходные ===');
localStorage.setItem('extra_holidays', JSON.stringify(['2026-01-07']));
assert('суббота выходной', isDayOff(2026, 1, 3) === true);   // 2026-01-03 сб
assert('доп. выходной 07.01', isDayOff(2026, 1, 7) === true);
assert('обычный день не выходной', isDayOff(2026, 1, 8) === false);  // чт

console.log('');
console.log(fails === 0 ? '!!! ВСЕ ТЕСТЫ ПЕРСИСТЕНЦИИ ПРОШЛИ !!!' : ('!!! ПРОВАЛОВ: ' + fails + ' !!!'));
`;

fs.writeFileSync('tools/_persist.js', code);
require('child_process').execSync('node tools/_persist.js', { stdio: 'inherit' });
