// Тест: сохранение workbook + экспорт в Excel (структура листов)
const fs = require('fs');
const html = fs.readFileSync('app_kmhto.html', 'utf8');
const allScripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const js = allScripts[allScripts.length - 1];

function extract(name){
  const re = new RegExp('function\\s+'+name+'\\s*\\([^)]*\\)\\s*\\{');
  const mm = re.exec(js);
  if(!mm) return '// MISSING '+name;
  let i=mm.index,depth=0,j=js.indexOf('{',i);
  for(;j<js.length;j++){ if(js[j]==='{')depth++; else if(js[j]==='}'){depth--;if(depth===0){j++;break;}} }
  return js.slice(i,j);
}

const prelude = `
let currentYear = 2026;
let lastWorkbook = null;
let lastFileName = '';
let equipmentData = [];
let normData = {};
let allWorksCache = [];
let VARS = {};
const localStorage = { _s:{}, getItem(k){return k in this._s?this._s[k]:null}, setItem(k,v){this._s[k]=String(v)}, removeItem(k){delete this._s[k]} };
const _els = {};
function makeStub(id){ return { value:'', _id:id, style:{}, classList:{add(){},remove(){},toggle(){}}, querySelectorAll:()=>[], querySelector:()=>null, appendChild(){}, addEventListener(){} }; }
const document = { getElementById(id){ return _els[id] || (_els[id]=makeStub(id)); }, querySelector:()=>null, querySelectorAll:()=>[], addEventListener(){}, createElement:()=>makeStub('t') };
function showNotification(m){ VARS.lastNotify = m; }
function alert(m){ console.log('  ALERT:', m); }
function updateDataStatus(){}
// мок XLSX
var EXPORT_MONTHS = ['январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'];
var XLSX = {
  write(wb, opts){ wb.__written = opts; return 'BASE64DATA'; },
  read(data, opts){ return { __restored: true, __from: data, __opts: opts }; },
  utils: {
    book_new(){ return { SheetNames: [], Sheets: {} }; },
    aoa_to_sheet(rows){ return { __rows: rows }; },
    book_append_sheet(wb, sheet, name){ wb.SheetNames.push(name); wb.Sheets[name] = sheet; }
  },
  writeFile(wb, name){ VARS.lastExport = { wb: wb, name: name }; }
};
`;

const code = prelude + '\n'
  + 'var EQ_DATA_KEY = "kmhto_equipment_data";\n'
  + 'var WORKBOOK_KEY = "kmhto_workbook";\n'
  + [extract('saveWorkbookToStorage'), extract('loadWorkbookFromStorage'),
     extract('hasSavedWorkbook'), extract('clearSavedWorkbook'),
     extract('exportToExcel')].join('\n')
  + `
let fails = 0;
function assert(n,c){ if(!c)fails++; console.log((c?'  OK   ':'  FAIL ')+n); }

console.log('=== Сохранение/восстановление workbook ===');
lastWorkbook = { SheetNames:['1','2'], Sheets:{} };
lastFileName = 'TOKMHver5.xlsx';
saveWorkbookToStorage();
assert('workbook сохранён в localStorage', !!localStorage.getItem(WORKBOOK_KEY));
assert('hasSavedWorkbook() = true', hasSavedWorkbook() === true);
lastWorkbook = null; lastFileName = '';
assert('восстановление вернуло true', loadWorkbookFromStorage() === true);
assert('workbook восстановлен', !!lastWorkbook && lastWorkbook.__restored === true);
assert('имя файла восстановлено', lastFileName === 'TOKMHver5.xlsx');

console.log('=== Экспорт в Excel (структура как в исходном файле) ===');
equipmentData = [
  { id:'eq1', name:'Датчик A', code:'7', serialNumber:'123456', location:'Объект № 101',
    toSchedule:{ 'январь':[{type:'ТО-1',day:15}], 'март':[{type:'ТО-3',day:20}] },
    kmhSchedule:{ 'февраль':[10,25] }, hasKmh:true },
  { id:'eq2', name:'Датчик B', code:'8', serialNumber:'', location:'Объект № 2',
    toSchedule:{ 'январь':[{type:'ТО-2',day:5}] }, kmhSchedule:{}, hasKmh:false }
];
normData = { '7': { code:'7', name:'ТПР', types: { 'ТО-1': {count:11,time:2.5,yearTime:27.5}, 'КМХ': {count:11,time:2.2,yearTime:22} } } };
// Настройки импорта намеренно «неправильные»: имена листов экспорта от них не зависят
document.getElementById('settingKmhSheet').value = '2';
document.getElementById('settingNormSheet').value = '9';
exportToExcel();
assert('был вызван XLSX.writeFile', !!VARS.lastExport);
var wb = VARS.lastExport.wb;
assert('имя файла содержит _изменённый_', /_изменённый_/.test(VARS.lastExport.name));
assert('листы всегда 1 (ТО), 3 (КМХ), data', JSON.stringify(wb.SheetNames) === JSON.stringify(['1','3','data']), JSON.stringify(wb.SheetNames));

var toRows = wb.Sheets['1'].__rows;
var kmhRows = wb.Sheets['3'].__rows;
var normRows = wb.Sheets['data'].__rows;
assert('лист ТО: 1 шапка + 2 записи', toRows.length === 3);
assert('шапка: 4 описательные колонки + январь..декабрь', toRows[0].length === 16 && toRows[0][4] === 'январь' && toRows[0][15] === 'декабрь',
       JSON.stringify(toRows[0].slice(0, 5)));
assert('шапка: наименование в C, место в D (как в файле)', toRows[0][2] === 'Наименование СИ и оборудования' && toRows[0][3] === 'Место установки');
assert('ТО строка 1: № п/п = 1', toRows[1][0] === '1');
assert('ТО строка 1: код = 7', toRows[1][1] === '7');
assert('ТО строка 1: наименование = Датчик A', toRows[1][2] === 'Датчик A');
assert('ТО строка 1: место = Объект № 101', toRows[1][3] === 'Объект № 101');
assert('ТО янв = "ТО-1 (15)" (колонка E)', toRows[1][4] === 'ТО-1 (15)');
assert('ТО март = "ТО-3 (20)"', toRows[1][6] === 'ТО-3 (20)');
assert('ТО строка 2: № п/п = 2', toRows[2][0] === '2');
assert('КМХ фев = "10, 25" (колонка F)', kmhRows[1][5] === '10, 25');
assert('КМХ янв пусто', kmhRows[1][4] === '');
assert('КМХ: наименование и место на своих местах', kmhRows[1][2] === 'Датчик A' && kmhRows[1][3] === 'Объект № 101');
assert('Справочник: шапка + 2 строки оборудования', normRows.length === 3);
assert('Справочник шапка: код оборудования', normRows[0][0] === 'код оборудования');
assert('Справочник строка: код 7', normRows[1][0] === '7');
assert('Справочник: кол-во ТО-1 = 11', normRows[1][3] === 11);
assert('Справочник: кол-во КМХ = 11', normRows[1][8] === 11);

console.log('');
console.log(fails===0 ? '!!! СОХРАНЕНИЕ И ЭКСПОРТ РАБОТАЮТ !!!' : ('!!! ПРОВАЛОВ: '+fails+' !!!'));
`;

fs.writeFileSync('tools/_saveexport.js', code);
require('child_process').execSync('node tools/_saveexport.js', { stdio: 'inherit' });
