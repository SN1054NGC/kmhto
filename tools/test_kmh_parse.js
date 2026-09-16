// Тест: парсинг КМХ-дат и ТО-меток на реальных значениях из файла
const fs = require('fs');
const html = fs.readFileSync('app_kmhto.html', 'utf8');
const allScripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const js = allScripts[allScripts.length - 1];

function extract(name){
  const re = new RegExp('function\\s+'+name+'\\s*\\([^)]*\\)\\s*\\{');
  const mm = re.exec(js); if(!mm) return '// MISSING '+name;
  let i=mm.index,depth=0,j=js.indexOf('{',i);
  for(;j<js.length;j++){ if(js[j]==='{')depth++; else if(js[j]==='}'){depth--;if(depth===0){j++;break;}} }
  return js.slice(i,j);
}

const code = 'var PARSE_ISSUES=[]; function addIssue(s,r,c,raw,p,i){PARSE_ISSUES.push({raw:raw,parsed:p,issue:i});}\n'
  + extract('canonizeTOString') + '\n'
  + extract('canonizeTOLabel') + '\n'
  + extract('parseKMHValue') + '\n'
  + extract('parseTOValue') + '\n'
  + `
let fails=0;
function A(n,c){ if(!c)fails++; console.log((c?'  OK   ':'  FAIL ')+n); }

console.log('=== КМХ-парсинг (реальные значения из файла) ===');
A('"14,\\n20,\\n2" -> [2,14,20]', JSON.stringify(parseKMHValue('14,\\n20,\\n2'))==='[2,14,20]');
A('"12,22\\n27 " -> [12,22,27]', JSON.stringify(parseKMHValue('12,22\\n27 '))==='[12,22,27]');
A('"14,\\n20,\\n2," -> [2,14,20]', JSON.stringify(parseKMHValue('14,\\n20,\\n2,'))==='[2,14,20]');
A('одиночное "5" -> [5]', JSON.stringify(parseKMHValue('5'))==='[5]');
A('дубли "10,10" -> [10]', JSON.stringify(parseKMHValue('10,10'))==='[10]');
A('диапазон "5-8" -> [5,6,7,8]', JSON.stringify(parseKMHValue('5-8'))==='[5,6,7,8]');
A('день вне диапазона "40" -> []', JSON.stringify(parseKMHValue('40'))==='[]');

console.log('=== ТО-парсинг (реальные значения из файла) ===');
A('"ТО-3 (20)"', JSON.stringify(parseTOValue('ТО-3 (20)','1',1,1))==='{"type":"ТО-3","day":20}');
A('"ТО-3(10)"', JSON.stringify(parseTOValue('ТО-3(10)','1',1,1))==='{"type":"ТО-3","day":10}');
A('"ТО-3( 10 )"', JSON.stringify(parseTOValue('ТО-3( 10 )','1',1,1))==='{"type":"ТО-3","day":10}');
A('"ТО-3 (07)" -> day 7', JSON.stringify(parseTOValue('ТО-3 (07)','1',1,1))==='{"type":"ТО-3","day":7}');
A('"ТО-1 (13)"', JSON.stringify(parseTOValue('ТО-1 (13)','1',1,1))==='{"type":"ТО-1","day":13}');

console.log('');
console.log(fails===0 ? '!!! ПАРСИНГ КМХ/ТО КОРРЕКТЕН !!!' : ('!!! ПРОВАЛОВ: '+fails+' !!!'));
`;
fs.writeFileSync('tools/_parsetest.js', code);
require('child_process').execSync('node tools/_parsetest.js', { stdio: 'inherit' });
