const fs = require('fs');
const html = fs.readFileSync('app_kmhto.html', 'utf8');
// Берём последний inline-скрипт (без src) — это основная логика приложения
const allScripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const js = allScripts[allScripts.length - 1];

// Минимальный mock DOM только для renderScheduleTable
const makeStub = (id) => ({
  _id: id, innerHTML: '', textContent: '', value: '', style: {}, dataset: {},
  className: '', classList: { add(){}, remove(){}, toggle(){} },
  querySelectorAll: () => [], querySelector: () => null,
  appendChild(){}, addEventListener(){}, getElementsByTagName: () => [],
});
const store = {};
global.localStorage = { getItem:k=>k in store?store[k]:null, setItem:(k,v)=>{store[k]=String(v)}, removeItem:k=>{delete store[k]} };
global.window = { innerWidth:1200, innerHeight:800 };
global.document = {
  _els: {},
  getElementById(id){ return this._els[id] || (this._els[id]=makeStub(id)); },
  querySelectorAll(){ return []; },
  querySelector(){ return null; },
  addEventListener(){},
  createElement(){ return makeStub('tmp'); },
  body:{ appendChild(){}, removeChild(){} },
};
global.alert = ()=>{};
global.showNotification = ()=>{};
global.initColumnResizers = ()=>{};
global.applyColumnWidths = ()=>{};
global.initDragDrop = ()=>{ global.__dragInited = (global.__dragInited||0)+1; };

function extract(name){
  const re = new RegExp('function\\s+'+name+'\\s*\\([^)]*\\)\\s*\\{');
  const mm = re.exec(js);
  if(!mm) return null;
  let i=mm.index,depth=0,j=js.indexOf('{',i);
  for(;j<js.length;j++){ if(js[j]==='{')depth++; else if(js[j]==='}'){depth--;if(depth===0){j++;break;}} }
  return js.slice(i,j);
}

const prelude = `
let currentYear = 2026;
let allWorksCache = [];
let selectedEvents = new Set();
const equipmentData = [
  { id:'eq_a', name:'Датчик A', code:'7', serialNumber:'1', location:'Место', section:'Объект №1', type:'Датчик',
    toSchedule:{ 'январь':[{type:'ТО-1',day:15}], 'март':[{type:'ТО-3',day:20}] },
    kmhSchedule:{ 'февраль':[10,25] }, hasKmh:true },
  { id:'eq_b', name:'Датчик B', code:'8', serialNumber:'2', location:'Место2', section:'Объект №2', type:'Датчик',
    toSchedule:{ 'январь':[{type:'ТО-2',day:5}] }, kmhSchedule:{}, hasKmh:false },
];
function getFilteredEquipment(){ return equipmentData; }
function getExtraHolidays(){ return []; }
function lastChangesByEq(){ return {}; }
function isRemoteAuthor(){ return false; }
function escHtml(v){ if(v===null||v===undefined) return ''; return String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function loadMovedMarks(){ return {}; }
function getMonthNumber(m){ return ({'январь':1,'март':3,'февраль':2})[m]; }
function isDayOff(){ return false; }
function weekdayShort(){ return 'Пн'; }
function dayClass(){ return ''; }
function getAllWorks(){ return []; }
`;

const parts = [extract('getMovedMark'), extract('renderScheduleTable')];
const code = prelude + '\n' + parts.join('\n') + '\n'
  + `
renderScheduleTable();
const out = document.getElementById('scheduleTableBody').innerHTML;
let fails = 0;
function assert(n,c){ if(!c)fails++; console.log((c?'  OK   ':'  FAIL ')+n); }
console.log('--- Атрибуты ячеек для DnD ---');
assert('data-month присутствует', /data-month="\\d+"/.test(out));
assert('data-eq-id на ячейке с работой', /data-eq-id="eq_a"/.test(out));
assert('метка ТО имеет data-work-day', /data-work-day="15"/.test(out));
assert('метка ТО имеет data-work-type', /data-work-type="ТО-1"/.test(out));
assert('метка КМХ имеет data-work-day', /data-work-day="10"/.test(out));
assert('КМХ data-work-type', /data-work-type="КМХ"/.test(out));
assert('класс .dnd-over определён в CSS', __CSS_OK__);
setTimeout(function() {
  assert('initDragDrop вызван после рендера', (global.__dragInited||0) >= 1);
  console.log('');
  console.log(fails===0 ? '!!! АТРИБУТЫ DnD В ПОРЯДКЕ !!!' : ('!!! ПРОВАЛОВ: '+fails+' !!!'));
}, 10);
`;

const cssOk = html.includes('.schedule-table td.dnd-over');
const mockHeader = `
const __CSS_OK__ = ${cssOk};
const makeStub = (id) => ({
  _id: id, innerHTML: '', textContent: '', value: '', style: {}, dataset: {},
  className: '', classList: { add(){}, remove(){}, toggle(){} },
  querySelectorAll: () => [], querySelector: () => null,
  appendChild(){}, addEventListener(){}, getElementsByTagName: () => [],
});
const store = {};
global.localStorage = { getItem:k=>k in store?store[k]:null, setItem:(k,v)=>{store[k]=String(v)}, removeItem:k=>{delete store[k]} };
global.window = { innerWidth:1200, innerHeight:800 };
global.document = {
  _els: {},
  getElementById(id){ return this._els[id] || (this._els[id]=makeStub(id)); },
  querySelectorAll(){ return []; },
  querySelector(){ return null; },
  addEventListener(){},
  createElement(){ return makeStub('tmp'); },
  body:{ appendChild(){}, removeChild(){} },
};
global.alert = ()=>{};
global.showNotification = ()=>{};
global.initColumnResizers = ()=>{};
global.applyColumnWidths = ()=>{};
global.initDragDrop = ()=>{ global.__dragInited = (global.__dragInited||0)+1; };
global.renderArrows = ()=>{};
`;
const finalCode = mockHeader + '\n' + code;
fs.writeFileSync('tools/_dndtest.js', finalCode);
require('child_process').execSync('node tools/_dndtest.js', { stdio: 'inherit' });
