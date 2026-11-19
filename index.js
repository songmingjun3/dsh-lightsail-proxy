/**
 * Claude Lightsail proxy — DeepSeek Harness Host plugin.
 *
 * Keeps the Windows system proxy pointed at a local HTTP CONNECT bridge:
 *   127.0.0.1:8088 -> SOCKS5 127.0.0.1:1080 -> ssh -D -> Lightsail -> target
 * A PAC file adds direct-connect exclusions so chosen domains bypass Lightsail.
 * The system proxy never points at Lightsail or CloudFront directly.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import tls from 'node:tls';
import { performance } from 'node:perf_hooks';
import { execFile, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const localRequire = createRequire(import.meta.url);
const { defineTool } = localRequire('./lib/tool.cjs');

const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_MODULE_PATH = path.join(PACKAGE_DIR, 'lib', 'config.cjs');

// Reload lib/config.cjs in-process when it changes. Without this, plugin
// reloads keep Node's require cache and keep using an old Config implementation
// until the whole DSH process restarts.
let configSnapshot = null;
let configModuleMtimeMs = 0;
function configModule() {
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(CONFIG_MODULE_PATH).mtimeMs; } catch { /* keep last snapshot */ }
  if (!configSnapshot || mtimeMs !== configModuleMtimeMs) {
    delete localRequire.cache[localRequire.resolve(CONFIG_MODULE_PATH)];
    configSnapshot = localRequire(CONFIG_MODULE_PATH);
    configModuleMtimeMs = mtimeMs;
  }
  return configSnapshot;
}

// Export the real Config function object so its Standard Schema metadata
// (`~standard`, `.dict`, etc.) stays intact for DSH's config validation.
// Internal value normalization uses configModule().Config below so updated
// defaults/logic take effect without a DSH restart.
const Config = configModule().Config;
export { Config };
export const name = 'claude-lightsail-proxy';
export const inject = ['timer'];
const BRIDGE_SCRIPT = path.join(PACKAGE_DIR, 'lib', 'http-socks-bridge.cjs');
const STATE_DIR = path.join(os.homedir(), '.dsh', 'claude-ec2');
const CONFIG_FILE = path.join(STATE_DIR, 'config.json');
const LOG_FILE = path.join(STATE_DIR, 'plugin.log');
const PAC_FILE = path.join(STATE_DIR, 'lightsail.pac');
const PROXY_BACKUP = path.join(STATE_DIR, 'system-proxy.backup.json');
const ACTIVE_MARKER = path.join(STATE_DIR, 'lightsail.active');
const API_PREFIX = '/api/claude-ec2';
const PID_FILES = {
  ssh: path.join(STATE_DIR, 'ssh.pid'),
  bridge: path.join(STATE_DIR, 'bridge.pid'),
};

function errorOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function ensureState() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

function atomicWriteJson(file, value) {
  ensureState();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return {}; }
}

