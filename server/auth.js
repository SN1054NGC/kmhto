/*
 * KMHTO — учёт и планирование ТО/КМХ метрологического оборудования
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Логвиненко А. А. (SN1054NGC) <logvinenko-aa@mail.ru>
 * Исходный код: https://github.com/SN1054NGC/kmhto
 */
'use strict';
/**
 * Аутентификация: пользователи в users.json, пароли — scrypt, сессии — HMAC-токен.
 * Сервер ВСЕГДА берёт роль из токена и игнорирует всё, что клиент прислал в сообщении.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DATA_DIR, TOKEN_TTL_MS } = require('./config');

const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SECRET_FILE = path.join(DATA_DIR, 'secret.key');

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), s, 32).toString('hex');
  return { salt: s, hash };
}

function verifyPassword(password, rec) {
  if (!rec || !rec.salt || !rec.hash) return false;
  const h = hashPassword(password, rec.salt).hash;
  const a = Buffer.from(h, 'hex');
  const b = Buffer.from(rec.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function loadUsers() {
  return readJson(USERS_FILE, {});
}

function saveUsers(users) {
  writeJsonAtomic(USERS_FILE, users);
}

function getSecret() {
  if (process.env.KMHTO_SECRET) return process.env.KMHTO_SECRET;
  try {
    const s = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    if (s) return s;
  } catch (e) {}
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SECRET_FILE, secret, { encoding: 'utf8', mode: 0o600 });
  return secret;
}

/** Создать пользователя. role — ключ из roles.js */
function addUser(login, password, role, name) {
  if (!login || !password) throw new Error('login и password обязательны');
  const users = loadUsers();
  const rec = hashPassword(password);
  users[login] = {
    login,
    name: name || login,
    role: role || 'viewer',
    salt: rec.salt,
    hash: rec.hash,
    createdAt: Date.now()
  };
  saveUsers(users);
  return users[login];
}

/** При первом запуске создать админа, иначе система недоступна. */
function ensureAdmin(log) {
  const users = loadUsers();
  if (Object.keys(users).length > 0) return null;
  const password = process.env.KMHTO_ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  const rec = hashPassword(password);
  users['admin'] = { login: 'admin', name: 'Администратор', role: 'admin', salt: rec.salt, hash: rec.hash, createdAt: Date.now() };
  saveUsers(users);
  const line = 'Создан администратор по умолчанию: логин "admin", пароль "' + password + '"';
  if (log) log(line + ' — смените пароль (server/adduser.js).');
  return { login: 'admin', password };
}

function signToken(payload, ttlMs) {
  const body = Object.assign({}, payload, { exp: Date.now() + (ttlMs || TOKEN_TTL_MS) });
  const data = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', getSecret()).update(data).digest('base64url');
  return data + '.' + sig;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const data = parts[0];
  const expected = crypto.createHmac('sha256', getSecret()).update(data).digest('base64url');
  const a = Buffer.from(expected);
  const b = Buffer.from(parts[1]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let body;
  try { body = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')); } catch (e) { return null; }
  if (!body.exp || body.exp < Date.now()) return null;
  // роль перечитываем из файла: смена роли действует без перевыпуска токена
  const users = loadUsers();
  const rec = users[body.login];
  if (!rec) return null;
  return { login: body.login, name: rec.name || body.login, role: rec.role };
}

/** Проверка пары логин/пароль. Возвращает пользователя или null. */
function authenticate(login, password) {
  const users = loadUsers();
  const rec = users[login];
  if (!rec) {
    // выравниваем время ответа, чтобы не палить существование логина
    hashPassword(String(password || ''), '0000000000000000');
    return null;
  }
  if (!verifyPassword(password, rec)) return null;
  return { login, name: rec.name || login, role: rec.role };
}

/** Список пользователей без секретов (для админ-панели). */
function listUsers() {
  const users = loadUsers();
  return Object.keys(users).sort().map(function (login) {
    const u = users[login] || {};
    return { login: login, name: u.name || login, role: u.role || 'viewer', createdAt: u.createdAt || null };
  });
}

/** Сколько пользователей с ролью admin. */
function countAdmins() {
  const users = loadUsers();
  return Object.keys(users).filter(function (l) { return (users[l] || {}).role === 'admin'; }).length;
}

/** Удалить пользователя. Возвращает true, если запись была. */
function removeUser(login) {
  const users = loadUsers();
  if (!users[login]) return false;
  delete users[login];
  saveUsers(users);
  return true;
}

/** Изменить имя, роль и/или пароль. Возвращает запись без секретов или null. */
function updateUser(login, patch) {
  patch = patch || {};
  const users = loadUsers();
  const u = users[login];
  if (!u) return null;
  if (patch.name !== undefined && patch.name !== null) {
    const nm = String(patch.name).trim();
    u.name = nm || login;
  }
  if (patch.role !== undefined && patch.role !== null) u.role = String(patch.role);
  if (patch.password) {
    const rec = hashPassword(String(patch.password));
    u.salt = rec.salt;
    u.hash = rec.hash;
  }
  u.updatedAt = Date.now();
  saveUsers(users);
  return { login: login, name: u.name || login, role: u.role, createdAt: u.createdAt || null };
}

module.exports = {
  USERS_FILE, SECRET_FILE,
  hashPassword, verifyPassword, addUser, ensureAdmin,
  signToken, verifyToken, authenticate,
  loadUsers, saveUsers,
  listUsers, countAdmins, removeUser, updateUser
};
