// The browser of the Mercurius agent: one Chromium per profile (its cookies and logins kept on disk), one page per
// profile, a small API for the agent. Every request a page makes is checked by guard.js.
// spec: BRIEF.md#интернет-и-браузер

import Fastify from 'fastify';
import puppeteer from 'puppeteer-core';
import { timingSafeEqual } from 'node:crypto';
import { readOnlyRefusal, refusal, scriptExpression } from './guard.js';

const TOKEN = process.env.BROWSER_TOKEN ?? '';
const PROFILES_DIR = process.env.PROFILES_DIR ?? '/profiles';
const IDLE_MS = 10 * 60 * 1000;
const NAV_TIMEOUT_MS = 30_000;
const TEXT_MAX = 60_000;
const PROFILE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const SCRIPT_MAX = 200_000;
const RESULT_MAX = 60_000;
const SCRIPT_TIMEOUT_MS = 30_000;

if (TOKEN.length < 16) {
    console.error('BROWSER_TOKEN must be at least 16 characters');
    process.exit(1);
}

/** @type {Map<string, {browser: import('puppeteer-core').Browser, page: import('puppeteer-core').Page, timer: NodeJS.Timeout|null}>} */
const sessions = new Map();

async function session(profile) {
    let s = sessions.get(profile);
    if (!s) {
        const browser = await puppeteer.launch({
            executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
            userDataDir: `${PROFILES_DIR}/${profile}`,
            headless: true,
            args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run', '--lang=ru-RU'],
        });
        const page = (await browser.pages())[0] ?? (await browser.newPage());
        await page.setViewport({ width: 1280, height: 900 });
        await page.setRequestInterception(true);
        // hosts the owner allowed for the current page; every navigation sets them anew
        const allowed = new Set();
        page.on('request', async (request) => {
            const reason = await refusal(request.url(), undefined, allowed);
            if (reason === null) {
                request.continue();
            } else {
                request.abort('accessdenied');
            }
        });
        s = { browser, page, timer: null, allowed };
        sessions.set(profile, s);
    }
    if (s.timer) {
        clearTimeout(s.timer);
    }
    s.timer = setTimeout(() => close(profile), IDLE_MS);
    return s;
}

async function close(profile) {
    const s = sessions.get(profile);
    sessions.delete(profile);
    if (s) {
        await s.browser.close().catch(() => {});
    }
}

/** The page as text plus the elements one can act on, each with a number. */
async function snapshot(page) {
    return page.evaluate((max) => {
        const visible = (el) => {
            const r = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        document.querySelectorAll('[data-mercurius-ref]').forEach((el) => el.removeAttribute('data-mercurius-ref'));
        const elements = [];
        let n = 0;
        for (const el of document.querySelectorAll('a[href], button, input, textarea, select, [role=button], [contenteditable=true]')) {
            if (!visible(el) || n >= 200) {
                continue;
            }
            n++;
            el.setAttribute('data-mercurius-ref', String(n));
            const label = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || '').trim().slice(0, 80);
            const kind = el.tagName.toLowerCase() + (el.type ? `:${el.type}` : '');
            elements.push(`[${n}] ${kind} ${label}${el.href ? ' → ' + el.href : ''}`);
        }
        const text = (document.body ? document.body.innerText : '').replace(/\n{3,}/g, '\n\n').slice(0, max);
        return { url: location.href, title: document.title, text, elements };
    }, TEXT_MAX);
}

async function settle(page) {
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
        reply.code(401).send({ error: 'unauthorized' });
    }
});

app.addHook('preHandler', async (request, reply) => {
    const profile = request.body?.profile ?? 'main';
    if (request.method === 'POST' && !PROFILE.test(profile)) {
        reply.code(400).send({ error: 'bad profile' });
    }
});

app.get('/health', async () => ({ ok: true, sessions: sessions.size }));

app.post('/navigate', async (request, reply) => {
    const { url, profile = 'main', allow = [] } = request.body ?? {};
    const hosts = Array.isArray(allow)
        ? allow.filter((h) => typeof h === 'string' && h.length > 0 && h.length <= 253).slice(0, 4).map((h) => h.toLowerCase())
        : [];
    const reason = await refusal(String(url ?? ''), undefined, new Set(hosts));
    if (reason !== null) {
        return reply.code(403).send({ error: `адрес запрещён: ${reason}` });
    }
    const { page, allowed } = await session(profile);
    allowed.clear();
    hosts.forEach((h) => allowed.add(h));
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    } catch (e) {
        return reply.code(502).send({ error: `страница не открылась: ${e.name}` });
    }
    await settle(page);
    return snapshot(page);
});

