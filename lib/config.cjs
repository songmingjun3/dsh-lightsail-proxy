/**
 * Standard Schema Config for the Lightsail proxy plugin.
 * Hand-written CJS avoids ESM peer resolution surprises for linked bundles.
 */
'use strict';

const DEFAULTS = {
  // Lightsail SSH target
  ec2Host: '<YOUR_LIGHTSAIL_IP>',
  ec2User: 'ubuntu',
  ec2Port: 22,
  keyPath: '<YOUR_PRIVATE_KEY_PATH>',

  // Local proxy chain: 8088 HTTP CONNECT -> 1080 SOCKS5 -> SSH -> Lightsail
  socksHost: '127.0.0.1',
  socksPort: 1080,
  proxyHost: '127.0.0.1',
  proxyPort: 8088,

  // Permanent system proxy behaviour
  permanentProxy: true,
  failClosed: true,

  // Domestic domains/IPs and user exclusions go DIRECT.
  excludeDomains: 'localhost,.local,127.*,10.*,172.16.*,172.17.*,172.18.*,172.19.*,172.2*,172.30.*,172.31.*,192.168.*',
  excludeSuffixes: '.cn,.aliyun.com,.baidu.com,.qq.com,.taobao.com,.tmall.com,.jd.com,.weibo.com,.bilibili.com,.aliyuncs.com,.alicdn.com',
  excludeIps: '',

  // Hosts forced through the original proxy. Kept empty by default: every
  // public host (including agentrouter.org) goes through Lightsail, so the
  // egress IP stays fixed and no local-DNS surprises are possible.
  proxyDomains: '',

  // Claude/Anthropic hosts pinned to the local bridge in the PAC so their
  // egress never drifts, even after the permanent proxy is turned off.
  claudeDomains: 'claude.ai,.claude.ai,claude.com,.claude.com,claudeusercontent.com,.claudeusercontent.com,anthropic.com,.anthropic.com,claudeusercontent.com,claudemcpcontent.com,.claudemcpcontent.com',

  // Exact hosts pinned to Lightsail regardless of China-route classification.
  // Used for WAF/captcha endpoints that must share the main site's egress IP.
  // Exact full-host match only; no suffix/wildcard matching.
  lightsailDomains: 'o.alicdn.com,cloudauth-device-dualstack.ap-southeast-1.aliyuncs.com,cloudauth-device-pre.ap-southeast-1.aliyuncs.com,pre-ap-southeast-1.device.saf.aliyuncs.com,pre-device.captcha-open.aliyuncs.com,20febf84394ca86df1247f5ad3a87b60.captcha-open-southeast.aliyuncs.com,20febf84394ca86df1247f5ad3a87b60-verify.captcha-open-southeast.aliyuncs.com,upload.captcha-open-southeast.aliyuncs.com',

  // Original proxy, used only for proxyDomains. When the permanent proxy is
  // disabled and no backup exists, the system is restored to DIRECT (no proxy),
  // never hardcoded to this fallback.
  fallbackProxyHost: '127.0.0.1',
  fallbackProxyPort: 7890,
};

const KEYS = Object.keys(DEFAULTS);
const PORT_FIELDS = new Set(['ec2Port', 'socksPort', 'proxyPort', 'fallbackProxyPort']);
const BOOLEAN_FIELDS = new Set(['permanentProxy', 'failClosed']);
const OPTIONAL_TEXT_FIELDS = new Set(['excludeDomains', 'excludeSuffixes', 'excludeIps', 'proxyDomains', 'lightsailDomains', 'claudeDomains']);

function text(value, max = 1000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function boolean(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string' && /^(true|false)$/i.test(value.trim())) return value.trim().toLowerCase() === 'true';
  if (typeof value === 'number' && (value === 0 || value === 1)) return value === 1;
  return fallback;
}

function normalize(name, raw) {
  const fallback = DEFAULTS[name];
  // An explicit empty string on an optional list means "cleared" and must be
  // preserved. Only an absent value (undefined/null) falls back to the default.
  const clearedOptional = raw === '' && OPTIONAL_TEXT_FIELDS.has(name);
  const empty = raw === undefined || raw === null || raw === '';
  const value = (empty && !clearedOptional) ? fallback : raw;
  if (PORT_FIELDS.has(name)) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error(`${name}: expected TCP port 1-65535`);
    return parsed;
  }
  if (BOOLEAN_FIELDS.has(name)) return boolean(value, fallback);
  const result = text(value, 8000);
  if (!result && OPTIONAL_TEXT_FIELDS.has(name)) return '';
  if (!result) throw new Error(`${name}: expected a non-empty string`);
  if (name === 'keyPath' && !/\.pem$|\.key$|id_[a-z0-9]+$/i.test(result)) {
    // still allowed, only a soft hint
  }
  return result;
}

const FIELDS = Object.fromEntries(KEYS.map(name => {
  const fallback = DEFAULTS[name];
  return [name, {
    type: typeof fallback,
    default: fallback,
    description: `Lightsail proxy setting: ${name}.`,
    validate() { return undefined; },
  }];
}));

const STANDARD = {
  version: 1,
  vendor: 'dsh-claude-ec2',
  validate(value) {
    const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const result = {};
    const issues = [];
    for (const name of KEYS) {
      try { result[name] = normalize(name, raw[name]); }
      catch (error) { issues.push({ message: error.message, path: [name] }); }
    }
    return issues.length ? { issues } : { value: result };
  },
};

function Config(raw) {
  const result = STANDARD.validate(raw);
  if (result.issues) throw new TypeError(result.issues.map(issue => issue.message).join('; '));
  return result.value;
}

function field(name) {
  const spec = FIELDS[name];
  const schema = () => { throw new TypeError('Use Config["~standard"].validate()'); };
  schema.type = spec.type;
  schema.meta = { default: spec.default, description: spec.description, volatile: true };
  schema.dict = undefined;
  schema.list = undefined;
  schema.inner = undefined;
  schema.default = () => schema;
  schema.volatile = () => schema;
  schema.description = value => { schema.meta.description = value; return schema; };
  schema.i18n = () => schema;
  return schema;
}

Config.type = 'object';
Config.meta = {};
Config.dict = Object.fromEntries(KEYS.map(name => [name, field(name)]));
Config['~standard'] = STANDARD;
Config.default = () => Config;
Config.i18n = () => Config;
Config.description = value => { Config.meta.description = value; return Config; };

/** Split a comma/newline separated rule list into trimmed entries. */
function splitRules(raw) {
  return String(raw || '')
    .split(/[\n,;]+/)
    .map(item => item.trim().toLowerCase())
    .filter(Boolean);
}

module.exports = { Config, DEFAULTS, KEYS, FIELDS, splitRules };
