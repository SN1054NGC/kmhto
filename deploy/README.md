# Развёртывание KMHTO на сервере

Приложение — один файл `app_kmhto.html` плюс сервер совместной работы на Node.js.
Сервер отдаёт и само приложение (`GET /`), и API (`POST /login`, `GET /arshin/*`),
и WebSocket (`/ws`) — поэтому всё живёт на одном домене.

## Требования

- **Node.js 24+** — используются встроенные модули `node:sqlite` и глобальный
  `WebSocket`; на Node 18/20 сервер не запустится.
- Долгоживущий процесс (не CGI), записываемый каталог для `data/`.
- Домен, проксирующий трафик на локальный порт **с поддержкой WebSocket**.
- HTTPS: если сайт открыт по `https://`, браузер не даст открыть `ws://` —
  нужен `wss://`. Приложение само подставляет `wss://<домен>/ws`, если открыто
  с сервера.

## Состав

```
app_kmhto.html        — приложение (отдаётся сервером на /)
server/               — сервер совместной работы (index.js и модули)
deploy/               — этот каталог: запуск и конфиги
data/                 — создаётся при первом запуске (SQLite, users.json, secret.key)
deploy/start-kmhto.sh — запуск без root (nohup/экран)
deploy/kmhto.service  — вариант для systemd (VPS, root)
deploy/nginx-kmhto.conf — обратный прокси nginx с WebSocket
```

## Быстрый старт (SSH, без root)

```sh
cd ~/domains/kmhto.ru
mkdir -p logs data
# первый администратор (логин/пароль/роль/имя)
node server/adduser.js admin 'СвойПароль' admin 'Администратор'

# запуск в фоне
KMHTO_PORT=8787 nohup node server/index.js > logs/kmhto.log 2>&1 &
tail -n 20 logs/kmhto.log     # должно быть: [KMHTO] сервер … слушает ws://127.0.0.1:8787
```

Проверка: `curl -s http://127.0.0.1:8787/health`.

Остановить: `pkill -f 'server/index.js'` (или найти PID через `ps`).

## Переменные окружения

| Переменная | По умолчанию | Смысл |
|---|---|---|
| `KMHTO_HOST` | `127.0.0.1` | адрес прослушивания (за прокси оставить localhost) |
| `KMHTO_PORT` | `8787` | порт |
| `KMHTO_DATA` | `./data` | каталог состояния (SQLite и пользователи) |
| `KMHTO_ADMIN_PASSWORD` | — | пароль администратора при первом старте |
| `KMHTO_ARSHIN_INTERVAL_MS` | `1200` | пауза между запросами к ФГИС «Аршин» |

## Проксирование домена

Нужно, чтобы `https://kmhto.ru/*` и `wss://kmhto.ru/ws` уходили на
`127.0.0.1:8787`. Пример для nginx — `nginx-kmhto.conf` (важны строки
`Upgrade`/`Connection` и большой `proxy_read_timeout`, иначе WebSocket рвётся).

Если в панели хостинга есть раздел «Node.js-приложение», указываем:

- корень приложения — каталог с `app_kmhto.html` и `server/`;
- точка входа — `server/index.js`;
- порт — тот, что выдаёт панель (пробросить в `KMHTO_PORT`).

## Использование

1. Открыть `https://kmhto.ru/`.
2. Вкладка **«Сеть»** → адрес сервера подставится сам (`wss://kmhto.ru/ws`) →
   логин/пароль → «Подключиться».
3. Администратором один раз нажать **«⬆ Загрузить расписание на сервер»**.

## Обновление версии

```sh
# остановить, заменить app_kmhto.html и server/, запустить снова
pkill -f 'server/index.js'
# … загрузка новых файлов …
nohup node server/index.js > logs/kmhto.log 2>&1 &
```

Каталог `data/` не трогать — в нём состояние и пользователи.

## Безопасность

- Сразу сменить пароль администратора и SSH-пароль, перейти на SSH-ключи.
- Не держать `data/` в публичном доступе (сервер отдаёт только `/`, но
  веб-сервер сверху не должен отдавать листинг каталогов).
- `data/secret.key` — ключ подписи токенов; при его смене все сессии сбросятся.
---

## Замена существующего сайта на kmhto.ru (если там уже другое приложение)

**Порядок строго такой: сначала бэкап, потом диагностика Node, только потом замена.**

### 0. Бэкап текущего сайта (обязательно)

    mkdir -p ~/backup
    tar czf ~/backup/kmhto.ru_$(date +%Y%m%d_%H%M).tar.gz -C ~/domains kmhto.ru
    ls -lh ~/backup

### 1. Диагностика (ничего не меняет)

    node -v; which node npm
    ls /usr/local/bin | head -50
    cat ~/domains/kmhto.ru/.htaccess 2>/dev/null | head -40
    head -30 ~/domains/kmhto.ru/passenger_wsgi.py
    ls -la ~/domains/kmhto.ru/public_html

Если node не найден или версия < 24 — Node-сервер на этом тарифе не запустится.
Тогда остаётся вариант B (статично) или VPS.

### 2. Отложить старый сайт в сторону (не удаляя)

    cd ~/domains/kmhto.ru
    mkdir -p _old_python_app
    mv passenger_wsgi.py gunicorn.conf.py requirements.txt setup.sh fix_all.sh *.py *.json *.md *.txt templates static uploads data licenses backup logs venv __pycache__ _old_python_app/ 2>/dev/null
    ls -la

Служебные каталоги хостинга (public_html, tmp и т.п.) не трогаем.

### 3. Разложить KMHTO

    cd ~/domains/kmhto.ru
    unzip -o ~/kmhto-deploy-*.zip -d .
    chmod +x deploy/start-kmhto.sh
    cp deploy/htaccess-passenger-node .htaccess     # либо: cp deploy/htaccess-static .htaccess

В htaccess-passenger-node заменить путь к node на вывод команды which node.

### 4. Запуск и проверка

Вариант A (Node):

    mkdir -p logs data
    node server/adduser.js admin 'СвойПароль' admin 'Администратор'
    sh deploy/start-kmhto.sh
    curl -s http://127.0.0.1:8787/health

Вариант B (статично):

    ls -la public_html    # app_kmhto.html должен лежать в docroot

### 5. Откат

    cd ~/domains
    mv kmhto.ru kmhto.ru.bad
    tar xzf ~/backup/kmhto.ru_ГГГГММДД_ЧЧММ.tar.gz