app.post('/read', async (request) => {
    const { profile = 'main' } = request.body ?? {};
    return snapshot((await session(profile)).page);
});

app.post('/click', async (request, reply) => {
    const { ref, profile = 'main' } = request.body ?? {};
    const { page } = await session(profile);
    const element = await page.$(`[data-mercurius-ref="${Number(ref)}"]`);
    if (!element) {
        return reply.code(404).send({ error: 'элемента с таким номером нет — сначала прочитай страницу' });
    }
    await element.click();
    await settle(page);
    return snapshot(page);
});

app.post('/type', async (request, reply) => {
    const { ref, text = '', submit = false, profile = 'main' } = request.body ?? {};
    const { page } = await session(profile);
    const element = await page.$(`[data-mercurius-ref="${Number(ref)}"]`);
    if (!element) {
        return reply.code(404).send({ error: 'элемента с таким номером нет — сначала прочитай страницу' });
    }
    await element.click({ clickCount: 3 });
    await element.type(String(text), { delay: 15 });
    if (submit) {
        await element.press('Enter');
        await settle(page);
    }
    return snapshot(page);
});

/**
 * A read-only script runs on a frozen copy of the page in a tab of its own: the current DOM, the page's own scripts
 * off; while the copy loads, only GET to the same host, and before the script the tab goes offline — no fetch, no
 * WebSocket (blocked URL lists of CDP do not stop a WebSocket in Chromium 156, offline does). It cannot touch the live
 * page or its connections, so it cannot send anything; closing the copy ends whatever it left running.
 * spec: BRIEF.md#скрипты-браузера-решение-владельца-2026-11-17
 */
async function frozenCopy(s, host) {
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
                request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
                return;
            }
            const reason = readOnlyRefusal(request.method(), request.url(), host) ?? await refusal(request.url(), undefined, s.allowed);
            if (reason === null) {
                request.continue();
            } else {
                request.abort('accessdenied');
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

app.post('/evaluate', async (request, reply) => {
    const { profile = 'main', source = '', args = {}, mode = 'read', host = '' } = request.body ?? {};
    if (typeof source !== 'string' || source.trim() === '' || source.length > SCRIPT_MAX) {
        return reply.code(400).send({ error: `скрипт пуст или длиннее ${SCRIPT_MAX} символов` });
    }
    if (mode !== 'read' && mode !== 'act') {
        return reply.code(400).send({ error: 'mode — read или act' });
    }
    const s = await session(profile);
    let current = '';
    try {
        current = new URL(s.page.url()).hostname.toLowerCase();
    } catch {
        // an empty tab
    }
    if (current === '' || current !== String(host).toLowerCase()) {
        return reply.code(409).send({ error: `страница открыта на ${current || 'пустой вкладке'}, а скрипт — для ${host}: сначала open` });
    }
    if (s.busy) {
        return reply.code(409).send({ error: 'в этом профиле уже работает скрипт' });
    }
    s.busy = true;
    let page = s.page;
    let timer;
    try {
        if (mode === 'read') {
            page = await frozenCopy(s, current);
        }
        const result = await Promise.race([
            page.evaluate(scriptExpression(source, args)),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`скрипт работал дольше ${SCRIPT_TIMEOUT_MS / 1000} с`)), SCRIPT_TIMEOUT_MS);
            }),
        ]);
        if (mode === 'act') {
            await settle(page);
        }
        const text = JSON.stringify(result ?? null) ?? 'null';
        return { url: s.page.url(), result: text.slice(0, RESULT_MAX), truncated: text.length > RESULT_MAX };
    } catch (e) {
        return reply.code(422).send({ error: `скрипт не выполнен: ${String(e?.message ?? e).slice(0, 500)}` });
    } finally {
        clearTimeout(timer);
        s.busy = false;
        if (page !== s.page) {
            // not awaited: closing a tab with requests still held by interception can hang, the answer must not wait
            page.close().catch(() => {});
        }
    }
});

app.post('/screenshot', async (request) => {
    const { profile = 'main' } = request.body ?? {};
    const { page } = await session(profile);
    const png = await page.screenshot({ type: 'png' });
    return { url: page.url(), png: Buffer.from(png).toString('base64') };
});

app.post('/close', async (request) => {
    const { profile = 'main' } = request.body ?? {};
    await close(profile);
    return { ok: true };
});

for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, async () => {
        await Promise.all([...sessions.keys()].map(close));
        process.exit(0);
    });
}

await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 3000) });
