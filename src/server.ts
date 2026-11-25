// The browser of the Mercurius agent: one Chromium per profile (its cookies and logins kept on disk), one page per
// profile, a small API for the agent. Every request a page makes is checked by guard.js.
// spec: brief/internet.md#как-сделано-поиск-чтение-и-браузер

import Fastify from 'fastify';
import puppeteer from 'puppeteer-core';
import type { Browser, Page } from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { PRESSABLE, PROFILE, dialogLine, legacyProfile, optionFor, readOnlyRefusal, refusal, scriptExpression, scrollTarget, typable } from './guard.js';
import type { ScrollTarget } from './guard.js';
import { startProxy } from './proxy.js';
import type { Proxy } from './proxy.js';
import { routeFrom } from './upstream.js';
import type { Route } from './upstream.js';

const TOKEN = process.env.BROWSER_TOKEN ?? '';
const PROFILES_DIR = process.env.PROFILES_DIR ?? '/profiles';
const IDLE_MS = 10 * 60 * 1000;
const NAV_TIMEOUT_MS = 30_000;
const TEXT_MAX = 60_000;
const SCRIPT_MAX = 200_000;
const RESULT_MAX = 60_000;
const SCRIPT_TIMEOUT_MS = 30_000;

if (TOKEN.length < 16) {
    console.error('BROWSER_TOKEN must be at least 16 characters');
    process.exit(1);
}

// spec: brief/internet.md#как-сделано-поиск-чтение-и-браузер — the browser leaves through the VLESS tunnel of the
//       installation, else through the owner's proxy, else directly; a proxy that cannot be read stops the start
let ROUTE: Route;
try {
    ROUTE = routeFrom(process.env);
} catch (error) {
    console.error((error as Error).message);
    process.exit(1);
}

// spec: services/browser/BRIEF.md#решения — the browser is an ordinary one: Chromium with a window, on a screen that
//       exists only in memory. A site refuses a browser without a window (x.com answers 403 to "HeadlessChrome",
//       Google says the browser may not be secure) and refuses one that pretends to be another system just as well,
//       so nothing about the browser is faked: it tells the truth, and the truth is an ordinary Chromium on Linux.
//       No reference repository has an implementation of its own (hermes drives no Chromium).
const DISPLAY = ':99';
/** the screen of an ordinary monitor; the window of the browser is smaller */
const SCREEN = '1920x1080x24';

/**
 * Starts the screen the browsers draw on and keeps it up: a screen that died comes back in a second. A display given
 * from outside (DISPLAY) is used as it is.
 */
async function display(): Promise<void> {
    if ((process.env.DISPLAY ?? '') !== '') {
        return;
    }
    process.env.DISPLAY = DISPLAY;
    const number = DISPLAY.slice(1);
    const start = async (): Promise<void> => {
        // what a screen killed with the container left behind: its lock names a process that may be another one now
        await rm(`/tmp/.X${number}-lock`, { force: true }).catch(() => {});
        await rm(`/tmp/.X11-unix/X${number}`, { force: true }).catch(() => {});
        const screen = spawn('Xvfb', [DISPLAY, '-screen', '0', SCREEN, '-nolisten', 'tcp'], { stdio: 'ignore' });
        screen.on('error', (error) => {
            console.error(`the screen of the browser did not start: ${error.message}`);
            process.exit(1);
        });
        screen.on('exit', () => setTimeout(() => void start(), 1000));
    };
    await start();
}
/** the window of an ordinary laptop: a viewport of 1280×900 in a window of that size */
const WIDTH = 1280;
const HEIGHT = 900;

/** @type {Map<string, {browser: import('puppeteer-core').Browser, page: import('puppeteer-core').Page, timer: NodeJS.Timeout|null}>} */
const sessions = new Map<string, Session>();

/** A profile's browser, its current page and what the service keeps about it. */
interface Session {
    browser: Browser;
    page: Page;
    timer: ReturnType<typeof setTimeout> | null;
    allowed: Set<string>;
    proxy: Proxy;
    dialogs: string[];
    busy?: boolean;
}

