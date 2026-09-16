'use strict';
// Тест управления пользователями: список, добавление, смена роли, пароль, удаление,
// а также инварианты безопасности (пароли не утекают, токен удалённого не работает).
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kmhto_users_'));
process.env.KMHTO_DATA = tmp;
process.env.KMHTO_SECRET = 'test-secret-key';

const auth = require('../server/auth.js');

let fails = 0, total = 0;
function ok(name, cond, extra) {
  total++;
  if (!cond) fails++;
  console.log((cond ? '  OK   ' : '  FAIL ') + name + (extra !== undefined ? '  [' + extra + ']' : ''));
}

// 1) пустая база -> ensureAdmin создаёт администратора
const created = auth.ensureAdmin();
ok('ensureAdmin создал администратора при пустой базе', !!created && created.login === 'admin');
ok('пароль администратора непустой', !!created && String(created.password).length >= 8);
ok('countAdmins = 1', auth.countAdmins() === 1, auth.countAdmins());
ok('повторный ensureAdmin ничего не создаёт', auth.ensureAdmin() === null);

// 2) добавление пользователя
auth.addUser('alice', 'secret123', 'specialist', 'Алиса');
const list1 = auth.listUsers();
ok('listUsers вернул 2 записи', list1.length === 2, list1.length);
const alice = list1.filter(function (u) { return u.login === 'alice'; })[0];
ok('alice есть в списке', !!alice);
ok('роль alice = specialist', alice && alice.role === 'specialist');
ok('имя alice сохранено', alice && alice.name === 'Алиса');
ok('в списке нет salt/hash', list1.every(function (u) { return u.salt === undefined && u.hash === undefined; }));

// 3) вход по паролю
ok('authenticate верный пароль', !!auth.authenticate('alice', 'secret123'));
ok('authenticate неверный пароль', auth.authenticate('alice', 'wrong') === null);
ok('authenticate несуществующий логин', auth.authenticate('nobody', 'x') === null);

// 4) смена роли
auth.updateUser('alice', { role: 'manager' });
ok('роль изменена на manager', auth.listUsers().filter(function (u) { return u.login === 'alice'; })[0].role === 'manager');

// 5) смена имени
auth.updateUser('alice', { name: 'Алиса П.' });
ok('имя изменено', auth.listUsers().filter(function (u) { return u.login === 'alice'; })[0].name === 'Алиса П.');

// 6) смена пароля
auth.updateUser('alice', { password: 'newpass123' });
ok('новый пароль работает', !!auth.authenticate('alice', 'newpass123'));
ok('старый пароль больше не работает', auth.authenticate('alice', 'secret123') === null);

// 7) хеширование: одинаковый пароль -> разные хеши (соль)
const h1 = auth.hashPassword('same-pass');
const h2 = auth.hashPassword('same-pass');
ok('соль разная', h1.salt !== h2.salt);
ok('хеш разный', h1.hash !== h2.hash);
ok('verifyPassword подтверждает', auth.verifyPassword('same-pass', h1));

// 8) токены
const tokenAdmin = auth.signToken({ login: 'admin' });
const vAdmin = auth.verifyToken(tokenAdmin);
ok('токен администратора проверяется', !!vAdmin && vAdmin.role === 'admin');
const tokenAlice = auth.signToken({ login: 'alice' });
ok('токен alice проверяется', !!auth.verifyToken(tokenAlice));
ok('битый токен отклонён', auth.verifyToken('abc.def') === null);
ok('пустой токен отклонён', auth.verifyToken('') === null);

// 9) удаление
ok('removeUser(alice) = true', auth.removeUser('alice') === true);
ok('alice больше нет в списке', auth.listUsers().filter(function (u) { return u.login === 'alice'; }).length === 0);
ok('токен удалённого не работает', auth.verifyToken(tokenAlice) === null);
ok('removeUser(несуществующий) = false', auth.removeUser('nobody') === false);

// 10) последний администратор
ok('countAdmins = 1 после удаления alice', auth.countAdmins() === 1);
auth.addUser('admin2', 'admin2pass', 'admin', 'Второй админ');
ok('countAdmins = 2', auth.countAdmins() === 2);
auth.removeUser('admin2');
ok('countAdmins = 1 снова', auth.countAdmins() === 1);

// 11) обновление несуществующего
ok('updateUser(нет такого) = null', auth.updateUser('nobody', { role: 'viewer' }) === null);

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}

console.log('');
if (fails === 0) {
  console.log('!!! ПОЛЬЗОВАТЕЛИ: ВСЕ ' + total + ' ПРОВЕРОК ПРОЙДЕНЫ !!!');
  process.exit(0);
}
console.log('!!! ПРОВАЛЕНО ' + fails + ' из ' + total);
process.exit(1);
