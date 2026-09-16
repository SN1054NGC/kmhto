'use strict';
// Тест сервера этапа 1: аутентификация, права по ролям, арбитраж baseVersion,
// рассылка, presence, персистентность после перезапуска.
const fs = require('fs');
const path = require('path');
const net = require('net');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
// временный каталог вне проекта, чтобы не мусорить в data/
const DATA = path.join(os.tmpdir(), 'kmhto_test_' + Date.now());
const PORT = 0; // заполнится ниже

process.env.KMHTO_DATA = DATA;
process.env.KMHTO_ADMIN_PASSWORD = 'admin-secret';

const auth = require('../server/auth');
const config = require('../server/config');
config.DATA_DIR = DATA;

let fails = 0, passed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  OK   ' + name + (extra !== undefined ? ' [' + extra + ']' : '')); }
  else { fails++; console.log('  FAIL ' + name + (extra !== undefined ? ' [' + extra + ']' : '')); }
}

function freePort() {
  return new Promise(function (resolve) {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', function () {
      const p = s.address().port;
      s.close(function () { resolve(p); });
    });
  });
}

function startServer(port) {
  const logFile = path.join(DATA, 'server.log');
  const fd = fs.openSync(logFile, 'a');
  const env = Object.assign({}, process.env, {
    KMHTO_DATA: DATA, KMHTO_PORT: String(port), KMHTO_HOST: '127.0.0.1',
    KMHTO_ADMIN_PASSWORD: 'admin-secret',
    KMHTO_HEARTBEAT_MS: '3000', KMHTO_HEARTBEAT_SWEEP_MS: '1000'
  });
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT, env: env, stdio: ['ignore', fd, fd]
  });
  child.on('error', function (e) { console.log('spawn error:', e.message); });
  return { child: child, fd: fd };
}

function stopServer(s) {
  return new Promise(function (resolve) {
    s.child.once('exit', function () { try { fs.closeSync(s.fd); } catch (e) {} resolve(); });
    s.child.kill();
    setTimeout(function () { try { s.child.kill('SIGKILL'); } catch (e) {} resolve(); }, 3000);
  });
}

async function waitHealth(port, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 15000);
  while (Date.now() < deadline) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/health');
      if (r.ok) return true;
    } catch (e) {}
    await new Promise(function (r) { setTimeout(r, 120); });
  }
  throw new Error('сервер не поднялся на порту ' + port);
}

function makeClient(url) {
  return new Promise(function (resolve, reject) {
    const ws = new WebSocket(url);
    const queue = [], waiters = [];
    let opened = false;
    ws.onmessage = function (ev) {
      let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
      const w = waiters.shift();
      if (w) w(msg); else queue.push(msg);
    };
    ws.onerror = function () { if (!opened) reject(new Error('не удалось подключиться к ' + url)); };
    ws.onopen = function () {
      opened = true;
      resolve({
        raw: ws,
        send: function (o) { ws.send(JSON.stringify(o)); },
        next: function (timeout) {
          return new Promise(function (res, rej) {
            if (queue.length) return res(queue.shift());
            const t = setTimeout(function () { rej(new Error('timeout ожидания сообщения')); }, timeout || 6000);
            waiters.push(function (m) { clearTimeout(t); res(m); });
          });
        },
        close: function () { try { ws.close(); } catch (e) {} }
      });
    };
  });
}

async function waitFor(client, type, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 6000);
  const skipped = [];
  while (Date.now() < deadline) {
    let m;
    try { m = await client.next(deadline - Date.now()); } catch (e) { break; }
    if (m && m.type === type) return m;
    if (m) skipped.push(m.type);
  }
  throw new Error('не дождались ' + type + ' (получено: ' + skipped.join(',') + ')');
}

async function login(port, loginName, password) {
  const r = await fetch('http://127.0.0.1:' + port + '/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: loginName, password: password })
  });
  let body = null;
  try { body = await r.json(); } catch (e) {}
  return { status: r.status, body: body };
}

