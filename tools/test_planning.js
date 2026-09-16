const fs = require('fs');

/* ------------------------------------------------------------------
   ТЕСТ: правила планирования и автогенерация графика на год.
   Проверяются И клиентские функции (из app_kmhto.html), И серверная
   модель (server/model.js) — они должны строить одинаковый график.
   ------------------------------------------------------------------ */

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
const MONTH_FULL = ['январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'];
var PLAN_WORK_TYPES = ['ТО-1', 'ТО-2', 'ТО-3', 'КМХ'];
var DEFAULT_PLAN_DENY_DAYS = [5, 6, 7];
const store = {};
const localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; }
};
function showNotification(x) { }
function alert(x) { console.log('  ALERT:', x); }
function netConnected() { return false; }
function netCan() { return true; }
function saveEquipmentData() { }
function updateDataStatus() { }
function renderAll() { }
function commitOp(d, m) { if (m) m(); return { ok: true, op: { kind: d.kind } }; }
`;

const wanted = ['planRulesOf', 'planRuleHasStart', 'activePlanRules', 'planLastAnchor', 'planRuleWorks', 'planAddEntry', 'weekdayNum', 'snapPlanDay', 'planDayPolicy',
                'planRemoveGenerated', 'planGenerateLocal', 'commitPlanRules',
                'commitPlanGenerate', 'autoGeneratePlans',
                'snapDayWithinMonth', 'getMonthNumber', 'getExtraHolidays', 'isDayOff'];
const modelPath = require('path').resolve('server/model.js');
let code = 'const model = require(' + JSON.stringify(modelPath) + ');\n' + prelude + '\n';
for (const w of wanted) code += (extract(w) || ('/* MISSING ' + w + ' */')) + '\n';

code += `
let fails = 0;
function assert(name, cond) { if (!cond) fails++; console.log((cond ? '  OK   ' : '  FAIL ') + name); }
function validMonths(list) {
  return list.every(function (w) { return MONTH_FULL.indexOf(w.month) !== -1 && w.day >= 1 && w.day <= 31; });
}
// Канонический вид расписания: месяцы по порядку, записи по дню —
// чтобы сравнение не зависело от порядка ключей и пустых месяцев.
function canon(sched) {
  var out = {};
  Object.keys(sched || {}).sort(function (a, b) { return MONTH_FULL.indexOf(a) - MONTH_FULL.indexOf(b); })
    .forEach(function (m) {
      var arr = sched[m];
      if (!arr || !arr.length) return;
      out[m] = JSON.parse(JSON.stringify(arr)).sort(function (a, b) {
        var da = (typeof a === 'object') ? a.day : a, db = (typeof b === 'object') ? b.day : b;
        return da - db;
      });
    });
  return JSON.stringify(out);
}

console.log('=== 1. Правило: состав работ на год ===');
var rule = { id: 'r1', work: 'ТО-1', baseDate: '2026-01-15', intervalDays: 30, tolerance: 0, active: true };
var w26 = planRuleWorks(rule, 2026);
var w27 = planRuleWorks(rule, 2027);
assert('2026: работ достаточно (11..13)', w26.length >= 11 && w26.length <= 13);
assert('2027: работ достаточно (11..13)', w27.length >= 11 && w27.length <= 13);
assert('все месяцы и дни корректны', validMonths(w26) && validMonths(w27));
assert('первая работа = базовая дата', w26[0].month === 'январь' && w26[0].day === 15);
assert('детерминизм: повтор даёт то же', JSON.stringify(planRuleWorks(rule, 2026)) === JSON.stringify(w26));
assert('план 2027 отличается от 2026', JSON.stringify(w27) !== JSON.stringify(w26));

console.log('=== 2. Допуск: сдвиг с выходного ===');
var sat = { work: 'ТО-1', baseDate: '2026-01-03', intervalDays: 7, tolerance: 2, active: true, denyDays: [] }; // сб
var ws = planRuleWorks(sat, 2026);
assert('суббота сдвинута на будний день', ws[0].day === 2 && ws[0].shifted === true);
assert('без допуска сдвига нет', planRuleWorks({ work: 'ТО-1', baseDate: '2026-01-03', intervalDays: 7, tolerance: 0, denyDays: [] }, 2026)[0].day === 3);

