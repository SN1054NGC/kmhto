/*
 * KMHTO — учёт и планирование ТО/КМХ метрологического оборудования
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Логвиненко А. А. (SN1054NGC) <logvinenko-aa@mail.ru>
 * Исходный код: https://github.com/SN1054NGC/kmhto
 */
'use strict';
/**
 * Точка входа для Passenger (панель хостинга ищет app.js в корне приложения).
 * Просто запускает основной сервер KMHTO: server/index.js.
 */
require('./server/index.js');
