/**
 * Tiny local HTTP CONNECT proxy -> upstream SOCKS5 (ssh -D) or fallback HTTP proxy.
 * Claude Desktop / Claude Code accept HTTP_PROXY/HTTPS_PROXY but not SOCKS5.
 * It listens on loopback only and never terminates TLS.
 */
'use strict';

const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns').promises;

const PAC_FILE = process.env.CLAUDE_PAC_FILE || '';
const ROUTES_FILE = process.env.CLAUDE_ROUTES_FILE || path.join(__dirname, '..', 'data', 'china-routes.json');
const LOCAL_HOST = process.env.CLAUDE_HTTP_HOST || '127.0.0.1';
const LOCAL_PORT = Number(process.env.CLAUDE_HTTP_PORT || 8088);
const SOCKS_HOST = process.env.CLAUDE_SOCKS_HOST || '127.0.0.1';
const SOCKS_PORT = Number(process.env.CLAUDE_SOCKS_PORT || 1080);
const FALLBACK_HOST = process.env.CLAUDE_FALLBACK_HOST || '127.0.0.1';
const FALLBACK_PORT = Number(process.env.CLAUDE_FALLBACK_PORT || 7890);
const MAX_ACTIVE = Number(process.env.CLAUDE_MAX_ACTIVE || 512);
// Hosts that must use the original proxy (e.g. local DNS is poisoned to
// 127.0.0.1). Everything domestic goes DIRECT instead.
const proxyDomains = String(process.env.CLAUDE_PROXY_DOMAINS || '')
  .split(/[\n,;]+/).map(item => item.trim().toLowerCase()).filter(Boolean);
// Exact hosts forced through Lightsail even if the China-route library would
// classify them domestic. Highest priority; exact full-host match only.
const lightsailDomains = String(process.env.CLAUDE_LIGHTSAIL_DOMAINS || '')
  .split(/[\n,;]+/).map(item => item.trim().toLowerCase()).filter(Boolean);

const activeConnections = new Map();
const recentConnections = [];
let nextConnectionId = 1;
let totalOpened = 0;
let totalAbandoned = 0;

function loadRoutes() {
  try {
    const value = JSON.parse(fs.readFileSync(ROUTES_FILE, 'utf8'));
    const domains = new Set(String(value.chinaDomains || '').split('\n').map(item => item.trim().toLowerCase()).filter(Boolean));
    return {
      available: true,
      generatedAt: value.generatedAt || null,
      ranges: Array.isArray(value.chinaRanges) ? value.chinaRanges : [],
      domains,
      domainSuffixes: [...domains],
      status: routeCountsLite(value, domains),
    };
  } catch (error) {
    console.error(`Could not load China routes: ${error.message}`);
    return { available: false, ranges: [], domains: new Set(), domainSuffixes: [], status: { error: error.message } };
  }
}

function routeCountsLite(value, domains) {
  return {
    generatedAt: value.generatedAt || null,
    chinaRanges: Array.isArray(value.chinaRanges) ? value.chinaRanges.length : 0,
    chinaDomains: domains.size,
  };
}

const routes = loadRoutes();
const exclusionRules = String(process.env.CLAUDE_EXCLUDE_RULES || '')
  .split(/[\n,;]+/)
  .map(item => item.trim().toLowerCase())
  .filter(Boolean);
const localRules = ['localhost', '.local', '127.*', '10.*', '172.16.*', '172.17.*', '172.18.*', '172.19.*', '172.2*', '172.30.*', '172.31.*', '192.168.*', '<local>'];

