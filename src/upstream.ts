// The way out of the browser: directly, or through an upstream proxy — the VLESS tunnel of the installation (its
// vless-proxy beside the browser) or a SOCKS5 / HTTP proxy the owner set. One route for every connection of a profile.
// spec: brief/internet.md#как-сделано-поиск-чтение-и-браузер — the browser leaves through VLESS or a proxy when one is set
// ref: references/amphp-vless/bin/vless-proxy@065417f:L37-L88 (USAGE) — the HTTP door of vless-proxy takes CONNECT with
//      Basic credentials; here its client side, and the same for any HTTP proxy
// ref: docs/notes/amphp-vless.md:L237-L242 — Chrome in a neighbouring container goes out through vless-proxy; the
//      credentials are given by the service's own proxy, since Chrome cannot send them to a SOCKS5 door

import { connect } from 'node:net';
import type { Socket } from 'node:net';

const HANDSHAKE_TIMEOUT_MS = 20_000;
const HEAD_MAX = 16 * 1024;

/** Where the connections of the browser go out: directly, or through a proxy. */
export interface Route {
    /** what the health check and the logs call it: direct, vless, proxy */
    name: 'direct' | 'vless' | 'proxy';
    /** the proxy; null — directly */
    upstream: URL | null;
}

/**
 * The route from the environment: the VLESS tunnel when the installation has one, else the owner's proxy, else
 * directly. A proxy of another scheme stops the start: a typo must not send the browser out directly.
 *
 * @param env BROWSER_VIA_VLESS (non-empty when VLESS_URI is set), BROWSER_VLESS_PROXY (the door of vless-proxy),
 *        BROWSER_TOKEN (sent to the door, which asks for none), BROWSER_PROXY (socks5://, socks5h://, http://, or the
 *        word direct)
 */
export function routeFrom(env: NodeJS.ProcessEnv): Route {
    const proxy = (env.BROWSER_PROXY ?? '').trim();
    // the word direct keeps the browser off every route, the VLESS of the installation too
    if (proxy.toLowerCase() === 'direct') {
        return { name: 'direct', upstream: null };
    }
    if ((env.BROWSER_VIA_VLESS ?? '').trim() !== '') {
        const door = new URL((env.BROWSER_VLESS_PROXY ?? '').trim() || 'http://vless-proxy:8080');
        door.username = 'browser';
        door.password = env.BROWSER_TOKEN ?? '';
        return { name: 'vless', upstream: checked(door) };
    }
    if (proxy !== '') {
        return { name: 'proxy', upstream: checked(new URL(proxy)) };
    }
    return { name: 'direct', upstream: null };
}

function checked(url: URL): URL {
    if (!['http:', 'socks5:', 'socks5h:'].includes(url.protocol) || url.hostname === '' || url.port === '') {
        throw new Error('the proxy of the browser must be http://host:port, socks5://host:port or socks5h://host:port');
    }
    return url;
}

/** A TCP connection to host:port, through the proxy when there is one. */
export async function dial(host: string, port: number, upstream: URL | null, timeoutMs = HANDSHAKE_TIMEOUT_MS): Promise<Socket> {
    if (upstream === null) {
        return open(host, port, timeoutMs);
    }
    const socket = await open(upstream.hostname, Number(upstream.port), timeoutMs);
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error('the proxy did not answer in time')));
    try {
        if (upstream.protocol === 'http:') {
            await httpConnect(socket, host, port, upstream);
        } else {
            await socks5(socket, host, port, upstream);
        }
    } catch (error) {
        socket.destroy();
        throw error;
    }
    socket.setTimeout(0);
    return socket;
}

function open(host: string, port: number, timeoutMs: number): Promise<Socket> {
    return new Promise((resolve, reject) => {
        const socket = connect({ host, port, timeout: timeoutMs }, () => {
            socket.setTimeout(0);
            socket.removeListener('error', reject);
            resolve(socket);
        });
        socket.once('timeout', () => socket.destroy(new Error('the connection timed out')));
        socket.once('error', reject);
    });
}

/** Reads until the predicate says the answer is whole; what came after it is pushed back. */
function readUntil(socket: Socket, whole: (data: Buffer) => number | null): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        let data = Buffer.alloc(0);
        const onData = (chunk: Buffer) => {
            data = Buffer.concat([data, chunk]);
            const end = whole(data);
            if (end !== null) {
                cleanup();
                if (end < data.length) {
                    socket.unshift(data.subarray(end));
                }
                resolve(data.subarray(0, end));
            } else if (data.length > HEAD_MAX) {
                cleanup();
                reject(new Error('the answer of the proxy is too long'));
            }
        };
        const onEnd = () => {
            cleanup();
            reject(new Error('the proxy closed the connection'));
        };
        const onError = (error: Error) => {
            cleanup();
            reject(error);
        };
        const cleanup = () => {
            socket.removeListener('data', onData);
            socket.removeListener('end', onEnd);
            socket.removeListener('error', onError);
        };
        socket.on('data', onData);
        socket.once('end', onEnd);
        socket.once('error', onError);
    });
}

async function httpConnect(socket: Socket, host: string, port: number, upstream: URL): Promise<void> {
    const target = `${host.includes(':') ? `[${host}]` : host}:${port}`;
    let head = `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n`;
    if (upstream.username !== '') {
        const credentials = `${decodeURIComponent(upstream.username)}:${decodeURIComponent(upstream.password)}`;
        head += `Proxy-Authorization: Basic ${Buffer.from(credentials).toString('base64')}\r\n`;
    }
    socket.write(head + '\r\n');
    const answer = await readUntil(socket, (data) => {
        const end = data.indexOf('\r\n\r\n');
        return end === -1 ? null : end + 4;
    });
    const status = /^HTTP\/1\.[01] (\d{3})/.exec(answer.toString('latin1'));
    if (status === null || status[1] !== '200') {
        throw new Error(`the proxy refused the tunnel (${status?.[1] ?? 'no status'})`);
    }
}

async function socks5(socket: Socket, host: string, port: number, upstream: URL): Promise<void> {
    const user = decodeURIComponent(upstream.username);
    const password = decodeURIComponent(upstream.password);
    socket.write(Buffer.from(user !== '' ? [5, 2, 0, 2] : [5, 1, 0]));
    const choice = await readUntil(socket, (data) => (data.length >= 2 ? 2 : null));
    if (choice[0] !== 5 || (choice[1] !== 0 && choice[1] !== 2)) {
        throw new Error('the SOCKS5 proxy offered no way to sign in');
    }
    if (choice[1] === 2) {
        const u = Buffer.from(user);
        const p = Buffer.from(password);
        socket.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
        const auth = await readUntil(socket, (data) => (data.length >= 2 ? 2 : null));
        if (auth[1] !== 0) {
            throw new Error('the SOCKS5 proxy refused the credentials');
        }
    }
    const name = Buffer.from(host);
    socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([port >> 8, port & 0xff])]));
    const reply = await readUntil(socket, (data) => {
        if (data.length < 5) {
            return null;
        }
        const length = data[3] === 1 ? 4 : data[3] === 4 ? 16 : data[3] === 3 ? 1 + data[4] : -1;
        if (length < 0) {
            return 0;
        }
        return data.length >= 4 + length + 2 ? 4 + length + 2 : null;
    });
    if (reply.length < 2 || reply[0] !== 5 || reply[1] !== 0) {
        throw new Error(`the SOCKS5 proxy refused the connection (${reply[1] ?? 'no answer'})`);
    }
}
