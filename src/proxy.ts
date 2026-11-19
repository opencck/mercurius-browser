// The browser's only way out: a proxy on the loopback that resolves a name once, checks every address it got and
// dials the checked one. Chromium resolving a name again on its own could get another, internal answer between the
// check and the connection (DNS rebinding); through this proxy there is no second answer to swap in.
// spec: BRIEF.md#решения-по-доработкам-2026-11-18 — the browser connects to the address it checked
// ref: references/hermes-agent/tools/url_safety.py@e96221fa:L1-L10 — hermes re-applies the policy at TCP connect and
//      dials the validated IP for its own HTTP client; here the same for the browser, as a proxy Chromium must use

import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { isIP } from 'node:net';
import type { AddressInfo } from 'node:net';
import { lookup } from 'node:dns/promises';
import { isBlockedIp } from './guard.js';

const CONNECT_TIMEOUT_MS = 15_000;

/** How the proxy resolves a name: every answer, as node:dns lookup with {all: true} gives them. */
export type Resolve = (host: string, options: { all: true }) => Promise<Array<{ address: string; family: number }>>;

/** The proxy on the loopback: its port and how to stop it. */
export interface Proxy {
    port: number;
    close: () => Promise<void>;
}

/**
 * The address to dial for a host, or the reason it is refused. A host the owner allowed may be internal; any other
 * must resolve to public addresses only. One lookup, its first good answer is the one dialed.
 *
 * @param {string} host
 * @param {(host: string, options: object) => Promise<Array<{address: string, family: number}>>} resolve
 * @param {Set<string>} allowed
 * @returns {Promise<{address: string}|{refused: string}>}
 */
export async function pick(host: string, resolve: Resolve, allowed: Set<string>): Promise<{ address: string } | { refused: string }> {
    const name = host.replace(/^\[|\]$/g, '').toLowerCase();
    const permitted = allowed.has(name);
    if (isIP(name)) {
        return permitted || !isBlockedIp(name) ? { address: name } : { refused: 'internal address' };
    }
    if (!name.includes('.') && !permitted) {
        return { refused: 'internal name' };
    }
    let addresses: Array<{ address: string; family: number }>;
    try {
        addresses = await resolve(name, { all: true });
    } catch {
        return { refused: 'name not found' };
    }
    if (addresses.length === 0) {
        return { refused: 'name not found' };
    }
    if (!permitted && addresses.some((a) => isBlockedIp(a.address))) {
        return { refused: 'internal address' };
    }
    return { address: addresses[0].address };
}

/**
 * Starts the proxy on a free port of the loopback.
 *
 * @param {{resolve?: Function, allowed: () => Set<string>}} options allowed — the hosts the owner let in for the page now
 * @returns {Promise<{port: number, close: () => Promise<void>}>}
 */
export async function startProxy({ resolve = lookup, allowed }: { resolve?: Resolve; allowed: () => Set<string> }): Promise<Proxy> {
    const server = createServer(async (req, res) => {
        // plain http: the request names the whole address
        let url: URL;
        try {
            url = new URL(req.url ?? '');
        } catch {
            res.writeHead(400).end();
            return;
        }
        if (url.protocol !== 'http:') {
            res.writeHead(400).end();
            return;
        }
        const target = await pick(url.hostname, resolve, allowed());
        if ('refused' in target) {
            res.writeHead(403, { 'content-type': 'text/plain' }).end(target.refused);
            return;
        }
        const upstream = httpRequest({
            host: target.address,
            port: url.port === '' ? 80 : Number(url.port),
            method: req.method,
            path: url.pathname + url.search,
            headers: { ...req.headers, host: url.host },
            timeout: CONNECT_TIMEOUT_MS,
        }, (answer) => {
            res.writeHead(answer.statusCode ?? 502, answer.headers);
            answer.pipe(res);
        });
        upstream.on('timeout', () => upstream.destroy());
        upstream.on('error', () => {
            if (!res.headersSent) {
                res.writeHead(502).end();
            } else {
                res.destroy();
            }
        });
        req.pipe(upstream);
    });

    // https and websockets: a tunnel to host:port, opened only to the checked address
    server.on('connect', async (req, client, head) => {
        const match = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(req.url ?? '');
        if (match === null) {
            client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
            return;
        }
        const target = await pick(match[1], resolve, allowed());
        if ('refused' in target) {
            client.end(`HTTP/1.1 403 Forbidden\r\n\r\n${target.refused}`);
            return;
        }
        const upstream = connect({ host: target.address, port: Number(match[2]), timeout: CONNECT_TIMEOUT_MS }, () => {
            upstream.setTimeout(0);
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head.length > 0) {
                upstream.write(head);
            }
            upstream.pipe(client);
            client.pipe(upstream);
        });
        upstream.on('timeout', () => upstream.destroy());
        upstream.on('error', () => client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
        client.on('error', () => upstream.destroy());
    });

    // an upgrade over plain http (ws://) is not proxied: a page gets wss through a tunnel
    server.on('upgrade', (req, socket) => socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'));

    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    return {
        port: (server.address() as AddressInfo).port,
        close: () => new Promise<void>((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
        }),
    };
}
