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
                'applyChangeType','applyMoveAndType','_findRec','saveEquipmentData','commitChanges'];
let code = 'var EQ_DATA_KEY = "kmhto_equipment_data";\n' + prelude + '\n';
for (const w of wanted) code += (extract(w) || ('// MISSING ' + w)) + '\n';

code += `
let fails = 0;
function assert(n,c){ if(!c)fails++; console.log((c?'  OK   ':'  FAIL ')+n); }

console.log('=== ИЗМЕНЕНИЕ ВИДА ТО (в пределах одного расписания) ===');
equipmentData = [{ id:'eq1', name:'EQ1', toSchedule:{ 'февраль':[ {type:'ТО-1',day:13}, {type:'ТО-3',day:20} ] }, kmhSchedule:{}, hasKmh:false }];
applyChangeType({ eqId:'eq1', eqName:'EQ1', type:'ТО-1', day:13, dateStr:'2026-02-13' }, 'ТО-2', 'по приказу');
var feb = equipmentData[0].toSchedule['февраль'];
console.log('  февраль:', JSON.stringify(feb));
assert('ТО-1 (13) стал ТО-2 (13)', feb.some(w=>w.type==='ТО-2'&&w.day===13));
assert('ТО-3 (20) не тронут', feb.some(w=>w.type==='ТО-3'&&w.day===20));
assert('метка поставлена (по id)', !!loadMovedMarks()['eq1|2026-02-13']);

console.log('=== ТО -> КМХ (перенос между массивами) ===');
equipmentData = [{ id:'eq2', name:'EQ2', toSchedule:{ 'март':[ {type:'ТО-1',day:10} ] }, kmhSchedule:{}, hasKmh:false }];
applyChangeType({ eqId:'eq2', eqName:'EQ2', type:'ТО-1', day:10, dateStr:'2026-03-10' }, 'КМХ', 'стало КМХ');
assert('ТО-1 убран из toSchedule', (equipmentData[0].toSchedule['март']||[]).length === 0);
assert('КМХ 10 добавлен', (equipmentData[0].kmhSchedule['март']||[]).indexOf(10) !== -1);
assert('hasKmh=true', equipmentData[0].hasKmh === true);

console.log('=== ПЕРЕНОС + ИЗМЕНЕНИЕ ВИДА ===');
equipmentData = [{ id:'eq3', name:'EQ3', toSchedule:{ 'апрель':[ {type:'ТО-2',day:5} ] }, kmhSchedule:{}, hasKmh:false }];
applyMoveAndType({ eqId:'eq3', eqName:'EQ3', type:'ТО-2', day:5, dateStr:'2026-04-05' }, '2026-06-20', 'ТО-3', 'перенос+смена');
assert('апрель пуст', (equipmentData[0].toSchedule['апрель']||[]).length === 0);
assert('июнь = ТО-3 (20)', JSON.stringify(equipmentData[0].toSchedule['июнь']) === JSON.stringify([{type:'ТО-3',day:20}]));
assert('метка на новой дате (по id)', !!loadMovedMarks()['eq3|2026-06-20']);

console.log('');
console.log(fails===0 ? '!!! ВСЕ ТЕСТЫ ИЗМЕНЕНИЯ ВИДА ПРОШЛИ !!!' : ('!!! ПРОВАЛОВ: '+fails+' !!!'));
`;

fs.writeFileSync('tools/_changetype.js', code);
require('child_process').execSync('node tools/_changetype.js', { stdio: 'inherit' });
