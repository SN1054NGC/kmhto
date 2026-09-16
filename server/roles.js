/*
 * KMHTO — учёт и планирование ТО/КМХ метрологического оборудования
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Логвиненко А. А. (SN1054NGC) <logvinenko-aa@mail.ru>
 * Исходный код: https://github.com/SN1054NGC/kmhto
 */
'use strict';
/**
 * Роли и права. Роль приходит ТОЛЬКО от сервера (из подписанного токена),
 * клиент не может её подделать. Права задаются не «по ячейкам A1/B2», а
 * по ВИДАМ ОПЕРАЦИЙ — это соответствует предметной области KMHTO.
 */

const DEFAULT_ROLES = {
  viewer:     { priority: 0,   label: 'Наблюдатель',   color: '#cccccc' },
  specialist: { priority: 300, label: 'Специалист',    color: '#87ceeb' },
  manager:    { priority: 600, label: 'Руководитель',  color: '#ffd700' },
  admin:      { priority: 999, label: 'Администратор', color: '#ff6b6b' }
};

// минимальный приоритет роли для каждого вида операции
const DEFAULT_PERMISSIONS = {
  add_work:      300,
  move_work:     300,
  change_type:   300,
  move_and_type: 300,
  swap_days:     300,
  swap_types:    300,
  note:          300,
  metrology:     300,
  delete_work:   600,
  plan_interval: 600,
  plan_rule:     600,
  plan_generate: 600,
  holiday:       600,
  set_state:     999,
  save_settings: 999
};

let roles = JSON.parse(JSON.stringify(DEFAULT_ROLES));
let permissions = Object.assign({}, DEFAULT_PERMISSIONS);

function getPriority(role) {
  const r = roles[role];
  return r ? r.priority : -1;
}

function canDo(role, kind) {
  const need = permissions[kind];
  if (need === undefined) return false;
  return getPriority(role) >= need;
}

function isAdmin(role) {
  return roles[role] !== undefined && getPriority(role) >= 999;
}

function setRolePriority(role, priority) {
  if (!roles[role]) return false;
  if (!Number.isInteger(priority) || priority < 0 || priority > 999) return false;
  roles[role].priority = priority;
  return true;
}

function setPermission(kind, minPriority) {
  if (!Number.isInteger(minPriority) || minPriority < 0 || minPriority > 999) return false;
  permissions[kind] = minPriority;
  return true;
}

/** Применить настройки, пришедшие от админа (с валидацией). */
function applySettings(payload) {
  const errors = [];
  const newRoles = payload && payload.roles;
  const newPerms = payload && payload.permissions;
  if (newRoles) {
    for (const key of Object.keys(newRoles)) {
      if (!roles[key]) { errors.push('неизвестная роль: ' + key); continue; }
      const p = newRoles[key].priority;
      if (!Number.isInteger(p) || p < 0 || p > 999) { errors.push('приоритет ' + key + ' вне 0..999'); continue; }
      roles[key].priority = p;
      if (typeof newRoles[key].label === 'string') roles[key].label = newRoles[key].label;
      if (typeof newRoles[key].color === 'string') roles[key].color = newRoles[key].color;
    }
  }
  if (newPerms) {
    for (const kind of Object.keys(newPerms)) {
      const v = newPerms[kind];
      if (!Number.isInteger(v) || v < 0 || v > 999) { errors.push('право ' + kind + ' вне 0..999'); continue; }
      permissions[kind] = v;
    }
  }
  return errors;
}

function snapshot() {
  return { roles: JSON.parse(JSON.stringify(roles)), permissions: JSON.parse(JSON.stringify(permissions)) };
}

function loadFromState(saved) {
  if (!saved) return;
  if (saved.roles) {
    for (const key of Object.keys(saved.roles)) {
      if (roles[key]) roles[key] = Object.assign(roles[key], saved.roles[key]);
    }
  }
  if (saved.permissions) permissions = Object.assign(permissions, saved.permissions);
}

module.exports = {
  getPriority, canDo, isAdmin, setRolePriority, setPermission,
  applySettings, snapshot, loadFromState,
  getRoles: () => roles, getPermissions: () => permissions
};