async function session(profile: string): Promise<Session> {
    let s = sessions.get(profile);
    if (!s) {
        await mkdir(`${PROFILES_DIR}/${profile}`, { recursive: true });
        // hosts the owner allowed for the current page; every navigation sets them anew
        const allowed = new Set<string>();
        // spec: brief/internet.md#как-сделано-поиск-чтение-и-браузер — every connection of the browser goes through a proxy that
        //       dials the address it checked; the loopback is not bypassed
        const proxy = await startProxy({ allowed: () => allowed, upstream: ROUTE.upstream });
        const browser = await puppeteer.launch({
            executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
            userDataDir: `${PROFILES_DIR}/${profile}`,
            headless: false,
            // the switch that announces automation goes; the window has the size of the viewport and shows no bubbles
            // of its own over the page
            ignoreDefaultArgs: ['--enable-automation'],
            args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run', '--lang=ru-RU',
                '--no-default-browser-check', '--hide-crash-restore-bubble', '--disable-session-crashed-bubble',
                '--disable-blink-features=AutomationControlled', `--window-size=${WIDTH},${HEIGHT}`,
                `--proxy-server=http://127.0.0.1:${proxy.port}`, '--proxy-bypass-list=<-loopback>'],
        });
        // dialogs the pages opened since the last answer, already dismissed; the next snapshot tells the agent
        const dialogs: string[] = [];
        const guard = async (tab: Page) => {
            tab.on('dialog', async (dialog) => {
                dialogs.push(dialogLine(dialog.type(), dialog.message()));
                if (dialogs.length > 20) {
                    dialogs.shift();
                }
                await dialog.dismiss().catch(() => {});
            });
            await tab.setRequestInterception(true);
            tab.on('request', async (request) => {
                const reason = await refusal(request.url(), undefined, allowed, ROUTE.upstream !== null);
                if (reason === null) {
                    void request.continue();
                } else {
                    void request.abort('accessdenied');
                }
            });
        };
        // a tab the page opens (window.open, a link with target) is checked the same way as the first one; a tab the
        // service opens itself (the frozen copy) has no opener and its own checks
        browser.on('targetcreated', async (target) => {
            if (target.opener() === undefined) {
                return;
            }
            const tab = await target.page().catch(() => null);
            if (tab === null) {
                return;
            }
            await guard(tab).catch(() => {});
            // spec: brief/internet.md#как-сделано-поиск-чтение-и-браузер — a tab the page opened becomes the current one: the agent works with
            //       one page, and a link with target=_blank must not leave it on the old one
            const current = sessions.get(profile);
            if (current && current.page !== tab) {
                const old = current.page;
                current.page = tab;
                await tab.setViewport({ width: WIDTH, height: HEIGHT }).catch(() => {});
                old.close().catch(() => {});
            }
        });
        // the service works in one tab: its own; what Chromium opened at the start (the tabs of the last run) goes
        const first = await browser.pages();
        const page = await browser.newPage();
        for (const tab of first) {
            await tab.close().catch(() => {});
        }
        await page.setViewport({ width: WIDTH, height: HEIGHT });
        await guard(page);
        s = { browser, page, timer: null, allowed, proxy, dialogs };
        sessions.set(profile, s);
    }
    if (s.timer) {
        clearTimeout(s.timer);
    }
    s.timer = setTimeout(() => close(profile), IDLE_MS);
    return s;
}

async function close(profile: string): Promise<void> {
    const s = sessions.get(profile);
    sessions.delete(profile);
    if (s) {
        await s.browser.close().catch(() => {});
        await s.proxy?.close().catch(() => {});
    }
}

/** What the agent gets back about a page. */
interface Snapshot {
    url: string;
    title: string;
    text: string;
    elements: string[];
    dialogs: string[];
}

/** An element the snapshot lists: a link, a button, a field or a list; each reads what it has of these. */
type ShownElement = HTMLElement & { value?: string; type?: string; href?: string };

/** The parts of a call the routes read: a JSON body from the network, every field unknown until checked. */
interface Call {
    Body: Record<string, unknown> | null | undefined;
}

/** The page of a session as text plus the elements one can act on, each with a number, and the dialogs it dismissed. */
async function snapshot(s: Session): Promise<Snapshot> {
    const shown = await s.page.evaluate((max, pressable) => {
        const visible = (el: Element) => {
            const r = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        document.querySelectorAll('[data-mercurius-ref]').forEach((el) => el.removeAttribute('data-mercurius-ref'));
        const elements: string[] = [];
        let n = 0;
        for (const el of document.querySelectorAll<ShownElement>(pressable)) {
            if (!visible(el) || n >= 200) {
                continue;
            }
            n++;
            el.setAttribute('data-mercurius-ref', String(n));
            const label = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || '').trim().slice(0, 80);
            const kind = el.tagName.toLowerCase() + (el.type ? `:${el.type}` : '');
            // a list shows what is chosen and what may be: the agent picks by value or text (select)
            const choices = el.tagName === 'SELECT'
                ? ' {' + [...(el as HTMLSelectElement).options].slice(0, 30).map((o) => `${o.selected ? '*' : ''}${o.value}=${o.text.trim().slice(0, 40)}`).join(' | ') + ((el as HTMLSelectElement).options.length > 30 ? ' | …' : '') + '}'
                : '';
            elements.push(`[${n}] ${kind} ${label.replace(/\s+/g, ' ')}${choices}${el.href ? ' → ' + el.href : ''}`);
        }
        const text = (document.body ? document.body.innerText : '').replace(/\n{3,}/g, '\n\n').slice(0, max);
        return { url: location.href, title: document.title, text, elements };
    }, TEXT_MAX, PRESSABLE);
    return { ...shown, dialogs: s.dialogs.splice(0) };
}