console.log('=== 3. Фильтр правил ===');
assert('неактивное правило игнорируется', activePlanRules({ planRules: [{ work: 'ТО-1', baseDate: '2026-01-01', intervalDays: 30, active: false }] }).length === 0);
assert('битый вид работ отброшен', activePlanRules({ planRules: [{ work: 'ТО-9', baseDate: '2026-01-01', intervalDays: 30 }] }).length === 0);
assert('битая дата отброшена', activePlanRules({ planRules: [{ work: 'ТО-1', baseDate: '01.2026', intervalDays: 30 }] }).length === 0);
assert('нулевой интервал отброшен', activePlanRules({ planRules: [{ work: 'ТО-1', baseDate: '2026-01-01', intervalDays: 0 }] }).length === 0);

console.log('=== 4. Построение и переключение года ===');
var eq = { id: 'eqA', name: 'A', toSchedule: {}, kmhSchedule: {}, hasKmh: false, planRules: [JSON.parse(JSON.stringify(rule))] };
var res26 = planGenerateLocal(eq, 2026, activePlanRules(eq));
var snap26 = canon(eq.toSchedule);
assert('2026 построен', res26.added >= 11 && eq.planGen.year === 2026);
var res27 = planGenerateLocal(eq, 2027, activePlanRules(eq));
assert('2027 построен', res27.added >= 11 && eq.planGen.year === 2027);
assert('график изменился при смене года', canon(eq.toSchedule) !== snap26);
planGenerateLocal(eq, 2026, activePlanRules(eq));
assert('возврат на 2026 воспроизводит план', canon(eq.toSchedule) === snap26);

console.log('=== 5. Ручные записи не теряются ===');
var eq2 = { id: 'eqB', toSchedule: { 'март': [{ type: 'ТО-2', day: 7 }] }, kmhSchedule: { 'май': [5] }, hasKmh: true,
            planRules: [{ work: 'ТО-1', baseDate: '2026-02-10', intervalDays: 60, tolerance: 0, active: true }] };
planGenerateLocal(eq2, 2026, activePlanRules(eq2));
assert('ручная ТО-2 сохранена (2026)', eq2.toSchedule['март'].some(function (w) { return w.type === 'ТО-2' && w.day === 7; }));
planGenerateLocal(eq2, 2027, activePlanRules(eq2));
assert('ручная ТО-2 сохранена (2027)', eq2.toSchedule['март'].some(function (w) { return w.type === 'ТО-2' && w.day === 7; }));
assert('ручной КМХ сохранён (2027)', eq2.kmhSchedule['май'].indexOf(5) !== -1);
var dup = false;
Object.keys(eq2.toSchedule).forEach(function (m) {
  var seen = {};
  eq2.toSchedule[m].forEach(function (w) { var k = w.type + ':' + w.day; if (seen[k]) dup = true; seen[k] = true; });
});
assert('дублей работ нет', dup === false);

console.log('=== 6. Ручная запись не объявляется автопланом ===');
var eq3 = { id: 'eqC', toSchedule: { 'январь': [{ type: 'ТО-1', day: 20 }] }, kmhSchedule: {},
            planRules: [{ work: 'ТО-1', baseDate: '2026-01-20', intervalDays: 365, tolerance: 0, active: true }] };
planGenerateLocal(eq3, 2026, activePlanRules(eq3));
assert('ручная запись не попала в автоплан', !((eq3.planGen.to['январь'] || []).length));
assert('ручная запись на месте (2026)',
       eq3.toSchedule['январь'].some(function (w) { return w.type === 'ТО-1' && w.day === 20; }));
planGenerateLocal(eq3, 2027, activePlanRules(eq3));
assert('ручная запись пережила смену года',
       eq3.toSchedule['январь'].some(function (w) { return w.type === 'ТО-1' && w.day === 20; }));
assert('нет дубля ручной+авто в январе', eq3.toSchedule['январь'].filter(function (w) { return w.day === 20; }).length === 1);

