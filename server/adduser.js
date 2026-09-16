#!/usr/bin/env node
/*
 * KMHTO — учёт и планирование ТО/КМХ метрологического оборудования
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Логвиненко А. А. (SN1054NGC) <logvinenko-aa@mail.ru>
 * Исходный код: https://github.com/SN1054NGC/kmhto
 */
'use strict';
/**
 * Добавить пользователя:
 *   node server/adduser.js <login> <password> [role] [Имя]
 * Роли: viewer | specialist | manager | admin
 */
const config = require('./config');
const auth = require('./auth');
const roles = require('./roles');

config.ensureDataDir();
const args = process.argv.slice(2);
if (args.length < 2) {
  console.log('Использование: node server/adduser.js <login> <password> [role] [Имя]');
  console.log('Роли: ' + Object.keys(roles.getRoles()).join(' | '));
  process.exit(1);
}
const [login, password, role, name] = args;
if (role && !roles.getRoles()[role]) {
  console.error('Неизвестная роль: ' + role);
  process.exit(1);
}
const rec = auth.addUser(login, password, role || 'viewer', name);
console.log('Пользователь создан: ' + rec.login + ' (' + rec.role + ')');
