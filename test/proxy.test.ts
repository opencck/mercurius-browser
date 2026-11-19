import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { pick, startProxy } from '../src/proxy.js';

/** A site on the loopback that the proxy may reach only when its name is allowed. */
async function site() {
    const server = createServer((req, res) => res.end(`hello ${req.headers.host}`));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return server;
}

function get(proxyPort: number, url: string): Promise<{ status: number | undefined; body: string }> {
    return new Promise((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port: proxyPort, path: url, headers: { host: new URL(url).host } }, (res) => {
            let body = '';
            res.on('data', (c: Buffer) => (body += c.toString()));
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', reject);
        req.end();
    });
}

function tunnel(proxyPort: number, target: string): Promise<string> {
    return new Promise((resolve) => {
        const socket = connect(proxyPort, '127.0.0.1', () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
        socket.once('data', (chunk) => {
            socket.destroy();
            resolve(chunk.toString().split('\r\n')[0]);
        });
    });
}

test('the proxy dials the address it checked, and refuses an internal one', async () => {
    const server = await site();
    const port = (server.address() as AddressInfo).port;
    const lookups: string[] = [];
    // the name answers with a public address first and an internal one after: the proxy asks once and keeps the answer
    const answers: Record<string, Array<Array<{ address: string; family: number }>>> = { 'rebind.example': [[{ address: '93.184.216.34', family: 4 }], [{ address: '127.0.0.1', family: 4 }]] };
    const resolve = async (host: string) => {
        lookups.push(host);
        if (host === 'local.test' || host === 'evil.test') {
            return [{ address: '127.0.0.1', family: 4 }];
        }
        return (answers[host] ?? [[{ address: '93.184.216.34', family: 4 }]]).shift() ?? [{ address: '127.0.0.1', family: 4 }];
    };
    const allowed = new Set(['local.test']);
    const proxy = await startProxy({ resolve, allowed: () => allowed });
    try {
        const ok = await get(proxy.port, `http://local.test:${port}/`);
        assert.equal(ok.status, 200);
        assert.equal(ok.body, `hello local.test:${port}`, 'the Host stays the name, the connection goes to the checked address');

        const evil = await get(proxy.port, `http://evil.test:${port}/`);
        assert.equal(evil.status, 403, 'a name that resolves to an internal address is refused');
        assert.match(await tunnel(proxy.port, `evil.test:${port}`), / 403 /, 'and so is a tunnel to it');
        assert.match(await tunnel(proxy.port, `127.0.0.1:${port}`), / 403 /, 'an internal address itself too');
        assert.match(await tunnel(proxy.port, `local.test:${port}`), / 200 /, 'a host the owner allowed is reached');

        lookups.length = 0;
        assert.deepEqual(await pick('rebind.example', resolve, new Set()), { address: '93.184.216.34' });
        assert.deepEqual(lookups, ['rebind.example'], 'one lookup per connection: no second answer to swap in');
    } finally {
        await proxy.close();
        server.close();
    }
});
