/*
 * KMHTO — учёт и планирование ТО/КМХ метрологического оборудования
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Логвиненко А. А. (SN1054NGC) <logvinenko-aa@mail.ru>
 * Исходный код: https://github.com/SN1054NGC/kmhto
 */
'use strict';
/**
 * Авторитетная модель расписания. Сервер применяет ОПЕРАЦИИ (не «значения ячеек»),
 * поэтому перенос, смена вида и перестановка конкурируют корректно.
 * Логика повторяет клиентскую (app_kmhto.html), но описана данными.
 */

const MONTHS = ['январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'];

function emptyState() {
  return {
    equipment: [],
    holidays: {},
    notes: {},
    docVersion: 0,
    docLastAuthor: null,
    docLastRole: null
  };
}

function monthName(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') return MONTHS[v - 1] || null;
  const s = String(v).toLowerCase().trim();
  if (MONTHS.indexOf(s) !== -1) return s;
  const n = parseInt(s, 10);
  if (!isNaN(n) && n >= 1 && n <= 12) return MONTHS[n - 1];
  return null;
}

function findEq(state, id) {
  return state.equipment.find(function (e) { return e.id === id; }) || null;
}

function pad2(n) { return String(n).padStart(2, '0'); }

function isWeekend(y, m, d) {
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === 0 || dow === 6;
}

function isDayOff(state, y, m, d) {
  if (isWeekend(y, m, d)) return true;
  return !!state.holidays[y + '-' + pad2(m) + '-' + pad2(d)];
}

/** Номер дня недели: 1=Пн … 7=Вс */
function planWeekday(y, m, d) {
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd === 0 ? 7 : wd;
}

/**
 * Подбор планового дня:
 *   opts.shift — сдвигать с выходных/праздников (по умолчанию да);
 *   opts.allow — только эти дни недели (пусто — любые);
 *   opts.deny  — не ставить в эти дни недели;
 *   tol        — допуск ± дней. Если заданы дни недели, окно — не меньше недели.
 */
function planSnapDay(state, y, m, d, tol, opts) {
  const o = opts || {};
  const shift = o.shift !== false;
  const allow = Array.isArray(o.allow) ? o.allow : [];
  const deny = Array.isArray(o.deny) ? o.deny : [];
  const win = Math.max(parseInt(tol, 10) || 0, (allow.length || deny.length) ? 6 : 0);
  if (win < 1) return d;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const ok = function (day) {
    if (shift && isDayOff(state, y, m, day)) return false;
    const wd = planWeekday(y, m, day);
    if (deny.indexOf(wd) !== -1) return false;
    if (allow.length && allow.indexOf(wd) === -1) return false;
    return true;
  };
  if (ok(d)) return d;
  for (let off = 1; off <= win; off++) {
    if (d + off <= last && ok(d + off)) return d + off;
    if (d - off >= 1 && ok(d - off)) return d - off;
  }
  return d;
}

/** Совместимость: сдвиг только с выходных в пределах ±tol. */
function snapDayWithinMonth(state, y, m, d, tol) {
  return planSnapDay(state, y, m, d, tol, { shift: true });
}

/** Найти запись. type=null/undefined -> искать по дню в обоих графиках. */
function findRec(eq, month, type, day) {
  const want = (type === undefined) ? null : type;
  const fields = (want && want !== 'КМХ') ? ['toSchedule'] : (want === 'КМХ' ? ['kmhSchedule'] : ['toSchedule', 'kmhSchedule']);
  for (let f = 0; f < fields.length; f++) {
    const field = fields[f];
    const arr = eq[field] && eq[field][month];
    if (!Array.isArray(arr)) continue;
    for (let i = 0; i < arr.length; i++) {
      const it = arr[i];
      const d = (typeof it === 'object') ? it.day : it;
      const t = (typeof it === 'object') ? it.type : 'КМХ';
      if (d === day && (!want || t === want)) return { field: field, arr: arr, index: i, item: it };
    }
  }
  return null;
}