console.log('=== 7. КМХ строится отдельно ===');
var eq4 = { id: 'eqD', toSchedule: {}, kmhSchedule: {}, hasKmh: false,
            planRules: [{ work: 'КМХ', baseDate: '2026-04-01', intervalDays: 90, tolerance: 0, active: true }] };
planGenerateLocal(eq4, 2026, activePlanRules(eq4));
var kmhTotal = 0;
Object.keys(eq4.kmhSchedule).forEach(function (m) { kmhTotal += eq4.kmhSchedule[m].length; });
assert('КМХ построен', kmhTotal >= 3 && eq4.hasKmh === true);
assert('planGen.kmh заполнен', Object.keys(eq4.planGen.kmh).length > 0);

console.log('=== 8. Автоплан: год, повтор, смена года ===');
equipmentData = [
  { id: 'eqE', name: 'E', toSchedule: {}, kmhSchedule: {}, hasKmh: false, planRules: [JSON.parse(JSON.stringify(rule))] },
  { id: 'eqF', name: 'F', toSchedule: {}, kmhSchedule: {}, hasKmh: false }
];
currentYear = 2026;
assert('автоплан построен для 1 ед.', autoGeneratePlans(2026) === 1);
assert('повторный вызов ничего не делает', autoGeneratePlans(2026) === 0);
assert('смена года перестраивает план', autoGeneratePlans(2027) === 1);
assert('оборудование без правил не тронуто', Object.keys(equipmentData[1].toSchedule).length === 0);

console.log('=== 9. Сохранение правил операцией ===');
var eq5 = { id: 'eqG', planRules: [], toSchedule: {}, kmhSchedule: {} };
commitPlanRules(eq5, [{ work: 'ТО-3', baseDate: '2026-06-01', intervalDays: 180, tolerance: 1, note: 'x', active: true }]);
assert('правила записаны в оборудование', eq5.planRules.length === 1 && eq5.planRules[0].work === 'ТО-3');
commitPlanGenerate(eq5, 2026);
assert('генерация выставила planGen', eq5.planGen && eq5.planGen.year === 2026);

console.log('=== 10. Серверная модель ===');
var state = model.emptyState();
state.equipment.push({ id: 's1', name: 'S1', toSchedule: {}, kmhSchedule: {}, hasKmh: false, version: 0 });
var okRule = model.applyOp(state, { kind: 'plan_rule', eqId: 's1', to: { planRules: [
  { work: 'ТО-1', baseDate: '2026-01-15', intervalDays: 30, tolerance: 0, active: true, note: 'n' },
  { work: 'XXX', baseDate: 'нет', intervalDays: 0 }
] } });
assert('plan_rule принят', okRule.ok === true);
assert('мусорное правило отброшено', state.equipment[0].planRules.length === 1);
var srvRules = state.equipment[0].planRules;
var okGen = model.applyOp(state, { kind: 'plan_generate', eqId: 's1', to: { year: 2026, rules: srvRules } });
assert('plan_generate принят', okGen.ok === true && okGen.added >= 11);
assert('planGen.year = 2026', state.equipment[0].planGen.year === 2026);
var srv26 = JSON.stringify(state.equipment[0].toSchedule);
model.addRec(state.equipment[0], 'март', 'ТО-2', 7);
var okGen27 = model.applyOp(state, { kind: 'plan_generate', eqId: 's1', to: { year: 2027, rules: srvRules } });
assert('смена года на сервере', okGen27.ok === true && state.equipment[0].planGen.year === 2027 && JSON.stringify(state.equipment[0].toSchedule) !== srv26);
assert('сервер сохранил ручную запись', state.equipment[0].toSchedule['март'].some(function (w) { return w.type === 'ТО-2' && w.day === 7; }));
assert('некорректный год отклонён', model.applyOp(state, { kind: 'plan_generate', eqId: 's1', to: { year: 0 } }).ok === false);
assert('пустые правила отклонены', model.applyOp(state, { kind: 'plan_generate', eqId: 's1', to: { year: 2026, rules: [] } }).ok === false);

