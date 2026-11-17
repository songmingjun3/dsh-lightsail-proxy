/**
 * Build compact offline China-routing data from two upstream text lists.
 * Output is plain JSON so the local proxy bridge can load it without network.
 */
'use strict';

const CHINA_IP_SOURCE = 'https://raw.githubusercontent.com/17mon/china_ip_list/master/china_ip_list.txt';
const CHINA_DOMAINS_SOURCE = 'https://raw.githubusercontent.com/felixonmars/dnsmasq-china-list/master/accelerated-domains.china.conf';

function ipToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    value = (value * 256) + n;
  }
  return value >>> 0;
}

function cidrToRange(line) {
  const [ipText, bitsText] = String(line).trim().split('/');
  const ip = ipToInt(ipText);
  const bits = Number(bitsText);
  if (ip === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const size = bits === 0 ? 0x100000000 : 2 ** (32 - bits);
  const start = Math.floor(ip / size) * size;
  return [start >>> 0, (start + size - 1) >>> 0];
}

function mergeRanges(ranges) {
  ranges.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const range of ranges) {
    const last = out[out.length - 1];
    if (!last || range[0] > last[1] + 1) out.push([range[0], range[1]]);
    else last[1] = Math.max(last[1], range[1]);
  }
  return out;
}

function parseChinaDomains(text) {
  const set = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    // dnsmasq line: server=/example.com/114.114.114.114
    const match = line.match(/^\s*server=\/([^/]+)\//);
    if (!match) continue;
    const domain = match[1].trim().toLowerCase().replace(/^\.+/, '');
    if (!domain || domain.includes('*') || domain.includes('/') || domain.includes(' ')) continue;
    set.add(domain);
  }
  return [...set].sort();
}

function buildRoutes(ipText, domainText) {
  const ranges = [];
  for (const line of String(ipText || '').split(/\r?\n/)) {
    const range = cidrToRange(line);
    if (range) ranges.push(range);
  }
  const domains = parseChinaDomains(domainText);
  return {
    generatedAt: new Date().toISOString(),
    sources: [CHINA_IP_SOURCE, CHINA_DOMAINS_SOURCE],
    chinaRanges: mergeRanges(ranges),
    chinaDomains: domains.join('\n'),
  };
}

function routeCounts(routes) {
  return {
    generatedAt: routes?.generatedAt || null,
    sources: routes?.sources || [],
    chinaRanges: Array.isArray(routes?.chinaRanges) ? routes.chinaRanges.length : 0,
    chinaDomains: typeof routes?.chinaDomains === 'string' && routes.chinaDomains
      ? routes.chinaDomains.split('\n').length
      : 0,
  };
}

module.exports = { CHINA_IP_SOURCE, CHINA_DOMAINS_SOURCE, buildRoutes, routeCounts, ipToInt };
