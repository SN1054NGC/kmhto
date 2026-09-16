'use strict';
// Этап 1 (клиентская часть): приложение подключается к серверу, отправляет операции
// на арбитраж, принимает авторитетные строки, откатывает отклонённое и конфликты.
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const vm = require('vm');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(os.tmpdir(), 'kmhto_cli_' + Date.now());

process.env.KMHTO_DATA = DATA;
process.env.KMHTO_ADMIN_PASSWORD = 'admin-secret';
const auth = require('../server/auth');

let fails = 0, passed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  OK   ' + name + (extra !== undefined ? ' [' + extra + ']' : '')); }
  else { fails++; console.log('  FAIL ' + name + (extra !== undefined ? ' [' + extra + ']' : '')); }
}

function freePort() {
  return new Promise(function (resolve) {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', function () { const p = s.address().port; s.close(function () { resolve(p); }); });
  });
}

function startServer(port) {
  const fd = fs.openSync(path.join(DATA, 'server.log'), 'a');
  const env = Object.assign({}, process.env, {
    KMHTO_DATA: DATA, KMHTO_PORT: String(port), KMHTO_HOST: '127.0.0.1', KMHTO_ADMIN_PASSWORD: 'admin-secret'
  });
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { cwd: ROOT, env: env, stdio: ['ignore', fd, fd] });
  return { child: child, fd: fd };
}
function stopServer(s) {
  return new Promise(function (resolve) {
    s.child.once('exit', function () { try { fs.closeSync(s.fd); } catch (e) {} resolve(); });
    s.child.kill();
    setTimeout(function () { try { s.child.kill('SIGKILL'); } catch (e) {} resolve(); }, 3000);
  });
}
async function waitHealth(port) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { const r = await fetch('http://127.0.0.1:' + port + '/health'); if (r.ok) return; } catch (e) {}
    await new Promise(function (r) { setTimeout(r, 120); });
  }
  throw new Error('сервер не поднялся');
}
async function waitFor(pred, what, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 6000);
  while (Date.now() < deadline) {
    let v;
    try { v = pred(); } catch (e) { v = false; }
    if (v) return v;
    await new Promise(function (r) { setTimeout(r, 25); });
  }
  throw new Error('не дождались: ' + what);
}