function ruleMatches(host, rule) {
  if (!rule) return false;
  if (rule === '<local>') return !host.includes('.');
  if (rule.startsWith('.')) return host === rule.slice(1) || host.endsWith(rule);
  if (rule.includes('*')) {
    const re = new RegExp(`^${rule.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    return re.test(host);
  }
  return host === rule || host.endsWith(`.${rule}`);
}

function isLocal(host) {
  return localRules.some(rule => ruleMatches(host, rule));
}

function isExcluded(host) {
  return exclusionRules.some(rule => ruleMatches(host, rule));
}

function domainInChina(host) {
  if (!routes.available) return false;
  if (routes.domains.has(host)) return true;
  const labels = host.split('.');
  for (let i = 1; i < labels.length; i += 1) {
    if (routes.domains.has(labels.slice(i).join('.'))) return true;
  }
  return false;
}

function ipToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    value = value * 256 + n;
  }
  return value >>> 0;
}

function ipInChina(ip) {
  const value = ipToInt(ip);
  if (value === null || !routes.ranges.length) return false;
  let left = 0;
  let right = routes.ranges.length - 1;
  while (left <= right) {
    const mid = (left + right) >> 1;
    const range = routes.ranges[mid];
    if (value < range[0]) right = mid - 1;
    else if (value > range[1]) left = mid + 1;
    else return true;
  }
  return false;
}

/**
 * Returns 'proxy' | 'lightsail' | 'direct'.
 *  - proxy     : explicit proxyDomains (local DNS is unusable), via original proxy
 *  - direct    : domestic domains/IPs and user exclusions, direct TCP
 *  - lightsail : everything else
 */
async function routeFor(host) {
  const lower = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!lower || isLocal(lower)) return 'direct';
  // Exact hosts pinned to Lightsail, highest priority (e.g. WAF/captcha
  // endpoints that must share the main site's egress IP).
  if (lightsailDomains.includes(lower)) return 'lightsail';
  // Explicitly force through the original proxy even if it looks domestic.
  if (proxyDomains.some(rule => ruleMatches(lower, rule))) return 'proxy';
  if (isExcluded(lower) || domainInChina(lower)) return 'direct';
  if (net.isIP(lower) === 4 && ipInChina(lower)) return 'direct';
  if (net.isIP(lower)) return 'lightsail';
  try {
    const answers = await dns.lookup(lower, { family: 4, all: true, verbatim: true });
    if (answers.length && answers.every(answer => ipInChina(answer.address))) return 'direct';
  } catch { /* DNS failed: fall through to Lightsail */ }
  return 'lightsail';
}

function encodeTarget(host, port) {
  let atyp;
  let address;
  if (net.isIP(host) === 4) {
    atyp = 1;
    address = Buffer.from(host.split('.').map(part => Number(part) & 255));
  } else if (net.isIP(host) === 6) {
    atyp = 4;
    address = Buffer.from(host.replace(/^\[|\]$/g, '').split(':').map(part => {
      const value = Number.parseInt(part || '0', 16);
      return [value >> 8, value & 255];
    }).flat());
  } else {
    const encoded = Buffer.from(host, 'ascii');
    if (encoded.length > 255) throw new Error('hostname too long');
    atyp = 3;
    address = Buffer.concat([Buffer.from([encoded.length]), encoded]);
  }
  const portBytes = Buffer.alloc(2);
  portBytes.writeUInt16BE(port, 0);
  return Buffer.concat([Buffer.from([5, 1, 0, atyp]), address, portBytes]);
}

function socksReplyLength(buffer) {
  if (buffer.length < 4) return null;
  if (buffer[0] !== 5) return { error: 'bad SOCKS5 version' };
  if (buffer[1] !== 0) return { error: `SOCKS5 CONNECT rejected (${buffer[1]})` };
  const atyp = buffer[3];
  if (atyp === 1) return 4 + 4 + 2;
  if (atyp === 3) return buffer.length >= 5 ? 4 + 1 + buffer[4] + 2 : null;
  if (atyp === 4) return 4 + 16 + 2;
  return { error: `unsupported SOCKS5 ATYP ${atyp}` };
}

/**
 * Both upstream helpers return a controller with abandon() so the caller can
 * always destroy the in-flight socket, even during the handshake. This is the
 * fix for the file-descriptor leak: previously the internal socket was not
 * reachable by the outer close() until onReady fired.
 */
/**
 * Direct TCP connection (domestic targets). Mirrors the controller interface
 * of openSocks/openFallback so the caller treats all three routes uniformly.
 */
function openDirect(host, port, firstChunk, onReady, onFail) {
  const upstream = net.createConnection({ host, port });
  let ended = false;
  let established = false;
  const abandon = () => {
    if (ended) return;
    ended = true;
    try { upstream.destroy(); } catch { /* already closed */ }
  };
  const fail = error => {
    if (ended) return;
    ended = true;
    try { upstream.destroy(); } catch { /* already closed */ }
    onFail(error);
  };
  upstream.once('error', fail);
  upstream.once('connect', () => {
    if (ended) return;
    upstream.removeListener('error', fail);
    upstream.on('error', fail);
    upstream.setNoDelay(true);
    established = true;
    // setTimeout is an idle timer; clear it once the tunnel is established so
    // long-lived connections are not reaped after 30s of inactivity.
    upstream.setTimeout(0);
    onReady(upstream, firstChunk || Buffer.alloc(0));
  });
  upstream.setTimeout(30000, () => fail(new Error('direct connect timeout')));
  return {
    socket: upstream,
    abandon,
    write: data => { if (!ended && established) upstream.write(data); },
  };
}

function openFallback(host, port, firstChunk, onReady, onFail) {
  const upstream = net.createConnection({ host: FALLBACK_HOST, port: FALLBACK_PORT });
  let ended = false;
  let established = false;
  const abandon = () => {
    if (ended) return;
    ended = true;
    try { upstream.destroy(); } catch { /* already closed */ }
  };
  const fail = error => {
    if (ended) return;
    ended = true;
    try { upstream.destroy(); } catch { /* already closed */ }
    onFail(error);
  };
  upstream.once('error', fail);
  upstream.once('connect', () => {
    if (ended) return;
    upstream.removeListener('error', fail);
    upstream.on('error', fail);
    upstream.setNoDelay(true);
    const request = `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\nProxy-Connection: Keep-Alive\r\n\r\n`;
    upstream.write(request);
    let response = Buffer.alloc(0);
    const onData = chunk => {
      if (ended) return;
      response = Buffer.concat([response, chunk]);
      const end = response.indexOf('\r\n\r\n');
      if (end < 0) {
        if (response.length > 65536) fail(new Error('fallback proxy response too large'));
        return;
      }
      const status = response.subarray(0, end).toString('latin1').split('\r\n')[0] || '';
      if (!/^HTTP\/1\.[01]\s+2\d\d\b/i.test(status)) {
        fail(new Error(`fallback proxy rejected CONNECT: ${status.trim()}`));
        return;
      }
      upstream.removeListener('data', onData);
      established = true;
      // Handshake done: stop treating tunnel idle time as a connect timeout.
      upstream.setTimeout(0);
      const early = response.subarray(end + 4);
      upstream.pause();
      onReady(upstream, Buffer.concat([early, firstChunk || Buffer.alloc(0)]));
    };
    upstream.on('data', onData);
  });
  upstream.setTimeout(45000, () => fail(new Error('fallback proxy CONNECT timeout')));
  return {
    socket: upstream,
    abandon,
    write: data => { if (!ended && established) upstream.write(data); },
  };
}

function openSocks(host, port, firstChunk, onReady, onFail) {
  const upstream = net.createConnection({ host: SOCKS_HOST, port: SOCKS_PORT });
  upstream.setNoDelay(true);
  let handshake = Buffer.alloc(0);
  let sentConnect = false;
  let established = false;
  let pending = Buffer.alloc(0);
  let ended = false;
  const abandon = () => {
    if (ended) return;
    ended = true;
    try { upstream.destroy(); } catch { /* already closed */ }
  };
  const fail = error => {
    if (ended) return;
    ended = true;
    try { upstream.destroy(); } catch { /* already closed */ }
    onFail(error);
  };

  upstream.on('error', error => fail(error));
  upstream.on('data', chunk => {
    if (ended || established) return;
    handshake = Buffer.concat([handshake, chunk]);
    if (!sentConnect) {
      if (handshake.length < 2) return;
      if (handshake[0] !== 5 || handshake[1] !== 0) return fail(new Error('bad SOCKS5 greeting'));
      handshake = handshake.subarray(2);
      sentConnect = true;
      try { upstream.write(encodeTarget(host, port)); }
      catch (error) { return fail(error); }
    }
    const total = socksReplyLength(handshake);
    if (total && total.error) return fail(new Error(total.error));
    if (total === null || handshake.length < total) return;
    established = true;
    upstream.removeAllListeners('data');
    // Clear the handshake idle timer; established tunnels may idle freely.
    upstream.setTimeout(0);
    const rest = handshake.subarray(total);
    upstream.pause();
    onReady(upstream, Buffer.concat([rest, pending]));
  });
  upstream.once('connect', () => {
    if (ended) return;
    upstream.write(Buffer.from([5, 1, 0]));
    if (firstChunk?.length) pending = Buffer.concat([pending, firstChunk]);
  });
  upstream.setTimeout(45000, () => fail(new Error('SOCKS5 handshake timeout')));
  return {
    socket: upstream,
    abandon,
    write: data => {
      if (ended) return;
      if (established) upstream.write(data);
      else pending = Buffer.concat([pending, data]);
    },
  };
}

function publicConnection(conn, now = Date.now()) {
  return {
    id: conn.id,
    host: conn.host,
    port: conn.port,
    kind: conn.kind,
    state: conn.state,
    startedAt: new Date(conn.startedAt).toISOString(),
    durationMs: Math.max(0, now - conn.startedAt),
    localAddress: conn.localAddress,
    localPort: conn.localPort,
    upstream: conn.upstream || null,
    bytesIn: conn.bytesIn,
    bytesOut: conn.bytesOut,
  };
}

function badRequest(socket, message) {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 400 Bad Request\r\nContent-Length: ${Buffer.byteLength(message)}\r\nConnection: close\r\n\r\n${message}`);
}

function tooMany(socket) {
  if (socket.destroyed) return;
  socket.end('HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
}

const server = net.createServer(client => {
  client.setNoDelay(true);
  let buffer = Buffer.alloc(0);
  let settled = false;
  let cancelled = false;
  let controller = null; // { abandon, write, socket }
  let finishConnection = null;

  const close = () => {
    cancelled = true;
    try { controller?.abandon(); } catch { /* best effort */ }
    try { client.destroy(); } catch { /* already closed */ }
  };
  client.on('error', () => close());
  client.on('close', () => {
    cancelled = true;
    try { finishConnection?.('closed'); } catch { /* best effort */ }
    try { controller?.abandon(); } catch { /* best effort */ }
  });

  client.on('data', chunk => {
    if (settled) return;
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > 65536) { settled = true; return badRequest(client, 'Request line too large'); }
    const end = buffer.indexOf('\r\n\r\n');
    if (end < 0) return;
    settled = true;
    const head = buffer.subarray(0, end).toString('latin1');
    const lines = head.split('\r\n');
    const request = lines[0] || '';
    const carry = buffer.subarray(end + 4);

    const fail = error => {
      const message = `SOCKS5 bridge failed: ${error.message}`;
      if (!client.destroyed) {
        client.end(`HTTP/1.1 502 Bad Gateway\r\nContent-Length: ${Buffer.byteLength(message)}\r\nConnection: close\r\n\r\n${message}`);
      }
      close();
    };

    const connectionsMatch = request.match(/^GET\s+(?:http:\/\/[^/\s]+)?\/__lightsail\/connections(?:\?[^\s]*)?\s+HTTP\/1\.\d$/i);
    if (connectionsMatch) {
      const now = Date.now();
      const body = Buffer.from(JSON.stringify({
        now: new Date(now).toISOString(),
        routing: { ...routes.status, exclusions: exclusionRules, proxyDomains, lightsailDomains, fallback: `${FALLBACK_HOST}:${FALLBACK_PORT}`, maxActive: MAX_ACTIVE },
        active: [...activeConnections.values()].map(conn => publicConnection(conn, now)),
        recent: recentConnections.slice(-30).reverse(),
        counts: { active: activeConnections.size, recent: recentConnections.length, totalOpened, totalAbandoned },
      }, null, 2));
      client.end(Buffer.concat([
        Buffer.from(`HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`, 'ascii'),
        body,
      ]));
      return;
    }

    const pacMatch = request.match(/^GET\s+(?:http:\/\/[^/\s]+)?\/lightsail\.pac(?:\?[^\s]*)?\s+HTTP\/1\.\d$/i);
    if (pacMatch) {
      try {
        const pac = PAC_FILE && fs.existsSync(PAC_FILE) ? fs.readFileSync(PAC_FILE) : Buffer.from('function FindProxyForURL(){return "DIRECT";}');
        client.end(Buffer.concat([
          Buffer.from(`HTTP/1.1 200 OK\r\nContent-Type: application/x-ns-proxy-autoconfig; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: ${pac.length}\r\nConnection: close\r\n\r\n`, 'ascii'),
          pac,
        ]));
      } catch {
        client.end('HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      }
      return;
    }

    const connectMatch = request.match(/^CONNECT\s+(\S+)\s+HTTP\/1\.\d$/i);
    let host;
    let port;
    let plainHttp = null;
    if (connectMatch) {
      const target = connectMatch[1];
      if (target.startsWith('[')) {
        const m = target.match(/^\[([^\]]+)\]:(\d+)$/);
        if (!m) return badRequest(client, 'Invalid CONNECT target');
        host = m[1];
        port = Number(m[2]);
      } else {
        const at = target.lastIndexOf(':');
        if (at < 1) return badRequest(client, 'Invalid CONNECT target');
        host = target.slice(0, at);
        port = Number(target.slice(at + 1));
      }
    } else {
      const m = request.match(/^([A-Z]+)\s+http:\/\/([^/\s]+)(\/\S*)?\s+HTTP\/1\.\d$/i);
      if (!m) return badRequest(client, 'Only HTTP proxy requests are supported');
      const authority = m[2];
      const at = authority.startsWith('[') ? authority.lastIndexOf(']:') : authority.lastIndexOf(':');
      if (at > 0) {
        host = authority.slice(authority.startsWith('[') && at === authority.length - 2 ? 1 : 0, at);
        port = Number(authority.slice(at + 1));
      } else {
        host = authority.replace(/^\[|\]$/g, '');
        port = 80;
      }
      const path = m[3] || '/';
      const rewritten = [`${m[1]} ${path} HTTP/1.1`, ...lines.slice(1)].join('\r\n') + '\r\n\r\n';
      plainHttp = Buffer.from(rewritten, 'latin1');
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) return badRequest(client, 'Invalid port');

    // Hard cap: refuse new tunnels instead of exhausting file descriptors.
    if (activeConnections.size >= MAX_ACTIVE) {
      return tooMany(client);
    }

    const conn = {
      id: nextConnectionId++,
      host,
      port,
      kind: connectMatch ? 'CONNECT' : 'HTTP',
      state: 'connecting',
      startedAt: Date.now(),
      localAddress: client.remoteAddress || null,
      localPort: client.remotePort || null,
      bytesIn: 0,
      bytesOut: 0,
      endedAt: null,
      error: null,
    };
    conn.bytesIn += buffer.length;
    activeConnections.set(conn.id, conn);
    totalOpened += 1;

    const finish = (state, error = null) => {
      if (!activeConnections.has(conn.id)) return;
      conn.state = state;
      conn.endedAt = Date.now();
      conn.error = error;
      activeConnections.delete(conn.id);
      const snapshot = publicConnection(conn, conn.endedAt);
      snapshot.endedAt = new Date(conn.endedAt).toISOString();
      snapshot.finalState = state;
      snapshot.error = error;
      recentConnections.push(snapshot);
      while (recentConnections.length > 30) recentConnections.shift();
    };
    finishConnection = finish;

    const firstChunk = connectMatch ? carry : Buffer.alloc(0);
    const onUpstreamError = error => {
      finish('failed', error?.message || String(error));
      fail(error);
    };
    const establishUpstream = (socket, early, mode) => {
      if (cancelled) {
        conn.upstream = mode;
        try { controller?.abandon(); } catch { /* best effort */ }
        finish('closed');
        return;
      }
      conn.state = 'established';
      conn.mode = mode;
      conn.upstream = mode;
      socket.on('error', error => { conn.error = error.message; close(); });
      socket.on('close', () => { try { client.destroy(); } catch { /* already closed */ } });
      client.on('data', chunk => {
        conn.bytesIn += chunk.length;
        try { controller?.write(chunk); } catch { close(); }
      });
      socket.on('data', chunk => { conn.bytesOut += chunk.length; client.write(chunk); });
      client.on('close', () => finish('closed'));
      if (connectMatch) {
        try { client.write('HTTP/1.1 200 Connection established\r\n\r\n'); }
        catch { close(); return; }
        if (early.length) { conn.bytesOut += early.length; client.write(early); }
      } else {
        socket.write(plainHttp);
        conn.bytesIn += plainHttp.length;
        if (carry.length) socket.write(carry);
      }
      socket.resume();
    };
    void (async () => {
      try {
        const route = await routeFor(host);
        // Client may have gone away during DNS lookup: never create a socket.
        if (cancelled) { finish('closed'); return; }
        conn.upstream = route === 'proxy' ? 'fallback' : route === 'direct' ? 'direct' : 'lightsail';
        const opener = route === 'proxy' ? openFallback : route === 'direct' ? openDirect : openSocks;
        controller = opener(host, port, firstChunk, (socket, early) => establishUpstream(socket, early, conn.upstream), onUpstreamError);
        if (cancelled) { controller.abandon(); totalAbandoned += 1; finish('closed'); }
      } catch (error) {
        onUpstreamError(error);
      }
    })();
  });
});

server.on('error', error => {
  console.error(`HTTP-SOCKS bridge listener error: ${error.message}`);
  process.exitCode = 1;
});
// Detect fd exhaustion early and exit so the host watchdog can rebuild the
// process. Continuing to accept with no descriptors available produced tens of
// thousands of "Too many open files" errors without ever recovering.
setInterval(() => {
  if (activeConnections.size > MAX_ACTIVE) {
    console.error(`Active connection limit exceeded (${activeConnections.size} > ${MAX_ACTIVE}); exiting for supervisor restart`);
    process.exit(1);
  }
}, 5000).unref();

server.listen(LOCAL_PORT, LOCAL_HOST, () => {
  console.log(`HTTP CONNECT ${LOCAL_HOST}:${LOCAL_PORT} -> SOCKS5 ${SOCKS_HOST}:${SOCKS_PORT} (maxActive=${MAX_ACTIVE})`);
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
