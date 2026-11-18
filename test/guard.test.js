import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBlockedIp, readOnlyRefusal, refusal, scriptExpression, typable } from '../guard.js';

test('private, loopback, link-local and metadata addresses are blocked', () => {
    for (const ip of ['10.1.2.3', '127.0.0.1', '169.254.169.254', '172.20.0.5', '192.168.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
        assert.equal(isBlockedIp(ip), true, ip);
    }
    for (const ip of ['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111']) {
        assert.equal(isBlockedIp(ip), false, ip);
    }
});

test('an internal IPv4 address inside an IPv6 wrapper is blocked, in any spelling', async () => {
    // new URL() rewrites [::ffff:169.254.169.254] as [::ffff:a9fe:a9fe]: the dotted form never reaches the check
    const inside = [
        '::ffff:a9fe:a9fe', '::ffff:7f00:1', '::ffff:0:a9fe:a9fe', '64:ff9b::a9fe:a9fe', '64:ff9b::10.0.0.1',
        '2002:a9fe:a9fe::1', '::a9fe:a9fe', '0:0:0:0:0:ffff:127.0.0.1', 'fec0::1', '2001:db8::1', '100::1', '::',
    ];
    for (const ip of inside) {
        assert.equal(isBlockedIp(ip), true, ip);
    }
    for (const ip of ['::ffff:5db8:d822', '64:ff9b::5db8:d822', '2a00:1450:4010:c0b::8a']) {
        assert.equal(isBlockedIp(ip), false, ip);
    }
    const resolve = async () => [{ address: '93.184.216.34' }];
    for (const url of ['http://[::ffff:169.254.169.254]/', 'http://[::ffff:127.0.0.1]/', 'http://[64:ff9b::a9fe:a9fe]/', 'http://[fec0::1]/']) {
        assert.match(await refusal(url, resolve), /внутренний/, url);
    }
    // a name that resolves to a wrapped internal address
    assert.match(await refusal('https://wrapped.example/', async () => [{ address: '::ffff:a00:5' }]), /внутренний/);
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

test('a read-only script reads its own site with GET and sends nothing', () => {
    assert.equal(readOnlyRefusal('GET', 'https://web.telegram.org/k/api/list', 'web.telegram.org'), null);
    assert.equal(readOnlyRefusal('HEAD', 'https://web.telegram.org/x', 'web.telegram.org'), null);
    assert.equal(readOnlyRefusal('GET', 'data:image/png;base64,AAAA', 'web.telegram.org'), null, 'inline data is not sent anywhere');
    assert.match(readOnlyRefusal('POST', 'https://web.telegram.org/api/send', 'web.telegram.org'), /POST/);
    assert.match(readOnlyRefusal('GET', 'https://evil.example/?leak=1', 'web.telegram.org'), /evil\.example/, 'no other site: a query could carry the page away');
    assert.match(readOnlyRefusal('GET', 'https://web.telegram.org.evil.example/', 'web.telegram.org'), /evil/);
    assert.match(readOnlyRefusal('GET', 'not a url', 'web.telegram.org'), /адрес/);
});

test('a script is the body of an async function with its arguments', () => {
    assert.equal(scriptExpression('return args.n + 1;', { n: 41 }), '(async (args) => {\nreturn args.n + 1;\n})({"n":41})');
    assert.equal(scriptExpression('return 1', null), '(async (args) => {\nreturn 1\n})({})');
});

test('typing goes only into text fields, never into what presses something', () => {
    for (const element of [
        { tag: 'INPUT', type: 'text' }, { tag: 'input', type: '' }, { tag: 'input', type: 'password' },
        { tag: 'TEXTAREA' }, { tag: 'div', editable: true },
    ]) {
        assert.equal(typable(element), true, JSON.stringify(element));
    }
    for (const element of [
        { tag: 'BUTTON' }, { tag: 'input', type: 'submit' }, { tag: 'input', type: 'checkbox' }, { tag: 'input', type: 'file' },
        { tag: 'a' }, { tag: 'div' }, { tag: 'input', type: 'text', disabled: true }, { tag: 'textarea', readOnly: true }, null,
    ]) {
        assert.equal(typable(element), false, JSON.stringify(element));
    }
});