async function settle(page: Page): Promise<void> {
    await Promise.race([
        page.waitForNetworkIdle({ idleTime: 500, timeout: 8000 }).catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 8000)),
    ]);
}

const app = Fastify({ logger: false, bodyLimit: 1_048_576 });

app.addHook('onRequest', async (request, reply) => {
    if (request.url === '/health') {
        return;
    }
    const given = Buffer.from((request.headers.authorization ?? '').replace(/^Bearer /, ''));
    const expected = Buffer.from(TOKEN);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        void reply.code(401).send({ error: 'unauthorized' });
    }
});

app.addHook<Call>('preHandler', async (request, reply) => {
    // every call names its profile as a path of a participant; adopt alone has none
    const given = request.body?.profile;
    const profile = typeof given === 'string' ? given : '';
    if (request.method === 'POST' && request.url !== '/adopt' && !PROFILE.test(profile)) {
        void reply.code(400).send({ error: 'bad profile' });
    }
});

app.get('/health', async () => ({ ok: true, sessions: sessions.size, route: ROUTE.name }));

app.post<Call>('/navigate', async (request, reply) => {
    const { url, profile = 'main', allow = [] } = request.body ?? {};
    const hosts = Array.isArray(allow)
        ? allow.filter((h: unknown): h is string => typeof h === 'string' && h.length > 0 && h.length <= 253).slice(0, 4).map((h) => h.toLowerCase())
        : [];
    const reason = await refusal(typeof url === 'string' ? url : '', undefined, new Set(hosts));
    if (reason !== null) {
        return reply.code(403).send({ error: `адрес запрещён: ${reason}` });
    }
    const s = await session(String(profile));
    const { page, allowed } = s;
    allowed.clear();
    hosts.forEach((h) => allowed.add(h));
    try {
        await page.goto(String(url), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    } catch (e) {
        return reply.code(502).send({ error: `страница не открылась: ${(e as Error).name}` });
    }
    await settle(page);
    return snapshot(s);
});

app.post<Call>('/read', async (request) => {
    const { profile = 'main' } = request.body ?? {};
    return snapshot(await session(String(profile)));
});

app.post<Call>('/click', async (request, reply) => {
    const { ref, x, y, profile = 'main' } = request.body ?? {};
    const s = await session(String(profile));
    // a point of the screenshot: what stands in a frame of another site (the tick of a check "I am not a robot") has
    // no number, a person looking at the screenshot says where to press
    if (x !== undefined && y !== undefined) {
        const [px, py] = [Number(x), Number(y)];
        if (!Number.isFinite(px) || !Number.isFinite(py) || px < 0 || py < 0 || px >= WIDTH || py >= HEIGHT) {
            return reply.code(400).send({ error: `точка вне снимка: x от 0 до ${WIDTH - 1}, y от 0 до ${HEIGHT - 1}` });
        }
        await s.page.mouse.click(px, py);
        await settle(s.page);
        return snapshot(s);
    }
    const element = await s.page.$(`[data-mercurius-ref="${Number(ref)}"]`);
    if (!element) {
        return reply.code(404).send({ error: 'элемента с таким номером нет — сначала прочитай страницу' });
    }
    await element.click();
    // a click may open a tab: the session moves to it, and the wait is for the page that is current then
    await settle(s.page);
    return snapshot(s);
});

/**
 * Picks an option of a list by its value or text, as a person would: the page gets input and change events.
 * spec: brief/internet.md#как-сделано-поиск-чтение-и-браузер — the agent picks a value in a list
 */
app.post<Call>('/select', async (request, reply) => {
    const { ref, value = '', profile = 'main' } = request.body ?? {};
    const s = await session(String(profile));
    const element = await s.page.$(`[data-mercurius-ref="${Number(ref)}"]`);
    if (!element) {
        return reply.code(404).send({ error: 'элемента с таким номером нет — сначала прочитай страницу' });
    }
    const options = await element.evaluate((el) => (el.tagName === 'SELECT' ? [...(el as HTMLSelectElement).options].map((o) => ({ value: o.value, text: o.text })) : null));
    if (options === null) {
        return reply.code(400).send({ error: 'это не список выбора: select — для элементов select, кнопки нажимают click' });
    }
    const chosen = optionFor(options, value);
    if (chosen === null) {
        return reply.code(400).send({ error: `в списке нет варианта «${String(value).slice(0, 80)}» или он не однозначен; варианты: ${options.slice(0, 30).map((o) => o.text.trim()).join(', ')}` });
    }
    await element.select(chosen);
    await settle(s.page);
    return snapshot(s);
});

/** Scrolls the page most of a screen down or up, or to the top or the bottom; a lazy page loads what comes next. */
app.post<Call>('/scroll', async (request, reply) => {
    const { direction = 'down', profile = 'main' } = request.body ?? {};
    const target = scrollTarget(String(direction), 900);
    if (target === null) {
        return reply.code(400).send({ error: 'direction — down, up, top или bottom' });
    }
    const s = await session(String(profile));
    await s.page.evaluate((t: ScrollTarget) => {
        if (t.to === 'top') {
            window.scrollTo(0, 0);
        } else if (t.to === 'bottom') {
            window.scrollTo(0, document.documentElement.scrollHeight);
        } else {
            window.scrollBy(0, t.by);
        }
    }, target);
    await settle(s.page);
    return snapshot(s);
});

/** Goes back in the page's history; every request of the page it returns to is checked as on open. */
app.post<Call>('/back', async (request, reply) => {
    const { profile = 'main' } = request.body ?? {};
    const s = await session(String(profile));
    let response;
    try {
        response = await s.page.goBack({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    } catch (e) {
        return reply.code(502).send({ error: `назад не вернулась: ${(e as Error).name}` });
    }
    if (response === null && s.page.url() === 'about:blank') {
        return reply.code(409).send({ error: 'назад некуда: это первая страница' });
    }
    await settle(s.page);
    return snapshot(s);
});

app.post<Call>('/type', async (request, reply) => {
    const { ref, text = '', submit = false, profile = 'main' } = request.body ?? {};
    const s = await session(String(profile));
    const { page } = s;
    const element = await page.$(`[data-mercurius-ref="${Number(ref)}"]`);
    if (!element) {
        return reply.code(404).send({ error: 'элемента с таким номером нет — сначала прочитай страницу' });
    }
    // spec: brief/internet.md#как-сделано-поиск-чтение-и-браузер — typing only into fields, focused without a mouse click; the
    // text goes in as text (a line break is a line break, never the Enter key), sending only by an explicit submit
    const kind = await element.evaluate((el) => ({
        tag: el.tagName, type: el.getAttribute('type') ?? '', editable: (el as HTMLElement).isContentEditable === true,
        disabled: (el as HTMLInputElement).disabled === true, readOnly: (el as HTMLInputElement).readOnly === true,
    }));
    if (!typable(kind)) {
        return reply.code(400).send({ error: 'вводить текст можно только в поле ввода; кнопку нажимают действием click' });
    }
    await element.evaluate((el) => {
        (el as HTMLElement).focus();
        if (typeof (el as HTMLInputElement).select === 'function') {
            (el as HTMLInputElement).select();
        } else {
            const range = document.createRange();
            range.selectNodeContents(el);
            const selection = window.getSelection();
            selection!.removeAllRanges();
            selection!.addRange(range);
        }
    });
    if (String(text) === '') {
        await page.keyboard.press('Delete');
    } else {
        await page.keyboard.sendCharacter(String(text));
    }
    if (submit) {
        await element.press('Enter');
        await settle(s.page);
    }
    return snapshot(s);
});

/**
 * A read-only script runs on a frozen copy of the page in a tab of its own: the current DOM, the page's own scripts
 * off; while the copy loads, only GET to the same host, and before the script the tab goes offline — no fetch, no
 * WebSocket (blocked URL lists of CDP do not stop a WebSocket in Chromium 156, offline does). It cannot touch the live
 * page or its connections, so it cannot send anything; closing the copy ends whatever it left running.
 * spec: brief/internet.md#скрипты-браузера
 */
async function frozenCopy(s: Session, host: string): Promise<Page> {
    const html = await s.page.content();
    const url = s.page.url();
    const copy = await s.browser.newPage();
    try {
        await copy.setViewport({ width: 1280, height: 900 });
        await copy.setJavaScriptEnabled(false);
        await copy.setRequestInterception(true);
        let served = false;
        copy.on('request', async (request) => {
            // the address of the request has no #fragment, the page's may have one (web.telegram.org/k/#@chat)
            if (!served && request.isNavigationRequest() && request.url().split('#')[0] === url.split('#')[0]) {
                served = true;
                void request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
                return;
            }
            const reason = readOnlyRefusal(request.method(), request.url(), host) ?? await refusal(request.url(), undefined, s.allowed);
            if (reason === null) {
                void request.continue();
            } else {
                void request.abort('accessdenied');
            }
        });
        await copy.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
        const cdp = await copy.createCDPSession();
        await cdp.send('Network.enable');
        await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
        return copy;
    } catch (e) {
        await copy.close().catch(() => {});
        throw e;
    }
}

app.post<Call>('/evaluate', async (request, reply) => {
    const { profile = 'main', source = '', args = {}, mode = 'read', host = '' } = request.body ?? {};
    if (typeof source !== 'string' || source.trim() === '' || source.length > SCRIPT_MAX) {
        return reply.code(400).send({ error: `скрипт пуст или длиннее ${SCRIPT_MAX} символов` });
    }
    if (mode !== 'read' && mode !== 'act') {
        return reply.code(400).send({ error: 'mode — read или act' });
    }
    const s = await session(String(profile));
    let current = '';
    try {
        current = new URL(s.page.url()).hostname.toLowerCase();
    } catch {
        // an empty tab
    }
    if (current === '' || current !== String(host).toLowerCase()) {
        return reply.code(409).send({ error: `страница открыта на ${current || 'пустой вкладке'}, а скрипт — для ${String(host)}: сначала open` });
    }
    if (s.busy) {
        return reply.code(409).send({ error: 'в этом профиле уже работает скрипт' });
    }
    s.busy = true;
    let page = s.page;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        if (mode === 'read') {
            page = await frozenCopy(s, current);
        }
        const result = await Promise.race([
            page.evaluate(scriptExpression(source, args)),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`скрипт работал дольше ${SCRIPT_TIMEOUT_MS / 1000} с`)), SCRIPT_TIMEOUT_MS);
            }),
        ]);
        if (mode === 'act') {
            await settle(page);
        }
        const text = JSON.stringify(result ?? null) ?? 'null';
        return { url: s.page.url(), result: text.slice(0, RESULT_MAX), truncated: text.length > RESULT_MAX };
    } catch (e) {
        return reply.code(422).send({ error: `скрипт не выполнен: ${String((e as { message?: unknown } | null | undefined)?.message ?? e).slice(0, 500)}` });
    } finally {
        clearTimeout(timer);
        s.busy = false;
        if (page !== s.page) {
            // not awaited: closing a tab with requests still held by interception can hang, the answer must not wait
            page.close().catch(() => {});
        }
    }
});