console.log('=== 11. Клиент и сервер строят одинаково ===');
var cmpRules = [
  { work: 'ТО-1', baseDate: '2026-01-15', intervalDays: 30, tolerance: 0, active: true },
  { work: 'ТО-3', baseDate: '2026-03-10', intervalDays: 180, tolerance: 2, active: true },
  { work: 'КМХ', baseDate: '2026-02-20', intervalDays: 90, tolerance: 1, active: true }
];
var cmpState = model.emptyState();
cmpState.equipment.push({ id: 'cmpSrv', name: 'cmp', toSchedule: {}, kmhSchedule: {}, hasKmh: false, version: 0, planRules: [] });
model.applyOp(cmpState, { kind: 'plan_rule', eqId: 'cmpSrv', to: { planRules: cmpRules } });
model.applyOp(cmpState, { kind: 'plan_generate', eqId: 'cmpSrv', to: { year: 2026, rules: cmpState.equipment[0].planRules } });
var cEq = { id: 'cmp', toSchedule: {}, kmhSchedule: {}, hasKmh: false, planRules: JSON.parse(JSON.stringify(cmpState.equipment[0].planRules)) };
planGenerateLocal(cEq, 2026, activePlanRules(cEq));
assert('ТО: клиент и сервер совпадают', canon(cEq.toSchedule) === canon(cmpState.equipment[0].toSchedule));
assert('КМХ: клиент и сервер совпадают', canon(cEq.kmhSchedule) === canon(cmpState.equipment[0].kmhSchedule));
assert('КМХ действительно построен', Object.keys(cEq.kmhSchedule).length > 0);
model.applyOp(cmpState, { kind: 'plan_generate', eqId: 'cmpSrv', to: { year: 2027, rules: cmpState.equipment[0].planRules } });
planGenerateLocal(cEq, 2027, activePlanRules(cEq));
assert('2027: клиент и сервер совпадают', canon(cEq.toSchedule) === canon(cmpState.equipment[0].toSchedule) && canon(cEq.kmhSchedule) === canon(cmpState.equipment[0].kmhSchedule));

console.log('=== 12. Автопродолжение от последней даты прошлого года ===');
var eqA = { id: 'a', toSchedule: { 'ноябрь': [{ type: 'ТО-1', day: 25 }] }, kmhSchedule: {}, hasKmh: false,
            planRules: [{ id: 'r', work: 'ТО-1', baseDate: '2026-01-20', intervalDays: 30, tolerance: 0, autoContinue: true, active: true, denyDays: [] }] };
assert('якорь: последняя дата ТО-1', JSON.stringify(planLastAnchor(eqA, 'ТО-1')) === JSON.stringify({ month: 11, day: 25 }));
var resA = planGenerateLocal(eqA, 2027, activePlanRules(eqA));
assert('автопродолжение построено', resA.added > 0 && !!eqA.planGen.starts['ТО-1'] && eqA.planGen.starts['ТО-1'].auto === true,
       JSON.stringify(eqA.planGen.starts['ТО-1']));
// 25.11.2026 + 30 = 25.12.2026, +30 = 24.01.2027 (вс); допуск 0 -> 24
assert('первая работа = якорь + интервал', eqA.planGen.starts['ТО-1'].month === 'январь' && eqA.planGen.starts['ТО-1'].day === 24,
       JSON.stringify(eqA.planGen.starts['ТО-1']));

console.log('=== 13. Допуск ± при автопродолжении ===');
var eqB = { id: 'b', toSchedule: { 'ноябрь': [{ type: 'ТО-1', day: 25 }] }, kmhSchedule: {}, hasKmh: false,
            planRules: [{ work: 'ТО-1', baseDate: '2026-01-20', intervalDays: 30, tolerance: 3, autoContinue: true, active: true }] };
planGenerateLocal(eqB, 2027, activePlanRules(eqB));
assert('воскресенье сдвинуто в окне ±3', eqB.planGen.starts['ТО-1'].day === 25, JSON.stringify(eqB.planGen.starts['ТО-1']));

console.log('=== 14. Ручная стартовая дата на год ===');
var eqC = { id: 'c', toSchedule: { 'ноябрь': [{ type: 'ТО-1', day: 25 }] }, kmhSchedule: {}, hasKmh: false,
            planRules: [{ work: 'ТО-1', baseDate: '2026-01-20', intervalDays: 30, tolerance: 0, autoContinue: true,
                          starts: { '2027': '2027-03-05' }, active: true, denyDays: [] }] };
