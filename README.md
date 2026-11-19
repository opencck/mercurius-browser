**English** | [Русский](README.ru.md)

# mercurius-browser

The browser of the [Mercurius](https://github.com/opencck/mercurius) agent: Chromium from Debian under puppeteer-core,
behind a small Fastify API. It is a module of Mercurius and can be used on its own. Without it the agent works too, it
just has no `browser` tool.

## API

Every route except `/health` needs `Authorization: Bearer <BROWSER_TOKEN>`. A body is JSON; `profile` (default `main`)
names a profile whose logins survive restarts (`[a-z0-9][a-z0-9_-]{0,31}`).

| Route | What it does |
|---|---|
| `GET /health` | `{"ok": true, "sessions": N}` |
| `POST /navigate` | opens a URL |
| `POST /read` | the text of the page and its links and fields |
| `POST /click`, `POST /type` | acts on an element; `type` writes only into a text field, line breaks go in as text and only `submit` sends |
| `POST /select` | picks an option of a list by its value, its text or a part of the text only one option has |
| `POST /scroll` | scrolls `down`, `up`, to the `top` or the `bottom` |
| `POST /back` | goes back in the page's history |
| `POST /evaluate` | runs a script: on a frozen offline copy to read, or on the live page to act |
| `POST /screenshot` | a PNG of the page |
| `POST /close` | closes the profile's page |
| `POST /adopt` | moves profiles of the old flat layout into the owner's set (`{"owner":"p1"}`), logins stay |

A dialog of the page (`alert`, `confirm`, `prompt`, `beforeunload`) is dismissed at once and its text comes with the next answer (`dialogs`): an open dialog would hold the page. A tab the page opens becomes the current one.

Every request of a page is checked against internal and private addresses (`guard.js`), so a page cannot reach the
host's network. A session closes after 10 minutes without requests.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `BROWSER_TOKEN` | — | required, 16+ characters |
| `PORT` | `3000` | port |
| `PROFILES_DIR` | `/profiles` | where profiles with logins live: `p<participant>/<name>`, `p<participant>/projects/<project>/<name>` |
| `CHROMIUM_PATH` | `/usr/bin/chromium` | the browser |

## Run

```sh
docker build -t mercurius-browser .
docker run --rm --shm-size=512m -e BROWSER_TOKEN=$(openssl rand -hex 32) -p 3000:3000 mercurius-browser
```

In Mercurius the service is in the compose profile `browser`: add it to `COMPOSE_PROFILES` and set `BROWSER_TOKEN` in
`.env`.

## Development

```sh
npm install
npm test
```

## License

MIT
