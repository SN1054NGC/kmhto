/*
 * KMHTO — учёт и планирование ТО/КМХ метрологического оборудования
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Логвиненко А. А. (SN1054NGC) <logvinenko-aa@mail.ru>
 * Исходный код: https://github.com/SN1054NGC/kmhto
 */
'use strict';
/**
 * Настройки сервера KNMTO. Всё через переменные окружения — без файлов конфигов.
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.KMHTO_DATA || path.join(ROOT, 'data');
// PORT — для запуска через Passenger (он сам передаёт порт в process.env.PORT).
// Passenger может отдать как числовой порт, так и путь к unix-сокету —
// поддерживаем оба варианта, иначе listen() падает и Passenger не стартует.
const RAW_PORT = process.env.KMHTO_PORT || process.env.PORT || '8787';
const PORT = /^\d+$/.test(String(RAW_PORT)) ? parseInt(RAW_PORT, 10) : String(RAW_PORT);
const HOST = process.env.KMHTO_HOST || '127.0.0.1';

// клиент считается мёртвым, если не подавал признаков жизни дольше этого времени
const HEARTBEAT_TIMEOUT_MS = parseInt(process.env.KMHTO_HEARTBEAT_MS || '45000', 10);
const HEARTBEAT_SWEEP_MS = parseInt(process.env.KMHTO_HEARTBEAT_SWEEP_MS || '10000', 10);
const OPLOG_LIMIT = parseInt(process.env.KMHTO_OPLOG_LIMIT || '2000', 10);
const TOKEN_TTL_MS = parseInt(process.env.KMHTO_TOKEN_TTL_MS || String(12 * 60 * 60 * 1000), 10);

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  return DATA_DIR;
}

module.exports = {
  ROOT, DATA_DIR, PORT, HOST,
  HEARTBEAT_TIMEOUT_MS, HEARTBEAT_SWEEP_MS, OPLOG_LIMIT, TOKEN_TTL_MS,
  ensureDataDir
};
