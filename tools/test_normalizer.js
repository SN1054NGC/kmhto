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
var PARSE_ISSUES = [];
function resetParseIssues(){ PARSE_ISSUES = []; }
`;
const wanted = ['canonizeTOString','canonizeTOLabel','addIssue','parseTOValue','parseKMHValue'];
let code = prelude + '\n';
for (const w of wanted) code += (extract(w) || ('// MISSING '+w)) + '\n';

code += `
let fails = 0;
function chk(input, expType, expDay) {
  resetParseIssues();
  var r = parseTOValue(input, '1', 5, 6);
  var ok = r && r.type === expType && r.day === expDay;
  if (!ok) fails++;
  console.log((ok?'  OK   ':'  FAIL ') + JSON.stringify(input) + ' -> ' + (r ? (r.type+' ('+r.day+')') : 'null') + '  (ожид. ' + expType + ' (' + expDay + '))');
}

console.log('=== ВАРИАНТЫ ОПЕЧАТОК ТО -> должны дать ТО-1 (12) ===');
chk('ТО-1 (12)', 'ТО-1', 12);
chk('ТО-1(12)', 'ТО-1', 12);
chk('ТО- 1(12)', 'ТО-1', 12);
chk('ТО-1 (12 )', 'ТО-1', 12);
chk('ТО-1 ( 12 )', 'ТО-1', 12);
chk('ТО1(12)', 'ТО-1', 12);
chk('ТО 1 (12)', 'ТО-1', 12);
chk('ТО - 1 ( 12 )', 'ТО-1', 12);
chk('то-1(12)', 'ТО-1', 12);
chk('TO-1 (12)', 'ТО-1', 12);        // латиница
chk('TО-1(12)', 'ТО-1', 12);         // T латин + О кир
chk('Т0-1 (12)', 'ТО-1', 12);        // ноль вместо О
chk('ТО-1 — 12', 'ТО-1', 12);        // тире
chk('ТО-2 (05)', 'ТО-2', 5);
chk('то3(1)', 'ТО-3', 1);

console.log('=== НЕКОРРЕКТНЫЕ (должны дать null + issue) ===');
resetParseIssues();
var bad1 = parseTOValue('ТО-5 (12)', '1', 5, 6);
console.log('  ТО-5 (12):', bad1, '| issues:', PARSE_ISSUES.length);
if (bad1 !== null) fails++; else console.log('  OK   ТО-5 -> null');
resetParseIssues();
var bad2 = parseTOValue('ТО-1 (45)', '1', 5, 6);  // день >31
console.log('  ТО-1 (45):', bad2, '| issues:', PARSE_ISSUES.length);
if (bad2 !== null) fails++; else console.log('  OK   день 45 -> null');

console.log('=== КМХ дни ===');
resetParseIssues();
console.log('  "12,13 14" ->', parseKMHValue('12,13 14','2',3,4));
console.log('  "5;6;7"    ->', parseKMHValue('5;6;7','2',3,4));
console.log('  "12.13"    ->', parseKMHValue('12.13','2',3,4));
console.log('  "40"       ->', parseKMHValue('40','2',3,4), '| issues:', PARSE_ISSUES.length);

console.log('');
console.log(fails===0 ? '!!! ТЕСТ НОРМАЛИЗАТОРА ПРОШЁЛ !!!' : ('!!! ПРОВАЛОВ: '+fails+' !!!'));
`;

fs.writeFileSync('tools/_norm.js', code);
require('child_process').execSync('node tools/_norm.js', { stdio: 'inherit' });
