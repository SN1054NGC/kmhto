/*
 * KMHTO — учёт и планирование ТО/КМХ метрологического оборудования
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Логвиненко А. А. (SN1054NGC) <logvinenko-aa@mail.ru>
 * Исходный код: https://github.com/SN1054NGC/kmhto
 */
'use strict';
/**
 * Поиск в ФГИС «Аршин» (Росстандарт) через внешний публичный интерфейс.
 *
 *   GET https://fgis.gost.ru/fundmetrology/eapi/vri?<параметры>
 *
 * Мягкий (по части строки) поиск: *текст*, пробелы заменяются на ?.
 * Полное совпадение: текст, пробелы заменяются на ?.
 *
 * Ограничения Росстандарта: не чаще одного обращения в секунду-пять
 * (иначе блокировка), доступ ограничен с зарубежных IP и через VPN.
 * Поэтому запросы идут через сервер, с паузой, кэшем и таймаутом.
 */
const EAPI = process.env.KMHTO_ARSHIN_URL || 'https://fgis.gost.ru/fundmetrology/eapi/vri';
const USER_AGENT = 'KMHTO/1.0 (local metrology planner)';   // заголовки — только латиница
const MIN_INTERVAL_MS = parseInt(process.env.KMHTO_ARSHIN_INTERVAL_MS || '1200', 10);
const TIMEOUT_MS = parseInt(process.env.KMHTO_ARSHIN_TIMEOUT_MS || '20000', 10);
const CACHE_TTL_MS = parseInt(process.env.KMHTO_ARSHIN_CACHE_MS || String(10 * 60 * 1000), 10);

let lastCallAt = 0;
let chain = Promise.resolve();
const cache = new Map();

/** Мягкий поиск по части строки: *иванов?насос* */
function soft(value) {
  return '*' + String(value === null || value === undefined ? '' : value).trim().replace(/\s+/g, '?') + '*';
}

/** Точный поиск: значение без звёздочек (пробелы — ?) */
function exact(value) {
  return String(value === null || value === undefined ? '' : value).trim().replace(/\s+/g, '?');
}

