/*
 * KMHTO — учёт и планирование ТО/КМХ метрологического оборудования
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Логвиненко А. А. (SN1054NGC) <logvinenko-aa@mail.ru>
 * Исходный код: https://github.com/SN1054NGC/kmhto
 */
'use strict';
/**
 * KMHTO collaboration server.
 *
 * Запуск:  node server/index.js
 * Настройки: KMHTO_PORT, KMHTO_HOST, KMHTO_DATA, KMHTO_ADMIN_PASSWORD,
 *            KMHTO_HEARTBEAT_MS, KMHTO_OPLOG_LIMIT.
 *
 * Принцип «сервер-арбитр»: клиент присылает ОПЕРАЦИЮ и baseVersion, сервер
 * сверяет права роли (взятой из подписанного токена), версии и применяет/
 * отклоняет. Никакие поля user/role из сообщения не принимаются.
 */
const http = require('http');
const path = require('path');
const fs = require('fs');

const config = require('./config');
const ws = require('./ws');
const auth = require('./auth');
const roles = require('./roles');
const model = require('./model');
const store = require('./store');
const arshin = require('./arshin');

const VERSION = require('./version');

config.ensureDataDir();
const DB_PATH = path.join(config.DATA_DIR, 'collab.db');
const db = store.open(DB_PATH);
const state = store.loadState(db);

// настройки ролей/прав переживают перезапуск
roles.loadFromState(store.getDoc(db, 'settings', null));

const clients = new Set();
let opCounter = 0;

// HTTP-транспорт (длинные опросы) — для хостингов, где прокси не туннелирует
// WebSocket. Сессия живёт по логину, события копятся в очереди.
const httpSessions = new Map();

function httpSession(user) {
  let s = httpSessions.get(user.login);
  if (!s) { s = { user: user, seq: 0, events: [], waiters: [], lastSeen: Date.now() }; httpSessions.set(user.login, s); }
  s.user = user;
  s.lastSeen = Date.now();
  return s;
}

function httpEmit(session, obj) {
  session.seq += 1;
  session.events.push({ seq: session.seq, msg: obj });
  if (session.events.length > 500) session.events.splice(0, session.events.length - 500);
  const waiters = session.waiters.splice(0);
  for (const w of waiters) { try { w(); } catch (e) {} }
}

function onlineList() {
  const out = [];
  const seen = {};
  for (const c of clients) {
    if (c.data.user && c.readyState === 1) {
      out.push({ login: c.data.user.login, name: c.data.user.name, role: c.data.user.role, since: c.data.since });
      seen[c.data.user.login] = true;
    }
  }
  const now = Date.now();
  for (const s of httpSessions.values()) {
    if (!s.user || seen[s.user.login]) continue;
    if (now - s.lastSeen > config.HEARTBEAT_TIMEOUT_MS) continue;
    out.push({ login: s.user.login, name: s.user.name, role: s.user.role, since: s.user.since || s.lastSeen });
  }
  return out;
}

function broadcast(obj, except) {
  const exceptLogin = (typeof except === 'string')
    ? except
    : (except && except.data && except.data.user ? except.data.user.login : null);
  const text = JSON.stringify(obj);
  for (const c of clients) {
    if (c === except) continue;
    if (c.data.user && c.readyState === 1) c.send(text);
  }
  for (const s of httpSessions.values()) {
    if (exceptLogin && s.user && s.user.login === exceptLogin) continue;
    httpEmit(s, obj);
  }
}

function broadcastPresence() {
  broadcast({ type: 'presence_update', online: onlineList() });
}

function versionsMap() {
  const v = { _doc: state.docVersion || 0 };
  for (const eq of state.equipment) v[eq.id] = eq.version || 0;
  return v;
}

function equipmentSlice(ids) {
  const out = {};
  for (const id of ids) {
    const eq = model.findEq(state, id);
    if (eq) out[id] = eq;
  }
  return out;
}

function fullState() {
  return {
    equipment: state.equipment,
    holidays: state.holidays,
    notes: state.notes,
    versions: versionsMap()
  };
}