function removeRec(eq, month, type, day) {
  const rec = findRec(eq, month, type, day);
  if (!rec) return null;
  const removed = rec.arr.splice(rec.index, 1)[0];
  const t = (typeof removed === 'object') ? removed.type : 'КМХ';
  return { field: rec.field, type: t, day: (typeof removed === 'object') ? removed.day : removed };
}

function addRec(eq, month, type, day) {
  if (type === 'КМХ') {
    if (!eq.kmhSchedule) eq.kmhSchedule = {};
    if (!Array.isArray(eq.kmhSchedule[month])) eq.kmhSchedule[month] = [];
    if (eq.kmhSchedule[month].indexOf(day) !== -1) return false;
    eq.kmhSchedule[month].push(day);
    eq.kmhSchedule[month].sort(function (a, b) { return a - b; });
    eq.hasKmh = true;
    return true;
  }
  if (!eq.toSchedule) eq.toSchedule = {};
  if (!Array.isArray(eq.toSchedule[month])) eq.toSchedule[month] = [];
  const exists = eq.toSchedule[month].some(function (w) { return w.day === day && w.type === type; });
  if (exists) return false;
  eq.toSchedule[month].push({ type: type, day: day });
  return true;
}

function validDate(day) { return Number.isInteger(day) && day >= 1 && day <= 31; }

/* ------------------------------------------------------------------ */
/* Правила планирования и автогенерация графика на год                 */
/* ------------------------------------------------------------------ */

const PLAN_WORK_TYPES = ['ТО-1', 'ТО-2', 'ТО-3', 'КМХ'];

/** Политика дней по умолчанию: Пн–Чт можно, Пт/Сб/Вс — нет. */
const DEFAULT_PLAN_DENY_DAYS = [5, 6, 7];

/** Привести список дней недели к 1..7 без повторов. */
function normalizeWeekdays(arr) {
  const out = [];
  if (Array.isArray(arr)) arr.forEach(function (v) {
    const n = parseInt(v, 10);
    if (n >= 1 && n <= 7 && out.indexOf(n) === -1) out.push(n);
  });
  return out.sort(function (a, b) { return a - b; });
}

/**
 * Дни недели для планирования. Отсутствие поля — «по умолчанию» (без Пт/Сб/Вс),
 * пустой массив — пользователь снял все галочки, уважаем как есть.
 */
function planDayPolicy(src) {
  const s = src || {};
  return {
    shift: s.shift !== false,
    allow: s.allowDays == null ? [] : normalizeWeekdays(s.allowDays),
    deny: s.denyDays == null ? DEFAULT_PLAN_DENY_DAYS.slice() : normalizeWeekdays(s.denyDays)
  };
}

function normalizePlanRule(r) {
  if (!r || typeof r !== 'object') return null;
  const work = String(r.work || '');
  if (PLAN_WORK_TYPES.indexOf(work) === -1) return null;
  const intervalDays = parseInt(r.intervalDays, 10);
  if (!(intervalDays >= 1 && intervalDays <= 3650)) return null;
  const baseDate = String(r.baseDate || '');
  const hasBase = /^\d{4}-\d{2}-\d{2}$/.test(baseDate);
  const starts = {};
  if (r.starts && typeof r.starts === 'object') {
    Object.keys(r.starts).forEach(function (y) {
      if (/^\d{4}$/.test(y) && /^\d{4}-\d{2}-\d{2}$/.test(String(r.starts[y] || ''))) starts[y] = String(r.starts[y]);
    });
  }
  const autoContinue = r.autoContinue === true;
  // Основание расчёта: базовая дата, ручная стартовая дата на год или
  // автопродолжение от последней даты прошлого года.
  if (!hasBase && !autoContinue && !Object.keys(starts).length) return null;
  let tolerance = parseInt(r.tolerance, 10);
  if (!(tolerance >= 0)) tolerance = 0;
  if (tolerance > 31) tolerance = 31;
  // Дни недели: если день попал и в allow, и в deny — при подборе побеждает deny
  // (так же считает клиент), поэтому списки не «вычищаем» друг другом.
  const allowDays = r.allowDays == null ? [] : normalizeWeekdays(r.allowDays);
  const denyDays = r.denyDays == null ? DEFAULT_PLAN_DENY_DAYS.slice() : normalizeWeekdays(r.denyDays);
  return {
    id: String(r.id || ('rule_' + Math.random().toString(36).slice(2, 9))),
    work: work,
    baseDate: hasBase ? baseDate : '',
    intervalDays: intervalDays,
    tolerance: tolerance,
    note: String(r.note || '').slice(0, 500),
    active: r.active !== false,
    autoContinue: autoContinue,
    starts: starts,
    shift: r.shift !== false,
    allowDays: allowDays,
    denyDays: denyDays
  };
}

