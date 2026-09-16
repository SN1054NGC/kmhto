const fs = require('fs');
const html = fs.readFileSync('app_kmhto.html', 'utf8');
const js = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function extract(name) {
  const re = new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const mm = re.exec(js);
  if (!mm) return null;
  let i = mm.index, depth = 0, j = js.indexOf('{', i);
  for (; j < js.length; j++) { if (js[j]==='{') depth++; else if (js[j]==='}') { depth--; if (depth===0){j++;break;} } }
  return js.slice(i, j);
}

const prelude = `
let currentYear = 2026;
let equipmentData = [];
let allWorksCache = [];
let ctxTarget = null;
let lastFileName = '';
const store = {};
const localStorage = { getItem:(k)=>k in store?store[k]:null, setItem:(k,v)=>{store[k]=String(v);}, removeItem:(k)=>{delete store[k];} };
function alert(x){ console.log('  ALERT:', x); }
function showNotification(x){ console.log('  NOTIFY:', x); }
function renderScheduleTableFromData(){}
function updateDataStatus(){}
function drawSwapArrow(){}
function getMonthNumber(m){ return ({'январь':1,'февраль':2,'март':3,'апрель':4,'май':5,'июнь':6,'июль':7,'август':8,'сентябрь':9,'октябрь':10,'ноябрь':11,'декабрь':12})[m]; }
function commitOp(d, m){ if (m) m(); if (typeof commitChanges === 'function') commitChanges(); return { ok: true, op: {} }; }
`;

const wanted = ['loadMovedMarks','saveMovedMarks','markMoved','unmarkMoved','dateKeyFromMonthDay',
                'applyMove','removeWorkForDay','saveEquipmentData','commitChanges'];
let code = 'var EQ_DATA_KEY = "kmhto_equipment_data";\n' + prelude + '\n';
for (const w of wanted) code += (extract(w) || ('// MISSING ' + w)) + '\n';

code += `
let fails = 0;
function assert(n,c){ if(!c)fails++; console.log((c?'  OK   ':'  FAIL ')+n); }

console.log('=== ТОЧНЫЙ ПЕРЕНОС: в ячейке несколько записей ===');
// В феврале: ТО-3 (20), ТО-1 (02), ТО-1 (13) — как в реальных данных
equipmentData = [{
  id:'eq1', name:'Оборудование xxxxzx',
  toSchedule: { 'февраль': [ {type:'ТО-3',day:20}, {type:'ТО-1',day:2}, {type:'ТО-1',day:13} ] },
  kmhSchedule: {}, hasKmh:false
}];
ctxTarget = { eqId:'eq1', eqName:'Оборудование xxxxzx', type:'ТО-1', day:13, dateStr:'2026-02-13' };
// Переносим именно ТО-1 день 13
applyMove({ eqId:'eq1', eqName:'Оборудование xxxxzx', type:'ТО-1', day:13, dateStr:'2026-02-13' }, '2026-02-28', 'тест');
var feb = equipmentData[0].toSchedule['февраль'];
console.log('  февраль:', JSON.stringify(feb));
assert('в феврале 3 записи (13 перенесён в 28 внутри месяца)', feb.length === 3);
assert('ТО-3 (20) не тронут', feb.some(w=>w.type==='ТО-3'&&w.day===20));
assert('ТО-1 (02) не тронут', feb.some(w=>w.type==='ТО-1'&&w.day===2));
assert('ТО-1 (13) перенесён (нет в фев)', !feb.some(w=>w.type==='ТО-1'&&w.day===13));
var feb2 = equipmentData[0].toSchedule['февраль'];
assert('ТО-1 (28) добавлен', feb2.some(w=>w.type==='ТО-1'&&w.day===28));

console.log('=== КМХ переносится в kmhSchedule, ТО не задет ===');
equipmentData = [{
  id:'eq2', name:'EQ2',
  toSchedule: { 'март': [ {type:'ТО-1',day:15} ] },
  kmhSchedule: { 'март': [15, 27] }, hasKmh:true
}];
ctxTarget = { eqId:'eq2', type:'КМХ', day:27, dateStr:'2026-03-27' };
applyMove({ eqId:'eq2', type:'КМХ', day:27, dateStr:'2026-03-27' }, '2026-04-10', 'кмх');
assert('ТО-1 (15) в марте не тронут', equipmentData[0].toSchedule['март'].some(w=>w.day===15));
assert('КМХ 15 остался', equipmentData[0].kmhSchedule['март'].indexOf(15) !== -1);
assert('КМХ 27 ушёл из марта', equipmentData[0].kmhSchedule['март'].indexOf(27) === -1);
assert('КМХ 10 в апреле', (equipmentData[0].kmhSchedule['апрель']||[]).indexOf(10) !== -1);

console.log('=== УДАЛЕНИЕ точной записи ===');
equipmentData = [{ id:'eq3', name:'EQ3', toSchedule:{ 'январь':[ {type:'ТО-1',day:5}, {type:'ТО-2',day:5} ] }, kmhSchedule:{}, hasKmh:false }];
ctxTarget = { eqId:'eq3', type:'ТО-1', day:5, dateStr:'2026-01-05' };
removeWorkForDay({ eqId:'eq3', eqName:'EQ3', type:'ТО-1', day:5, dateStr:'2026-01-05' });
var jan = equipmentData[0].toSchedule['январь'];
assert('ТО-1 (5) удалён', !jan.some(w=>w.type==='ТО-1'&&w.day===5));
assert('ТО-2 (5) остался', jan.some(w=>w.type==='ТО-2'&&w.day===5));

console.log('');
console.log(fails===0 ? '!!! ВСЕ ТЕСТЫ ТОЧНОГО ПЕРЕНОСА ПРОШЛИ !!!' : ('!!! ПРОВАЛОВ: '+fails+' !!!'));
`;

fs.writeFileSync('tools/_precise.js', code);
require('child_process').execSync('node tools/_precise.js', { stdio: 'inherit' });