function appendLog(message) {
  try {
    ensureState();
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${String(message).replace(/\r?\n/g, ' | ')}\n`, 'utf8');
  } catch { /* logging is best effort */ }
}

function writePid(kind, pid) {
  ensureState();
  if (pid && Number.isInteger(pid)) fs.writeFileSync(PID_FILES[kind], String(pid), 'ascii');
}

function readPid(kind) {
  try {
    const pid = Number.parseInt(fs.readFileSync(PID_FILES[kind], 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}

function clearPid(kind) {
  try { fs.rmSync(PID_FILES[kind], { force: true }); } catch { /* best effort */ }
}

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error && error.code === 'EPERM'; }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function runCapture(command, args, timeout = 30000) {
  return new Promise(resolve => {
    execFile(command, args, { timeout, windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = typeof error?.code === 'number' ? error.code : (error ? 1 : 0);
      resolve({ code, out: String(stdout ?? ''), err: String(stderr ?? '') });
    });
  });
}

function portOpen(host, port, timeout = 800) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port });
    let done = false;
    const settle = value => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch { /* already closed */ }
      resolve(value);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));
    socket.once('error', () => settle(false));
  });
}

async function waitForPort(host, port, pid, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await portOpen(host, port, 500)) return true;
    if (pid && !isAlive(pid)) return false;
    await sleep(250);
  }
  return false;
}

function resolveNodeBinary() {
  const candidates = [];
  const roots = [
    path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'dsh-runtimes'),
    path.join(os.homedir(), '.dsh', 'dsh-runtimes'),
  ];
  for (const root of new Set(roots)) {
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        candidates.push(path.join(root, entry.name, 'dependencies', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node'));
      }
    } catch { /* runtime tree may be absent */ }
  }
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
    if (base) candidates.push(path.join(base, 'nodejs', process.platform === 'win32' ? 'node.exe' : 'node'));
  }
  for (const candidate of candidates) {
    try { if (fs.existsSync(candidate)) return candidate; } catch { /* keep looking */ }
  }
  return process.execPath;
}

const NODE_BINARY = resolveNodeBinary();

function spawnDetached(command, args, options = {}) {
  ensureState();
  const logFd = fs.openSync(LOG_FILE, 'a');
  try {
    const child = spawn(command, args, {
      cwd: STATE_DIR,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      windowsHide: options.windowsHide !== false,
      env: { ...process.env, ...(options.env || {}) },
    });
    child.on('error', error => appendLog(`spawn error (${path.basename(command)}): ${errorOf(error)}`));
    child.unref();
    return child.pid ?? null;
  } finally {
    fs.closeSync(logFd);
  }
}

async function killPid(pid) {
  if (!isAlive(pid)) return false;
  if (process.platform === 'win32') {
    const result = await runCapture('taskkill.exe', ['/PID', String(pid), '/T', '/F'], 10000);
    if (result.code === 0) return true;
  }
  try { process.kill(pid, 'SIGTERM'); return true; }
  catch { return false; }
}

async function listenerOwner(port) {
  if (process.platform !== 'win32') return null;
  const netstat = await runCapture('netstat.exe', ['-ano', '-p', 'tcp'], 10000);
  if (netstat.code !== 0) return null;
  for (const line of netstat.out.split(/\r?\n/)) {
    const match = line.trim().match(/^TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i);
    if (!match) continue;
    if (Number(match[2]) !== Number(port)) continue;
    const owner = Number(match[3]);
    if (Number.isInteger(owner) && owner > 0) return owner;
  }
  return null;
}

async function processCommand(pid) {
  if (!pid || process.platform !== 'win32') return '';
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const encoded = Buffer.from(`(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue).CommandLine`, 'utf16le').toString('base64');
  const result = await runCapture(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], 8000);
  return result.out.trim();
}

async function adoptOwnedListener(kind, host, port, settings) {
  const owner = await listenerOwner(port);
  if (!owner) return null;
  const command = await processCommand(owner);
  const lower = String(command || '').toLowerCase();
  const ours = kind === 'ssh'
    ? lower.includes('ssh.exe') && lower.includes(`-d ${String(settings.socksHost).toLowerCase()}:${settings.socksPort}`) && lower.includes(String(settings.ec2Host).toLowerCase())
    : lower.includes('http-socks-bridge.cjs');
  if (!ours) return null;
  writePid(kind, owner);
  appendLog(`adopted existing ${kind} listener: pid=${owner}`);
  return owner;
}

async function readSystemProxyFull() {
  if (process.platform !== 'win32') return null;
  const reg = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
  const result = await runCapture(reg, ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], 8000);
  if (result.code !== 0) return null;
  const value = name => {
    const match = result.out.match(new RegExp(`^\\s*${name}\\s+REG_(?:SZ|DWORD)\\s+(.+)$`, 'im'));
    return match ? match[1].trim() : null;
  };
  return {
    proxyEnable: value('ProxyEnable'),
    proxyServer: value('ProxyServer'),
    autoConfigUrl: value('AutoConfigURL'),
    proxyOverride: value('ProxyOverride'),
  };
}

async function writeSystemProxy(values) {
  if (process.platform !== 'win32') return;
  const reg = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
  const set = async (name, value, type = 'REG_SZ') => {
    if (value === null || value === undefined) {
      await runCapture(reg, ['delete', key, '/v', name, '/f'], 8000);
    } else {
      const result = await runCapture(reg, ['add', key, '/v', name, '/t', type, '/d', String(value), '/f'], 8000);
      if (result.code !== 0) throw new Error(`Could not set ${name}: ${result.err || result.out}`);
    }
  };
  // Clearing AutoConfigURL first makes WinHTTP drop its cached PAC; writing the
  // new versioned URL then forces a fresh download after exclusion changes.
  if (values.autoConfigUrl) {
    await runCapture(reg, ['delete', key, '/v', 'AutoConfigURL', '/f'], 8000);
    await sleep(150);
  }
  await set('ProxyEnable', values.proxyEnable ?? '1', 'REG_DWORD');
  await set('ProxyServer', values.proxyServer);
  await set('AutoConfigURL', values.autoConfigUrl);
  await set('ProxyOverride', values.proxyOverride);
}

function hostMatches(host, rule) {
  if (!rule) return false;
  if (rule.startsWith('*.')) {
    const suffix = rule.slice(1);
    return host === suffix.slice(1) || host.endsWith(suffix);
  }
  if (rule.includes('*')) {
    const escaped = rule.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`).test(host);
  }
  return host === rule || host.endsWith(`.${rule}`);
}

function ipMatches(host, rule) {
  if (!net.isIP(host) || !rule) return false;
  if (rule.endsWith('.*')) return host.startsWith(rule.slice(0, -1));
  return host === rule;
}

function compileExclusions(settings) {
  return {
    domains: configModule().splitRules(settings.excludeDomains),
    suffixes: configModule().splitRules(settings.excludeSuffixes),
    ips: configModule().splitRules(settings.excludeIps),
  };
}

/**
 * Windows' manual proxy cannot express per-host rules; a PAC file can.
 *
 * Two layers:
 *  1. Claude/Anthropic hosts are ALWAYS pinned to the local bridge (8088).
 *     If the bridge is down they fail hard instead of leaking to another
 *     egress, so the Claude IP never drifts.
 *  2. Everything else follows `defaultProxy` — the bridge while the permanent
 *     proxy is enabled, or the configured fallback proxy after it is turned off.
 * Loopback/LAN is always DIRECT.
 */
function renderPac(settings, options = {}) {
  const bridge = `${settings.proxyHost}:${settings.proxyPort}`;
  const claudeProxy = `PROXY ${bridge}`;
  const rawDefault = options.defaultProxy || bridge;
  // "DIRECT" is a bare PAC keyword; anything else needs the PROXY prefix.
  const defaultReturn = rawDefault === 'DIRECT' ? 'DIRECT' : `PROXY ${rawDefault}`;
  const claudeRules = configModule().splitRules(settings.claudeDomains || '');
  const directRules = ['localhost', '<local>', '127.*', '10.*', '172.16.*', '172.17.*', '172.18.*', '172.19.*', '172.2*', '172.30.*', '172.31.*', '192.168.*', '.local'];
  return `// Generated by dsh-claude-ec2.
// Claude hosts -> ${claudeProxy} (fail-closed, pinned)
// Other hosts  -> ${defaultReturn}
// Loopback/LAN -> DIRECT
function FindProxyForURL(url, host) {
  host = host.toLowerCase();
  function match(pattern) {
    if (!pattern) return false;
    if (pattern === '<local>') return host.indexOf('.') === -1;
    if (pattern.charAt(0) === '.') return host.slice(-pattern.length) === pattern;
    if (pattern.indexOf('*') >= 0) {
      var re = new RegExp('^' + pattern.replace(/[.+?^\${}()|[\\]\\\\]/g, '\\\\$&').replace(/\\*/g, '.*') + '$');
      return re.test(host);
    }
    return host === pattern || host.slice(-(pattern.length + 1)) === '.' + pattern;
  }
  var direct = ${JSON.stringify(directRules)};
  var claude = ${JSON.stringify(claudeRules)};
  var i;
  for (i = 0; i < direct.length; i++) if (match(direct[i])) return "DIRECT";
  for (i = 0; i < claude.length; i++) if (match(claude[i])) return "${claudeProxy}";
  return "${defaultReturn}";
}
`;
}