function activePlanRules(eq) {
  return (eq && Array.isArray(eq.planRules) ? eq.planRules : []).filter(function (r) {
    if (!r || r.active === false) return false;
    if (PLAN_WORK_TYPES.indexOf(r.work) === -1) return false;
    if (!(parseInt(r.intervalDays, 10) > 0)) return false;
    const hasStart = !!(r.starts && Object.keys(r.starts).some(function (y) {
      return /^\d{4}-\d{2}-\d{2}$/.test(String(r.starts[y] || ''));
    }));
    return /^\d{4}-\d{2}-\d{2}$/.test(String(r.baseDate || '')) || hasStart || r.autoContinue === true;
  });
}

/** Последняя дата (месяц/день) по виду работ — «конец прошлого года». */
function planLastAnchor(eq, work) {
  let best = null;
  function consider(monthKey, day) {
    const d = parseInt(day, 10);
    if (!(d >= 1)) return;
    let idx = MONTHS.indexOf(String(monthKey || '').toLowerCase().trim());
    if (idx === -1) {
      const n = parseInt(monthKey, 10);
      if (n >= 1 && n <= 12) idx = n - 1;
    }
    if (idx === -1) return;
    const key = (idx + 1) * 100 + d;
    if (!best || key > best.key) best = { key: key, month: idx + 1, day: d };
  }
  if (work === 'КМХ') {
    Object.keys(eq.kmhSchedule || {}).forEach(function (m) {
      (eq.kmhSchedule[m] || []).forEach(function (d) { consider(m, d); });
    });
  } else {
    Object.keys(eq.toSchedule || {}).forEach(function (m) {
      (eq.toSchedule[m] || []).forEach(function (w) {
        if (w && w.type === work) consider(m, w.day);
      });
    });
  }
  return best ? { month: best.month, day: best.day } : null;
}

/**
 * Работы, которые правило даёт в указанном году.
 * Основание: ручная стартовая дата на год -> автопродолжение от последней даты
 * прошлого года (anchor) -> базовая дата. tolerance — окно ± дней.
 */
function planRuleWorks(state, rule, year, anchor) {
  const out = [];
  const work = rule.work;
  const interval = parseInt(rule.intervalDays, 10);
  const tol = parseInt(rule.tolerance, 10) || 0;
  if (!work || !(interval > 0)) return out;
  const snapOpts = planDayPolicy(rule);
  const starts = rule.starts || {};
  const manual = starts[String(year)];
  let base = null;
  if (manual && /^\d{4}-\d{2}-\d{2}$/.test(String(manual))) {
    base = new Date(String(manual) + 'T00:00:00Z');
  } else if (rule.autoContinue === true && anchor && anchor.month && anchor.day) {
    base = new Date(Date.UTC(year - 1, anchor.month - 1, anchor.day));
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(String(rule.baseDate || ''))) {
    base = new Date(String(rule.baseDate) + 'T00:00:00Z');
  }
  if (!base || isNaN(base.getTime())) return out;
  const end = new Date(Date.UTC(year, 11, 31));
  const cur = new Date(base.getTime());
  let guard = 0;
  while (cur <= end && guard < 10000) {
    guard++;
    if (cur.getUTCFullYear() === year) {
      const mo = cur.getUTCMonth() + 1;
      const day = cur.getUTCDate();
      const snapped = planSnapDay(state, year, mo, day, tol, snapOpts);
      out.push({ month: MONTHS[mo - 1], day: snapped, type: work, shifted: snapped !== day, expected: day });
    }
    cur.setUTCDate(cur.getUTCDate() + interval);
  }
  return out;
}