/* ------------------------------------------------------------------ */
/* Арбитраж                                                            */
/* ------------------------------------------------------------------ */

function arbitrate(user, op) {
  if (!op || !op.kind) return { rejected: 'не указан вид операции' };
  if (!roles.canDo(user.role, op.kind)) {
    return { rejected: 'недостаточно прав на операцию «' + op.kind + '» (роль: ' + user.role + ')' };
  }
  const ids = (op.eqIds && op.eqIds.length) ? op.eqIds : (op.eqId ? [op.eqId] : []);

  if (!ids.length) {
    // документная операция (выходной, заметка, настройки)
    const base = op.baseVersion ? op.baseVersion._doc : undefined;
    if (base === undefined) return { rejected: 'не указана baseVersion документа' };
    if (base > (state.docVersion || 0)) return { rejected: 'baseVersion документа из будущего' };
    if (base < (state.docVersion || 0)) {
      const authorPriority = roles.getPriority(user.role);
      const lastPriority = roles.getPriority(state.docLastRole || 'viewer');
      if (authorPriority > lastPriority) return { ok: true, override: true };
      return { conflict: { docVersion: state.docVersion, currentUser: state.docLastAuthor } };
    }
    return { ok: true, override: false };
  }

  for (const id of ids) {
    const eq = model.findEq(state, id);
    if (!eq) return { rejected: 'неизвестное оборудование: ' + id };
    const base = op.baseVersion ? op.baseVersion[id] : undefined;
    if (base === undefined) return { rejected: 'не указана baseVersion для ' + id };
    if (base > (eq.version || 0)) return { rejected: 'baseVersion из будущего (клиент опередил сервер)' };
    if (base < (eq.version || 0)) {
      const authorPriority = roles.getPriority(user.role);
      const lastPriority = roles.getPriority(eq.lastRole || 'viewer');
      if (authorPriority > lastPriority) return { ok: true, override: true };
      return {
        conflict: {
          eqId: id,
          currentVersion: eq.version,
          currentUser: eq.lastAuthor,
          equipment: equipmentSlice([id])[id]
        }
      };
    }
  }
  return { ok: true, override: false };
}

function trimOps() {
  opCounter++;
  if (opCounter % 100 !== 0) return;
  try {
    db.exec('DELETE FROM oplog WHERE op_id NOT IN (SELECT op_id FROM oplog ORDER BY ts DESC LIMIT ' + config.OPLOG_LIMIT + ')');
  } catch (e) { /* не критично */ }
}

