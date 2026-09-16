# Пошаговое развёртывание KMHTO на kmhto.ru (Jino, CloudLinux + Passenger)

Проверено на сервере:
- Node v22.23.2: /opt/alt/alt-nodejs22/root/usr/bin/node
- node:sqlite работает без флага (только warning «experimental»)
- дом: /home/users/j/j17637313
- сайт: /home/users/j/j17637313/domains/kmhto.ru
- Passenger управляется через public_html/.htaccess (для Python там указывался PassengerPython)

## 1. Бэкап текущего сайта (обязательно)

    mkdir -p ~/backup
    tar czf ~/backup/kmhto.ru_$(date +%Y%m%d_%H%M).tar.gz -C ~/domains kmhto.ru
    ls -lh ~/backup

## 2. Отложить Python-приложение (не удаляя)

    cd ~/domains/kmhto.ru
    mkdir -p _old_python_app
    for f in .[!.]* *; do
      case "$f" in _old_python_app|public_html|tmp|.|..) continue;; esac
      mv -- "$f" _old_python_app/ 2>/dev/null || true
    done
    ls -la

## 3. Загрузить и распаковать архив

Архив kmhto-deploy-*.zip залить в ~ (SFTP или файловый менеджер панели), затем:

    cd ~/domains/kmhto.ru
    unzip -o ~/kmhto-deploy-*.zip -d .
    chmod +x deploy/start-kmhto.sh
    ls -la

## 4. Включить Node через Passenger

    cd ~/domains/kmhto.ru
    cp deploy/htaccess-passenger-node public_html/.htaccess
    cat public_html/.htaccess

## 5. Администратор и каталог данных

    cd ~/domains/kmhto.ru
    mkdir -p data logs
    N=/opt/alt/alt-nodejs22/root/usr/bin/node
    $N server/adduser.js admin 'СвойПароль' admin 'Администратор'
    ls -la data

