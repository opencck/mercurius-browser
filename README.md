**English** | [Русский](README.ru.md) | [中文](README.cn.md)

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
| `POST /reset` | `kind`: `cache` — clears the caches of the profile (the sign-ins stay), `profile` — removes the whole profile |
| `POST /close` | closes the profile's page |
| `POST /adopt` | moves profiles of the old flat layout into the owner's set (`{"owner":"p1"}`), logins stay |

A dialog of the page (`alert`, `confirm`, `prompt`, `beforeunload`) is dismissed at once and its text comes with the next answer (`dialogs`): an open dialog would hold the page. A tab the page opens becomes the current one.

Every request of a page is checked against internal and private addresses (`src/guard.ts`) and goes out through a
loopback proxy that dials the checked address (`src/proxy.ts`), so a page cannot reach the host's network. A session closes after 10 minutes without requests.

That proxy goes out by one route for the whole service: through the VLESS tunnel of the installation (a `vless-proxy` beside the browser) when `BROWSER_VIA_VLESS` is set, else through `BROWSER_PROXY`, else directly. `/health` names the route in `route`. Chromium runs under `puppeteer-extra` with the stealth plugin and without the automation switch, so sites that refuse a headless browser (`HeadlessChrome` in the user agent, `navigator.webdriver`) see an ordinary one.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `BROWSER_TOKEN` | — | required, 16+ characters |
| `PORT` | `3000` | port |
| `PROFILES_DIR` | `/profiles` | where profiles with logins live: `p<participant>/<name>`, `p<participant>/projects/<project>/<name>` |
| `CHROMIUM_PATH` | `/usr/bin/chromium` | the browser |
| `BROWSER_VIA_VLESS` | — | non-empty — go out through the VLESS door `BROWSER_VLESS_PROXY` |
| `BROWSER_VLESS_PROXY` | `http://vless-proxy:8080` | the HTTP door of `vless-proxy`; it asks for no login |
| `BROWSER_PROXY` | — | the owner's proxy when there is no VLESS: `socks5://`, `socks5h://` or `http://`, with `user:password@` if needed; the word `direct` — directly even with VLESS |

## Run

```sh
docker build -t mercurius-browser .
docker run --rm --shm-size=512m -e BROWSER_TOKEN=$(openssl rand -hex 32) -p 3000:3000 mercurius-browser
```

In Mercurius the service is in the compose profile `browser`: add it to `COMPOSE_PROFILES` and set `BROWSER_TOKEN` in
`.env`.

## Development

The service is written in TypeScript (Node.js 22): the sources are in `src/` (`server.ts` — the API, `guard.ts` — the
address checks and helpers, `proxy.ts` — the loopback proxy), the tests in `test/`. `tsc` compiles both into `dist/`;
the Docker image builds them in a separate stage and runs `dist/src/server.js`.

```sh
npm install
npm run build    # compile into dist/
npm start        # run dist/src/server.js
npm run check    # TypeScript type check, ESLint and the tests
```

The tests need no browser and no network (the proxy tests open sockets on the loopback). CI runs `npm ci` and
`npm run check`.

## License

MIT