function handleOp(conn, msg) {
  const user = conn.data.user;
  const op = msg.op || {};
  if (!op.kind) return conn.sendJson({ type: 'op_rejected', opId: op.opId || null, reason: 'не указан вид операции' });

  // Идемпотентность: клиент может повторить операцию после обрыва связи
  // (офлайн-очередь). Повторно применять её нельзя.
  if (op.opId) {
    const dup = store.findOp(db, op.opId);
    if (dup) {
      const dupIds = (dup.eqIds && dup.eqIds.length) ? dup.eqIds : (dup.eqId ? [dup.eqId] : []);
      const res = {
        type: 'op_applied',
        opId: op.opId,
        kind: dup.kind,
        eqId: dup.eqId || null,
        eqIds: dupIds,
        status: 'duplicate',
        changed: false,
        duplicate: true,
        versions: dup.versions || {},
        versionsAll: versionsMap(),
        author: dup.authorId,
        role: dup.authorRole,
        ts: dup.ts
      };
      if (dupIds.length) res.equipment = equipmentSlice(dupIds);
      return conn.sendJson(res);
    }
  }

  const verdict = arbitrate(user, op);
  if (verdict.rejected) {
    return conn.sendJson({ type: 'op_rejected', opId: op.opId || null, reason: verdict.rejected });
  }
  if (verdict.conflict) {
    return conn.sendJson({ type: 'op_conflict', opId: op.opId || null, conflict: verdict.conflict, versions: versionsMap() });
  }

  const ids = (op.eqIds && op.eqIds.length) ? op.eqIds : (op.eqId ? [op.eqId] : []);
  const applied = model.applyOp(state, op);
  if (!applied.ok) {
    return conn.sendJson({ type: 'op_rejected', opId: op.opId || null, reason: applied.reason });
  }

  op.authorId = user.login;
  op.authorRole = user.role;
  op.authorName = user.name || user.login;
  op.ts = op.ts || Date.now();
  op.versions = {};

  if (ids.length) {
    for (const id of ids) {
      const eq = model.findEq(state, id);
      if (!eq) continue;
      eq.version = (eq.version || 0) + 1;
      eq.lastAuthor = user.login;
      eq.lastRole = user.role;
      op.versions[id] = eq.version;
      store.saveEquipment(db, eq);
    }
  } else {
    state.docVersion = (state.docVersion || 0) + 1;
    state.docLastAuthor = user.login;
    state.docLastRole = user.role;
    op.versions._doc = state.docVersion;
    store.saveDocSlice(db, state);
  }

  const status = !applied.changed ? 'noop' : (verdict.override ? 'overridden' : 'approved');
  store.saveOp(db, op, status);
  trimOps();

  const out = {
    type: 'op_applied',
    opId: op.opId || null,
    kind: op.kind,
    eqId: op.eqId || null,
    eqIds: ids,
    status: status,
    changed: !!applied.changed,
    added: applied.added,
    shifted: applied.shifted,
    versions: op.versions,
    versionsAll: versionsMap(),
    author: user.login,
    authorName: user.name || user.login,
    role: user.role,
    ts: op.ts,
    // «что было / что стало» — для журнала изменений у всех клиентов
    from: op.from || null,
    to: op.to || null,
    meta: op.meta || null,
    comment: op.comment || ''
  };
  if (ids.length) out.equipment = equipmentSlice(ids);
  if (op.kind === 'holiday' || op.kind === 'note') {
    out.holidays = state.holidays;
    out.notes = state.notes;
  }
  // рассылаем всем, включая автора: клиент приводит строку к авторитетному виду
  broadcast(out);
}

/* ------------------------------------------------------------------ */
/* Разбор сообщений                                                    */
/* ------------------------------------------------------------------ */