planGenerateLocal(eqC, 2027, activePlanRules(eqC));
assert('ручной старт перебивает автопродолжение', eqC.planGen.starts['ТО-1'].month === 'март' && eqC.planGen.starts['ТО-1'].day === 5,
       JSON.stringify(eqC.planGen.starts['ТО-1']));
assert('ручной старт помечен как не авто', eqC.planGen.starts['ТО-1'].auto === false);

console.log('=== 15. Правило без базовой даты (авто/ручной старт) ===');
assert('авто без базовой даты активно', activePlanRules({ planRules: [{ work: 'ТО-1', intervalDays: 30, autoContinue: true }] }).length === 1);
assert('без основания правило неактивно', activePlanRules({ planRules: [{ work: 'ТО-1', intervalDays: 30 }] }).length === 0);
assert('ручной старт без базовой даты активен', activePlanRules({ planRules: [{ work: 'КМХ', intervalDays: 90, starts: { '2027': '2027-04-01' } }] }).length === 1);

console.log('=== 16. Сервер: автопродолжение и ручной старт ===');
var sEq = { id: 's', toSchedule: { 'ноябрь': [{ type: 'ТО-1', day: 25 }] }, kmhSchedule: {}, hasKmh: false, version: 0, planRules: [] };
var sState = model.emptyState();
sState.equipment.push(sEq);
var ruleOk = model.applyOp(sState, { kind: 'plan_rule', eqId: 's', to: { planRules: [
  { work: 'ТО-1', intervalDays: 30, tolerance: 3, autoContinue: true, active: true }
] } });
assert('сервер принял правило без базовой даты (авто)', ruleOk.ok === true && sEq.planRules.length === 1, JSON.stringify(sEq.planRules[0]));
assert('сервер: якорь найден', JSON.stringify(model.planLastAnchor(sEq, 'ТО-1')) === JSON.stringify({ month: 11, day: 25 }));
var sGen = model.applyOp(sState, { kind: 'plan_generate', eqId: 's', to: { year: 2027, rules: sEq.planRules } });
assert('сервер: автопродолжение построено', sGen.ok === true && sGen.added > 0, sGen.added);
assert('сервер: старт = январь 25 (допуск ±3)', !!sEq.planGen.starts['ТО-1'] && sEq.planGen.starts['ТО-1'].day === 25,
       JSON.stringify(sEq.planGen.starts['ТО-1']));
var sMan = model.applyOp(sState, { kind: 'plan_rule', eqId: 's', to: { planRules: [
  { work: 'КМХ', intervalDays: 60, starts: { '2027': '2027-06-10' }, active: true }
] } });
assert('сервер: ручной старт сохранён', sMan.ok === true && sEq.planRules[0].starts['2027'] === '2027-06-10');
model.applyOp(sState, { kind: 'plan_generate', eqId: 's', to: { year: 2027, rules: sEq.planRules } });
assert('сервер: старт КМХ = 10 июня', !!sEq.planGen.starts['КМХ'] && sEq.planGen.starts['КМХ'].month === 'июнь' && sEq.planGen.starts['КМХ'].day === 10,
       JSON.stringify(sEq.planGen.starts['КМХ']));

console.log('=== 17. Клиент и сервер: автопродолжение совпадает ===');
var cAuto = { id: 'ca', toSchedule: { 'ноябрь': [{ type: 'ТО-1', day: 25 }] }, kmhSchedule: {}, hasKmh: false,
              planRules: [{ work: 'ТО-1', intervalDays: 30, tolerance: 3, autoContinue: true, active: true }] };
