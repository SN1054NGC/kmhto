# Развёртывание на kmhto.ru (Jino) — рабочая конфигурация

Сайт развёрнут и работает: `https://kmhto.ru/` отдаёт приложение, `/health`
отвечает, WebSocket (`/ws`) поднимается. Ключевые моменты — в `deploy/SERVER-STEPS.md`.

Кратко:

- Node 22: `/opt/alt/alt-nodejs22/root/usr/bin/node`; `node:sqlite` без флага.
- Панель Jino задаёт `startup_file = app.js`, поэтому в корне сайта есть `app.js`
  (`require('./server/index.js')`), а `PassengerStartupFile` из `.htaccess` не влияет.
- WebSocket: прокси срезает заголовки `Upgrade`/`Connection`, поэтому в
  `public_html/.htaccess` они возвращаются приложению только для `/ws`. Если прокси
  не туннелирует соединение, клиент автоматически работает через HTTP-опрос
  (`POST /api/msg`, `GET /api/events`).
- Библиотеки интерфейса (Bootstrap, SheetJS, FileSaver, иконки) лежат локально
  в `vendor/` и отдаются сервером по `/vendor/...` — внешний CDN не нужен.
- Сервер отдаёт приложение и API на одном домене: `/`, `/login`, `/health`,
  `/arshin/*`, `/ws`. Поиск в ФГИС «Аршин» работает по обычному HTTPS.
- Прежний Python-сайт убран в `_old_python_app/`, бэкапы — в `~/backup/`.

Что дальше: сменить принципала `admin`, загрузить расписание на сервер
кнопкой «⬆ Загрузить расписание на сервер» и раздать логины коллегам
(`node server/adduser.js ...`).