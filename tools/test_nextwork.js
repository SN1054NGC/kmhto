const fs = require('fs');
// Тест «сколько дней до ближайшего ТО/КМХ» (блок оборудования и сведения).
const html = fs.readFileSync('app_kmhto.html', 'utf8');
const js = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function extract(name) {
  const re = new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const mm = re.exec(js);
  if (!mm) return '/* MISSING ' + name + ' */';
  let i = mm.index, depth = 0, j = js.indexOf('{', i);
  for (; j < js.length; j++) {
    if (js[j] === '{') depth++;
    else if (js[j] === '}') { depth--; if (depth === 0) { j++; break; } }
  }
  return js.slice(i, j);
}

const prelude = `
const MONTH_FULL = ['январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'];
`;

const wanted = ['nextWorkInfo', 'humanDaysLeft', 'getMonthNumber', 'formatDateUTC', 'formatDateDisplayUTC'];
let code = prelude + '\n' + wanted.map(extract).join('\n') + '\n';

code += `
let fails = 0;
function assert(n, c, extra) { if (!c) fails++; console.log((c ? '  OK   ' : '  FAIL ') + n + ((!c && extra !== undefined) ? ' [' + extra + ']' : '')); }
function monthNameOf(d) { return MONTH_FULL[d.getUTCMonth()]; }
function addDays(n) { var d = new Date(); return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate() + n)); }

console.log('=== Ближайшее ТО/КМХ ===');
var dt2 = addDays(2);
var eq1 = { id: 'e1', toSchedule: {}, kmhSchedule: {}, hasKmh: false };
eq1.toSchedule[monthNameOf(dt2)] = [{ type: 'ТО-1', day: dt2.getUTCDate() }];
var n1 = nextWorkInfo(eq1);
assert('через 2 дня найдено', !!n1 && n1.days === 2 && n1.type === 'ТО-1', n1 && (n1.type + ':' + n1.days));
assert('дата в формате ГГГГ-ММ-ДД', !!n1 && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(n1.dateStr), n1 && n1.dateStr);

var dt1 = addDays(1), dt5 = addDays(5);
var eq2 = { id: 'e2', toSchedule: {}, kmhSchedule: {}, hasKmh: true };
eq2.toSchedule[monthNameOf(dt5)] = [{ type: 'ТО-3', day: dt5.getUTCDate() }];
eq2.kmhSchedule[monthNameOf(dt1)] = [dt1.getUTCDate()];
var n2 = nextWorkInfo(eq2);
assert('ближайшее — КМХ через 1 день', !!n2 && n2.type === 'КМХ' && n2.days === 1, n2 && (n2.type + ':' + n2.days));

var eq3 = { id: 'e3', toSchedule: {}, kmhSchedule: {} };
assert('без работ — null', nextWorkInfo(eq3) === null);
eq3.toSchedule['февраль'] = [{ type: 'ТО-1', day: 31 }];
assert('несуществующая дата 31.02 игнорируется', nextWorkInfo(eq3) === null);

var dm1 = addDays(-1);
var eq4 = { id: 'e4', toSchedule: {}, kmhSchedule: {}, hasKmh: false };
eq4.toSchedule[monthNameOf(dm1)] = [{ type: 'ТО-2', day: dm1.getUTCDate() }];
var n4 = nextWorkInfo(eq4);
assert('прошедшая дата переносится на следующий год', !!n4 && n4.days > 300, n4 && n4.days);

console.log('=== Формулировки ===');
assert('0 дней — сегодня', humanDaysLeft(0) === 'сегодня', humanDaysLeft(0));
assert('1 день — завтра', humanDaysLeft(1) === 'завтра', humanDaysLeft(1));
assert('2 дня', humanDaysLeft(2) === 'через 2 дня', humanDaysLeft(2));
assert('5 дней', humanDaysLeft(5) === 'через 5 дней', humanDaysLeft(5));
assert('11 дней (не «11 день»)', humanDaysLeft(11) === 'через 11 дней', humanDaysLeft(11));
assert('21 день', humanDaysLeft(21) === 'через 21 день', humanDaysLeft(21));
assert('22 дня', humanDaysLeft(22) === 'через 22 дня', humanDaysLeft(22));

console.log('');
console.log(fails === 0 ? '!!! ДНИ ДО БЛИЖАЙШЕГО ТО/КМХ: ВСЁ ОК !!!' : ('!!! ПРОВАЛОВ: ' + fails + ' !!!'));
process.exit(fails === 0 ? 0 : 1);
`;

new Function('console', 'process', code)(console, process);
