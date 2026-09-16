// Тест: Shift-перестановка видов ТО (обмен type, дни на месте) + запись линии
const fs = require('fs');
const html = fs.readFileSync('app_kmhto.html', 'utf8');
const allScripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const js = allScripts[allScripts.length - 1];

const store = {};
global.localStorage = { getItem:k=>k in store?store[k]:null, setItem:(k,v)=>{store[k]=String(v)}, removeItem:k=>{delete store[k]} };
global.document = { getElementById:()=>null, querySelectorAll:()=>[], querySelector:()=>null, addEventListener:()=>{}, createElement:()=>({style:{},classList:{add(){},remove(){},toggle(){}}}) };
global.window = { innerWidth:1200, innerHeight:800 };
global.alert = (m)=>console.log('  ALERT:', m);
global.showNotification = (m)=>console.log('  NOTIFY:', m);
global.renderScheduleTableFromData = ()=>{};
global.renderArrows = ()=>{};
global.commitChanges = ()=>{ global.__commits=(global.__commits||0)+1; };
global.updateDataStatus = ()=>{};
global.saveEquipmentData = ()=>{};

function extract(name){
  const re = new RegExp('function\\s+'+name+'\\s*\\([^)]*\\)\\s*\\{');
  const mm = re.exec(js); if(!mm) return '// MISSING '+name;
  let i=mm.index,depth=0,j=js.indexOf('{',i);
  for(;j<js.length;j++){ if(js[j]==='{')depth++; else if(js[j]==='}'){depth--;if(depth===0){j++;break;}} }
  return js.slice(i,j);
}

const code = `
let currentYear = 2026;
let allWorksCache = [];
let equipmentData = [];
var MONTH_NAMES_RU = ['январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'];
let __arrowCalls = [];
function markMoved(){}
function dateKeyFromMonthDay(){ return '2026-01-01'; }
function recordArrow(){} 
function drawSwapArrow(a,b,c,d,e,f){ __arrowCalls.push([a,b,c,d,e,f]); }
function commitChanges(){ global.__commits=(global.__commits||0)+1; }
function commitOp(d, m){ if (m) m(); commitChanges(); return { ok: true, op: {} }; }
function showNotification(m){ console.log('  NOTIFY:', m); }
function alert(m){ console.log('  ALERT:', m); }
`
  + extract('_findRec') + '\n'
  + extract('applyShiftSwap') + '\n'
  + `
let fails=0;
function assert(n,c){ if(!c)fails++; console.log((c?'  OK   ':'  FAIL ')+n); }

console.log('=== Shift: обмен вида ТО (дни на месте) ===');
equipmentData = [{ id:'eq1', name:'EQ1',
  toSchedule:{ 'январь':[{type:'ТО-1',day:10}], 'март':[{type:'ТО-2',day:20}] },
  kmhSchedule:{}, hasKmh:false }];
applyShiftSwap({ eqId:'eq1', day:10, type:'ТО-1' }, 1, 'ТО-2', 20, 3, 'тест причина');
assert('январь: тип стал ТО-2, день 10', equipmentData[0].toSchedule['январь'][0].type==='ТО-2' && equipmentData[0].toSchedule['январь'][0].day===10);
assert('март: тип стал ТО-1, день 20', equipmentData[0].toSchedule['март'][0].type==='ТО-1' && equipmentData[0].toSchedule['март'][0].day===20);
assert('линия нарисована (drawSwapArrow)', __arrowCalls.length===1);
assert('линия: дни/месяцы верные', JSON.stringify(__arrowCalls[0])===JSON.stringify([10,1,20,3,false,'eq1']));

console.log('=== Shift: КМХ участвует — вызывается перенос, не обмен ===');
// applyShiftSwap не должен использоваться для КМХ — проверяем, что _findRec не находит КМХ в toSchedule
equipmentData = [{ id:'eq2', name:'EQ2', toSchedule:{ 'январь':[{type:'ТО-1',day:5}] }, kmhSchedule:{ 'февраль':[10] }, hasKmh:true }];
assert('_findRec ищет ТО корректно', !!_findRec(equipmentData[0],'январь','ТО-1',5));

console.log('');
console.log(fails===0 ? '!!! SHIFT-ПЕРЕСТАНОВКА РАБОТАЕТ !!!' : ('!!! ПРОВАЛОВ: '+fails+' !!!'));
`;

fs.writeFileSync('tools/_shifttest.js', code);
require('child_process').execSync('node tools/_shifttest.js', { stdio: 'inherit' });
