[English](README.md) | **Русский**

# mercurius-browser

Браузер агента [Меркурий](https://github.com/opencck/mercurius): Chromium из Debian под puppeteer-core за небольшим API
на Fastify. Модуль Меркурия, работает и сам по себе. Без него агент тоже работает — просто без инструмента `browser`.

## API

Все пути, кроме `/health`, требуют `Authorization: Bearer <BROWSER_TOKEN>`. Тело — JSON; `profile` (по умолчанию
`main`) — профиль, входы в котором переживают перезапуск (`[a-z0-9][a-z0-9_-]{0,31}`).

| Путь | Что делает |
|---|---|
| `GET /health` | `{"ok": true, "sessions": N}` |
| `POST /navigate` | открывает адрес |
| `POST /read` | текст страницы, её ссылки и поля |
| `POST /click`, `POST /type` | действие с элементом; `type` пишет только в поле ввода, перевод строки вводится как текст, отправляет только `submit` |
| `POST /evaluate` | скрипт: на замороженной копии без сети — чтобы читать, или на живой странице — чтобы действовать |
| `POST /screenshot` | PNG страницы |
| `POST /close` | закрывает страницу профиля |

Каждый запрос страницы сверяется со списком внутренних и частных адресов (`guard.js`): страница не достаёт до сети
хоста. Сессия закрывается после 10 минут без запросов.

## Настройки

| Переменная | По умолчанию | Смысл |
|---|---|---|
| `BROWSER_TOKEN` | — | обязательна, от 16 символов |
| `PORT` | `3000` | порт |
| `PROFILES_DIR` | `/profiles` | где лежат профили со входами |
| `CHROMIUM_PATH` | `/usr/bin/chromium` | браузер |

## Запуск

```sh
docker build -t mercurius-browser .
docker run --rm --shm-size=512m -e BROWSER_TOKEN=$(openssl rand -hex 32) -p 3000:3000 mercurius-browser
```

В Меркурии сервис — в профиле compose `browser`: добавьте его в `COMPOSE_PROFILES` и задайте `BROWSER_TOKEN` в `.env`.

## Разработка

```sh
npm install
npm test
```

## Лицензия

MIT
