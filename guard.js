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

export function isBlockedIp(ip) {
    if (isIP(ip) === 4) {
        const value = v4ToInt(ip);
        return V4_BLOCKED.some(([base, bits]) => {
            const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
            return (value & mask) === (v4ToInt(base) & mask);
        });
    }
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') {
        return true;
    }
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) {
        return isBlockedIp(mapped[1]);
    }
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(lower);
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