## 6. Проверка

    curl -s https://kmhto.ru/health
    curl -sI https://kmhto.ru/ | head -5
    tail -n 60 ~/domains/kmhto.ru/logs/passenger.log 2>/dev/null
    tail -n 60 ~/logs/*.log 2>/dev/null

Открыть https://kmhto.ru/ — приложение должно загрузиться; вкладка «Сеть» →
адрес wss://kmhto.ru/ws подставится сам → логин/пароль → «Подключиться».

## Если Passenger не поддерживает Node

В логе будет что-то вроде «Node.js support not installed» или 500 без запуска
процесса. Тогда:

- проверить в панели Jino тип приложения/версию Node для сайта;
- либо оставить статику: cp deploy/htaccess-static public_html/.htaccess
  (работает всё клиентское, кроме совместной работы и Аршина);
- либо вынести сервер на VPS.

## Откат

    cd ~/domains
    mv kmhto.ru kmhto.ru.bad
    tar xzf ~/backup/kmhto.ru_ГГГГММДД_ЧЧММ.tar.gz

---

## Рабочая конфигурация на Jino

Что выяснилось на сервере:

- Node 22 лежит в `/opt/alt/alt-nodejs22/root/usr/bin/node` (v22.23.2);
  модуль `node:sqlite` работает **без флага** (только ExperimentalWarning).
- Дом: `/home/users/j/j17637313`, сайт: `/home/users/j/j17637313/domains/kmhto.ru`.
- Веб-сервер: Apache + Phusion Passenger. Python-сайты запускаются через
  `public_html/.htaccess` (`PassengerPython`), Node — так же.
- **Панель Jino задаёт `app_root` и `startup_file = app.js`** на уровне vhost,
  поэтому директива `PassengerStartupFile` в `.htaccess` игнорируется. Решение:
  в корне сайта лежит `app.js` с одной строкой `require('./server/index.js')`.
- **Прокси срезает hop-by-hop заголовки `Upgrade`/`Connection`**, из-за чего
  WebSocket не поднимался (запрос приходил как обычный `GET /ws` → 404).
  Лечится в `public_html/.htaccess`: `RequestHeader set Upgrade/Connection`
  (`mod_headers`) — после этого Passenger отвечает `101 Switching Protocols`.

Итоговый `public_html/.htaccess` (он же `deploy/htaccess-passenger-node`):

    PassengerEnabled on
    PassengerAppRoot /home/users/j/j17637313/domains/kmhto.ru
    PassengerAppType node
    PassengerStartupFile app.js
    SetEnv KMHTO_HOST 127.0.0.1
    SetEnv KMHTO_DATA /home/users/j/j17637313/domains/kmhto.ru/data

    # Возвращаем Upgrade/Connection ТОЛЬКО для /ws
    SetEnvIf Request_URI "^/ws" kmhto_ws

    <IfModule mod_headers.c>
        RequestHeader set Upgrade "websocket" env=kmhto_ws
        RequestHeader set Connection "Upgrade" env=kmhto_ws
    </IfModule>

Состав каталога сайта после развёртывания:

    app.js            — точка входа для Passenger (require('./server/index.js'))
    app_kmhto.html    — приложение (сервер отдаёт его на /)
    server/           — сервер и модули
    vendor/           — Bootstrap, SheetJS, FileSaver, иконки (без внешнего CDN)
    deploy/           — инструкции и конфиги
    data/             — SQLite, users.json, secret.key (создаёт сервер)
    public_html/      — .htaccess (настройки Passenger) + favicon
    _old_python_app/  — прежний Python-сайт (удалить после проверки)

Проверка (все три пункта должны пройти):

    cd ~/domains/kmhto.ru
    touch tmp/restart.txt; sleep 2

    # 1) сервер жив
    curl -s https://kmhto.ru/health; echo

    # 2) приложение отдаётся (ожидаем HTTP 200 и ~572000 б)
    curl -s -o /dev/null -w 'HTTP %{http_code}, %{size_download} b\n' https://kmhto.ru/

    # 3) WebSocket поднимается (ждём 101 Switching Protocols)
    curl -sS -i --http1.1 -m 8 \
      -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
      -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
      https://kmhto.ru/ws | head -5

Важно по безопасности:

- Сразу сменить пароль администратора:
      node server/adduser.js admin 'СложныйПароль' admin 'Администратор'
- В панели сменить SSH/FTP-пароли, по возможности перейти на SSH-ключи.
- Каталог `data/` не должен отдаваться веб-сервером (сейчас сервер отдаёт только `/`).
Заголовки добавляются только для `/ws`. Если поставить их без условия, Apache
передаст `Connection: Upgrade` и `Upgrade: websocket` во **все** запросы: Node
будет считать апгрейдом каждый запрос, не найдёт `Sec-WebSocket-Key` и ответит
`400 Bad Request`, из-за чего обычные страницы перестанут открываться. Поэтому
используется `SetEnvIf` по `Request_URI` и `env=` в `RequestHeader`.
---

## Транспорт: WebSocket и HTTP-опрос

Особенности хостинга Jino, которые нужно учитывать:

1. **Защитный фильтр (anti-bot)** отдаёт клиентам без JavaScript заглушку со
   скриптом `document.cookie="bpc=..."` и редиректом. Браузер её выполняет и
   попадает на сайт; проверки без cookie получают служебную страницу.
   Учитывать при проверках:

       curl -s https://kmhto.ru/health            # получим заглушку с bpc
       # взять cookie из ответа и повторить:
       curl -s -H 'Cookie: bpc=<значение>' https://kmhto.ru/health

2. **Прокси не туннелирует WebSocket**: рукопожатие проходит (`101 Switching
   Protocols`), но кадры в обе стороны не доходят. Для таких хостингов
   предусмотрен запасной транспорт — HTTP-опрос.

### HTTP-опрос (длинные опросы)

Сервер (`server/index.js`) получил два обычных HTTP-эндпоинта:

- `POST /api/msg` — тело `{ msg: {...} }`, заголовок `Authorization: Bearer <токен>`;
  обрабатывается тем же `onMessage`, что и WebSocket; ответ `{ ok, replies[], seq }`;
- `GET /api/events?since=N` — длинный опрос (до 25 с): отдаёт накопленные
  события (`op_applied`, `presence_update`, `state_replaced` и т. д.).

Сессии живут по логину (`httpSessions`), рассылка `broadcast()` уходит и в
WebSocket-клиентов, и в HTTP-сессии; presence учитывает оба транспорта.

Клиент (`app_kmhto.html`) сам выбирает транспорт:

- по умолчанию пробует WebSocket и отправляет `hello`;
- если за 4 секунды не пришло ни одного сообщения — включает HTTP-режим
  и продолжает работать через длинные опросы (в логе: «включён HTTP-режим»);
- если WebSocket работает (обычный хостинг/VPS) — используется он.

Проверено локально двумя клиентами: операция администратора доходит до второго
пользователя через `/api/events` (`op_applied: approved`).