planGenerateLocal(cAuto, 2027, activePlanRules(cAuto));
var sAuto = { id: 'sa', toSchedule: { 'ноябрь': [{ type: 'ТО-1', day: 25 }] }, kmhSchedule: {}, hasKmh: false, version: 0, planRules: [] };
var sAutoState = model.emptyState();
sAutoState.equipment.push(sAuto);
model.applyOp(sAutoState, { kind: 'plan_rule', eqId: 'sa', to: { planRules: [{ work: 'ТО-1', intervalDays: 30, tolerance: 3, autoContinue: true, active: true }] } });
model.applyOp(sAutoState, { kind: 'plan_generate', eqId: 'sa', to: { year: 2027, rules: sAuto.planRules } });
assert('автопродолжение: ТО клиент=сервер', canon(cAuto.toSchedule) === canon(sAuto.toSchedule));
assert('автопродолжение: planGen.starts совпадает', JSON.stringify(cAuto.planGen.starts) === JSON.stringify(sAuto.planGen.starts));

console.log('=== 18. Выбор дней недели ===');
function wdOf(w) { return ((new Date(Date.UTC(2026, MONTH_FULL.indexOf(w.month), w.day)).getUTCDay() + 6) % 7) + 1; }
assert('allow=[Вт]: понедельник сдвинут на вторник', snapPlanDay(2026, 'январь', 5, 0, { shift: true, allow: [2] }) === 6,
       snapPlanDay(2026, 'январь', 5, 0, { shift: true, allow: [2] }));
var tueRule = { work: 'ТО-1', baseDate: '2026-01-01', intervalDays: 30, tolerance: 0, shift: true, allowDays: [2], active: true };
var wsTue = planRuleWorks(tueRule, 2026);
assert('только вторник: работы есть', wsTue.length > 0);
assert('все работы — вторник', wsTue.every(function (w) { return wdOf(w) === 2; }), JSON.stringify(wsTue.slice(0, 3)));

var denyRule = { work: 'ТО-1', baseDate: '2026-01-05', intervalDays: 7, tolerance: 0, shift: true, denyDays: [1], active: true };
var wsDeny = planRuleWorks(denyRule, 2026);
assert('понедельник запрещён: их нет', wsDeny.every(function (w) { return wdOf(w) !== 1; }));
assert('понедельник сдвинут на вторник', wsDeny[0].month === 'январь' && wsDeny[0].day === 6, JSON.stringify(wsDeny[0]));

var noShift = { work: 'ТО-1', baseDate: '2026-01-03', intervalDays: 7, tolerance: 0, shift: false, active: true, denyDays: [] };
var wsNo = planRuleWorks(noShift, 2026);
assert('shift=false: суббота остаётся на месте', wsNo[0].day === 3 && wsNo[0].shifted === false, JSON.stringify(wsNo[0]));

var noWeekend = { work: 'ТО-1', baseDate: '2026-01-03', intervalDays: 7, tolerance: 0, shift: false, denyDays: [6, 7], active: true };
var wsNoW = planRuleWorks(noWeekend, 2026);
assert('shift=false + запрет Сб/Вс: выходных нет', wsNoW.every(function (w) { return wdOf(w) !== 6 && wdOf(w) !== 7; }), JSON.stringify(wsNoW.slice(0, 2)));

console.log('=== 19. Сервер: дни недели и нормализация ===');
var sWd = model.emptyState();
sWd.equipment.push({ id: 'wd', toSchedule: {}, kmhSchedule: {}, hasKmh: false, version: 0, planRules: [] });
var wdRuleRes = model.applyOp(sWd, { kind: 'plan_rule', eqId: 'wd', to: { planRules: [
  { work: 'ТО-1', baseDate: '2026-01-05', intervalDays: 7, tolerance: 0, shift: true, allowDays: [2, 2, 'y', 9], denyDays: [1, 1, 'x'], active: true }
] } });
assert('сервер нормализует дни недели', wdRuleRes.ok === true &&
       JSON.stringify(sWd.equipment[0].planRules[0].allowDays) === JSON.stringify([2]) &&
       JSON.stringify(sWd.equipment[0].planRules[0].denyDays) === JSON.stringify([1]),
       JSON.stringify(sWd.equipment[0].planRules[0].allowDays) + ' / ' + JSON.stringify(sWd.equipment[0].planRules[0].denyDays));