const html = fs.readFileSync(path.join(ROOT, 'app_kmhto.html'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(function (m) { return m[1]; });
const APP_JS = scripts[scripts.length - 1];

function stubEl(id) {
  return {
    id: id, innerHTML: '', textContent: '', value: '', checked: true, disabled: false,
    className: '', style: {}, dataset: {}, children: [], childNodes: [],
    classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
    querySelectorAll: function () { return []; }, querySelector: function () { return null; },
    appendChild: function () {}, insertBefore: function () {}, removeChild: function () {},
    remove: function () {}, prepend: function () {}, setAttribute: function () {}, focus: function () {},
    addEventListener: function () {}, parentNode: null, firstChild: null, lastChild: null
  };
}

// Создать «экземпляр приложения»: тот же inline-скрипт в изолированном контексте
function createApp(name) {
  const store = {};
  const ctx = {
    console: console, setTimeout: setTimeout, clearTimeout: clearTimeout,
    setInterval: setInterval, clearInterval: clearInterval,
    WebSocket: WebSocket, fetch: fetch, Math: Math, Date: Date, JSON: JSON, RegExp: RegExp,
    String: String, Number: Number, Array: Array, Object: Object, parseInt: parseInt,
    parseFloat: parseFloat, isNaN: isNaN, Set: Set, Map: Map, Promise: Promise, Error: Error,
    alert: function () {}, Blob: function () {}, URL: { createObjectURL: function () { return ''; }, revokeObjectURL: function () {} },
    FileReader: function () {}, XLSX: { utils: {}, read: function () { return {}; }, write: function () { return ''; } },
    localStorage: {
      getItem: function (k) { return (k in store) ? store[k] : null; },
      setItem: function (k, v) { store[k] = String(v); },
      removeItem: function (k) { delete store[k]; }
    },
    document: {
      _els: {},
      getElementById: function (id) { return this._els[id] || (this._els[id] = stubEl(id)); },
      querySelectorAll: function () { return []; }, querySelector: function () { return null; },
      addEventListener: function () {}, createElement: function () { return stubEl('tmp'); },
      body: { appendChild: function () {}, removeChild: function () {}, style: {} }
    },
    window: { innerWidth: 1200, innerHeight: 800 }
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(APP_JS, ctx, { filename: 'app_' + name + '.js' });
  vm.runInContext(String.raw`
    currentYear = 2026;
    lastFileName = 'test.xlsx';
    netInit();
    // перехватываем ответы сервера, чтобы проверять их в тесте
    var _origHandle = netHandleMessage;
    netHandleMessage = function (msg) {
      if (msg && (msg.type === 'op_applied' || msg.type === 'op_conflict' || msg.type === 'op_rejected')) {
        globalThis.__lastNetAnswer = msg;
      }
      return _origHandle(msg);
    };
    globalThis.__t = {
      setEquipment: function (list) { equipmentData = list; renderAll(); },
      equipment: function () { return equipmentData; },
      row: function (id) { return equipmentData.find(function (e) { return e.id === id; }); },
      connect: function (url, login, password) {
        document.getElementById('netUrl').value = url;
        document.getElementById('netLogin').value = login;
        document.getElementById('netPassword').value = password;
        return netUiConnect();
      },
      submit: function (desc, mutate) { return commitOp(desc, mutate); },
      connected: function () { return netConnected(); },
      role: function () { return NET.user && NET.user.role; },
      versions: function () { return NET.versions; },
      upload: function () { return netUploadState(); },
      uploadVisible: function () { return document.getElementById('netUploadBtn').style.display; },
      disconnect: function () { netDisconnect(); },
      checkSync: function () { return netCheckSync(); },
      outbox: function () { return outboxCount(); },
      numbers: function (name, serial) { return extractNumbers({ name: name, serialNumber: serial || '', code: '' }); },
      card: function (rec) { arshinRenderCard(rec); return document.getElementById('mtCard').innerHTML; },
      sendRaw: function (obj) { return netSend(obj); },
      log: function () { return logLoad(); },
      loadLog: function () { return netLoadLog(); },
      equipCollapse: function (v) {
        var el = document.getElementById('equipmentListCollapse');
        if (v !== undefined) el.style.display = v;
        return el.style.display;
      },
      toggleEquipment: function () { return toggleEquipmentList(); },
      lastAnswer: function () { return globalThis.__lastNetAnswer; },
      stats: function () { return NET.stats; },
      net: function () { return NET; }
    };
  `, ctx, { filename: 'hook_' + name + '.js' });
  return { ctx: ctx, api: ctx.__t };
}

function eqList() {
  return [
    { id: 'eq_A', code: '7', name: 'Имя A', location: 'МЕСТО A', section: 'МЕСТО A', serialNumber: '', type: 'Тип',
      toSchedule: { 'январь': [{ type: 'ТО-1', day: 5 }] }, kmhSchedule: {}, hasKmh: false, version: 0 },
    { id: 'eq_B', code: '8', name: 'Имя B', location: 'МЕСТО B', section: 'МЕСТО B', serialNumber: '', type: 'Тип',
      toSchedule: {}, kmhSchedule: {}, hasKmh: false, version: 0 }
  ];
}

(async function main() {
  fs.mkdirSync(DATA, { recursive: true });
  const port = await freePort();
  auth.addUser('admin', 'admin-secret', 'admin', 'Админ');
  auth.addUser('alice', 'alice-pass', 'specialist', 'Алиса');
  auth.addUser('bob', 'bob-pass', 'manager', 'Боб');
  auth.addUser('vera', 'vera-pass', 'viewer', 'Вера');
  auth.addUser('carol', 'carol-pass', 'specialist', 'Кэрол');

  const srv = startServer(port);
  await waitHealth(port);
  const ws = 'ws://127.0.0.1:' + port + '/ws';

  console.log('=== Подключение и вход ===');
  const A = createApp('alice');
  A.api.setEquipment(eqList());
  const badConnect = await A.api.connect(ws, 'alice', 'неверный');
  await new Promise(function (r) { setTimeout(r, 400); });
  ok('неверный пароль — не подключились', A.api.connected() === false);

  await A.api.connect(ws, 'alice', 'alice-pass');
  await waitFor(function () { return A.api.connected(); }, 'подключение alice');
  ok('специалист подключён', A.api.connected() === true);
  ok('роль получена от сервера', A.api.role() === 'specialist', A.api.role());
  ok('кнопка загрузки скрыта для не-админа', A.api.uploadVisible() === 'none', A.api.uploadVisible());

  console.log('=== Загрузка расписания администратором ===');
  const ADM = createApp('admin');
  ADM.api.setEquipment(eqList());
  await ADM.api.connect(ws, 'admin', 'admin-secret');
  await waitFor(function () { return ADM.api.connected(); }, 'подключение admin');
  ok('кнопка загрузки видна админу', ADM.api.uploadVisible() === 'inline-block', ADM.api.uploadVisible());
  ADM.api.upload();
  await waitFor(function () { return A.api.versions().eq_A !== undefined; }, 'рассылка состояния на клиента alice');
  ok('состояние разошлось на другого клиента', A.api.row('eq_A').version === 0 && !!A.api.row('eq_A').toSchedule['январь'], JSON.stringify(A.api.versions()));

  console.log('=== Операция специалиста уходит на сервер ===');
  var res = A.api.submit({ kind: 'add_work', eqId: 'eq_A', to: { month: 'февраль', day: 10, type: 'ТО-2' } },
    function () { A.api.row('eq_A').toSchedule['февраль'] = [{ type: 'ТО-2', day: 10 }]; });
  ok('commitOp принят локально', res.ok === true, res.reason);
  await waitFor(function () { return A.api.row('eq_A').version === 1; }, 'серверную версию eq_A=1');
  ok('версия взята у сервера', A.api.row('eq_A').version === 1, A.api.row('eq_A').version);
  ok('правка есть на сервере (пришла обратно)', !!A.api.row('eq_A').toSchedule['февраль'], JSON.stringify(A.api.row('eq_A').toSchedule));
  await waitFor(function () { return ADM.api.row('eq_A') && ADM.api.row('eq_A').version === 1; }, 'рассылку операции админу');
  ok('второй клиент увидел правку', !!ADM.api.row('eq_A').toSchedule['февраль']);

  console.log('=== Роль viewer не может править ===');
  const V = createApp('vera');
  V.api.setEquipment(eqList());
  await V.api.connect(ws, 'vera', 'vera-pass');
  await waitFor(function () { return V.api.connected(); }, 'подключение vera');
  var before = JSON.stringify(V.api.row('eq_A').toSchedule);
  var vres = V.api.submit({ kind: 'add_work', eqId: 'eq_A', to: { month: 'март', day: 3, type: 'ТО-1' } },
    function () { V.api.row('eq_A').toSchedule['март'] = [{ type: 'ТО-1', day: 3 }]; });
  ok('операция отклонена на клиенте', vres.ok === false && /недостаточно прав/.test(vres.reason), vres.reason);
  ok('локальных изменений нет', JSON.stringify(V.api.row('eq_A').toSchedule) === before);

  console.log('=== Конфликт версий и откат ===');
  const A2 = createApp('alice2');
  A2.api.setEquipment(eqList());
  await A2.api.connect(ws, 'alice', 'alice-pass');
  await waitFor(function () { return A2.api.connected() && A2.api.row('eq_A').version === 1; }, 'второй клиент получил версию');
  // искусственно «отстаём»: локально видим версию 0, сервер уже 1
  A2.api.row('eq_A').version = 0;
  var c2 = A2.api.submit({ kind: 'add_work', eqId: 'eq_A', to: { month: 'апрель', day: 4, type: 'ТО-1' } },
    function () { A2.api.row('eq_A').toSchedule['апрель'] = [{ type: 'ТО-1', day: 4 }]; });
  ok('правка отправлена оптимистично', c2.ok === true);
  await waitFor(function () { return A2.api.row('eq_A').toSchedule['апрель'] === undefined; }, 'откат после конфликта');
  ok('конфликт откатил локальную правку', A2.api.row('eq_A').toSchedule['апрель'] === undefined);
  ok('версия восстановлена из серверной', A2.api.row('eq_A').version === 1, A2.api.row('eq_A').version);

  console.log('=== Приоритет руководителя перебивает ===');
  const B = createApp('bob');
  B.api.setEquipment(eqList());
  await B.api.connect(ws, 'bob', 'bob-pass');
  await waitFor(function () { return B.api.connected() && B.api.row('eq_B').version === 0; }, 'подключение bob');
  B.api.row('eq_B').version = 0;
  B.api.submit({ kind: 'add_work', eqId: 'eq_B', to: { month: 'июль', day: 7, type: 'ТО-3' } },
    function () { B.api.row('eq_B').toSchedule['июль'] = [{ type: 'ТО-3', day: 7 }]; });
  await waitFor(function () { return B.api.row('eq_B').version === 1; }, 'версия eq_B=1');
  // теперь специалист с устаревшей базой: приоритет ниже -> конфликт
  A.api.row('eq_B').version = 0;
  A.api.submit({ kind: 'add_work', eqId: 'eq_B', to: { month: 'август', day: 8, type: 'ТО-1' } },
    function () { A.api.row('eq_B').toSchedule['август'] = [{ type: 'ТО-1', day: 8 }]; });
  await waitFor(function () { return A.api.row('eq_B').toSchedule['август'] === undefined; }, 'откат специалиста');
  ok('специалист не перебил руководителя', A.api.row('eq_B').toSchedule['август'] === undefined);
  ok('версия eq_B осталась 1', A.api.row('eq_B').version === 1, A.api.row('eq_B').version);

  console.log('=== Контроль синхронизации ===');
  await A.api.checkSync();
  await waitFor(function () { return A.api.net().checkPending === false; }, 'выполнение контроля');
  ok('контроль получил статистику сервера', A.api.stats() && typeof A.api.stats().ops === 'number', JSON.stringify(A.api.stats()));

  console.log('=== Офлайн-правка не должна затираться при подключении ===');
  A.api.disconnect();
  ok('режим автономный', A.api.connected() === false);
  A.api.submit({ kind: 'add_work', eqId: 'eq_A', to: { month: 'октябрь', day: 3, type: 'ТО-1' } },
    function () { A.api.row('eq_A').toSchedule['октябрь'] = [{ type: 'ТО-1', day: 3 }]; });
  var offlineVer = A.api.row('eq_A').version;
  await A.api.connect(ws, 'alice', 'alice-pass');
  await waitFor(function () { return A.api.connected(); }, 'повторное подключение alice');
  await waitFor(function () { return A.api.outbox() === 0; }, 'автоотправку очереди');
  ok('офлайн-правка сохранилась после подключения', !!A.api.row('eq_A').toSchedule['октябрь'], JSON.stringify(A.api.row('eq_A').toSchedule));
  ok('очередь отправлена на сервер автоматически', A.api.outbox() === 0, A.api.outbox());
  await waitFor(function () { return A.api.row('eq_A').version === offlineVer; }, 'синхронизацию версии');
  ok('версия совпала с серверной', A.api.row('eq_A').version === offlineVer && offlineVer > 1, A.api.row('eq_A').version);

  console.log('=== Трое работают с одной записью (eq_B) ===');
  const C = createApp('carol');
  C.api.setEquipment(eqList());
  await C.api.connect(ws, 'carol', 'carol-pass');
  await waitFor(function () { return C.api.connected(); }, 'подключение carol');
  await new Promise(function (r) { setTimeout(r, 300); });
  var v0 = A.api.row('eq_B').version;
  ok('третий участник видит актуальную версию', C.api.row('eq_B').version === v0, C.api.row('eq_B').version + ' vs ' + v0);

  A.api.submit({ kind: 'add_work', eqId: 'eq_B', to: { month: 'сентябрь', day: 1, type: 'ТО-1' } },
    function () { A.api.row('eq_B').toSchedule['сентябрь'] = [{ type: 'ТО-1', day: 1 }]; });
  await waitFor(function () { return A.api.row('eq_B').version === v0 + 1; }, 'версию v0+1');
  ok('первый участник применил правку', A.api.row('eq_B').version === v0 + 1, A.api.row('eq_B').version);

  C.api.row('eq_B').version = v0;   // имитируем устаревшую базу
  C.api.submit({ kind: 'add_work', eqId: 'eq_B', to: { month: 'октябрь', day: 5, type: 'ТО-1' } },
    function () { C.api.row('eq_B').toSchedule['октябрь'] = [{ type: 'ТО-1', day: 5 }]; });
  await waitFor(function () { return C.api.row('eq_B').toSchedule['октябрь'] === undefined; }, 'откат carol');
  ok('устаревшая правка третьего участника откатана', C.api.row('eq_B').toSchedule['октябрь'] === undefined);
  ok('после конфликта версия взята с сервера', C.api.row('eq_B').version === v0 + 1, C.api.row('eq_B').version);

  C.api.submit({ kind: 'add_work', eqId: 'eq_B', to: { month: 'ноябрь', day: 11, type: 'ТО-2' } },
    function () { C.api.row('eq_B').toSchedule['ноябрь'] = [{ type: 'ТО-2', day: 11 }]; });
  await waitFor(function () { return C.api.row('eq_B').version === v0 + 2; }, 'версию v0+2');
  ok('повторная правка с актуальной версией применена', C.api.row('eq_B').version === v0 + 2, C.api.row('eq_B').version);
  await waitFor(function () { return A.api.row('eq_B').version === v0 + 2; }, 'рассылку первому участнику');
  ok('правка третьего участника разошлась первому', !!A.api.row('eq_B').toSchedule['ноябрь'], JSON.stringify(A.api.row('eq_B').toSchedule));

  console.log('=== Идемпотентность: повтор операции не применяется дважды ===');
  var vBefore = C.api.row('eq_A').version;
  var dupOp = { opId: 'test_dup_' + Date.now(), kind: 'add_work', eqId: 'eq_A',
                baseVersion: { eq_A: vBefore }, to: { month: 'декабрь', day: 12, type: 'ТО-3' } };
  C.api.sendRaw({ type: 'op', op: dupOp });
  await waitFor(function () {
    var a = C.api.lastAnswer();
    return a && a.opId === dupOp.opId && a.status !== 'duplicate';
  }, 'первое применение операции');
  var dup1 = C.api.lastAnswer();
  ok('первая отправка применилась', dup1.versions && dup1.versions.eq_A === vBefore + 1, JSON.stringify(dup1.versions));
  C.api.sendRaw({ type: 'op', op: dupOp });
  await waitFor(function () {
    var a = C.api.lastAnswer();
    return a && a.opId === dupOp.opId && a.status === 'duplicate';
  }, 'ответ «дубликат»');
  var dup2 = C.api.lastAnswer();
  ok('повтор помечен как дубликат', dup2.duplicate === true && dup2.status === 'duplicate', String(dup2.status));
  ok('версия не выросла повторно', dup2.versions.eq_A === dup1.versions.eq_A, dup2.versions.eq_A);

  console.log('=== Разбор номера из названия (для Аршина) ===');
  var nums1 = A.api.numbers('Оборудование xxxxzx, dfwesf fwer, зав.№ 4234234, аывпы №34243', '');
  ok('найден «зав. №»', nums1.indexOf('4234234') !== -1, JSON.stringify(nums1));
  ok('найден «№» из названия', nums1.indexOf('34243') !== -1, JSON.stringify(nums1));
  var nums2 = A.api.numbers('Преобразователь расхода, FH DN250, зав. №123456 (2024)', '');
  ok('найден зав. № с пробелом', nums2.indexOf('123456') !== -1, JSON.stringify(nums2));
  ok('год не считается номером', nums2.indexOf('2024') === -1, JSON.stringify(nums2));
  var nums3 = A.api.numbers('Датчик давления', '00534418');
  ok('серийный номер из карточки первый в списке', nums3[0] === '00534418', JSON.stringify(nums3));
  // правило заказчика: ровно «после № и до запятой»
  ok('берётся до запятой, мусор после не попадает',
     JSON.stringify(A.api.numbers('Прибор, зав.№ 12345 , далее текст', '')) === JSON.stringify(['12345']),
     JSON.stringify(A.api.numbers('Прибор, зав.№ 12345 , далее текст', '')));
  ok('буквенно-цифровой номер сохраняется',
     JSON.stringify(A.api.numbers('Прибор №АБ-77, год 2024', '')) === JSON.stringify(['АБ-77']),
     JSON.stringify(A.api.numbers('Прибор №АБ-77, год 2024', '')));
  ok('несколько «№» — все номера',
     JSON.stringify(A.api.numbers('зав.№ 111, доп.№222', '')) === JSON.stringify(['111', '222']),
     JSON.stringify(A.api.numbers('зав.№ 111, доп.№222', '')));

  console.log('=== Карточка поверки из Аршина ===');
  // запись в том виде, в каком её отдаёт сервер (/arshin/record)
  var CARD = {
    ok: true, id: '1-557751240',
    url: 'https://fgis.gost.ru/fundmetrology/eapi/vri/1-557751240',
    typeNumber: '44424-12', notation: 'КАРАТ-520', title: 'Расходомеры-счетчики жидкости ультразвуковые',
    modification: '80-0', number: '00534418',
    typeUrl: 'https://fgis.gost.ru/fundmetrology/cm/mits/8b228c88',
    org: 'ФБУ «Дальневосточный ЦСМ»', verificationDate: '16.09.2026', validDate: '15.09.2030',
    docTitle: 'МП 22-221-2012', certificate: 'С-АЭ/16-09-2026/557751240', vriType: '2', signCipher: 'АЭ',
    owner: 'ООО «Ромашка»', verifier: 'Иванов И.И.', calibration: false,
    conditions: { temperature: '22 °С', pressure: '101,4 мм рт.ст.', hymidity: '66 %' },
    etalons: [{ regNumber: '3.1.АБВ-1', regUrl: 'https://fgis.gost.ru/fundmetrology/cm/mieta/eta1',
                typeNumber: '77099-19', typeUrl: 'https://fgis.gost.ru/fundmetrology/cm/mits/0b01b',
                title: 'Установка', notation: 'УПРС+', modification: 'М', number: '080', year: '2023',
                rankCode: '2', rankTitle: 'Эталон 2-го разряда', schemaTitle: 'ГПС' }],
    applied: [{ typeNumber: '9084-83', typeUrl: 'https://fgis.gost.ru/fundmetrology/cm/mits/chast',
                title: 'Частотомеры электронно-счетные', number: '8906123' }],
    additionalInfo: '', checkedAt: '2026-09-16T10:00:00.000Z'
  };
  var cardHtml = A.api.card(CARD);
  ok('карточка: раздел средства измерений', cardHtml.indexOf('44424-12') !== -1 && cardHtml.indexOf('КАРАТ-520') !== -1);
  ok('карточка: поверка и свидетельство', cardHtml.indexOf('С-АЭ/16-09-2026/557751240') !== -1 && cardHtml.indexOf('16.09.2026') !== -1);
  ok('карточка: поверитель и владелец', cardHtml.indexOf('Иванов И.И.') !== -1 && cardHtml.indexOf('Ромашка') !== -1);
  ok('карточка: условия поверки (в т.ч. влажность)', cardHtml.indexOf('66 %') !== -1 && cardHtml.indexOf('101,4') !== -1);
  ok('карточка: эталон с разрядом и годом', cardHtml.indexOf('77099-19') !== -1 && cardHtml.indexOf('2-го разряда') !== -1 && cardHtml.indexOf('2023') !== -1);
  ok('карточка: применённые СИ', cardHtml.indexOf('8906123') !== -1 && cardHtml.indexOf('Частотомеры') !== -1);
  ok('карточка: ссылка на тип СИ открывается в новой вкладке',
     cardHtml.indexOf('href="https://fgis.gost.ru/fundmetrology/cm/mits/8b228c88"') !== -1 && /target="_blank"/.test(cardHtml));
  ok('карточка: ссылки на тип эталона и на эталон',
     cardHtml.indexOf('https://fgis.gost.ru/fundmetrology/cm/mits/0b01b') !== -1 &&
     cardHtml.indexOf('https://fgis.gost.ru/fundmetrology/cm/mieta/eta1') !== -1);
  ok('карточка: рабочая ссылка на запись', cardHtml.indexOf('/eapi/vri/1-557751240') !== -1);
  ok('в карточке нет «undefined»', cardHtml.indexOf('undefined') === -1 && cardHtml.indexOf('null') === -1);
  ok('карточка: пользовательские данные экранированы',
     A.api.card({ id: 'x', title: '<script>alert(1)</script>', url: 'https://a.b' }).indexOf('<script>alert') === -1);

  console.log('=== Журнал изменений ===');
  // перенос: в журнале должно быть видно «было → стало»
  A.api.submit({
    kind: 'move_work', eqId: 'eq_A',
    from: { month: 'январь', day: 5, type: 'ТО-1' },
    to: { date: '2026-04-20', month: 'апрель', day: 20 },
    comment: 'по приказу'
  }, function () {
    var eq = A.api.row('eq_A');
    eq.toSchedule['январь'] = (eq.toSchedule['январь'] || []).filter(function (w) { return w.day !== 5; });
    eq.toSchedule['апрель'] = [{ type: 'ТО-1', day: 20 }];
  });
  await waitFor(function () { return A.api.row('eq_A').toSchedule['апрель']; }, 'перенос в апрель');
  await new Promise(function (r) { setTimeout(r, 250); });

  var clog = C.api.log();
  ok('журнал заполняется автоматически', clog.length > 0, clog.length);
  ok('в журнале есть чужие правки с автором',
     clog.some(function (e) { return e.author === 'Алиса' && /добавлено/.test(e.text); }),
     JSON.stringify(clog.slice(0, 2).map(function (e) { return e.author + ': ' + String(e.text).replace(/<[^>]*>/g, ''); })));
  ok('в журнале видно «что было → что стало»',
     clog.some(function (e) { return /class="before"/.test(e.text) && /class="after"/.test(e.text); }),
     (clog.find(function (e) { return /class="before"/.test(e.text); }) || {}).text);
  await C.api.loadLog();
  await new Promise(function (r) { setTimeout(r, 400); });
  ok('журнал подтягивается с сервера (история общая)',
     C.api.log().some(function (e) { return e.kind === 'set_state'; }),
     C.api.log().filter(function (e) { return e.kind === 'set_state'; }).length + ' записей set_state');

  console.log('=== Сворачивание списка оборудования ===');
  C.api.equipCollapse('none');
  C.api.toggleEquipment();
  ok('разворачивается', C.api.equipCollapse() === 'block', String(C.api.equipCollapse()));
  C.api.toggleEquipment();
  ok('сворачивается обратно', C.api.equipCollapse() === 'none', String(C.api.equipCollapse()));

  console.log('=== Итог на сервере ===');
  const health = await (await fetch('http://127.0.0.1:' + port + '/health')).json();
  // конфликтные и отклонённые операции в журнал не попадают
  ok('сервер зафиксировал применённые операции', health.stats.ops >= 5, JSON.stringify(health.stats));
  ok('оборудование на сервере', health.stats.equipment === 2, health.stats.equipment);

  A.api.disconnect();
  ok('после отключения режим автономный', A.api.connected() === false);
  var off = A.api.submit({ kind: 'add_work', eqId: 'eq_A', to: { month: 'сентябрь', day: 9, type: 'ТО-1' } },
    function () { A.api.row('eq_A').toSchedule['сентябрь'] = [{ type: 'ТО-1', day: 9 }]; });
  ok('в офлайне правка проходит локально', off.ok === true && !!A.api.row('eq_A').toSchedule['сентябрь']);

  await stopServer(srv);
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {}

  console.log('');
  console.log(fails === 0 ? ('!!! КЛИЕНТ+СЕРВЕР: ВСЕ ' + passed + ' ПРОВЕРОК ПРОЙДЕНЫ !!!') : ('!!! ПРОВАЛОВ: ' + fails + ' из ' + (passed + fails) + ' !!!'));
  process.exit(fails === 0 ? 0 : 1);
})().catch(function (e) {
  console.log('КРИТИЧЕСКАЯ ОШИБКА ТЕСТА: ' + e.message);
  console.log(e.stack);
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (err) {}
  process.exit(1);
});
