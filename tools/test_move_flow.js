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
function renderScheduleTableFromData(){ console.log('  (render)'); }
function updateDataStatus(){}
function drawSwapArrow(){}
function getMonthNumber(m){ return ({'январь':1,'февраль':2,'март':3,'апрель':4,'май':5,'июнь':6,'июль':7,'август':8,'сентябрь':9,'октябрь':10,'ноябрь':11,'декабрь':12})[m]; }
function closeDialog(){}
function getExtraHolidays(){ return []; }
function commitOp(d, m){ if (m) m(); if (typeof commitChanges === 'function') commitChanges(); return { ok: true, op: {} }; }
`;

const wanted = ['loadMovedMarks','saveMovedMarks','markMoved','unmarkMoved','dateKeyFromMonthDay',
                'applyMove','applyMoveAndType','applyChangeType','_findRec',
                'saveEquipmentData','commitChanges'];
let code = 'var EQ_DATA_KEY = "kmhto_equipment_data";\n' + prelude + '\n';
for (const w of wanted) code += (extract(w) || ('// MISSING '+w)) + '\n';

code += `
let fails = 0;
function assert(n,c){ if(!c)fails++; console.log((c?'  OK   ':'  FAIL ')+n); }

console.log('=== ПОЛНЫЙ ЦИКЛ ПЕРЕНОСА (как из ПКМ) ===');
equipmentData = [{ id:'eq1', name:'EQ1', toSchedule:{ 'январь':[{type:'ТО-1',day:5}] }, kmhSchedule:{}, hasKmh:false }];
ctxTarget = { eqId:'eq1', eqName:'EQ1', type:'ТО-1', day:5, dateStr:'2026-01-05' };
try {
  applyMove(ctxTarget, '2026-03-20', 'причина');
  console.log('  applyMove выполнился без исключений');
} catch(e) { console.log('  ИСКЛЮЧЕНИЕ в applyMove:', e.message); fails++; }
assert('январь пуст', (equipmentData[0].toSchedule['январь']||[]).length === 0);
assert('март содержит ТО-1 день 20', equipmentData[0].toSchedule['март'] && equipmentData[0].toSchedule['март'][0].day === 20);

console.log('=== ПЕРЕНОС+ВИД (как из DnD) ===');
equipmentData = [{ id:'eq2', name:'EQ2', toSchedule:{ 'февраль':[{type:'ТО-1',day:10}] }, kmhSchedule:{}, hasKmh:false }];
ctxTarget = { eqId:'eq2', eqName:'EQ2', type:'ТО-1', day:10, dateStr:'2026-02-10' };
try {
  applyMoveAndType({ eqId:'eq2', eqName:'EQ2', type:'ТО-1', day:10, dateStr:'2026-02-10' }, '2026-05-15', 'ТО-3', 'dnd');
  console.log('  applyMoveAndType выполнился');
} catch(e) { console.log('  ИСКЛЮЧЕНИЕ:', e.message); fails++; }
assert('февраль пуст', (equipmentData[0].toSchedule['февраль']||[]).length === 0);
assert('май = ТО-3 (15)', equipmentData[0].toSchedule['май'] && equipmentData[0].toSchedule['май'][0].type === 'ТО-3');

console.log('=== commitChanges не падает ===');
try { commitChanges(); console.log('  commitChanges OK'); } catch(e){ console.log('  ИСКЛЮЧЕНИЕ commitChanges:', e.message); fails++; }

console.log('');
console.log(fails===0 ? '!!! ПЕРЕНОС РАБОТАЕТ !!!' : ('!!! ПРОВАЛОВ: '+fails+' !!!'));
`;

fs.writeFileSync('tools/_moveflow.js', code);
require('child_process').execSync('node tools/_moveflow.js', { stdio: 'inherit' });
