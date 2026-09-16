/*
 * KMHTO — учёт и планирование ТО/КМХ метрологического оборудования
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Логвиненко А. А. (SN1054NGC) <logvinenko-aa@mail.ru>
 * Исходный код: https://github.com/SN1054NGC/kmhto
 */
'use strict';
/**
 * Хранилище на встроенном node:sqlite — без внешних зависимостей.
 * Таблицы: equipment (текущее состояние + версия), oplog (журнал операций), doc (настройки/праздники/заметки).
 */
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS equipment (',
  '  id TEXT PRIMARY KEY,',
  '  data TEXT NOT NULL,',
  '  version INTEGER NOT NULL DEFAULT 0,',
  '  last_author TEXT,',
  '  last_role TEXT,',
  '  updated_at INTEGER',
  ');',
  'CREATE TABLE IF NOT EXISTS oplog (',
  '  op_id TEXT PRIMARY KEY,',
  '  kind TEXT NOT NULL,',
  '  eq_id TEXT,',
  '  author TEXT,',
  '  role TEXT,',
  '  base_version TEXT,',
  '  version TEXT,',
  '  year INTEGER,',
  '  status TEXT NOT NULL,',
  '  comment TEXT,',
  '  payload TEXT,',
  '  ts INTEGER NOT NULL',
  ');',
  'CREATE INDEX IF NOT EXISTS idx_oplog_ts ON oplog (ts);',
  'CREATE INDEX IF NOT EXISTS idx_oplog_eq ON oplog (eq_id, ts);',
  'CREATE TABLE IF NOT EXISTS doc (',
  '  key TEXT PRIMARY KEY,',
  '  value TEXT NOT NULL',
  ');'
].join('\n');

function open(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

function getDoc(db, key, fallback) {
  const row = db.prepare('SELECT value FROM doc WHERE key = ?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch (e) { return fallback; }
}

function setDoc(db, key, value) {
  db.prepare('INSERT INTO doc (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

function loadState(db) {
  const state = {
    equipment: [],
    holidays: getDoc(db, 'holidays', {}),
    notes: getDoc(db, 'notes', {}),
    docVersion: getDoc(db, 'docVersion', 0),
    docLastAuthor: getDoc(db, 'docLastAuthor', null),
    docLastRole: getDoc(db, 'docLastRole', null)
  };
  const rows = db.prepare('SELECT id, data, version, last_author, last_role FROM equipment ORDER BY rowid').all();
  for (const r of rows) {
    let data;
    try { data = JSON.parse(r.data); } catch (e) { continue; }
    data.version = r.version;
    data.lastAuthor = r.last_author;
    data.lastRole = r.last_role;
    state.equipment.push(data);
  }
  return state;
}

function saveEquipment(db, eq) {
  const payload = Object.assign({}, eq);
  delete payload.version; delete payload.lastAuthor; delete payload.lastRole;
  db.prepare(
    'INSERT INTO equipment (id, data, version, last_author, last_role, updated_at) VALUES (?, ?, ?, ?, ?, ?) ' +
    'ON CONFLICT(id) DO UPDATE SET data = excluded.data, version = excluded.version, ' +
    'last_author = excluded.last_author, last_role = excluded.last_role, updated_at = excluded.updated_at'
  ).run(eq.id, JSON.stringify(payload), eq.version || 0, eq.lastAuthor || null, eq.lastRole || null, Date.now());
}

function saveAllEquipment(db, list) {
  db.exec('BEGIN');
  try {
    for (const eq of list) saveEquipment(db, eq);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function saveOp(db, op, status) {
  db.prepare(
    'INSERT INTO oplog (op_id, kind, eq_id, author, role, base_version, version, year, status, comment, payload, ts) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(op_id) DO NOTHING'
  ).run(
    op.opId, op.kind, op.eqId || null, op.authorId || null, op.authorRole || null,
    JSON.stringify(op.baseVersion || {}), JSON.stringify(op.versions || {}),
    op.year || null, status, op.comment || null, JSON.stringify(op), op.ts || Date.now()
  );
}

function saveDocSlice(db, state) {
  setDoc(db, 'holidays', state.holidays || {});
  setDoc(db, 'notes', state.notes || {});
  setDoc(db, 'docVersion', state.docVersion || 0);
  setDoc(db, 'docLastAuthor', state.docLastAuthor || null);
  setDoc(db, 'docLastRole', state.docLastRole || null);
}

// Найти операцию по opId — для идемпотентности повторной отправки
function findOp(db, opId) {
  if (!opId) return null;
  const row = db.prepare('SELECT payload, status FROM oplog WHERE op_id = ?').get(opId);
  if (!row) return null;
  try {
    const op = JSON.parse(row.payload);
    op.appliedStatus = row.status;
    return op;
  } catch (e) { return null; }
}

function recentOps(db, limit, sinceTs) {
  const lim = Math.max(1, Math.min(parseInt(limit, 10) || 100, 2000));
  const rows = sinceTs
    ? db.prepare('SELECT payload FROM oplog WHERE ts > ? ORDER BY ts ASC LIMIT ?').all(sinceTs, lim)
    : db.prepare('SELECT payload FROM oplog ORDER BY ts DESC LIMIT ?').all(lim);
  const out = [];
  for (const r of rows) { try { out.push(JSON.parse(r.payload)); } catch (e) {} }
  return sinceTs ? out : out.reverse();
}

function stats(db) {
  const eq = db.prepare('SELECT COUNT(*) c FROM equipment').get();
  const ops = db.prepare('SELECT COUNT(*) c FROM oplog').get();
  return { equipment: eq.c, ops: ops.c };
}

module.exports = { open, loadState, saveEquipment, saveAllEquipment, saveOp, saveDocSlice, recentOps, findOp, getDoc, setDoc, stats };