app.post<Call>('/screenshot', async (request) => {
    const { profile = 'main' } = request.body ?? {};
    const { page } = await session(String(profile));
    const png = await page.screenshot({ type: 'png' });
    return { url: page.url(), png: Buffer.from(png).toString('base64') };
});

/**
 * Moves the profiles of the old flat layout (a name at the top of the folder) into the set of the owner: their logins
 * stay. The agent calls it once at start with the owner's folder; a profile already there is left as it is.
 * spec: brief/agent-loop.md#раскладка-каталогов — profiles of the browser are laid out by participants and projects
 */
app.post<Call>('/adopt', async (request, reply) => {
    const { owner = '' } = request.body ?? {};
    if (!/^p\d{1,10}$/.test(String(owner))) {
        return reply.code(400).send({ error: 'bad owner' });
    }
    const moved: string[] = [];
    await mkdir(`${PROFILES_DIR}/${String(owner)}`, { recursive: true });
    for (const name of await readdir(PROFILES_DIR)) {
        if (!legacyProfile(name) || !(await stat(`${PROFILES_DIR}/${name}`)).isDirectory()) {
            continue;
        }
        await close(name);
        const target = `${PROFILES_DIR}/${String(owner)}/${name}`;
        if (await stat(target).then(() => true, () => false)) {
            continue;
        }
        await rename(`${PROFILES_DIR}/${name}`, target);
        moved.push(name);
    }
    return { moved };
});

app.post<Call>('/close', async (request) => {
    const { profile = 'main' } = request.body ?? {};
    await close(String(profile));
    return { ok: true };
});

for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, async () => {
        await Promise.all([...sessions.keys()].map(close));
        process.exit(0);
    });
}

await display();
await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 3000) });