(async function main() {
  fs.mkdirSync(DATA, { recursive: true });
  const port = await freePort();

  // пользователи создаются до старта сервера (ensureAdmin тогда не сработает)
  auth.addUser('admin', 'admin-secret', 'admin', 'Админ');
  auth.addUser('alice', 'alice-pass', 'specialist', 'Алиса');
  auth.addUser('bob', 'bob-pass', 'manager', 'Боб');
  auth.addUser('vera', 'vera-pass', 'viewer', 'Вера');

  const srv = startServer(port);
  await waitHealth(port);
  const base = 'http://127.0.0.1:' + port;
  const wsUrl = 'ws://127.0.0.1:' + port + '/ws';

  console.log('=== HTTP: аутентификация ===');
  const h = await (await fetch(base + '/health')).json();
  ok('health отвечает', h.ok === true && h.version);
  const arshinAnon = await fetch(base + '/arshin/search?number=1');
  ok('поиск в ФГИС Аршин без входа отклонён', arshinAnon.status === 401, arshinAnon.status);
  const arshinTok = await login(port, 'alice', 'alice-pass');
  const arshinAuth = await fetch(base + '/arshin/search', { headers: { authorization: 'Bearer ' + arshinTok.body.token } });
  ok('поиск без параметров даёт понятную ошибку', arshinAuth.status === 502, arshinAuth.status);
  const badLogin = await login(port, 'alice', 'wrong');
  ok('неверный пароль -> 401', badLogin.status === 401, badLogin.status);
  const noUser = await login(port, 'ghost', 'x');
  ok('несуществующий логин -> 401', noUser.status === 401, noUser.status);
  const good = await login(port, 'alice', 'alice-pass');
  ok('верный пароль -> токен', good.status === 200 && !!good.body.token);
  ok('в ответе роль с сервера', good.body.user.role === 'specialist', good.body.user.role);

  console.log('=== WS: приветствие и подделка роли ===');
  const anon = await makeClient(wsUrl);
  anon.send({ type: 'op', op: { kind: 'add_work' } });
  ok('без hello -> auth_required', (await waitFor(anon, 'auth_required')).type === 'auth_required');

  const bad = await makeClient(wsUrl);
  bad.send({ type: 'hello', token: 'подделка', role: 'admin' });
  ok('битый токен -> auth_failed', (await waitFor(bad, 'auth_failed')).type === 'auth_failed');
  bad.close();

  const admin = await makeClient(wsUrl);
  const adminTok = (await login(port, 'admin', 'admin-secret')).body.token;
  admin.send({ type: 'hello', token: adminTok });
  const adminInit = await waitFor(admin, 'init');
  ok('admin вошёл', adminInit.user.login === 'admin' && adminInit.user.role === 'admin');
  ok('init содержит пустое состояние', adminInit.state.equipment.length === 0);

  const alice = await makeClient(wsUrl);
  const aliceTok = good.body.token;
  // специально шлём role:admin в hello — сервер обязан игнорировать
  alice.send({ type: 'hello', token: aliceTok, role: 'admin', user: 'admin' });
  const aliceInit = await waitFor(alice, 'init');
  ok('роль берётся из токена, а не из сообщения', aliceInit.user.role === 'specialist', aliceInit.user.role);
  ok('presence виден второму клиенту', aliceInit.online.length >= 1, aliceInit.online.map(function (u) { return u.login; }).join(','));

  console.log('=== Загрузка расписания (только админ) ===');
  alice.send({ type: 'set_state', state: { equipment: [{ id: 'eq_A', name: 'Имя A', toSchedule: {}, kmhSchedule: {} }] } });
  const denied = await waitFor(alice, 'op_rejected');
  ok('специалист не может загрузить расписание', /администратор/.test(denied.reason), denied.reason);

  admin.send({ type: 'set_state', state: { equipment: [
    { id: 'eq_A', name: 'Имя A', code: '7', toSchedule: { 'январь': [{ type: 'ТО-1', day: 5 }] }, kmhSchedule: {} },
    { id: 'eq_B', name: 'Имя B', code: '8', toSchedule: {}, kmhSchedule: {} }
  ] } });
  const replaced = await waitFor(admin, 'state_replaced');
  ok('админ загрузил расписание', replaced.state.equipment.length === 2, replaced.state.equipment.length);
  const vers0 = replaced.state.versions;
  const docVer = vers0._doc;
  ok('стартовые версии нулевые', vers0.eq_A === 0 && vers0.eq_B === 0, JSON.stringify(vers0));

  console.log('=== Права ролей ===');
  const vera = await makeClient(wsUrl);
  const veraTok = (await login(port, 'vera', 'vera-pass')).body.token;
  vera.send({ type: 'hello', token: veraTok });
  await waitFor(vera, 'init');
  vera.send({ type: 'op', op: { opId: 'v1', kind: 'add_work', eqId: 'eq_A', baseVersion: { eq_A: 0 }, to: { month: 'март', day: 3, type: 'ТО-1' } } });
  const vDenied = await waitFor(vera, 'op_rejected');
  ok('наблюдателю правка запрещена', /недостаточно прав/.test(vDenied.reason), vDenied.reason);

  console.log('=== Применение операции специалистом ===');
  alice.send({ type: 'op', op: { opId: 'a1', kind: 'add_work', eqId: 'eq_A', baseVersion: { eq_A: 0 }, to: { month: 'февраль', day: 10, type: 'ТО-2' }, year: 2026 } });
  const applied = await waitFor(alice, 'op_applied');
  ok('операция применена', applied.opId === 'a1' && applied.status === 'approved', applied.status);
  ok('версия выросла до 1', applied.versions.eq_A === 1, applied.versions.eq_A);
  ok('авторитетная строка вернулась', !!applied.equipment && applied.equipment.eq_A.toSchedule['февраль'][0].day === 10);

  // наблюдатель должен увидеть рассылку
  const broadcasted = await waitFor(vera, 'op_applied');
  ok('рассылка дошла до другого клиента', broadcasted.opId === 'a1', broadcasted.author);

  alice.send({ type: 'op', op: { opId: 'a2', kind: 'delete_work', eqId: 'eq_A', baseVersion: { eq_A: 1 }, from: { month: 'январь', day: 5, type: 'ТО-1' } } });
  const delRes = await waitFor(alice, 'op_rejected');
  ok('удаление требует приоритет 600 (специалисту отказано)', /недостаточно прав/.test(delRes.reason), delRes.reason);

  console.log('=== Поверка / калибровка (op metrology) ===');
  alice.send({ type: 'op', op: { opId: 'm1', kind: 'metrology', eqId: 'eq_A', baseVersion: { eq_A: 1 },
    to: { metrology: { verification: '2026-03-01', verificationUntil: '2027-03-01', certificate: 'СВ-123', arshin: 'https://fgis.gost.ru/x',
                       arshinRecord: { id: '1-123', title: 'Тип СИ', etalons: [{ typeNumber: '11111-11' }] } } },
    comment: 'поверка' } });
  const met = await waitFor(alice, 'op_applied');
  ok('операция поверки применена', met.kind === 'metrology' && met.status === 'approved', met.status);
  ok('данные поверки вернулись в строке',
     met.equipment && met.equipment.eq_A && met.equipment.eq_A.metrology &&
     met.equipment.eq_A.metrology.certificate === 'СВ-123',
     JSON.stringify(met.equipment && met.equipment.eq_A && met.equipment.eq_A.metrology));
  ok('в рассылке есть «до/после» для журнала', met.from === null && !!met.to, JSON.stringify(met.to));
  // Карточка Аршина едет вместе с данными поверки и синхронизируется всем клиентам
  const card = met.equipment && met.equipment.eq_A && met.equipment.eq_A.metrology && met.equipment.eq_A.metrology.arshinRecord;
  ok('карточка Аршина сохранена вместе с поверкой', !!card && card.id === '1-123', JSON.stringify(card));
  ok('в карточке сохранены эталоны', !!card && card.etalons && card.etalons[0].typeNumber === '11111-11');

  console.log('=== Конфликт версий (CS-модель) ===');
  alice.send({ type: 'op', op: { opId: 'a3', kind: 'add_work', eqId: 'eq_B', baseVersion: { eq_B: 0 }, to: { month: 'май', day: 1, type: 'ТО-1' } } });
  const b1 = await waitFor(alice, 'op_applied');
  ok('первая правка eq_B', b1.versions.eq_B === 1, b1.versions.eq_B);

  // второй специалист с устаревшей baseVersion и равным приоритетом
  const alice2 = await makeClient(wsUrl);
  alice2.send({ type: 'hello', token: aliceTok });
  await waitFor(alice2, 'init');
  alice2.send({ type: 'op', op: { opId: 'a4', kind: 'add_work', eqId: 'eq_B', baseVersion: { eq_B: 0 }, to: { month: 'июнь', day: 2, type: 'ТО-1' } } });
  const conflict = await waitFor(alice2, 'op_conflict');
  ok('равный приоритет -> конфликт', conflict.conflict.eqId === 'eq_B' && conflict.conflict.currentVersion === 1, JSON.stringify(conflict.conflict).slice(0, 90));
  ok('в конфликте есть текущее состояние', !!conflict.conflict.equipment);

  // руководитель с той же устаревшей базой — перебивает
  const bob = await makeClient(wsUrl);
  bob.send({ type: 'hello', token: (await login(port, 'bob', 'bob-pass')).body.token });
  await waitFor(bob, 'init');
  bob.send({ type: 'op', op: { opId: 'b1', kind: 'add_work', eqId: 'eq_B', baseVersion: { eq_B: 0 }, to: { month: 'июль', day: 7, type: 'ТО-3' } } });
  const over = await waitFor(bob, 'op_applied');
  ok('руководитель перебивает устаревшую правку', over.status === 'overridden', over.status);
  ok('версия поднялась до 2', over.versions.eq_B === 2, over.versions.eq_B);

  alice.send({ type: 'op', op: { opId: 'a5', kind: 'add_work', eqId: 'eq_B', baseVersion: { eq_B: 99 }, to: { month: 'август', day: 8, type: 'ТО-1' } } });
  const future = await waitFor(alice, 'op_rejected');
  ok('baseVersion из будущего отклонена', /будущего/.test(future.reason), future.reason);

  alice.send({ type: 'op', op: { opId: 'a6', kind: 'add_work', eqId: 'eq_ZZZ', baseVersion: { eq_ZZZ: 0 }, to: { month: 'август', day: 8, type: 'ТО-1' } } });
  const unknown = await waitFor(alice, 'op_rejected');
  ok('неизвестное оборудование отклонено', /неизвестное оборудование/.test(unknown.reason), unknown.reason);

  alice.send({ type: 'op', op: { opId: 'a7', kind: 'add_work', eqId: 'eq_B', to: { month: 'август', day: 9, type: 'ТО-1' } } });
  const noBase = await waitFor(alice, 'op_rejected');
  ok('без baseVersion операция не принимается', /baseVersion/.test(noBase.reason), noBase.reason);

  console.log('=== Документные операции (праздники) ===');
  bob.send({ type: 'op', op: { opId: 'h1', kind: 'holiday', baseVersion: { _doc: docVer }, to: { date: '2026-01-07', holiday: true } } });
  const hol = await waitFor(bob, 'op_applied');
  ok('праздник применён', hol.changed === true && !!hol.holidays['2026-01-07'], Object.keys(hol.holidays).join(','));

  vera.send({ type: 'op', op: { opId: 'h2', kind: 'holiday', baseVersion: { _doc: 1 }, to: { date: '2026-01-08', holiday: true } } });
  const holDenied = await waitFor(vera, 'op_rejected');
  ok('наблюдателю праздник запрещён', /недостаточно прав/.test(holDenied.reason));

  console.log('=== Синхронизация и настройки ===');
  const syncCli = await makeClient(wsUrl);
  syncCli.send({ type: 'hello', token: aliceTok });
  await waitFor(syncCli, 'init');
  syncCli.send({ type: 'sync_request', versions: { eq_A: 0, eq_B: 0, _doc: 0 } });
  const delta = await waitFor(syncCli, 'sync_delta');
  ok('дельта вернула обе изменившиеся единицы', delta.equipment.length === 2, delta.equipment.map(function (e) { return e.id + ':' + e.version; }).join(','));
  ok('дельта знает про праздник', !!delta.holidays['2026-01-07']);

  alice.send({ type: 'save_settings', roles: { specialist: { priority: 900 } }, permissions: {} });
  const setDenied = await waitFor(alice, 'error');
  ok('специалист не может менять настройки', /администратор/.test(setDenied.reason), setDenied.reason);

  admin.send({ type: 'save_settings', roles: { specialist: { priority: 900 } }, permissions: {} });
  const saved = await waitFor(admin, 'settings_saved');
  ok('админ сохранил настройки', Array.isArray(saved.errors) && saved.errors.length === 0, JSON.stringify(saved.errors));
  ok('приоритет роли изменён', (await waitFor(vera, 'settings_updated')).roles.specialist.priority === 900);

  // теперь специалист с приоритетом 900 может удалять (порог 600)
  alice.send({ type: 'op', op: { opId: 'a8', kind: 'delete_work', eqId: 'eq_A', baseVersion: { eq_A: met.versions.eq_A }, from: { month: 'январь', day: 5, type: 'ТО-1' } } });
  const delOk = await waitFor(alice, 'op_applied');
  ok('после смены приоритета удаление разрешено', delOk.changed === true && delOk.versions.eq_A === met.versions.eq_A + 1, delOk.versions.eq_A);

  console.log('=== Правила планирования и автоплан ===');
  const planRules = [
    { work: 'ТО-1', baseDate: '2026-01-15', intervalDays: 30, tolerance: 2, active: true },
    { work: 'КМХ', baseDate: '2026-02-20', intervalDays: 90, tolerance: 0, active: true }
  ];
  alice.send({ type: 'op', op: { opId: 'pr1', kind: 'plan_rule', eqId: 'eq_A', baseVersion: { eq_A: delOk.versions.eq_A }, to: { planRules: planRules } } });
  const prOk = await waitFor(alice, 'op_applied');
  ok('plan_rule применён', prOk.changed === true && prOk.kind === 'plan_rule');
  ok('правила вернулись в строке', prOk.equipment.eq_A.planRules.length === 2, JSON.stringify(prOk.equipment.eq_A.planRules));

  alice.send({ type: 'op', op: { opId: 'pg1', kind: 'plan_generate', eqId: 'eq_A', baseVersion: { eq_A: prOk.versions.eq_A }, to: { year: 2026, rules: prOk.equipment.eq_A.planRules }, year: 2026 } });
  const pgOk = await waitFor(alice, 'op_applied');
  const eqArow = pgOk.equipment.eq_A;
  let toCount = 0, kmhCount = 0;
  Object.keys(eqArow.toSchedule || {}).forEach(function (m) { toCount += eqArow.toSchedule[m].length; });
  Object.keys(eqArow.kmhSchedule || {}).forEach(function (m) { kmhCount += eqArow.kmhSchedule[m].length; });
  ok('plan_generate построил ТО', pgOk.changed === true && toCount >= 11, toCount);
  ok('plan_generate построил КМХ', kmhCount >= 3, kmhCount);
  ok('planGen.year = 2026', !!eqArow.planGen && eqArow.planGen.year === 2026, eqArow.planGen && eqArow.planGen.year);

  // подключаемся ПОСЛЕ первой генерации — дальше проверяем именно рассылку смены года
  const watcher = await makeClient(wsUrl);
  watcher.send({ type: 'hello', token: aliceTok });
  await waitFor(watcher, 'init');

  alice.send({ type: 'op', op: { opId: 'pg2', kind: 'plan_generate', eqId: 'eq_A', baseVersion: { eq_A: pgOk.versions.eq_A }, to: { year: 2027, rules: eqArow.planRules }, year: 2027 } });
  const watched = await waitFor(watcher, 'op_applied');
  ok('автоплан уехал другим клиентам', watched.kind === 'plan_generate' && watched.equipment.eq_A.planGen.year === 2027, watched.equipment.eq_A.planGen.year);
  watcher.close();

  vera.send({ type: 'op', op: { opId: 'pg3', kind: 'plan_generate', eqId: 'eq_A', baseVersion: { eq_A: 0 }, to: { year: 2026 }, year: 2026 } });
  const planDenied = await waitFor(vera, 'op_rejected');
  ok('наблюдателю автоплан запрещён', /недостаточно прав/.test(planDenied.reason), planDenied.reason);

  console.log('=== Heartbeat ===');
  alice.send({ type: 'ping' });
  ok('ping -> pong', (await waitFor(alice, 'pong')).type === 'pong');

  console.log('=== Персистентность после перезапуска ===');
  admin.close(); alice.close(); alice2.close(); bob.close(); vera.close(); syncCli.close(); anon.close();
  await new Promise(function (r) { setTimeout(r, 300); });
  await stopServer(srv);
  await new Promise(function (r) { setTimeout(r, 300); });

  const srv2 = startServer(port);
  await waitHealth(port);
  const admin2 = await makeClient(wsUrl);
  admin2.send({ type: 'hello', token: (await login(port, 'admin', 'admin-secret')).body.token });
  const init2 = await waitFor(admin2, 'init');
  const eqB = init2.state.equipment.find(function (e) { return e.id === 'eq_B'; });
  ok('оборудование пережило перезапуск', init2.state.equipment.length === 2, init2.state.equipment.length);
  ok('версии сохранены', eqB && eqB.version === 2, eqB && eqB.version);
  ok('правки сохранены', eqB && !!eqB.toSchedule['июль'], JSON.stringify(eqB && eqB.toSchedule));
  ok('праздники сохранены', !!init2.state.holidays['2026-01-07']);
  ok('настройки ролей сохранены', init2.roles.specialist.priority === 900, init2.roles.specialist.priority);
  admin2.close();
  await stopServer(srv2);

  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {}

  console.log('');
  console.log(fails === 0 ? ('!!! СЕРВЕР: ВСЕ ' + passed + ' ПРОВЕРОК ПРОЙДЕНЫ !!!') : ('!!! ПРОВАЛОВ: ' + fails + ' из ' + (passed + fails) + ' !!!'));
  process.exit(fails === 0 ? 0 : 1);
})().catch(function (e) {
  console.log('КРИТИЧЕСКАЯ ОШИБКА ТЕСТА: ' + e.message);
  console.log(e.stack);
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (err) {}
  process.exit(1);
});