function buildQuery(params) {
  const p = [];
  // sort передаётся как есть: ФГИС ждёт «поле+asc|desc», а не поле%2Basc
  const add = function (k, v, raw) {
    if (v === undefined || v === null || String(v).length === 0) return;
    p.push(k + '=' + (raw ? String(v) : encodeURIComponent(String(v))));
  };
  if (params.year) add('year', params.year);
  if (params.number) add('mi_number', params.isExact ? exact(params.number) : soft(params.number));
  if (params.name) add('mit_title', soft(params.name));
  if (params.number2) add('mi_number', params.isExact ? exact(params.number2) : soft(params.number2));
  if (params.mitNumber) add('mit_number', soft(params.mitNumber));
  if (params.docnum) add('result_docnum', soft(params.docnum));
  if (params.notation) add('mit_notation', soft(params.notation));
  if (params.org) add('org_title', soft(params.org));
  add('start', Math.max(0, parseInt(params.start, 10) || 0));
  add('rows', Math.min(Math.max(parseInt(params.rows, 10) || 20, 1), 100));
  add('sort', params.sort || 'verification_date+desc', true);
  return p.join('&');
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/** Один запрос к ФГИС с соблюдением паузы между обращениями. */
function callApi(query) {
  const run = chain.then(async function () {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastCallAt);
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
    const ctl = new AbortController();
    const timer = setTimeout(function () { ctl.abort(); }, TIMEOUT_MS);
    try {
      const res = await fetch(EAPI + '?' + query, {
        signal: ctl.signal,
        headers: { accept: 'application/json', 'user-agent': USER_AGENT }
      });
      const text = await res.text();
      if (!res.ok) throw new Error('ФГИС Аршин ответил ' + res.status);
      let json;
      try { json = JSON.parse(text); } catch (e) { throw new Error('ответ ФГИС не является JSON (доступ может быть ограничен VPN или зарубежным IP)'); }
      if (json.status && json.message) throw new Error(String(json.message));
      if (!json.result || !Array.isArray(json.result.items)) throw new Error('неожиданный формат ответа ФГИС Аршин');
      return json.result;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('ФГИС Аршин не ответил за ' + Math.round(TIMEOUT_MS / 1000) + ' с');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  });
  // важное: цепочка не должна «застревать» на ошибке, иначе все следующие
  // запросы будут повторять старую ошибку
  chain = run.catch(function () {});
  return run;
}

// Ссылка на запись. Именно /eapi/... — путь /cm/iaux/... перехватывается
// service worker'ом приложения Аршина и в браузере не открывается.
function recordUrl(vriId) {
  return vriId
    ? ('https://fgis.gost.ru/fundmetrology/eapi/vri/' + encodeURIComponent(vriId))
    : 'https://fgis.gost.ru/fundmetrology/cm/results';
}

function normalizeItem(it) {
  const num = String(it.mi_number || '').trim();
  const id = String(it.vri_id || '');
  return {
    id: id,
    org: String(it.org_title || ''),
    mitNumber: String(it.mit_number || ''),
    title: String(it.mit_title || ''),
    notation: String(it.mit_notation || ''),
    modification: String(it.mi_modification || ''),
    number: num,
    verificationDate: String(it.verification_date || ''),
    validDate: String(it.valid_date || ''),
    docnum: String(it.result_docnum || ''),
    applicable: it.applicability === true,
    // точная запись по идентификатору — открывается в браузере и не содержит «похожих»
    url: recordUrl(id),
    searchUrl: 'https://fgis.gost.ru/fundmetrology/cm/results'
  };
}

/**
 * Поиск: сначала по заводскому номеру (точнее), затем по части наименования.
 * Результаты объединяются без повторов.
 */
async function search(params) {
  const rows = Math.min(Math.max(parseInt(params.rows, 10) || 20, 1), 100);
  const number = String(params.number || '').trim();
  const number2 = String(params.number2 || '').trim();
  const name = String(params.name || '').trim();
  const mitNumber = String(params.mitNumber || '').trim();
  const docnum = String(params.docnum || '').trim();
  const org = String(params.org || '').trim();
  const notation = String(params.notation || '').trim();
  if (!number && !number2 && !name && !mitNumber && !docnum && !org && !notation) {
    throw new Error('укажите заводской номер, рег. № типа, № свидетельства, организацию или часть наименования');
  }

  const key = JSON.stringify({ number: number, number2: number2, name: name, mitNumber: mitNumber,
    docnum: docnum, org: org, notation: notation, year: params.year || '', rows: rows, sort: params.sort || '' });
  const hit = cache.get(key);
  if (hit && (Date.now() - hit.ts) < CACHE_TTL_MS) {
    return Object.assign({}, hit.value, { cached: true });
  }

  // Номера: точное совпадение в приоритете, затем нечёткое, затем название.
  const numbers = [];
  [params.numbers, number, number2].forEach(function (src) {
    if (!src) return;
    String(src).split(/[,;\s]+/).forEach(function (v) {
      const t = v.trim();
      if (t && numbers.indexOf(t) === -1) numbers.push(t);
    });
  });

  const queries = [];
  let mode = '';
  const newCriteria = !!(mitNumber || docnum || notation || org);
  const criteriaCount = numbers.length + (mitNumber ? 1 : 0) + (docnum ? 1 : 0) +
                        (notation ? 1 : 0) + (name ? 1 : 0) + (org ? 1 : 0);
  // Несколько условий: сначала пробуем одно уточнённое — ФГИС комбинирует поля
  // как «И». Если не подошло, ниже идёт перебор по одному критерию.
  if (newCriteria && criteriaCount >= 2) {
    queries.push({ q: buildQuery({ number: numbers[0], mitNumber: mitNumber, docnum: docnum, notation: notation,
                                   name: name, org: org, year: params.year, rows: rows, sort: params.sort }), mode: 'combined' });
  }
  numbers.forEach(function (n) { queries.push({ q: buildQuery({ number: n, rows: rows, sort: params.sort, isExact: true }), mode: 'exact', number: n }); });
  numbers.forEach(function (n) { queries.push({ q: buildQuery({ number: n, rows: rows, sort: params.sort }), mode: 'fuzzy', number: n }); });
  if (mitNumber) queries.push({ q: buildQuery({ mitNumber: mitNumber, year: params.year, rows: rows, sort: params.sort }), mode: 'mit' });
  if (docnum) queries.push({ q: buildQuery({ docnum: docnum, year: params.year, rows: rows, sort: params.sort }), mode: 'docnum' });
  if (notation) queries.push({ q: buildQuery({ notation: notation, year: params.year, rows: rows, sort: params.sort }), mode: 'notation' });
  if (name) queries.push({ q: buildQuery({ name: name, org: org, year: params.year, rows: rows, sort: params.sort }), mode: 'name' });
  if (org && !name) queries.push({ q: buildQuery({ org: org, year: params.year, rows: rows, sort: params.sort }), mode: 'org' });
  if (!queries.length) throw new Error('пустой запрос');

  const items = [];
  const seen = {};
  let count = 0;
  let lastError = null;
  for (let i = 0; i < queries.length; i++) {
    const step = queries[i];
    try {
      const r = await callApi(step.q);
      let found = (r.items || []).map(normalizeItem);
      // при точном поиске отбрасываем всё, что не совпало по номеру целиком
      if (step.mode === 'exact' && step.number) {
        const want = step.number.toLowerCase();
        found = found.filter(function (x) { return String(x.number).trim().toLowerCase() === want; });
      }
      count = Math.max(count, r.count || 0);
      found.forEach(function (n) {
        if (n.id && !seen[n.id]) { seen[n.id] = true; items.push(n); }
      });
      if (items.length) { mode = step.mode; break; }   // нашли — дальше не ищем
    } catch (e) {
      lastError = e;
      if (i === 0) break;          // сеть/доступ — дальше пробовать бессмысленно
    }
  }
  if (!items.length && lastError) throw lastError;

  const value = { count: count, shown: items.length, items: items.slice(0, rows), queries: queries.length, mode: mode || 'name', cached: false };
  cache.set(key, { ts: Date.now(), value: value });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return value;
}

/** Полная запись по идентификатору: данные + ссылка на карточку типа СИ */
function record(vriId) {
  const id = String(vriId || '').trim();
  if (!id) return Promise.reject(new Error('не указан идентификатор записи'));
  const url = 'https://fgis.gost.ru/fundmetrology/cm/iaux/vri/' + encodeURIComponent(id) + '?nonpub=1';
  const ctl = new AbortController();
  const timer = setTimeout(function () { ctl.abort(); }, TIMEOUT_MS);
  return fetch(url, { signal: ctl.signal, headers: { accept: 'application/json', 'user-agent': USER_AGENT } })
    .then(function (r) { return r.text().then(function (t) { return { ok: r.ok, status: r.status, text: t }; }); })
    .then(function (r) {
      if (!r.ok) throw new Error('ФГИС Аршин ответил ' + r.status);
      let j;
      try { j = JSON.parse(r.text); } catch (e) { throw new Error('ответ ФГИС не является JSON'); }
      const res = j.result || {};
      const mi = (res.miInfo && res.miInfo.singleMI) || {};
      const vi = res.vriInfo || {};
      const np = res.nonpub || {};
      const means = res.means || {};

      // Эталоны, которыми поверяли (со ссылками на их типы)
      const etalons = (means.mieta || []).map(function (e) {
        return {
          regNumber: String(e.regNumber || ''),
          regUrl: String(e.mietaURL || ''),
          typeNumber: String(e.mitypeNumber || ''),
          typeUrl: String(e.mitypeURL || ''),
          title: String(e.mitypeTitle || ''),
          notation: String(e.notation || ''),
          modification: String(e.modification || ''),
          number: String(e.manufactureNum || ''),
          year: e.manufactureYear || '',
          rankCode: String(e.rankCode || ''),
          rankTitle: String(e.rankTitle || ''),
          schemaTitle: String(e.schemaTitle || '')
        };
      });
      // Средства измерений, применённые при поверке
      const applied = (means.mis || []).map(function (m) {
        return {
          typeNumber: String(m.mitypeNumber || ''),
          typeUrl: String(m.mitypeURL || ''),
          title: String(m.mitypeTitle || ''),
          number: String(m.number || '')
        };
      });

      return {
        id: id,
        url: recordUrl(id),
        // средство измерений
        typeNumber: String(mi.mitypeNumber || ''),
        notation: String(mi.mitypeType || ''),
        title: String(mi.mitypeTitle || ''),
        modification: String(mi.modification || ''),
        number: String(mi.manufactureNum || ''),
        typeUrl: String(mi.mitypeURL || ''),
        // поверка
        org: String(vi.organization || ''),
        verificationDate: String(vi.vrfDate || ''),
        validDate: String(vi.validDate || ''),
        docTitle: String(vi.docTitle || ''),
        certificate: String((vi.applicable && vi.applicable.certNum) || ''),
        vriType: String(vi.vriType || ''),
        signCipher: String(vi.signCipher || ''),
        owner: String(vi.miOwner || ''),
        // условия и поверитель
        verifier: String(np.verifiername || ''),
        calibration: np.calibration === true,
        conditions: np.conditions || null,
        // эталоны и применённые СИ
        etalons: etalons,
        applied: applied,
        additionalInfo: String((res.info && res.info.additional_info) || ''),
        checkedAt: new Date().toISOString()
      };
    })
    .finally(function () { clearTimeout(timer); });
}

function stats() {
  return { cached: cache.size, minIntervalMs: MIN_INTERVAL_MS, endpoint: EAPI };
}

module.exports = { search, record, soft, exact, buildQuery, normalizeItem, recordUrl, stats };
