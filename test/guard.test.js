import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBlockedIp, refusal } from '../guard.js';

test('private, loopback, link-local and metadata addresses are blocked', () => {
    for (const ip of ['10.1.2.3', '127.0.0.1', '169.254.169.254', '172.20.0.5', '192.168.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
        assert.equal(isBlockedIp(ip), true, ip);
    }
    for (const ip of ['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111']) {
        assert.equal(isBlockedIp(ip), false, ip);
    }
});

test('urls are judged by scheme, name and every resolved address', async () => {
    const resolve = async (host) => host === 'rebind.example'
        ? [{ address: '93.184.216.34' }, { address: '10.0.0.5' }]
        : [{ address: '93.184.216.34' }];
    assert.equal(await refusal('https://example.com/page', resolve), null);
    assert.equal(await refusal('about:blank', resolve), null);
    assert.match(await refusal('file:///etc/passwd', resolve), /схема/);
    assert.match(await refusal('http://postgres:5432/', resolve), /внутреннее имя/);
    assert.match(await refusal('http://169.254.169.254/latest/meta-data', resolve), /внутренний/);
    assert.match(await refusal('https://rebind.example/', resolve), /внутренний/);
    assert.match(await refusal('http://[::1]:3000/', resolve), /внутренний/);
});

test('a host the owner allowed is let in, and no other', async () => {
    const resolve = async () => [{ address: '192.168.1.10' }];
    const allowed = new Set(['nas.home.lan', '10.0.0.1']);
    assert.equal(await refusal('http://nas.home.lan/', resolve, allowed), null);
    assert.equal(await refusal('http://NAS.home.lan:8080/x', resolve, allowed), null);
    assert.equal(await refusal('http://10.0.0.1/', resolve, allowed), null);
    assert.match(await refusal('http://other.lan/', resolve, allowed), /внутренний/);
    assert.match(await refusal('file:///etc/passwd', resolve, new Set(['etc'])), /схема/);
});
