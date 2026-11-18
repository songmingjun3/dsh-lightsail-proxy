window.__ModuleLoader__.load({
  id: 'dsh-claude-ec2',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback } = React;
    const NS = 'settings.claudeEc2';

    const DICT = {
      zh: {
        nav: 'Lightsail 代理',
        title: 'Lightsail 常驻代理',
        intro: '系统代理固定指向本机 HTTP 桥，再由 SSH SOCKS5 从 Lightsail 出网。排除规则里的域名/网段直连，其余流量（含 Claude、GitHub）全部走 Lightsail。',
        loading: '正在加载…',
        loadFailed: '无法连接插件服务',
        'section.status': '运行状态',
        'status.ssh': 'SSH 隧道',
        'status.bridge': '本机 HTTP 代理',
        'status.socks': 'SOCKS5 监听',
        'status.egress': 'Lightsail 出口 IP',
        'status.expected': '配置的 Lightsail IP',
        'status.systemProxy': 'Windows 系统代理',
        'status.active': '常驻代理',
        'status.blocked': '熔断状态',
        'status.connections': '活跃链接数',
        'status.routing': '境内分流库',
        'status.bypass': '绕过 PAC 直连原代理的程序',
        running: '运行中',
        stopped: '已停止',
        blocked: '已熔断',
        normal: '正常',
        'button.enable': '启动常驻代理',
        'button.disable': '关闭常驻代理并恢复',
        'button.test': '测试出口',
        'button.connections': '查看活跃链接',
        'button.latency': '测试代理延迟',
        'button.refresh': '刷新状态',
        'section.connections': '当前活跃链接',
        'section.latency': '代理延迟核心指标',
        'connections.busy': '正在读取活跃链接…',
        'connections.empty': '当前没有经过 Lightsail 代理的活跃链接。',
        'connections.recent': '最近结束 {recent} 条，其中失败 {failed} 条。',
        'connections.host': '目标',
        'connections.state': '状态',
        'connections.duration': '持续',
        'connections.traffic': '流量（收 / 发）',
        'connections.source': '本机端口',
        'connections.activeCount': '活跃 {count} 条',
        'latency.busy': '正在测试代理延迟…',
        'latency.empty': '点击“测试代理延迟”查看核心指标。',
        'latency.avg': '平均延迟',
        'latency.p95': 'P95 延迟',
        'latency.min': '最小 / 最大',
        'latency.jitter': '抖动',
        'latency.success': '成功 / 次数',
        'latency.egress': '出口 IP',
        'latency.breakdown': '代理连接 / TLS / TTFB',
        'button.log': '查看日志',
        'button.save': '保存配置',
        'button.start': '仅启动隧道（不改系统代理）',
        'button.restartTunnel': '重启隧道（不动系统代理）',
        'section.lightsail': 'Lightsail 与 SSH',
        'section.localProxy': '本地代理端口',
        'section.behaviour': '常驻代理行为',
        'section.exclusions': '排除规则（直连，不走 Lightsail）',
        'exclusions.hint': '逗号或换行分隔。域名支持精确匹配、后缀（.example.com）、通配符（*.example.com）；IP 支持精确和 10.* 前缀。这些规则命中后由本机桥直连，不经过任何代理。',
        'label.ec2Host': 'Lightsail 静态 IP',
        'label.ec2User': 'SSH 用户',
        'label.ec2Port': 'SSH 端口',
        'label.keyPath': '私钥路径',
        'label.socksHost': 'SOCKS5 监听地址',
        'label.socksPort': 'SOCKS5 端口',
        'label.proxyHost': 'HTTP 代理监听地址',
        'label.proxyPort': 'HTTP 代理端口',
        'label.permanentProxy': '启用常驻系统代理',
        'label.failClosed': '失败即阻断（不回落到其他代理）',
        'label.excludeDomains': '排除的域名 / 网段',
        'label.excludeSuffixes': '排除的后缀',
        'label.excludeIps': '排除的 IP',
        'label.proxyDomains': '强制走原代理的域名（本机 DNS 不可用时）',
        'proxyDomains.hint': '这些域名即使属于境内也会走下方原代理，而不是直连。用于 agentrouter.org 这类本机 DNS 被解析到 127.0.0.1 的站点。',
        'label.fallbackProxyHost': '原代理地址（仅供上面的域名使用）',
        'label.fallbackProxyPort': '恢复时使用的原代理端口',
        'hint.failClosed': '开启后，Lightsail 或本地桥断开时系统代理仍指向本机桥，访问会失败而不是偷偷切到原 VPN，避免出口 IP 变化。',
        'hint.pac': '常驻代理使用本机 PAC 文件按域名分流：排除项 DIRECT，其余走本机 HTTP 代理。',
        working: '执行中…',
        success: '操作成功',
        failed: '操作失败',
        'message.saved': '配置已保存',
        none: '无',
      },
      en: {
        nav: 'Lightsail proxy',
        title: 'Lightsail permanent proxy',
        intro: 'The Windows system proxy points at a local HTTP bridge, then SSH SOCKS5 out through Lightsail. Excluded domains/ranges go DIRECT; everything else, including Claude and GitHub, uses Lightsail.',
        loading: 'Loading…',
        loadFailed: 'Cannot reach the plugin service',
        'section.status': 'Status',
        'status.ssh': 'SSH tunnel',
        'status.bridge': 'Local HTTP proxy',
        'status.socks': 'SOCKS5 listener',
        'status.egress': 'Lightsail egress IP',
        'status.expected': 'Configured Lightsail IP',
        'status.systemProxy': 'Windows system proxy',
        'status.active': 'Permanent proxy',
        'status.blocked': 'Circuit breaker',
        'status.connections': 'Active connections',
        'status.routing': 'China routing data',
        'status.bypass': 'Apps bypassing PAC to the original proxy',
        running: 'Running',
        stopped: 'Stopped',
        blocked: 'Blocked',
        normal: 'Normal',
        'button.enable': 'Start permanent proxy',
        'button.disable': 'Stop and restore system proxy',
        'button.test': 'Test egress',
        'button.connections': 'Active connections',
        'button.latency': 'Test proxy latency',
        'button.refresh': 'Refresh',
        'section.connections': 'Active proxy connections',
        'section.latency': 'Core latency metrics',
        'connections.busy': 'Reading active connections…',
        'connections.empty': 'No active connections are using the Lightsail proxy.',
        'connections.recent': '{recent} recent connections, {failed} failed.',
        'connections.host': 'Target',
        'connections.state': 'State',
        'connections.duration': 'Duration',
        'connections.traffic': 'Traffic (in / out)',
        'connections.source': 'Local port',
        'connections.activeCount': '{count} active',
        'latency.busy': 'Measuring proxy latency…',
        'latency.empty': 'Click "Test proxy latency" to see core metrics.',
        'latency.avg': 'Average',
        'latency.p95': 'P95',
        'latency.min': 'Min / Max',
        'latency.jitter': 'Jitter',
        'latency.success': 'Success / Count',
        'latency.egress': 'Egress IP',
        'latency.breakdown': 'Proxy / TLS / TTFB',
        'button.log': 'View log',
        'button.save': 'Save settings',
        'button.start': 'Start tunnel only (no system proxy change)',
        'button.restartTunnel': 'Restart tunnel (keep system proxy)',
        'section.lightsail': 'Lightsail and SSH',
        'section.localProxy': 'Local proxy ports',
        'section.behaviour': 'Permanent proxy behaviour',
        'section.exclusions': 'Direct-connect exclusions',
        'exclusions.hint': 'Comma or newline separated. Domains accept exact names, suffixes (.example.com) and wildcards (*.example.com); IPs accept exact values and 10.* prefixes. Matching targets connect directly through the local bridge, with no proxy.',
        'label.ec2Host': 'Lightsail static IP',
        'label.ec2User': 'SSH user',
        'label.ec2Port': 'SSH port',
        'label.keyPath': 'Private key path',
        'label.socksHost': 'SOCKS5 listen address',
        'label.socksPort': 'SOCKS5 port',
        'label.proxyHost': 'HTTP proxy listen address',
        'label.proxyPort': 'HTTP proxy port',
        'label.permanentProxy': 'Enable permanent system proxy',
        'label.failClosed': 'Fail closed (never fall back to another proxy)',
        'label.excludeDomains': 'Excluded domains / ranges',
        'label.excludeSuffixes': 'Excluded suffixes',
        'label.excludeIps': 'Excluded IPs',
        'label.proxyDomains': 'Force via original proxy (when local DNS is unusable)',
        'proxyDomains.hint': 'These domains use the original proxy below even if they are domestic, instead of going DIRECT. For hosts like agentrouter.org whose local DNS resolves to 127.0.0.1.',
        'label.fallbackProxyHost': 'Original proxy host (only for the domains above)',
        'label.fallbackProxyPort': 'Original proxy port to restore',
        'hint.failClosed': 'When enabled, a Lightsail or local bridge failure makes requests fail instead of silently switching to another VPN, keeping the egress IP stable.',
        'hint.pac': 'The permanent proxy uses a local PAC file: exclusions go DIRECT, everything else uses the local HTTP proxy.',
        working: 'Working…',
        success: 'Success',
        failed: 'Failed',
        'message.saved': 'Settings saved',
        none: 'None',
      },
    };

    const API = (() => {
      try { return new URL('api/claude-ec2', document.baseURI).pathname; } catch { return '/api/claude-ec2'; }
    })();

    async function api(action, body, timeout = 90000) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout);
      try {
        const res = await fetch(`${API}/${action}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: body === undefined ? {} : { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: ctrl.signal,
          credentials: 'same-origin',
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok || payload.ok === false) throw new Error(payload.error || `HTTP ${res.status}`);
        return payload.result;
      } finally { clearTimeout(timer); }
    }

    const css = `
.cec-page { max-width: 980px; color: var(--dsw-alias-label-primary); }
.cec-head { margin-bottom: 20px; }
.cec-title { margin: 0 0 8px; font-size: 22px; font-weight: 600; }
.cec-intro { margin: 0; color: var(--dsw-alias-label-secondary); line-height: 1.6; }
.cec-card { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; padding: 20px; margin-bottom: 16px; }
.cec-card h2 { margin: 0 0 8px; font-size: 16px; font-weight: 600; }
.cec-hint { margin: 0 0 16px; font-size: 13px; color: var(--dsw-alias-label-secondary); line-height: 1.5; }
.cec-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px 20px; }
.cec-fact { padding: 8px 0; font-size: 13px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.cec-fact b { color: var(--dsw-alias-label-primary); font-weight: 500; }
.cec-badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); }
.cec-badge.ok { color: var(--dsw-alias-state-success-primary); }
.cec-badge.off { color: var(--dsw-alias-state-warn-primary); }
.cec-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 14px; }
.cec-button { padding: 8px 14px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); cursor: pointer; font: inherit; }
.cec-button:disabled { opacity: .55; cursor: not-allowed; }
.cec-button.primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); }
.cec-button.danger { color: var(--dsw-alias-state-error-primary); }
.cec-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin: 9px 0; }
.cec-row > label { min-width: 190px; color: var(--dsw-alias-label-secondary); font-size: 13px; }
.cec-input { flex: 1 1 320px; min-width: 160px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font: inherit; color-scheme: inherit; }
.cec-input:focus { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.cec-textarea { flex: 1 1 100%; min-height: 64px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font: 13px/1.5 ui-monospace, Consolas, monospace; }
.cec-switch { width: 44px; height: 24px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-state-idle-primary); position: relative; padding: 0; cursor: pointer; }
.cec-switch[aria-checked="true"] { background: var(--dsw-alias-brand-primary); }
.cec-switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: var(--dsw-alias-bg-base); transition: transform .15s ease; }
.cec-switch[aria-checked="true"]::after { transform: translateX(20px); }
.cec-message { margin-top: 14px; padding: 10px 12px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2); font-size: 13px; white-space: pre-wrap; }
.cec-message.error { color: var(--dsw-alias-state-error-primary); }
.cec-output { margin-top: 12px; max-height: 320px; overflow: auto; padding: 12px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-secondary); font: 12px/1.5 ui-monospace, Consolas, monospace; white-space: pre-wrap; }
.cec-diagnostics { margin-top: 16px; border-top: 1px solid var(--dsw-alias-border-l1); padding-top: 16px; }
.cec-diagnostics h3 { margin: 0 0 10px; font-size: 14px; font-weight: 600; }
.cec-metric-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 12px; }
.cec-metric { padding: 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-2); }
.cec-metric-label { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.cec-metric-value { margin-top: 5px; font-size: 18px; font-weight: 600; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
.cec-metric-value.small { font-size: 14px; }
.cec-list { display: flex; flex-direction: column; gap: 8px; }
.cec-list-item { display: grid; grid-template-columns: minmax(180px, 2fr) 90px 90px minmax(150px, 1fr) 90px; gap: 10px; align-items: center; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-base); font-size: 12px; }
.cec-list-head { color: var(--dsw-alias-label-secondary); font-weight: 600; background: transparent; border-color: transparent; padding-top: 2px; padding-bottom: 2px; }
.cec-list-host { font-weight: 500; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
.cec-list-muted { color: var(--dsw-alias-label-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cec-list-state { display: inline-flex; align-items: center; gap: 5px; }
.cec-list-state::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-state-success-primary); }
.cec-list-state.off::before { background: var(--dsw-alias-state-warn-primary); }
.cec-list-foot { margin-top: 10px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
@media (max-width: 760px) { .cec-list-item { grid-template-columns: 1fr 1fr; } .cec-list-head { display: none; } }
`;

    const FIELDS = [
      { section: 'section.lightsail', items: [['ec2Host', 'text'], ['ec2User', 'text'], ['ec2Port', 'number'], ['keyPath', 'text']] },
      { section: 'section.localProxy', items: [['socksHost', 'text'], ['socksPort', 'number'], ['proxyHost', 'text'], ['proxyPort', 'number']] },
      { section: 'section.behaviour', items: [['fallbackProxyHost', 'text'], ['fallbackProxyPort', 'number']] },
    ];

    function Button(props) {
      return h('button', {
        className: `cec-button${props.primary ? ' primary' : ''}${props.danger ? ' danger' : ''}`,
        disabled: props.disabled,
        onClick: props.onClick,
        type: 'button',
      }, props.children);
    }

    function Field(props) {
      return h('div', { className: 'cec-row' },
        h('label', { htmlFor: props.id }, props.label),
        h('input', {
          id: props.id, className: 'cec-input', type: props.type || 'text',
          value: props.value ?? '', placeholder: props.placeholder,
          onChange: event => props.onChange(props.type === 'number' ? Number(event.target.value) : event.target.value),
        }));
    }

    function TextArea(props) {
      return h('div', { className: 'cec-row' },
        h('label', { htmlFor: props.id }, props.label),
        h('textarea', {
          id: props.id, className: 'cec-textarea', value: props.value ?? '',
          onChange: event => props.onChange(event.target.value),
        }));
    }

    function Switch(props) {
      return h('button', {
        type: 'button', className: 'cec-switch', role: 'switch',
        'aria-checked': String(Boolean(props.checked)), 'aria-label': props.label,
        disabled: props.disabled, onClick: props.onChange,
      });
    }

    function pretty(value) {
      return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    }

    function formatDuration(ms) {
      const value = Number(ms) || 0;
      if (value < 1000) return `${Math.round(value)} ms`;
      if (value < 60000) return `${(value / 1000).toFixed(1)} s`;
      const minutes = Math.floor(value / 60000);
      const seconds = Math.round((value % 60000) / 1000);
      return `${minutes}m ${seconds}s`;
    }

    function formatBytes(bytes) {
      const value = Number(bytes) || 0;
      if (value < 1024) return `${value} B`;
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
      return `${(value / 1024 / 1024).toFixed(1)} MB`;
    }

    function formatMs(value) {
      return Number.isFinite(Number(value)) ? `${Number(value)} ms` : '—';
    }

    function renderLatency(result, t) {
      if (!result) return h('p', { className: 'cec-hint' }, t('latency.empty'));
      const metrics = [
        [t('latency.avg'), formatMs(result.avgMs)],
        [t('latency.p95'), formatMs(result.p95Ms)],
        [t('latency.min'), `${formatMs(result.minMs)} / ${formatMs(result.maxMs)}`],
        [t('latency.jitter'), formatMs(result.jitterMs)],
        [t('latency.success'), `${result.success ?? 0} / ${result.count ?? 0}`],
        [t('latency.egress'), result.egressIp || t('none')],
        [t('latency.breakdown'), `${formatMs(result.avgProxyConnectMs)} / ${formatMs(result.avgTlsMs)} / ${formatMs(result.avgTtfbMs)}`],
      ];
      return h('div', { className: 'cec-metric-grid' }, metrics.map(([label, value]) =>
        h('div', { className: 'cec-metric', key: label },
          h('div', { className: 'cec-metric-label' }, label),
          h('div', { className: `cec-metric-value${String(value).length > 10 ? ' small' : ''}` }, value))));
    }

    function renderConnection(conn, t) {
      const stateClass = conn.state === 'established' ? '' : ' off';
      return h('div', { className: 'cec-list-item', key: `${conn.id}-${conn.startedAt}` },
        h('div', { className: 'cec-list-host', title: conn.host }, `${conn.host}:${conn.port}`),
        h('div', { className: `cec-list-state${stateClass}` }, conn.state || t('none')),
        h('div', { className: 'cec-list-muted' }, formatDuration(conn.durationMs)),
        h('div', { className: 'cec-list-muted' }, `${formatBytes(conn.bytesIn)} / ${formatBytes(conn.bytesOut)}`),
        h('div', { className: 'cec-list-muted' }, conn.localPort || t('none')));
    }

    function renderConnections(result, t) {
      if (!result) return h('p', { className: 'cec-hint' }, t('connections.empty'));
      const active = result.active || [];
      const recent = result.recent || [];
      const failed = recent.filter(conn => conn.finalState === 'failed' || conn.error).length;
      return h('div', null,
        h('div', { className: 'cec-list' },
          h('div', { className: 'cec-list-item cec-list-head' },
            h('div', null, t('connections.host')),
            h('div', null, t('connections.state')),
            h('div', null, t('connections.duration')),
            h('div', null, t('connections.traffic')),
            h('div', null, t('connections.source'))),
          active.length
            ? active.map(conn => renderConnection(conn, t))
            : h('div', { className: 'cec-hint' }, t('connections.empty'))),
        h('div', { className: 'cec-list-foot' },
          t('connections.activeCount').replace('{count}', active.length),
          ' · ',
          t('connections.recent').replace('{recent}', recent.length).replace('{failed}', failed)));
    }

    function SettingsPage(props) {
      const ctx = props.ctx;
      const t = ctx.locale.bind(NS);
      const [status, setStatus] = useState(undefined);
      const [form, setForm] = useState({});
      const [busy, setBusy] = useState('');
      const [message, setMessage] = useState('');
      const [isError, setIsError] = useState(false);
      const [output, setOutput] = useState('');
      const [connectionsResult, setConnectionsResult] = useState(null);
      const [latencyResult, setLatencyResult] = useState(null);

      const notify = useCallback((value, error = false) => {
        setMessage(value);
        setIsError(error);
      }, []);

      const load = useCallback(async () => {
        try {
          const value = await api('status');
          setStatus(value);
          setForm({ ...value.settings });
          if (value.connections?.available) setConnectionsResult(value.connections);
          setMessage('');
          setIsError(false);
        } catch (error) { notify(`${t('loadFailed')}: ${error.message}`, true); }
      }, [notify, t]);

      useEffect(() => { void load(); }, [load]);

      const run = useCallback(async (label, operation, mode = null, successText = null) => {
        setBusy(label);
        setMessage('');
        setIsError(false);
        if (mode === 'text') setOutput('');
        try {
          const result = await operation();
          if (mode === 'text') setOutput(pretty(result));
          if (mode === 'connections') setConnectionsResult(result);
          if (mode === 'latency') setLatencyResult(result);
          await load();
          notify(successText || t('success'));
        } catch (error) { notify(`${t('failed')}: ${error.message}`, true); }
        finally { setBusy(''); }
      }, [load, notify, t]);

      const update = key => value => setForm(prev => ({ ...prev, [key]: value }));
      const working = busy !== '';
      const running = status?.running || {};
      const badge = value => h('span', { className: `cec-badge ${value ? 'ok' : 'off'}` }, value ? t('running') : t('stopped'));

      return h('div', { className: 'cec-page' },
        h('style', null, css),
        h('div', { className: 'cec-head' },
          h('h1', { className: 'cec-title' }, t('title')),
          h('p', { className: 'cec-intro' }, t('intro'))),

        status === undefined && h('div', { className: 'cec-card' }, t('loading')),

        status !== undefined && h('div', { className: 'cec-card' },
          h('h2', null, t('section.status')),
          h('div', { className: 'cec-grid' },
            h('div', { className: 'cec-fact' }, `${t('status.ssh')}: `, badge(running.ssh)),
            h('div', { className: 'cec-fact' }, `${t('status.bridge')}: `, badge(running.bridge)),
            h('div', { className: 'cec-fact' }, `${t('status.socks')}: `, h('b', null, running.socksListener ? `${form.socksHost}:${form.socksPort}` : t('stopped'))),
            h('div', { className: 'cec-fact' }, `${t('status.egress')}: `, h('b', null, status.egressIp || t('none'))),
            h('div', { className: 'cec-fact' }, `${t('status.expected')}: `, h('b', null, status.expectedIp)),
            h('div', { className: 'cec-fact' }, `${t('status.systemProxy')}: `, h('b', null,
              status.systemProxy?.autoConfigUrl || status.systemProxy?.proxyServer || t('none'))),
            h('div', { className: 'cec-fact' }, `${t('status.active')}: `, badge(status.active)),
            h('div', { className: 'cec-fact' }, `${t('status.blocked')}: `, h('span', { className: `cec-badge ${status.blocked ? 'off' : 'ok'}` }, status.blocked ? `${t('blocked')} · ${status.blockedReason || ''}` : t('normal'))),
            h('div', { className: 'cec-fact' }, `${t('status.connections')}: `, h('b', null, status.connections?.counts?.active ?? t('none'))),
            h('div', { className: 'cec-fact' }, `${t('status.routing')}: `, h('b', null, status.routing?.available ? `${status.routing.chinaDomains} 域名 / ${status.routing.chinaRanges} IP段` : t('none'))),
            h('div', { className: 'cec-fact' }, `${t('status.bypass')}: `, h('b', null, status.bypassingPac?.total ? `${status.bypassingPac.clients.map(c => `${c.process}×${c.connections}`).join(', ')}` : t('none')))),
          h('div', { className: 'cec-actions' },
            h(Button, { primary: true, disabled: working, onClick: () => run('enable', () => api('permanentProxyOn', {})) }, t('button.enable')),
            h(Button, { danger: true, disabled: working, onClick: () => run('disable', () => api('permanentProxyOff', {})) }, t('button.disable')),
            h(Button, { disabled: working, onClick: () => run('start', () => api('startTunnel', {})) }, t('button.start')),
            h(Button, { disabled: working, onClick: () => run('restartTunnel', () => api('restartTunnel', {}), 'text') }, t('button.restartTunnel')),
            h(Button, { disabled: working, onClick: () => run('test', () => api('test', {}), 'text') }, t('button.test')),
            h(Button, { disabled: working, onClick: () => run('connections', () => api('connections', {}), 'connections') }, t('button.connections')),
            h(Button, { disabled: working, onClick: () => run('latency', () => api('latency', { count: 5 }), 'latency') }, t('button.latency')),
            h(Button, { disabled: working, onClick: () => void load() }, t('button.refresh')),
            h(Button, { disabled: working, onClick: () => run('log', async () => { const r = await api('log', { limit: 120 }); return r.lines.length ? r.lines.join('\n') : t('none'); }, 'text') }, t('button.log')))),

        status !== undefined && h('div', { className: 'cec-card' },
          h('h2', null, t('section.exclusions')),
          h('p', { className: 'cec-hint' }, t('exclusions.hint')),
          h(TextArea, { id: 'cec-excludeDomains', label: t('label.excludeDomains'), value: form.excludeDomains, onChange: update('excludeDomains') }),
          h(TextArea, { id: 'cec-excludeSuffixes', label: t('label.excludeSuffixes'), value: form.excludeSuffixes, onChange: update('excludeSuffixes') }),
          h(TextArea, { id: 'cec-excludeIps', label: t('label.excludeIps'), value: form.excludeIps, onChange: update('excludeIps') }),
          h(TextArea, { id: 'cec-proxyDomains', label: t('label.proxyDomains'), value: form.proxyDomains, onChange: update('proxyDomains') }),
          h('p', { className: 'cec-hint', style: { marginTop: 6 } }, t('proxyDomains.hint')),
          h('p', { className: 'cec-hint', style: { marginTop: 10 } }, t('hint.pac'))),

        status !== undefined && h('div', { className: 'cec-card' },
          h('h2', null, t('section.behaviour')),
          h('div', { className: 'cec-row' },
            h('label', null, t('label.permanentProxy')),
            h(Switch, { checked: Boolean(form.permanentProxy), label: t('label.permanentProxy'), disabled: working, onChange: () => update('permanentProxy')(!form.permanentProxy) })),
          h('div', { className: 'cec-row' },
            h('label', null, t('label.failClosed')),
            h(Switch, { checked: Boolean(form.failClosed), label: t('label.failClosed'), disabled: working, onChange: () => update('failClosed')(!form.failClosed) })),
          h('p', { className: 'cec-hint' }, t('hint.failClosed'))),

        status !== undefined && FIELDS.map(group => h('div', { className: 'cec-card', key: group.section },
          h('h2', null, t(group.section)),
          group.items.map(([key, type]) => h(Field, {
            key, id: `cec-${key}`, label: t(`label.${key}`), type,
            value: form[key], onChange: update(key),
          })))),

        status !== undefined && h('div', { className: 'cec-card' },
          h('div', { className: 'cec-actions' },
            h(Button, { primary: true, disabled: working, onClick: () => run('save', () => api('saveSettings', form), false, t('message.saved')) }, t('button.save')),
            h(Button, { disabled: working, onClick: () => setForm({ ...status.settings }) }, t('button.refresh')))),

        status !== undefined && h('div', { className: 'cec-card' },
          h('h2', null, t('section.connections')),
          busy === 'connections' ? h('p', { className: 'cec-hint' }, t('connections.busy')) : renderConnections(connectionsResult, t)),

        status !== undefined && h('div', { className: 'cec-card' },
          h('h2', null, t('section.latency')),
          busy === 'latency' ? h('p', { className: 'cec-hint' }, t('latency.busy')) : renderLatency(latencyResult, t)),

        message && h('div', { className: `cec-message${isError ? ' error' : ''}` }, message),
        output && h('pre', { className: 'cec-output' }, output));
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'claude-ec2: dictionaries');
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'claude-ec2',
          order: 62,
          label: () => ctx.locale.bind(NS)('nav'),
          locale: NS,
        }, props => h(SettingsPage, { ...props, ctx })));
      },
    };
  },
});