var wdGen = model.applyOp(sWd, { kind: 'plan_generate', eqId: 'wd', to: { year: 2026, rules: sWd.equipment[0].planRules } });
assert('сервер построил план с запретом дня', wdGen.ok === true && wdGen.added > 0, wdGen.added);
var schedWd = sWd.equipment[0].toSchedule, hasMon = false;
Object.keys(schedWd).forEach(function (m) {
  schedWd[m].forEach(function (w) { if (((new Date(Date.UTC(2026, MONTH_FULL.indexOf(m), w.day)).getUTCDay() + 6) % 7) + 1 === 1) hasMon = true; });
});
assert('сервер: понедельников в плане нет', hasMon === false);

console.log('=== 20. Дни недели: клиент и сервер совпадают ===');
var cWd = { id: 'cw', toSchedule: {}, kmhSchedule: {}, hasKmh: false,
            planRules: [{ work: 'ТО-1', baseDate: '2026-01-05', intervalDays: 7, tolerance: 0, shift: true, denyDays: [1], active: true }] };
planGenerateLocal(cWd, 2026, activePlanRules(cWd));
var sWd2 = model.emptyState();
sWd2.equipment.push({ id: 'sw', toSchedule: {}, kmhSchedule: {}, hasKmh: false, version: 0, planRules: [] });
model.applyOp(sWd2, { kind: 'plan_rule', eqId: 'sw', to: { planRules: [{ work: 'ТО-1', baseDate: '2026-01-05', intervalDays: 7, tolerance: 0, shift: true, denyDays: [1], active: true }] } });
model.applyOp(sWd2, { kind: 'plan_generate', eqId: 'sw', to: { year: 2026, rules: sWd2.equipment[0].planRules } });
assert('дни недели: клиент=сервер', canon(cWd.toSchedule) === canon(sWd2.equipment[0].toSchedule));

console.log('=== 21. Политика по умолчанию: без Пт/Сб/Вс ===');
var defPolicy = planDayPolicy({});
assert('политика по умолчанию: deny = Пт,Сб,Вс', JSON.stringify(defPolicy.deny) === JSON.stringify([5, 6, 7]) && JSON.stringify(defPolicy.allow) === JSON.stringify([]),
       JSON.stringify(defPolicy));
assert('явно пустой список уважается', JSON.stringify(planDayPolicy({ denyDays: [], allowDays: [] }).deny) === JSON.stringify([]));
var defRule = { work: 'ТО-1', baseDate: '2026-01-02', intervalDays: 1, tolerance: 0, active: true }; // 02.01.2026 — пятница
var defWorks = planRuleWorks(defRule, 2026);
assert('по умолчанию только Пн–Чт', defWorks.length > 0 && defWorks.every(function (w) { return wdOf(w) >= 1 && wdOf(w) <= 4; }),
       JSON.stringify(defWorks.slice(0, 5)));
var sDef = model.emptyState();
sDef.equipment.push({ id: 'sd', toSchedule: {}, kmhSchedule: {}, hasKmh: false, version: 0, planRules: [] });
model.applyOp(sDef, { kind: 'plan_rule', eqId: 'sd', to: { planRules: [{ work: 'ТО-1', baseDate: '2026-01-02', intervalDays: 1, tolerance: 0, active: true }] } });
assert('сервер проставил дни по умолчанию', JSON.stringify(sDef.equipment[0].planRules[0].denyDays) === JSON.stringify([5, 6, 7]),
       JSON.stringify(sDef.equipment[0].planRules[0].denyDays));
model.applyOp(sDef, { kind: 'plan_generate', eqId: 'sd', to: { year: 2026, rules: sDef.equipment[0].planRules } });
var schedDef = sDef.equipment[0].toSchedule, badDay = false;
Object.keys(schedDef).forEach(function (m) {
  schedDef[m].forEach(function (w) { var d = ((new Date(Date.UTC(2026, MONTH_FULL.indexOf(m), w.day)).getUTCDay() + 6) % 7) + 1; if (d > 4) badDay = true; });
});
assert('сервер: по умолчанию только Пн–Чт', badDay === false);

console.log('');
console.log(fails === 0 ? '!!! АВТОПЛАНИРОВАНИЕ: ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ !!!' : ('!!! ПРОВАЛОВ: ' + fails + ' !!!'));
process.exit(fails === 0 ? 0 : 1);
`;

fs.writeFileSync('tools/_planning.js', code);
require('./_planning.js');