/** Снять ранее построенный по правилам график (по eq.planGen). */
function removeGenerated(eq) {
  const gen = eq.planGen;
  const removed = { to: [], kmh: [] };
  if (!gen) return removed;
  function rm(field, month, want) {
    const arr = eq[field] && eq[field][month];
    if (!Array.isArray(arr)) return;
    for (let i = arr.length - 1; i >= 0; i--) {
      const it = arr[i];
      const day = (typeof it === 'object') ? it.day : it;
      const type = (typeof it === 'object') ? it.type : 'КМХ';
      const match = (field === 'kmhSchedule') ? (day === want.day) : (day === want.day && type === want.type);
      if (match) {
        arr.splice(i, 1);
        (field === 'kmhSchedule' ? removed.kmh : removed.to).push({ month: month, day: day, type: type });
      }
    }
  }
  Object.keys(gen.to || {}).forEach(function (m) {
    (gen.to[m] || []).forEach(function (w) { rm('toSchedule', m, { day: w.day, type: w.type }); });
  });

  Object.keys(gen.kmh || {}).forEach(function (m) {
    (gen.kmh[m] || []).forEach(function (d) { rm('kmhSchedule', m, { day: d, type: 'КМХ' }); });
  });
  // пустые месяцы не храним — иначе они накапливаются при смене года
  ['toSchedule', 'kmhSchedule'].forEach(function (field) {
    const obj = eq[field];
    if (!obj) return;
    Object.keys(obj).forEach(function (m) {
      if (Array.isArray(obj[m]) && obj[m].length === 0) delete obj[m];
    });
  });
  return removed;
}

/** Построить график на год по правилам, сохранив ручные записи. */
function generatePlanForEq(state, eq, year, rules) {
  const useRules = rules || [];
  // Якоря (последняя дата прошлого года) считаем ДО снятия автоплана.
  const anchors = {};
  useRules.forEach(function (rule) {
    if (rule.autoContinue === true && !(rule.starts && rule.starts[String(year)])) {
      const a = planLastAnchor(eq, rule.work);
      if (a) anchors[rule.work] = a;
    }
  });
  const removed = removeGenerated(eq);
  const gen = { year: year, to: {}, kmh: {}, starts: {} };
  let added = 0, shifted = 0;
  useRules.forEach(function (rule) {
    const works = planRuleWorks(state, rule, year, anchors[rule.work]);
    if (works.length) {
      gen.starts[rule.work] = {
        month: works[0].month, day: works[0].day,
        auto: rule.autoContinue === true && !(rule.starts && rule.starts[String(year)])
      };
    }
    works.forEach(function (w) {
      const isKmh = (w.type === 'КМХ');
      if (addRec(eq, w.month, w.type, w.day)) {
        added++;
        if (isKmh) (gen.kmh[w.month] = gen.kmh[w.month] || []).push(w.day);
        else (gen.to[w.month] = gen.to[w.month] || []).push({ type: w.type, day: w.day });
      }
      if (w.shifted) shifted++;
    });
  });
  // В gen попадает только то, что генератор реально добавил: ручная запись,
  // уже стоявшая на этом дне, не объявляется автопланом и не снимается.
  eq.planGen = gen;
  return { added: added, shifted: shifted, removed: removed.to.length + removed.kmh.length };
}

/**
 * Применить операцию к состоянию.
 * op = { kind, eqId, eqIds, from, to, meta, year, ... }
 * Возвращает { ok:true, changed:boolean } либо { ok:false, reason }
 */
