import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { connect, createServer } from 'node:net';
import type { AddressInfo, Server, Socket } from 'node:net';
import { dial, routeFrom } from '../src/upstream.js';
import { startProxy } from '../src/proxy.js';

/** A site that answers with what it was asked. */
async function echo(): Promise<Server> {
    const server = createServer((socket) => socket.on('data', (chunk) => socket.end(`echo:${chunk.toString()}`)));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return server;
}

const port = (server: Server): number => (server.address() as AddressInfo).port;

/** An HTTP proxy that wants Basic credentials and remembers the targets it was asked for. */
async function httpProxy(targets: string[]): Promise<Server> {
    const server = createHttpServer();
    server.on('connect', (req, client: Socket) => {
        if (req.headers['proxy-authorization'] !== `Basic ${Buffer.from('user:pass word').toString('base64')}`) {
            client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
            return;
        }
        targets.push(req.url ?? '');
        const [, p] = (req.url ?? '').split(':');
        const upstream = connect(Number(p), '127.0.0.1', () => {
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            upstream.pipe(client);
            client.pipe(upstream);
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return server;
}

/** A SOCKS5 proxy with a login; it remembers the names it was asked to reach. */
async function socksProxy(targets: string[]): Promise<Server> {
    const server = createServer((client) => {
        let stage = 0;
        client.on('data', function onData(chunk: Buffer) {
            if (stage === 0) {
                stage = 1;
                client.write(Buffer.from([5, 2]));
            } else if (stage === 1) {
                const user = chunk.subarray(2, 2 + chunk[1]).toString();
                const pass = chunk.subarray(3 + chunk[1], 3 + chunk[1] + chunk[2 + chunk[1]]).toString();
                stage = 2;
                client.write(Buffer.from([1, user === 'user' && pass === 'secret' ? 0 : 1]));
            } else {
                client.removeListener('data', onData);
                const name = chunk.subarray(5, 5 + chunk[4]).toString();
                const p = chunk.readUInt16BE(5 + chunk[4]);
                targets.push(`${name}:${p}`);
                const upstream = connect(p, '127.0.0.1', () => {
                    client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
                    upstream.pipe(client);
                    client.pipe(upstream);
                });
            }
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return server;
}

async function say(socket: Socket, text: string): Promise<string> {
    socket.write(text);
    return new Promise((resolve) => {
        let answer = '';
        socket.on('data', (c: Buffer) => (answer += c.toString()));
        socket.on('end', () => resolve(answer));
    });
}

test('a connection goes through an HTTP proxy with its credentials, by name', async () => {
    const site = await echo();
    const targets: string[] = [];
    const proxy = await httpProxy(targets);
    const upstream = new URL(`http://user:pass%20word@127.0.0.1:${port(proxy)}`);
    const socket = await dial('site.example', port(site), upstream);
    // the name goes to the proxy, the proxy of the test dials the loopback
    assert.equal(await say(socket, 'hi'), 'echo:hi');
    assert.deepEqual(targets, [`site.example:${port(site)}`]);
    await assert.rejects(dial('site.example', port(site), new URL(`http://user:wrong@127.0.0.1:${port(proxy)}`)), /407/);
    site.close();
    proxy.close();
});

test('a connection goes through a SOCKS5 proxy with a login, the name resolved on the far side', async () => {
    const site = await echo();
    const targets: string[] = [];
    const proxy = await socksProxy(targets);
    const socket = await dial('far.example', port(site), new URL(`socks5h://user:secret@127.0.0.1:${port(proxy)}`));
    assert.equal(await say(socket, 'hello'), 'echo:hello');
    assert.deepEqual(targets, [`far.example:${port(site)}`]);
    await assert.rejects(dial('far.example', port(site), new URL(`socks5://user:bad@127.0.0.1:${port(proxy)}`)), /credentials/);
    site.close();
    proxy.close();
});

test('the route is VLESS when the installation has it, else the proxy, else directly', () => {
    assert.deepEqual(routeFrom({}), { name: 'direct', upstream: null });
    const proxy = routeFrom({ BROWSER_PROXY: 'socks5://u:p@proxy.example:1080' });
    assert.equal(proxy.name, 'proxy');
    assert.equal(proxy.upstream?.href, 'socks5://u:p@proxy.example:1080');
    const vless = routeFrom({ BROWSER_VIA_VLESS: '1', BROWSER_PROXY: 'http://proxy.example:3128', BROWSER_TOKEN: 'token-0123456789abcdef' });
    assert.equal(vless.name, 'vless', 'VLESS wins over a proxy');
    assert.equal(vless.upstream?.href, 'http://browser:token-0123456789abcdef@vless-proxy:8080/');
    assert.throws(() => routeFrom({ BROWSER_PROXY: 'ftp://proxy.example:21' }), /must be/);
    assert.throws(() => routeFrom({ BROWSER_PROXY: 'http://proxy.example' }), /must be/);
});

test('the guard proxy of a profile goes out through the upstream, and an internal name is still refused', async () => {
    const site = await echo();
    const targets: string[] = [];
    const upstream = await httpProxy(targets);
    const guard = await startProxy({
        allowed: () => new Set(),
        // the local DNS knows nothing of one name and gives an internal address for another
        resolve: async (host) => {
            if (host === 'inside.example') {
                return [{ address: '10.0.0.5', family: 4 }];
            }
            throw new Error('ENOTFOUND');
        },
        upstream: new URL(`http://user:pass%20word@127.0.0.1:${port(upstream)}`),
    });
    const ask = (target: string): Promise<string> => new Promise((resolve) => {
        const socket = connect(guard.port, '127.0.0.1', () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
        socket.once('data', (chunk) => {
            socket.destroy();
            resolve(chunk.toString().split('\r\n')[0]);
        });
    });
    assert.equal(await ask(`unknown-here.example:${port(site)}`), 'HTTP/1.1 200 Connection Established');
    assert.equal(await ask(`inside.example:${port(site)}`), 'HTTP/1.1 403 Forbidden');
    assert.deepEqual(targets, [`unknown-here.example:${port(site)}`]);
    await guard.close();
    site.close();
    upstream.close();
});