function onMessage(conn, text) {
  conn.data.lastSeen = Date.now();
  let msg;
  try { msg = JSON.parse(text); }
  catch (e) { return conn.sendJson({ type: 'error', reason: 'некорректный JSON' }); }
  if (!msg || typeof msg.type !== 'string') return conn.sendJson({ type: 'error', reason: 'нет type' });

  if (msg.type === 'ping') { conn.data.lastSeen = Date.now(); return conn.sendJson({ type: 'pong', ts: Date.now() }); }

  if (msg.type === 'hello') {
    const user = auth.verifyToken(msg.token);
    if (!user) return conn.sendJson({ type: 'auth_failed', reason: 'токен недействителен или истёк' });
    conn.data.user = user;
    conn.data.since = Date.now();
    conn.sendJson({
      type: 'init',
      user: user,
      roles: roles.getRoles(),
      permissions: roles.getPermissions(),
      online: onlineList(),
      serverVersion: VERSION,
      stats: store.stats(db),
      state: fullState()
    });
    broadcastPresence();
    return;
  }

  if (!conn.data.user) return conn.sendJson({ type: 'auth_required' });

  switch (msg.type) {
    case 'op':
      return handleOp(conn, msg);

    case 'sync_request': {
      const clientVersions = (msg.versions || msg.payload && msg.payload.clientVersions || {});
      const changed = [];
      for (const eq of state.equipment) {
        if ((clientVersions[eq.id] || 0) !== (eq.version || 0)) changed.push(eq);
      }
      return conn.sendJson({
        type: 'sync_delta',
        versions: versionsMap(),
        stats: store.stats(db),
        equipment: changed,
        holidays: state.holidays,
        notes: state.notes,
        ops: store.recentOps(db, 200)
      });
    }

    case 'get_state':
      return conn.sendJson({ type: 'state', state: fullState() });

    case 'get_log': {
      const limit = Math.min(parseInt(msg.limit, 10) || 100, 500);
      return conn.sendJson({ type: 'log', ops: store.recentOps(db, limit) });
    }

    case 'set_state': {
      if (!roles.isAdmin(conn.data.user.role)) {
        return conn.sendJson({ type: 'op_rejected', reason: 'загрузка расписания доступна только администратору' });
      }
      const list = (msg.state && msg.state.equipment) || msg.equipment || [];
      if (!Array.isArray(list)) return conn.sendJson({ type: 'error', reason: 'equipment должен быть массивом' });
      model.replaceEquipment(state, list);
      if (msg.state && msg.state.holidays) state.holidays = msg.state.holidays;
      state.docVersion = (state.docVersion || 0) + 1;
      state.docLastAuthor = conn.data.user.login;
      state.docLastRole = conn.data.user.role;
      store.saveAllEquipment(db, state.equipment);
      store.saveDocSlice(db, state);
      try {
        store.saveOp(db, {
          opId: 'state_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
          kind: 'set_state', eqId: null, eqIds: [],
          authorId: conn.data.user.login, authorRole: conn.data.user.role,
          authorName: conn.data.user.name || conn.data.user.login,
          from: null, to: { equipmentCount: state.equipment.length },
          comment: 'расписание загружено на сервер', versions: {}, baseVersion: {},
          ts: Date.now(), year: null
        }, 'approved');
      } catch (e) { /* журнал не критичен */ }
      const out = { type: 'state_replaced', state: fullState(), author: conn.data.user.login };
      broadcast(out);
      return;
    }

    case 'users_list': {
      if (!roles.isAdmin(conn.data.user.role)) return conn.sendJson({ type: 'user_error', reason: 'доступно только администратору' });
      return conn.sendJson({ type: 'users', users: auth.listUsers() });
    }

    case 'user_add': {
      if (!roles.isAdmin(conn.data.user.role)) return conn.sendJson({ type: 'user_error', reason: 'доступно только администратору' });
      const login = String(msg.login || '').trim();
      const password = String(msg.password || '');
      const name = String(msg.name || '').trim();
      const role = String(msg.role || 'viewer');
      if (!/^[A-Za-z0-9._-]{3,32}$/.test(login)) return conn.sendJson({ type: 'user_error', reason: 'логин: 3–32 символа, латиница, цифры, точка, дефис, подчёркивание' });
      if (password.length < 6) return conn.sendJson({ type: 'user_error', reason: 'пароль: минимум 6 символов' });
      if (!roles.getRoles()[role]) return conn.sendJson({ type: 'user_error', reason: 'неизвестная роль: ' + role });
      if (auth.listUsers().some(function (u) { return u.login === login; })) {
        return conn.sendJson({ type: 'user_error', reason: 'пользователь уже существует: ' + login });
      }
      auth.addUser(login, password, role, name || login);
      return conn.sendJson({ type: 'users', users: auth.listUsers(), message: 'добавлен пользователь ' + login + ' (' + role + ')' });
    }

    case 'user_update': {
      if (!roles.isAdmin(conn.data.user.role)) return conn.sendJson({ type: 'user_error', reason: 'доступно только администратору' });
      const login = String(msg.login || '').trim();
      const users0 = auth.listUsers();
      const target = users0.filter(function (u) { return u.login === login; })[0];
      if (!target) return conn.sendJson({ type: 'user_error', reason: 'пользователь не найден: ' + login });
      const patch = {};
      if (msg.name !== undefined) patch.name = String(msg.name || '').trim();
      if (msg.role !== undefined && msg.role !== null && String(msg.role) !== '') {
        if (!roles.getRoles()[String(msg.role)]) return conn.sendJson({ type: 'user_error', reason: 'неизвестная роль: ' + msg.role });
        if (target.role === 'admin' && String(msg.role) !== 'admin' && auth.countAdmins() <= 1) {
          return conn.sendJson({ type: 'user_error', reason: 'нельзя убрать последнего администратора' });
        }
        patch.role = String(msg.role);
      }
      if (msg.password) {
        if (String(msg.password).length < 6) return conn.sendJson({ type: 'user_error', reason: 'пароль: минимум 6 символов' });
        patch.password = String(msg.password);
      }
      const updated = auth.updateUser(login, patch);
      const note = patch.password ? 'пароль обновлён: ' + login : 'обновлён: ' + login;
      return conn.sendJson({ type: 'users', users: auth.listUsers(), message: note, user: updated });
    }

    case 'user_delete': {
      if (!roles.isAdmin(conn.data.user.role)) return conn.sendJson({ type: 'user_error', reason: 'доступно только администратору' });
      const login = String(msg.login || '').trim();
      if (login === conn.data.user.login) return conn.sendJson({ type: 'user_error', reason: 'нельзя удалить самого себя' });
      const target = auth.listUsers().filter(function (u) { return u.login === login; })[0];
      if (!target) return conn.sendJson({ type: 'user_error', reason: 'пользователь не найден: ' + login });
      if (target.role === 'admin' && auth.countAdmins() <= 1) return conn.sendJson({ type: 'user_error', reason: 'нельзя удалить последнего администратора' });
      auth.removeUser(login);
      return conn.sendJson({ type: 'users', users: auth.listUsers(), message: 'удалён пользователь ' + login });
    }

    case 'get_settings':
      return conn.sendJson({ type: 'settings', roles: roles.getRoles(), permissions: roles.getPermissions() });

    case 'save_settings': {
      if (!roles.isAdmin(conn.data.user.role)) return conn.sendJson({ type: 'error', reason: 'только администратор' });
      const errors = roles.applySettings(msg);
      store.setDoc(db, 'settings', { roles: roles.getRoles(), permissions: roles.getPermissions() });
      broadcast({ type: 'settings_updated', roles: roles.getRoles(), permissions: roles.getPermissions() });
      return conn.sendJson({ type: 'settings_saved', errors: errors });
    }

    default:
      return conn.sendJson({ type: 'error', reason: 'неизвестный тип сообщения: ' + msg.type });
  }
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

function readBody(req, limit) {
  return new Promise(function (resolve, reject) {
    let size = 0;
    const chunks = [];
    req.on('data', function (c) {
      size += c.length;
      if (size > limit) { reject(new Error('слишком большое тело запроса')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer(function (req, res) {
  // CORS: приложение часто открывают как файл (file://, Origin: null),
  // а вход идёт через fetch. Без этих заголовков браузер заблокирует /login.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Max-Age': '600' });
    return res.end();
  }

  if (req.method === 'POST' && req.url === '/login') {
    readBody(req, 64 * 1024).then(function (raw) {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (e) { return sendJson(res, 400, { error: 'некорректный JSON' }); }
      const user = auth.authenticate(body.login, body.password);
      if (!user) {
        // небольшая задержка против перебора
        return setTimeout(function () { sendJson(res, 401, { error: 'неверный логин или пароль' }); }, 250);
      }
      const token = auth.signToken({ login: user.login });
      sendJson(res, 200, { token: token, user: user, ws: '/ws' });
    }).catch(function (e) { sendJson(res, 413, { error: e.message }); });
    return;
  }

  // Поиск в ФГИС «Аршин». Через сервер: у браузера нет доступа к fgis.gost.ru
  // (CORS), плюс нужна пауза между обращениями по требованию Росстандарта.
  if (req.method === 'GET' && req.url.indexOf('/arshin/search') === 0) {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const user = auth.verifyToken(token);
    if (!user) return sendJson(res, 401, { ok: false, error: 'нужен вход (Authorization: Bearer …)' });
    const u = new URL(req.url, 'http://localhost');
    arshin.search({
      name: u.searchParams.get('name'),
      number: u.searchParams.get('number'),
      number2: u.searchParams.get('number2'),
      numbers: u.searchParams.get('numbers'),
      mitNumber: u.searchParams.get('mitNumber'),
      docnum: u.searchParams.get('docnum'),
      org: u.searchParams.get('org'),
      notation: u.searchParams.get('notation'),
      year: u.searchParams.get('year'),
      rows: u.searchParams.get('rows'),
      sort: u.searchParams.get('sort')
    }).then(function (r) {
      sendJson(res, 200, Object.assign({ ok: true }, r));
    }).catch(function (e) {
      sendJson(res, 502, { ok: false, error: e.message });
    });
    return;
  }

  // Полная запись по идентификатору: данные поверки + ссылка на карточку типа СИ
  if (req.method === 'GET' && req.url.indexOf('/arshin/record') === 0) {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!auth.verifyToken(token)) return sendJson(res, 401, { ok: false, error: 'нужен вход (Authorization: Bearer …)' });
    const u = new URL(req.url, 'http://localhost');
    arshin.record(u.searchParams.get('vriId')).then(function (r) {
      sendJson(res, 200, Object.assign({ ok: true }, r));
    }).catch(function (e) {
      sendJson(res, 502, { ok: false, error: e.message });
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, { ok: true, version: VERSION, clients: onlineList().length, stats: store.stats(db) });
  }

  if (req.method === 'GET' && (req.url === '/info')) {
    return sendJson(res, 200, {
      name: 'KMHTO collaboration server',
      version: VERSION,
      endpoints: ['GET / — приложение', 'POST /login', 'GET /health', 'WS /ws'],
      roles: roles.getRoles()
    });
  }

  // Приложение можно открыть прямо с сервера — тогда запросы к /login
  // идут с того же origin и CORS не нужен вообще.
  // --- HTTP-транспорт (длинные опросы): используется, когда прокси хостинга
  //     не туннелирует WebSocket. Тот же onMessage, что и для WS. ---
  if (req.method === 'POST' && req.url === '/api/msg') {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const user = auth.verifyToken(token);
    if (!user) return sendJson(res, 401, { ok: false, error: 'нужен вход' });
    return readBody(req, 4 * 1024 * 1024).then(function (raw) {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (e) { return sendJson(res, 400, { ok: false, error: 'некорректный JSON' }); }
      const session = httpSession(user);
      const replies = [];
      const connLike = {
        isHttp: true,
        data: { user: user, lastSeen: Date.now(), since: Date.now() },
        sendJson: function (obj) { replies.push(obj); },
        close: function () {}
      };
      try { onMessage(connLike, JSON.stringify(body.msg || {})); }
      catch (e) { replies.push({ type: 'error', reason: String(e.message || e) }); }
      sendJson(res, 200, { ok: true, replies: replies, seq: session.seq });
    }).catch(function (e) { sendJson(res, 400, { ok: false, error: String(e.message || e) }); });
  }

  if (req.method === 'GET' && req.url.indexOf('/api/events') === 0) {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const user = auth.verifyToken(token);
    if (!user) return sendJson(res, 401, { ok: false, error: 'нужен вход' });
    const u = new URL(req.url, 'http://localhost');
    const since = parseInt(u.searchParams.get('since'), 10) || 0;
    const session = httpSession(user);
    let timer = null;
    const flush = function () {
      if (timer) { clearTimeout(timer); timer = null; }
      if (res.writableEnded) return;
      const events = session.events.filter(function (e) { return e.seq > since; }).map(function (e) { return e.msg; });
      const lastSeq = session.events.length ? session.events[session.events.length - 1].seq : session.seq;
      sendJson(res, 200, { ok: true, seq: Math.max(lastSeq, since), events: events });
    };
    if (session.events.some(function (e) { return e.seq > since; })) return flush();
    const waiter = function () { flush(); };
    session.waiters.push(waiter);
    timer = setTimeout(function () {
      const i = session.waiters.indexOf(waiter);
      if (i !== -1) session.waiters.splice(i, 1);
      timer = null;
      if (!res.writableEnded) sendJson(res, 200, { ok: true, seq: since, events: [] });
    }, 25000);
    req.on('close', function () {
      if (timer) { clearTimeout(timer); timer = null; }
      const i = session.waiters.indexOf(waiter);
      if (i !== -1) session.waiters.splice(i, 1);
    });
    return;
  }

  // Локальные библиотеки интерфейса (Bootstrap, SheetJS, FileSaver, иконки):
  // приложение не зависит от внешнего CDN и работает в закрытой сети.
  if (req.method === 'GET' && req.url.indexOf('/vendor/') === 0) {
    const vendorRoot = path.join(config.ROOT, 'vendor');
    const rel = decodeURIComponent(req.url.slice('/vendor/'.length).split('?')[0]);
    const file = path.resolve(vendorRoot, rel);
    if (file !== vendorRoot && file.indexOf(vendorRoot + path.sep) !== 0) {
      return sendJson(res, 403, { error: 'forbidden' });
    }
    const types = {
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
      '.map': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml'
    };
    return fs.readFile(file, function (err, buf) {
      if (err) return sendJson(res, 404, { error: 'not found' });
      res.writeHead(200, {
        'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': buf.length,
        'Cache-Control': 'public, max-age=604800'
      });
      res.end(buf);
    });
  }

  if (req.method === 'GET' && (req.url === '/' || req.url === '/app' || req.url === '/app_kmhto.html')) {
    const appPath = path.join(config.ROOT, 'app_kmhto.html');
    return fs.readFile(appPath, function (err, buf) {
      if (err) { sendJson(res, 500, { error: 'app_kmhto.html не найден рядом с сервером: ' + err.message }); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
  }

  sendJson(res, 404, { error: 'not found' });
});

ws.attach(server, {
  onConnection: function (conn) {
    conn.data = { user: null, lastSeen: Date.now(), since: null };
    clients.add(conn);
  },
  onMessage: onMessage,
  onPong: function (conn) { conn.data.lastSeen = Date.now(); },
  onClose: function (conn) {
    clients.delete(conn);
    if (conn.data && conn.data.user) broadcastPresence();
  }
});

// heartbeat: рвём соединения, от которых давно нет признаков жизни
setInterval(function () {
  const now = Date.now();
  for (const c of clients) {
    if (now - (c.data.lastSeen || 0) > config.HEARTBEAT_TIMEOUT_MS) {
      c.close(1001, 'heartbeat timeout');
      clients.delete(c);
      broadcastPresence();
    } else if (c.readyState === 1) {
      c.ping();
    }
  }
  // чистим давно молчащие HTTP-сессии (клиент перестал опрашивать)
  for (const [login, s] of httpSessions) {
    if (now - s.lastSeen > config.HEARTBEAT_TIMEOUT_MS * 2) httpSessions.delete(login);
  }
}, config.HEARTBEAT_SWEEP_MS).unref();

// Понятная подсказка вместо необработанного исключения, если порт занят
server.on('error', function (e) {
  if (e && e.code === 'EADDRINUSE') {
    console.log('');
    console.log('[KMHTO] порт ' + config.PORT + ' уже занят — похоже, сервер уже запущен.');
    console.log('        Освободить порт:');
    console.log('          Get-NetTCPConnection -LocalPort ' + config.PORT + ' -State Listen |');
    console.log('            ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }');
    console.log('        Либо запустить на другом порту:');
    console.log('          $env:KMHTO_PORT=\'8788\'; node server/index.js');
    console.log('');
    process.exit(1);
  }
  throw e;
});

function onListen() {
  const created = auth.ensureAdmin(function (line) { console.log('[auth] ' + line); });
  const where = (typeof config.PORT === 'number')
    ? ('ws://' + config.HOST + ':' + config.PORT)
    : ('unix-сокет ' + config.PORT);
  console.log('[KMHTO] сервер ' + VERSION + ' слушает ' + where);
  console.log('[KMHTO] данные: ' + config.DATA_DIR + ' (' + JSON.stringify(store.stats(db)) + ')');
  if (created) console.log('[auth] первый вход: admin / ' + created.password);
}

// Passenger/Apache передаёт либо числовой порт, либо путь к сокету
if (typeof config.PORT === 'number') {
  server.listen(config.PORT, config.HOST, onListen);
} else {
  server.listen(config.PORT, onListen);
}

process.on('SIGINT', function () { console.log('\n[KMHTO] остановка'); try { db.close(); } catch (e) {} process.exit(0); });

module.exports = { server, db, state };
