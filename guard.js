// Which addresses the browser may load: public ones only. Every request of a page is checked — the page itself,
// its scripts, images, redirects — so a page cannot reach the agent's network, the cloud metadata service or the LAN.
// spec: BRIEF.md#интернет-и-браузер — the browser does not open internal addresses; the check repeats after redirects

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const V4_BLOCKED = [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
    ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
    ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

function v4ToInt(ip) {
    return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

/** IPv6 networks never loaded: unspecified and loopback, discard, benchmarking, ORCHID, documentation, ULA, link- and site-local, multicast. */
const V6_BLOCKED = [
    ['::', 8], ['100::', 64], ['2001:2::', 48], ['2001:20::', 28], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10],
    ['fec0::', 10], ['ff00::', 8],
];
/** IPv4 carried inside IPv6: [network, prefix bits, offset of the four IPv4 bytes]. */
const V6_WRAPS_V4 = [
    ['::ffff:0:0', 96, 12], // mapped
    ['::ffff:0:0:0', 96, 12], // translated
    ['64:ff9b::', 96, 12], // NAT64
    ['64:ff9b:1::', 48, 12], // local NAT64
    ['2002::', 16, 2], // 6to4
];

/**
 * The 16 bytes of an IPv6 address in any spelling (compressed, with a dotted IPv4 tail, with a zone); null — not one.
 * The spelling matters: new URL() turns [::ffff:169.254.169.254] into [::ffff:a9fe:a9fe], so a check of the text misses it.
 */
function v6Bytes(ip) {
    let text = ip.toLowerCase().split('%')[0];
    const dotted = text.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (dotted) {
        const parts = dotted.slice(2).map(Number);
        if (parts.some((part) => part > 255)) {
            return null;
        }
        text = dotted[1] + ((parts[0] << 8) | parts[1]).toString(16) + ':' + ((parts[2] << 8) | parts[3]).toString(16);
    }
    const halves = text.split('::');
    if (halves.length > 2) {
        return null;
    }
    const head = halves[0] === '' ? [] : halves[0].split(':');
    const tail = halves.length === 2 && halves[1] !== '' ? halves[1].split(':') : [];
    const missing = 8 - head.length - tail.length;
    if (halves.length === 1 ? missing !== 0 : missing < 1) {
        return null;
    }
    const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
    const bytes = [];
    for (const group of groups) {
        if (!/^[0-9a-f]{1,4}$/.test(group)) {
            return null;
        }
        const value = parseInt(group, 16);
        bytes.push(value >> 8, value & 255);
    }
    return bytes;
}

function inNetwork(bytes, base, bits) {
    const network = v6Bytes(base);
    for (let bit = 0; bit < bits; bit += 8) {
        const mask = bits - bit >= 8 ? 255 : (255 << (8 - (bits - bit))) & 255;
        if ((bytes[bit >> 3] & mask) !== (network[bit >> 3] & mask)) {
            return false;
        }
    }
    return true;
}

// ref: src/App/Agent/Tool/AddressGuard.php (the guard of the application) — the same networks and the same IPv4 wrappers,
//      so the browser refuses what http_request and web_read refuse
export function isBlockedIp(ip) {
    if (isIP(ip) === 4) {
        const value = v4ToInt(ip);
        return V4_BLOCKED.some(([base, bits]) => {
            const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
            return (value & mask) === (v4ToInt(base) & mask);
        });
    }
    const bytes = v6Bytes(ip);
    if (bytes === null) {
        // not an address this check understands: never loaded
        return true;
    }
    // a wrapped IPv4 address is judged as that IPv4 address
    for (const [base, bits, offset] of V6_WRAPS_V4) {
        if (inNetwork(bytes, base, bits)) {
            return isBlockedIp(bytes.slice(offset, offset + 4).join('.'));
        }
    }
    return V6_BLOCKED.some(([base, bits]) => inNetwork(bytes, base, bits));
}

/**
 * Null when the URL may be loaded, the reason otherwise. A host in `allowed` is one the owner let in for this page.
 * spec: BRIEF.md#подтверждения-и-запреты — internal addresses only with the owner's permission
 */
export async function refusal(url, resolve = lookup, allowed = new Set()) {
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return 'не адрес';
    }
    if (parsed.protocol === 'about:' || parsed.protocol === 'data:' || parsed.protocol === 'blob:') {
        return null;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return `схема ${parsed.protocol} запрещена`;
    }
    const host = parsed.hostname.replace(/^\[|\]$/g, '');
    if (allowed.has(host.toLowerCase())) {
        return null;
    }
    if (isIP(host)) {
        return isBlockedIp(host) ? 'внутренний адрес' : null;
    }
    if (!host.includes('.')) {
        return 'внутреннее имя';
    }
    let addresses;
    try {
        addresses = await resolve(host, { all: true });
    } catch {
        return 'имя не найдено';
    }
    if (addresses.length === 0 || addresses.some((a) => isBlockedIp(a.address))) {
        return 'внутренний адрес';
    }
    return null;
}

/**
 * Why a request is refused while a read-only script runs; null — it may go. Only GET (and HEAD) to the page's own host:
 * a read changes nothing on the site, and nothing read can leave for another site, not even in a query string.
 * spec: BRIEF.md#скрипты-браузера-решение-владельца-2026-11-17
 */
export function readOnlyRefusal(method, url, host) {
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return 'не адрес';
    }
    if (parsed.protocol === 'data:' || parsed.protocol === 'blob:') {
        return null;
    }
    if (method !== 'GET' && method !== 'HEAD') {
        return `скрипт чтения не отправляет ${method}`;
    }
    if (parsed.hostname.toLowerCase() !== host.toLowerCase()) {
        return `скрипт чтения не ходит на ${parsed.hostname}`;
    }
    return null;
}

/** The script file is the body of an async function: it gets args and returns what is given back. */
export function scriptExpression(source, args) {
    return `(async (args) => {\n${source}\n})(${JSON.stringify(args ?? {})})`;
}