let pacVersion = 1;

function localPacUrl(s) {
  // The local HTTP bridge serves the PAC from its own loopback listener so the
  // rules keep working even when the DSH Web GUI is closed. A version query
  // forces Windows to drop its cached PAC after settings are saved.
  return `http://${s.proxyHost}:${s.proxyPort}/lightsail.pac?v=${pacVersion}`;
}

function validatePaths(settings) {
  if (!fs.existsSync(settings.keyPath)) throw new Error(`SSH key not found: ${settings.keyPath}`);
}

function sshArgs(settings) {
  return [
    '-N',
    '-D', `${settings.socksHost}:${settings.socksPort}`,
    '-p', String(settings.ec2Port),
    '-i', settings.keyPath,
    '-o', 'IdentitiesOnly=yes',
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `HostKeyAlias=${settings.ec2Host}`,
    '-o', 'ConnectTimeout=15',
    `${settings.ec2User}@${settings.ec2Host}`,
  ];
}

function createService(ctx, config) {
  const settings = () => {
    const live = key => {
      const field = config[key];
      const value = typeof field?.get === 'function' ? field.get() : field;
      return value === undefined || value === null || value === '' ? configModule().DEFAULTS[key] : value;
    };
    const persisted = Object.fromEntries(configModule().KEYS.map(key => [key, live(key)]));
    return configModule().Config({ ...persisted, ...readJson(CONFIG_FILE) });
  };

  let blocked = false;
  let blockedReason = null;
  let watchdog = null;
  let guardFailures = 0;
  let egressCache = { at: 0, value: null };

  function assertNotBlocked() {
    if (blocked) throw new Error(`Lightsail proxy is blocked: ${blockedReason || 'tunnel unavailable'}. Restart the tunnel before use.`);
  }

  async function saveSettings(patch = {}) {
    const current = settings();
    const submitted = {};
    for (const key of configModule().KEYS) if (patch[key] !== undefined) submitted[key] = patch[key];
    const validated = configModule().Config({ ...current, ...submitted });
    atomicWriteJson(CONFIG_FILE, validated);
    if (validated.permanentProxy && fs.existsSync(ACTIVE_MARKER)) {
      fs.writeFileSync(PAC_FILE, renderPac(validated), 'utf8');
      pacVersion += 1;
      const pacUrl = localPacUrl(validated);
      await writeSystemProxy({
        proxyEnable: '1',
        proxyServer: `${validated.proxyHost}:${validated.proxyPort}`,
        autoConfigUrl: pacUrl,
        proxyOverride: null,
      });
    }
    appendLog(`settings saved: ${validated.ec2User}@${validated.ec2Host} proxy=${validated.proxyHost}:${validated.proxyPort}`);
    return { ...validated, configFile: CONFIG_FILE };
  }

  async function startSsh(s) {
    assertNotBlocked();
    const existing = readPid('ssh');
    if (isAlive(existing) && await portOpen(s.socksHost, s.socksPort)) return { started: false, pid: existing };
    if (await portOpen(s.socksHost, s.socksPort) && !isAlive(existing)) {
      const adopted = await adoptOwnedListener('ssh', s.socksHost, s.socksPort, s);
      if (adopted) return { started: false, pid: adopted, adopted: true };
      throw new Error(`Port ${s.socksHost}:${s.socksPort} is already in use by another process`);
    }
    if (isAlive(existing)) await killPid(existing);
    const pid = spawnDetached(process.platform === 'win32' ? 'ssh.exe' : 'ssh', sshArgs(s), { windowsHide: true });
    if (!pid) throw new Error('Could not start ssh.exe');
    writePid('ssh', pid);
    if (!(await waitForPort(s.socksHost, s.socksPort, pid))) {
      await killPid(pid);
      clearPid('ssh');
      throw new Error(`SSH SOCKS tunnel did not open ${s.socksHost}:${s.socksPort}. See ${LOG_FILE}`);
    }
    appendLog(`SSH tunnel started: pid=${pid} target=${s.ec2User}@${s.ec2Host}`);
    return { started: true, pid };
  }

  async function startBridge(s) {
    assertNotBlocked();
    const existing = readPid('bridge');
    if (isAlive(existing) && await portOpen(s.proxyHost, s.proxyPort)) return { started: false, pid: existing };
    if (await portOpen(s.proxyHost, s.proxyPort) && !isAlive(existing)) {
      const adopted = await adoptOwnedListener('bridge', s.proxyHost, s.proxyPort, s);
      if (adopted) return { started: false, pid: adopted, adopted: true };
      throw new Error(`Port ${s.proxyHost}:${s.proxyPort} is already in use by another process`);
    }
    if (isAlive(existing)) await killPid(existing);
    const env = {
      ELECTRON_RUN_AS_NODE: '1',
      CLAUDE_HTTP_HOST: s.proxyHost,
      CLAUDE_HTTP_PORT: String(s.proxyPort),
      CLAUDE_SOCKS_HOST: s.socksHost,
      CLAUDE_SOCKS_PORT: String(s.socksPort),
      CLAUDE_FALLBACK_HOST: s.fallbackProxyHost,
      CLAUDE_FALLBACK_PORT: String(s.fallbackProxyPort),
      CLAUDE_PROXY_DOMAINS: s.proxyDomains || '',
      CLAUDE_LIGHTSAIL_DOMAINS: s.lightsailDomains || '',
      CLAUDE_ROUTES_FILE: path.join(PACKAGE_DIR, 'data', 'china-routes.json'),
      CLAUDE_EXCLUDE_RULES: [
        ...compileExclusions(s).domains.filter(rule => !['localhost', '.local', '127.*', '10.*', '172.16.*', '172.17.*', '172.18.*', '172.19.*', '172.2*', '172.30.*', '172.31.*', '192.168.*', '<local>'].includes(rule)),
        ...compileExclusions(s).suffixes,
        ...compileExclusions(s).ips,
      ].join(','),
      CLAUDE_PAC_FILE: PAC_FILE,
    };
    const pid = spawnDetached(NODE_BINARY, [BRIDGE_SCRIPT], { env, windowsHide: true });
    if (!pid) throw new Error('Could not start the HTTP-SOCKS bridge');
    writePid('bridge', pid);
    if (!(await waitForPort(s.proxyHost, s.proxyPort, pid))) {
      await killPid(pid);
      clearPid('bridge');
      throw new Error(`HTTP proxy bridge did not open ${s.proxyHost}:${s.proxyPort}. See ${LOG_FILE}`);
    }
    appendLog(`HTTP bridge started: pid=${pid} ${s.proxyHost}:${s.proxyPort} -> socks ${s.socksHost}:${s.socksPort}`);
    return { started: true, pid };
  }

  async function probeEgress(s, force = false) {
    if (!(await portOpen(s.socksHost, s.socksPort))) return null;
    if (!force && egressCache.value && Date.now() - egressCache.at < 15000) return egressCache.value;
    // Probe several endpoints: a single site can rate-limit the Lightsail IP and
    // look like a dead tunnel even though SOCKS5 is healthy.
    for (const url of ['https://api.ipify.org', 'https://ifconfig.me/ip', 'https://icanhazip.com']) {
      const result = await runCapture('curl.exe', [
        '--silent', '--show-error', '--max-time', '12',
        '-x', `socks5h://${s.socksHost}:${s.socksPort}`,
        url,
      ], 18000);
      const value = result.code === 0 ? result.out.trim() : '';
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
        egressCache = { at: Date.now(), value };
        return value;
      }
    }
    egressCache = { at: Date.now(), value: null };
    return null;
  }

  async function confirmEgress(s) {
    const ip = await probeEgress(s, true);
    if (!ip) throw new Error('Lightsail egress check failed: no response through SOCKS5');
    if (net.isIP(s.ec2Host) && ip !== s.ec2Host) {
      throw new Error(`Lightsail egress mismatch: expected ${s.ec2Host}, got ${ip}`);
    }
    return ip;
  }

  async function block(reason) {
    if (blocked) return;
    blocked = true;
    blockedReason = reason;
    appendLog(`Lightsail proxy BLOCKED: ${reason}`);
    // Keep the PAC in place: excluded hosts stay DIRECT, everything else points
    // at the now-closed bridge and fails rather than falling back to another VPN.
  }

  async function unblock() {
    if (!blocked) return;
    blocked = false;
    blockedReason = null;
    guardFailures = 0;
    appendLog('Lightsail proxy block cleared');
  }

  async function enablePermanentProxy() {
    assertNotBlocked();
    const s = settings();
    validatePaths(s);
    await startSsh(s);
    await startBridge(s);
    const egressIp = await confirmEgress(s);
    const current = await readSystemProxyFull();
    if (!fs.existsSync(PROXY_BACKUP)) {
      atomicWriteJson(PROXY_BACKUP, { ...(current || {}), savedAt: new Date().toISOString() });
    }
    fs.writeFileSync(PAC_FILE, renderPac(s, { defaultProxy: `${s.proxyHost}:${s.proxyPort}` }), 'utf8');
    const pacUrl = localPacUrl(s);
    await writeSystemProxy({
      proxyEnable: '1',
      proxyServer: `${s.proxyHost}:${s.proxyPort}`,
      autoConfigUrl: pacUrl,
      proxyOverride: null,
    });
    fs.writeFileSync(ACTIVE_MARKER, JSON.stringify({ at: new Date().toISOString(), proxy: `${s.proxyHost}:${s.proxyPort}` }), 'utf8');
    startWatchdog();
    appendLog(`permanent proxy enabled: PAC ${PAC_FILE}, egress ${egressIp}`);
    return {
      enabled: true,
      mode: 'pac',
      pac: PAC_FILE,
      proxy: `http://${s.proxyHost}:${s.proxyPort}`,
      egressIp,
      exclusions: compileExclusions(s),
    };
  }

  async function disablePermanentProxy(options = {}) {
    // Scheme A. "Turn the Lightsail system proxy off" only changes where
    // GENERAL overseas traffic goes: it falls back to the configured original
    // proxy (fallbackProxyPort, e.g. 7890). Claude hosts stay pinned to the
    // local bridge in the PAC, so their egress never drifts. The SSH tunnel
    // and bridge therefore KEEP RUNNING to serve Claude; stopping them is the
    // separate stopAll() action.
    const s = settings();
    const fallback = `${s.fallbackProxyHost}:${s.fallbackProxyPort}`;
    fs.writeFileSync(PAC_FILE, renderPac(s, { defaultProxy: fallback }), 'utf8');
    await writeSystemProxy({
      proxyEnable: '1',
      proxyServer: fallback,
      autoConfigUrl: localPacUrl(s),
      proxyOverride: null,
    });
    try { fs.rmSync(ACTIVE_MARKER, { force: true }); } catch { /* best effort */ }
    appendLog(`permanent proxy disabled: general traffic -> ${fallback}, Claude pinned to ${s.proxyHost}:${s.proxyPort}, tunnel kept alive for Claude`);
    return {
      enabled: false,
      mode: 'fallback',
      fallbackProxy: fallback,
      claudePinned: `${s.proxyHost}:${s.proxyPort}`,
      tunnelKeptForClaude: true,
      note: `General overseas traffic now uses ${fallback}. Claude still routes through the local bridge to Lightsail, so its IP does not drift.`,
    };
  }

  async function restoreDirect(options = {}) {
    // Escape hatch: general traffic goes DIRECT, but Claude stays pinned to the
    // local bridge (still served by the running SSH tunnel) so its egress never
    // drifts. ProxyServer is left on the bridge so a PAC download failure still
    // keeps Claude on the safe path rather than leaking direct.
    const s = settings();
    fs.writeFileSync(PAC_FILE, renderPac(s, { defaultProxy: 'DIRECT' }), 'utf8');
    await writeSystemProxy({
      proxyEnable: '1',
      proxyServer: `${s.proxyHost}:${s.proxyPort}`,
      autoConfigUrl: localPacUrl(s),
      proxyOverride: null,
    });
    try { fs.rmSync(ACTIVE_MARKER, { force: true }); } catch { /* best effort */ }
    await unblock();
    appendLog('general traffic restored to DIRECT; Claude stays pinned to the bridge');
    return {
      enabled: false,
      mode: 'direct',
      claudePinned: `${s.proxyHost}:${s.proxyPort}`,
      tunnelKeptForClaude: true,
      note: 'General traffic is DIRECT. Claude still routes through the bridge to Lightsail.',
    };
  }

  async function startTunnel() {
    assertNotBlocked();
    const s = settings();
    validatePaths(s);
    const egressIp = await (async () => { await startSsh(s); await startBridge(s); return confirmEgress(s); })();
    if (s.permanentProxy) return enablePermanentProxy();
    return { started: true, egressIp, proxy: `http://${s.proxyHost}:${s.proxyPort}` };
  }

  function pacIsActive() {
    return fs.existsSync(ACTIVE_MARKER);
  }

  /**
   * Restart only the local tunnel (SSH + bridge) while leaving the Windows PAC
   * untouched. Restoring 7890 for even a few seconds lets other applications
   * (Chrome, ChatGPT, Codex) open long-lived connections straight to the VPN and
   * keep bypassing the PAC afterwards.
   */
  async function restartTunnel() {
    const s = settings();
    const started = Date.now();
    for (const kind of ['bridge', 'ssh']) {
      const pid = readPid(kind);
      if (pid) await killPid(pid);
      clearPid(kind);
    }
    // Wait for the loopback ports to be released before rebinding them.
    for (const [host, port] of [[s.proxyHost, s.proxyPort], [s.socksHost, s.socksPort]]) {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && await portOpen(host, port, 300)) await sleep(150);
    }
    await unblock();
    await startSsh(s);
    await startBridge(s);
    const egressIp = await confirmEgress(s);
    // PAC content may have changed while the bridge was down; rewrite it but
    // keep AutoConfigURL pointing at the same loopback endpoint.
    fs.writeFileSync(PAC_FILE, renderPac(s), 'utf8');
    startWatchdog();
    appendLog(`tunnel restarted in-place (${Date.now() - started} ms); system proxy untouched, egress ${egressIp}`);
    return {
      restarted: true,
      systemProxyUntouched: true,
      tookMs: Date.now() - started,
      egressIp,
      proxy: `http://${s.proxyHost}:${s.proxyPort}`,
    };
  }

  async function stopAll() {
    const s = settings();
    // Full teardown. General traffic falls back to the original proxy (or the
    // backup). We stop the SSH tunnel but KEEP the bridge alive so it still
    // serves the PAC and keeps Claude pinned to 8088: with SSH gone a Claude
    // request fails closed at the bridge instead of drifting to another egress.
    const restored = pacIsActive() || fs.existsSync(PROXY_BACKUP)
      ? await disablePermanentProxy()
      : null;
    const killed = { ssh: false, bridge: false };
    const sshPid = readPid('ssh');
    killed.ssh = sshPid ? await killPid(sshPid) : false;
    clearPid('ssh');
    await unblock();
    appendLog('Lightsail tunnel stopped (bridge kept for Claude fail-closed); general traffic restored');
    return { stopped: true, killed, bridgeKeptForClaude: true, restored };
  }

  function requestJson(url, timeout = 8000) {
    return new Promise((resolve, reject) => {
      const req = http.get(url, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch (error) { reject(new Error(`Invalid JSON from ${url}: ${error.message}`)); }
        });
      });
      req.setTimeout(timeout, () => req.destroy(new Error(`Timed out requesting ${url}`)));
      req.on('error', reject);
    });
  }

  async function routesStatus() {
    const localRequire2 = createRequire(import.meta.url);
    const routeHelpers = localRequire2('./lib/china-routes.cjs');
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, 'data', 'china-routes.json'), 'utf8'));
      return { available: true, ...routeHelpers.routeCounts(raw), sources: raw.sources || routeHelpers.CHINA_IP_SOURCE ? [routeHelpers.CHINA_IP_SOURCE, routeHelpers.CHINA_DOMAINS_SOURCE] : [] };
    } catch (error) {
      return { available: false, error: errorOf(error), chinaRanges: 0, chinaDomains: 0, sources: [] };
    }
  }

  async function connections() {
    const s = settings();
    if (!(await portOpen(s.proxyHost, s.proxyPort))) {
      return { available: false, reason: `HTTP bridge ${s.proxyHost}:${s.proxyPort} is not listening`, active: [], recent: [] };
    }
    try {
      const value = await requestJson(`http://${s.proxyHost}:${s.proxyPort}/__lightsail/connections`);
      return { available: true, ...value };
    } catch (error) {
      return { available: false, reason: errorOf(error), active: [], recent: [] };
    }
  }

  async function latencyProbe(url, timeoutMs = 15000) {
    const s = settings();
    const target = new URL(url);
    const proxyHost = s.proxyHost;
    const proxyPort = s.proxyPort;
    const start = performance.now();
    let connectAt = null;
    let secureAt = null;
    let ttfbAt = null;
    return new Promise(resolve => {
      const req = http.request({
        host: proxyHost,
        port: proxyPort,
        method: 'CONNECT',
        path: `${target.hostname}:${target.port || 443}`,
        headers: { Host: `${target.hostname}:${target.port || 443}` },
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
      req.once('connect', (res, socket) => {
        connectAt = performance.now();
        const secure = tls.connect({ socket, servername: target.hostname }, () => {
          secureAt = performance.now();
          const path = `${target.pathname}${target.search || ''}`;
          secure.write(`GET ${path} HTTP/1.1\r\nHost: ${target.hostname}\r\nUser-Agent: dsh-lightsail-latency/1.0\r\nConnection: close\r\n\r\n`);
        });
        secure.setTimeout(timeoutMs, () => secure.destroy(new Error('timeout')));
        let first = true;
        let bytes = 0;
        secure.on('data', chunk => {
          bytes += chunk.length;
          if (first) { first = false; ttfbAt = performance.now(); }
        });
        secure.once('error', error => resolve({ url, ok: false, error: errorOf(error), proxyConnectMs: connectAt ? Math.round(connectAt - start) : null }));
        secure.once('close', () => {
          const end = performance.now();
          resolve({
            url,
            ok: Boolean(ttfbAt),
            status: ttfbAt ? 'reachable' : 'no-response',
            proxyConnectMs: connectAt ? Number((connectAt - start).toFixed(1)) : null,
            tlsMs: connectAt && secureAt ? Number((secureAt - connectAt).toFixed(1)) : null,
            ttfbMs: secureAt && ttfbAt ? Number((ttfbAt - secureAt).toFixed(1)) : null,
            totalMs: Number((end - start).toFixed(1)),
            responseBytes: bytes,
          });
        });
      });
      req.once('error', error => resolve({ url, ok: false, error: errorOf(error), totalMs: Number((performance.now() - start).toFixed(1)) }));
      req.end();
    });
  }

  async function latency(payload = {}) {
    assertNotBlocked();
    const s = settings();
    await startSsh(s);
    await startBridge(s);
    const count = Math.max(1, Math.min(10, Number(payload.count) || 5));
    const url = typeof payload.url === 'string' && payload.url.startsWith('https://') ? payload.url : 'https://api.github.com/';
    const samples = [];
    for (let i = 0; i < count; i += 1) samples.push(await latencyProbe(url, Number(payload.timeoutMs) || 15000));
    const ok = samples.filter(sample => sample.ok && Number.isFinite(sample.totalMs));
    const totals = ok.map(sample => sample.totalMs).sort((a, b) => a - b);
    const avg = totals.length ? totals.reduce((sum, value) => sum + value, 0) / totals.length : null;
    const jitter = totals.length > 1
      ? totals.slice(1).reduce((sum, value, index) => sum + Math.abs(value - totals[index]), 0) / (totals.length - 1)
      : null;
    const proxyConnect = ok.map(sample => sample.proxyConnectMs).filter(Number.isFinite);
    const tls = ok.map(sample => sample.tlsMs).filter(Number.isFinite);
    const ttfb = ok.map(sample => sample.ttfbMs).filter(Number.isFinite);
    const mean = values => values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1)) : null;
    const result = {
      target: url,
      proxy: `http://${s.proxyHost}:${s.proxyPort}`,
      egressIp: await probeEgress(s, true),
      expectedIp: s.ec2Host,
      count,
      success: ok.length,
      failed: count - ok.length,
      avgMs: totals.length ? Number(avg.toFixed(1)) : null,
      minMs: totals.length ? totals[0] : null,
      maxMs: totals.length ? totals[totals.length - 1] : null,
      p50Ms: totals.length ? totals[Math.floor((totals.length - 1) * 0.5)] : null,
      p95Ms: totals.length ? totals[Math.floor((totals.length - 1) * 0.95)] : null,
      jitterMs: jitter === null ? null : Number(jitter.toFixed(1)),
      avgProxyConnectMs: mean(proxyConnect),
      avgTlsMs: mean(tls),
      avgTtfbMs: mean(ttfb),
      samples,
    };
    appendLog(`latency: target=${url} success=${result.success}/${count} avg=${result.avgMs ?? 'n/a'}ms egress=${result.egressIp}`);
    return result;
  }

  async function test() {
    assertNotBlocked();
    const s = settings();
    await startSsh(s);
    await startBridge(s);
    const egressIp = await confirmEgress(s);
    const endpoints = {};
    for (const url of ['https://claude.ai/', 'https://api.anthropic.com/', 'https://api.github.com/']) {
      const result = await runCapture('curl.exe', [
        '--silent', '--show-error', '--max-time', '20',
        '-o', 'NUL', '-w', '%{http_code}',
        '-x', `http://${s.proxyHost}:${s.proxyPort}`, url,
      ], 25000);
      endpoints[url] = result.code === 0 ? result.out.trim() : `error:${result.code}`;
    }
    appendLog(`test: egress=${egressIp} claude=${endpoints['https://claude.ai/']} api=${endpoints['https://api.anthropic.com/']}`);
    return { egressIp, expectedIp: s.ec2Host, endpoints, proxy: `http://${s.proxyHost}:${s.proxyPort}`, exclusions: compileExclusions(s) };
  }

  async function guardCheck() {
    if (blocked) {
      // Self-heal: once the tunnel answers again, clear the breaker instead of
      // staying blocked until a manual restart.
      const s0 = settings();
      if (!fs.existsSync(ACTIVE_MARKER)) return;
      const healthy = await portOpen(s0.socksHost, s0.socksPort) && await portOpen(s0.proxyHost, s0.proxyPort);
      if (!healthy) return;
      const ip = await probeEgress(s0, true);
      if (ip && (!net.isIP(s0.ec2Host) || ip === s0.ec2Host)) {
        guardFailures = 0;
        await unblock();
      }
      return;
    }
    if (!fs.existsSync(ACTIVE_MARKER)) return;
    const s = settings();
    if (!s.permanentProxy) return;
    if (!(await portOpen(s.socksHost, s.socksPort))) {
      guardFailures += 1;
      if (guardFailures >= 3) await block(`SOCKS5 listener ${s.socksHost}:${s.socksPort} disappeared`);
      return;
    }
    if (!(await portOpen(s.proxyHost, s.proxyPort))) {
      guardFailures += 1;
      if (guardFailures >= 3) await block(`HTTP bridge ${s.proxyHost}:${s.proxyPort} disappeared`);
      return;
    }
    try {
      await confirmEgress(s);
      guardFailures = 0;
    } catch (error) {
      // Require consecutive failures so transient TLS/rate-limit hiccups do not
      // tear down a healthy tunnel.
      guardFailures += 1;
      appendLog(`egress probe failed (${guardFailures}/3): ${errorOf(error)}`);
      if (guardFailures >= 3) await block(errorOf(error));
    }
  }

  function startWatchdog() {
    if (watchdog) return;
    watchdog = ctx.setInterval(() => { void guardCheck(); }, 20000);
  }

  async function fallbackClients() {
    if (process.platform !== 'win32') return { supported: false, clients: [], total: 0 };
    const s = settings();
    const netstat = await runCapture('netstat.exe', ['-ano', '-p', 'tcp'], 15000);
    if (netstat.code !== 0) return { supported: false, clients: [], total: 0, error: 'netstat failed' };
    const port = s.fallbackProxyPort;
    const rows = [];
    for (const line of netstat.out.split(/\r?\n/)) {
      const match = line.trim().match(/^TCP\s+(\S+):(\d+)\s+(\S+):(\d+)\s+ESTABLISHED\s+(\d+)$/i);
      if (!match) continue;
      if (Number(match[4]) !== Number(port)) continue;
      rows.push({ ownerPid: Number(match[5]), localPort: Number(match[2]) });
    }
    const clients = [];
    const seen = new Map();
    for (const row of rows) {
      if (!Number.isInteger(row.ownerPid) || row.ownerPid <= 0) continue;
      if (!seen.has(row.ownerPid)) {
        const command = await processCommand(row.ownerPid);
        const base = path.basename(String(command || '').trim().split(/"/)[1] || '');
        seen.set(row.ownerPid, base || `pid ${row.ownerPid}`);
      }
      clients.push({ process: seen.get(row.ownerPid), pid: row.ownerPid, localPort: row.localPort });
    }
    const grouped = [...clients.reduce((map, item) => {
      const key = `${item.process}#${item.pid}`;
      const entry = map.get(key) || { process: item.process, pid: item.pid, connections: 0 };
      entry.connections += 1;
      map.set(key, entry);
      return map;
    }, new Map()).values()].sort((a, b) => b.connections - a.connections);
    return {
      supported: true,
      proxy: `${s.fallbackProxyHost}:${s.fallbackProxyPort}`,
      total: clients.length,
      clients: grouped,
      note: '这些连接绕过了系统 PAC，通常是 PAC 生效前建立的旧连接，或程序自带代理配置。',
    };
  }

  async function status() {
    const s = settings();
    const socks = await portOpen(s.socksHost, s.socksPort);
    const bridge = await portOpen(s.proxyHost, s.proxyPort);
    if (socks && !isAlive(readPid('ssh'))) {
      await adoptOwnedListener('ssh', s.socksHost, s.socksPort, s);
    }
    if (bridge && !isAlive(readPid('bridge'))) {
      await adoptOwnedListener('bridge', s.proxyHost, s.proxyPort, s);
    }
    const pids = { ssh: readPid('ssh'), bridge: readPid('bridge') };
    const connectionSummary = bridge ? await connections() : { available: false, active: [], recent: [], counts: { active: 0, recent: 0 } };
    const routing = await routesStatus();
    const bypass = await fallbackClients();
    return {
      settings: s,
      running: {
        ssh: socks && isAlive(pids.ssh),
        bridge: bridge && isAlive(pids.bridge),
        socksListener: socks,
        httpProxyListener: bridge,
      },
      pids,
      egressIp: socks ? await probeEgress(s) : null,
      expectedIp: s.ec2Host,
      active: fs.existsSync(ACTIVE_MARKER),
      blocked,
      blockedReason,
      exclusions: compileExclusions(s),
      connections: connectionSummary,
      routing,
      bypassingPac: bypass,
      pacFile: PAC_FILE,
      systemProxy: await readSystemProxyFull(),
      stateDir: STATE_DIR,
      logFile: LOG_FILE,
      platform: process.platform,
    };
  }

  async function log(limit = 120) {
    const take = Math.max(1, Math.min(300, Number(limit) || 120));
    try {
      const lines = fs.readFileSync(LOG_FILE, 'utf8').split(/\r?\n/).filter(Boolean);
      return { lines: lines.slice(-take), file: LOG_FILE, empty: lines.length === 0 };
    } catch { return { lines: [], file: LOG_FILE, empty: true }; }
  }

  async function execute(action, payload = {}) {
    switch (action) {
      case 'status': return status();
      case 'saveSettings': return saveSettings(payload);
      case 'startTunnel': return startTunnel();
      case 'permanentProxyOn': return enablePermanentProxy();
      case 'permanentProxyOff': return disablePermanentProxy();
      case 'restoreDirect': return restoreDirect();
      case 'stop': return stopAll();
      case 'restartTunnel': return restartTunnel();
      case 'test': return test();
      case 'connections': return connections();
      case 'latency': return latency(payload);
      case 'log': return log(payload.limit);
      default: throw new Error(`Unknown Lightsail proxy action: ${action}`);
    }
  }

  ctx.inject(['webServer'], scoped => {
    const server = scoped.webServer;
    if (!server?.register) return;
    scoped.effect(() => server.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: async (req, res) => {
        const send = (code, body) => {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(JSON.stringify(body));
        };
        const urlForPac = new URL(req.url ?? '/', 'http://localhost');
        if (urlForPac.pathname === `${API_PREFIX}/lightsail.pac`) {
          try {
            const pac = fs.existsSync(PAC_FILE)
              ? fs.readFileSync(PAC_FILE, 'utf8')
              : renderPac(settings());
            res.writeHead(200, { 'content-type': 'application/x-ns-proxy-autoconfig; charset=utf-8', 'cache-control': 'no-store' });
            res.end(pac);
          } catch (error) {
            send(500, { ok: false, error: errorOf(error) });
          }
          return;
        }
        try {
          let connection;
          try { connection = ctx.get('connection'); } catch { connection = undefined; }
          const raw = connection?.admit?.(req);
          const admission = raw !== undefined ? raw : connection?.requestRejection?.(req);
          const rejected = typeof admission === 'object' && admission !== null ? admission.rejection : admission;
          if (rejected !== undefined && rejected !== null) return send(Number(rejected) || 403, { error: 'unauthorized' });
          const url = new URL(req.url ?? '/', 'http://localhost');
          const action = url.pathname.replace(new RegExp(`^${API_PREFIX}/?`), '').replace(/\/+$/, '') || 'status';
          let body = {};
          if ((req.method ?? 'GET').toUpperCase() === 'POST') {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            if (chunks.length) {
              try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
              catch { return send(400, { error: 'Invalid JSON' }); }
            }
          }
          send(200, { ok: true, result: await execute(action, body) });
        } catch (error) {
          appendLog(`api error: ${errorOf(error)}`);
          send(400, { ok: false, error: errorOf(error) });
        }
      },
    }), 'claude-ec2: settings API');
  });

  let toolRegistered = false;
  const registerTool = tools => {
    if (toolRegistered || !tools?.register) return;
    toolRegistered = true;
    try {
      tools.register(defineTool({
        name: 'claude_lightsail_proxy',
        description: 'Manage the Lightsail proxy: status, edit Lightsail/SSH/proxy/exclusion settings, start/stop the permanent system proxy, test egress, list active proxy connections, measure proxy latency, and read logs. Exclusion rules keep chosen domains and LAN ranges on DIRECT.',
        parameters: {
          action: {
            type: 'string', required: true,
            description: 'One of: status, saveSettings, startTunnel, restartTunnel, permanentProxyOn, permanentProxyOff, restoreDirect, stop, test, connections, latency, log.',
          },
          limit: { type: 'number', description: 'For log: number of trailing lines (1-300).' },
          count: { type: 'number', description: 'For latency: number of probes (1-10, default 5).' },
          url: { type: 'string', description: 'For latency: optional HTTPS URL to probe; defaults to https://api.github.com/.' },
          timeoutMs: { type: 'number', description: 'For latency: per-probe timeout in milliseconds (default 15000).' },
          ...Object.fromEntries(configModule().KEYS.map(key => [key, {
            type: typeof configModule().DEFAULTS[key],
            description: `For saveSettings: ${key}.`,
          }])),
        },
        output: {
          schema: { type: 'object', additionalProperties: true, properties: {} },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        async execute(args) {
          const { action, ...payload } = args;
          return execute(action, payload);
        },
      }));
    } catch (error) {
      toolRegistered = false;
      appendLog(`could not register agent tool: ${errorOf(error)}`);
      ctx.logger?.error?.(`[claude-ec2] could not register the agent tool: ${errorOf(error)}`);
    }
  };
  try { registerTool(ctx.get('tools')); } catch { /* tools may publish later */ }
  if (!toolRegistered) {
    ctx.inject(['tools'], scoped => {
      scoped.effect(() => registerTool(scoped.tools), 'claude-ec2: agent tool');
    });
  }

  ensureState();
  void (async () => {
    try {
      if (fs.existsSync(ACTIVE_MARKER)) {
        startWatchdog();
        const s = settings();
        if (!(await portOpen(s.proxyHost, s.proxyPort)) || !(await portOpen(s.socksHost, s.socksPort))) {
          try {
            await unblock();
            await startSsh(s);
            await startBridge(s);
            await confirmEgress(s);
            appendLog('permanent proxy tunnel recovered after plugin reload');
          } catch (error) {
            await block(`recovery failed: ${errorOf(error)}`);
          }
        }
      }
    } catch (error) { appendLog(`startup recovery failed: ${errorOf(error)}`); }
  })();
  appendLog(`plugin loaded: node=${NODE_BINARY} api=${API_PREFIX}`);

  return {
    execute, status, saveSettings, startTunnel, restartTunnel, enablePermanentProxy, disablePermanentProxy, restoreDirect, stop: stopAll, test, connections, latency, log,
    dispose() { /* detached processes intentionally survive a plugin reload */ },
  };
}

export function apply(ctx, config = {}) {
  const service = createService(ctx, config);
  ctx.provide('claudeEc2', service);
  return () => { try { service.dispose(); } catch { /* best effort */ } };
}