function applyOp(state, op) {
  const kind = op.kind;
  const eq = op.eqId ? findEq(state, op.eqId) : null;

  if (kind === 'holiday') {
    const date = op.to && op.to.date;
    if (!date) return { ok: false, reason: 'не указана дата' };
    if (op.to.holiday) {
      const already = !!state.holidays[date];
      state.holidays[date] = { by: op.authorName, ts: op.ts };
      return { ok: true, changed: !already };
    }
    const existed = !!state.holidays[date];
    delete state.holidays[date];
    return { ok: true, changed: existed };
  }

  if (kind === 'note') {
    const date = op.to && op.to.date;
    const note = op.to && op.to.note;
    if (!date) return { ok: false, reason: 'не указана дата' };
    const key = (op.eqId || '_doc') + '|' + date;
    if (note) state.notes[key] = { note: note, by: op.authorName, ts: op.ts };
    else delete state.notes[key];
    return { ok: true, changed: true };
  }

  if (!eq) return { ok: false, reason: 'неизвестное оборудование: ' + (op.eqId || '—') };

  const from = op.from || {};
  const to = op.to || {};

  if (kind === 'metrology') {
    const m = op.to && op.to.metrology;
    const tk = op.to ? op.to.tk : undefined;
    if ((!m || typeof m !== 'object') && tk === undefined) {
      return { ok: false, reason: 'не переданы данные карточки' };
    }
    if (m && typeof m === 'object') eq.metrology = m;
    if (tk !== undefined) eq.tk = String(tk || '');
    return { ok: true, changed: true };
  }

  if (kind === 'add_work') {
    const m = monthName(to.month);
    if (!m || !validDate(to.day) || !to.type) return { ok: false, reason: 'некорректная цель' };
    return { ok: true, changed: addRec(eq, m, to.type, to.day) };
  }

  if (kind === 'delete_work') {
    const m = monthName(from.month);
    if (!m) return { ok: false, reason: 'некорректный месяц' };
    if (from.type) {
      const r = removeRec(eq, m, from.type, from.day);
      return { ok: true, changed: !!r };
    }
    const a = removeRec(eq, m, null, from.day);
    const b = removeRec(eq, m, null, from.day);
    return { ok: true, changed: !!(a || b) };
  }

  if (kind === 'change_type') {
    const m = monthName(from.month);
    if (!m || !to.type) return { ok: false, reason: 'некорректные параметры' };
    const removed = removeRec(eq, m, from.type, from.day) || removeRec(eq, m, null, from.day);
    if (!removed) return { ok: false, reason: 'запись не найдена' };
    addRec(eq, m, to.type, removed.day);
    return { ok: true, changed: true };
  }

  if (kind === 'move_work' || kind === 'move_and_type') {
    const fromMonth = monthName(from.month);
    const toMonth = monthName(to.month);
    const newType = (kind === 'move_and_type') ? to.type : null;
    if (!fromMonth || !toMonth || !validDate(to.day)) return { ok: false, reason: 'некорректные параметры' };
    const removed = removeRec(eq, fromMonth, from.type, from.day);
    if (!removed) return { ok: false, reason: 'запись не найдена' };
    addRec(eq, toMonth, newType || removed.type, to.day);
    return { ok: true, changed: true };
  }

  if (kind === 'swap_days' || kind === 'swap_types') {
    const a = findRec(eq, monthName(from.month), from.type, from.day);
    const b = findRec(eq, monthName(to.month), to.type, to.day);
    if (!a || !b) return { ok: false, reason: 'записи для перестановки не найдены' };
    if (a.arr === b.arr && a.index === b.index) return { ok: false, reason: 'это одна и та же запись' };
    if (kind === 'swap_days') {
      const tmp = a.item.day;
      a.item.day = b.item.day;
      b.item.day = tmp;
    } else {
      const tmp = a.item.type;
      a.item.type = b.item.type;
      b.item.type = tmp;
    }
    return { ok: true, changed: true };
  }

  if (kind === 'plan_interval') {
    const work = to.work;
    const baseDate = to.baseDate;
    const intervalDays = parseInt(to.intervalDays, 10);
    const years = parseInt(to.years, 10) || 1;
    const tol = parseInt(to.tolerance, 10) || 0;
    const snapOpts = planDayPolicy(to);
    const year = op.year || new Date(baseDate + 'T00:00:00Z').getUTCFullYear();
    if (!work || !baseDate || !intervalDays || intervalDays < 1) return { ok: false, reason: 'некорректные параметры планирования' };
    const base = new Date(baseDate + 'T00:00:00Z');
    if (isNaN(base.getTime())) return { ok: false, reason: 'некорректная базовая дата' };
    const end = new Date(base.getTime());
    end.setUTCFullYear(end.getUTCFullYear() + years);
    let added = 0, shifted = 0, guard = 0;
    const cur = new Date(base.getTime());
    while (cur <= end && guard < 2000) {
      guard++;
      const y = cur.getUTCFullYear();
      if (y === year) {
        const mo = cur.getUTCMonth() + 1;
        let day = cur.getUTCDate();
        const snapped = planSnapDay(state, y, mo, day, tol, snapOpts);
        if (snapped !== day) { shifted++; day = snapped; }
        if (addRec(eq, MONTHS[mo - 1], work, day)) added++;
      }
      cur.setUTCDate(cur.getUTCDate() + intervalDays);
    }
    return { ok: true, changed: added > 0, added: added, shifted: shifted };
  }

  if (kind === 'plan_rule') {
    const rules = op.to && op.to.planRules;
    if (!Array.isArray(rules)) return { ok: false, reason: 'не переданы правила планирования' };
    const clean = rules.map(normalizePlanRule).filter(Boolean);
    if (rules.length && !clean.length) return { ok: false, reason: 'правила планирования некорректны' };
    eq.planRules = clean;
    return { ok: true, changed: true, rules: clean.length };
  }

  if (kind === 'plan_generate') {
    const year = parseInt(op.to && op.to.year, 10);
    if (!year || year < 1970 || year > 2200) return { ok: false, reason: 'некорректный год планирования' };
    let rules = (op.to && Array.isArray(op.to.rules))
      ? op.to.rules.map(normalizePlanRule).filter(Boolean)
      : activePlanRules(eq);
    if (!rules.length) return { ok: false, reason: 'нет активных правил планирования' };
    const res = generatePlanForEq(state, eq, year, rules);
    return { ok: true, changed: (res.added > 0 || res.removed > 0), added: res.added, shifted: res.shifted, year: year };
  }

  return { ok: false, reason: 'неизвестный вид операции: ' + kind };

}

