// The browser of the Mercurius agent: one Chromium per profile (its cookies and logins kept on disk), one page per
// profile, a small API for the agent. Every request a page makes is checked by guard.js.
// spec: BRIEF.md#интернет-и-браузер

import Fastify from 'fastify';
import puppeteer from 'puppeteer-core';
import { timingSafeEqual } from 'node:crypto';
import { refusal } from './guard.js';

const TOKEN = process.env.BROWSER_TOKEN ?? '';
const PROFILES_DIR = process.env.PROFILES_DIR ?? '/profiles';
const IDLE_MS = 10 * 60 * 1000;
const NAV_TIMEOUT_MS = 30_000;
const TEXT_MAX = 60_000;
const PROFILE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

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
        page.on('request', async (request) => {
            const reason = await refusal(request.url());
            if (reason === null) {
                request.continue();
            } else {
                request.abort('accessdenied');
            }
        });
        s = { browser, page, timer: null };
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
    const { url, profile = 'main' } = request.body ?? {};
    const reason = await refusal(String(url ?? ''));
    if (reason !== null) {
        return reply.code(403).send({ error: `адрес запрещён: ${reason}` });
    }
    const { page } = await session(profile);
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
