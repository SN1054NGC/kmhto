#!/bin/sh
# Запуск сервера KMHTO без root.
# Использование:  sh deploy/start-kmhto.sh
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export KMHTO_HOST="${KMHTO_HOST:-127.0.0.1}"
export KMHTO_PORT="${KMHTO_PORT:-8787}"
export KMHTO_DATA="${KMHTO_DATA:-$ROOT/data}"
mkdir -p "$KMHTO_DATA" "$ROOT/logs"
echo "[KMHTO] запуск: node server/index.js (host=$KMHTO_HOST port=$KMHTO_PORT data=$KMHTO_DATA)"
exec node server/index.js