/** Наложить снапшот оборудования (set_state): версии сохраняются/поднимаются. */
function replaceEquipment(state, list) {
  const prev = {};
  state.equipment.forEach(function (e) { prev[e.id] = e.version || 0; });
  state.equipment = list.map(function (e) {
    return {
      id: e.id,
      code: e.code || '',
      name: e.name || '',
      location: e.location || '',
      section: e.section || '',
      serialNumber: e.serialNumber || '',
      type: e.type || '',
      toSchedule: e.toSchedule || {},
      kmhSchedule: e.kmhSchedule || {},
      hasKmh: !!e.hasKmh,
      planRules: Array.isArray(e.planRules) ? e.planRules.map(normalizePlanRule).filter(Boolean) : [],
      planGen: e.planGen || null,
      version: e.version !== undefined ? e.version : (prev[e.id] || 0),
      lastAuthor: e.lastAuthor || null,
      lastRole: e.lastRole || null
    };
  });
  return state.equipment.length;
}

module.exports = {
  MONTHS, emptyState, monthName, findEq, findRec, removeRec, addRec,
  applyOp, replaceEquipment, isDayOff, snapDayWithinMonth, planSnapDay, planWeekday, validDate,
  normalizeWeekdays, planDayPolicy, DEFAULT_PLAN_DENY_DAYS,
  PLAN_WORK_TYPES, normalizePlanRule, activePlanRules, planLastAnchor, planRuleWorks,
  removeGenerated, generatePlanForEq
};
