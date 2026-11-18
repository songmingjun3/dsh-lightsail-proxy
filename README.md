# dsh-claude-ec2 · Lightsail 常驻代理

DeepSeek Harness 插件：把 Windows 系统代理固定指向本机 HTTP 桥，再由 SSH SOCKS5 从 **AWS Lightsail** 出网。三态分流：本机/局域网与境内流量直连，指定域名强制走原代理，其余流量（含 Claude、GitHub 等）走 Lightsail。

## 当前配置（唯一保留的部署）

```text
Lightsail 静态 IP : <YOUR_LIGHTSAIL_IP>
SSH 用户          : ubuntu
私钥              : <YOUR_PRIVATE_KEY_PATH>
本地 SOCKS5       : 127.0.0.1:1080
本地 HTTP 代理    : 127.0.0.1:8088
系统代理          : PAC http://127.0.0.1:8088/lightsail.pac
                    ProxyServer 兜底 127.0.0.1:8088（PAC 未加载时仍不会回落 7890）
```

链路：

```text
应用 / 浏览器 / Claude Desktop
  -> 系统 PAC（本机/局域网 DIRECT，其余交给本地桥）
  -> 127.0.0.1:8088 HTTP CONNECT 桥
       ├─ 境内域名/IP、排除项 -> DIRECT 直连
       └─ 其他（Claude/GitHub/agentrouter 等所有公网）-> 127.0.0.1:1080 SSH SOCKS5 -> Lightsail <YOUR_LIGHTSAIL_IP>
  -> 目标站点
```

## 功能

- **常驻代理**：系统代理长期指向本机桥，不再依赖 `7890`。
- **两态分流**：本机/局域网与境内域名/IP `DIRECT` 直连；其余所有公网域名（含 Claude、GitHub、agentrouter）全部走 Lightsail，出口 IP 固定。
- **fail-closed**：关闭常驻代理或隧道异常时，系统代理仍指向已停止的 `8088`，访问直接失败，绝不回落到直连导致 IP 漂移。
- **显式恢复直连**：只有点“恢复直连”才会清空系统代理、恢复正常上网。
- **fd 泄漏防护**：握手阶段 socket 可被取消，连接数上限 512，接近上限时自动重建进程，避免 `Too many open files`。
- **状态与测试**：显示 SSH/桥/出口 IP、PAC 路径、当前排除规则，并可测试 `claude.ai`、`api.anthropic.com`、`api.github.com`。
- **活跃链接**：查看当前经 `8088` 桥的 CONNECT/HTTP 链接：目标域名、端口、持续时间、收发字节、最近结束的 30 条连接。
- **代理延迟**：多次经 `8088 → SOCKS5 → Lightsail` 探测 HTTPS 目标，统计代理连接耗时、TLS 握手、TTFB、总延迟、最小/最大/P50/P95/抖动。
- **agent 工具**：`claude_lightsail_proxy`，动作 `status`、`saveSettings`、`startTunnel`、`restartTunnel`、`permanentProxyOn`、`permanentProxyOff`、`restoreDirect`、`stop`、`test`、`connections`、`latency`、`log`。

## 自动分流（境内 / 境外）

路由决策由本地 `8088` 桥统一完成，PAC 只负责把本机与局域网放行直连：

```text
localhost / 127.* / 10.* / 172.16-31.* / 192.168.* / .local -> DIRECT
中国域名 / 中国 IP（离线库）        -> DIRECT
用户排除规则命中的域名/后缀/IP      -> DIRECT
其他所有流量（Claude/GitHub/agentrouter 等）-> Lightsail <YOUR_LIGHTSAIL_IP>
```

离线分流库位于 `data/china-routes.json`，由两份公开列表生成：

| 数据 | 来源 | 规模 |
|---|---|---|
| 中国 IPv4 段 | `17mon/china_ip_list` | 约 4,700 个合并网段 |
| 中国域名 | `felixonmars/dnsmasq-china-list` | 约 10.9 万条 |

本地桥对域名做后缀匹配、对 IPv4 字面量做区间二分查找、对普通域名先用本机 DNS 解析再判断是否落在国内网段。因此无需手工把 `baidu.com`、`qq.com`、`aliyuncs.com` 等逐个写进排除规则。

已实测：

```text
www.baidu.com      -> direct
www.qq.com         -> direct
223.5.5.5          -> direct
api.github.com     -> lightsail
chatgpt.com        -> lightsail
agentrouter.org    -> lightsail（本机 DNS 被污染到 127.0.0.1，但 Lightsail 侧 DNS 正常）
```

## 排除规则

| 字段 | 示例 | 含义 |
|---|---|---|
| 排除的域名 / 网段 | `localhost,10.*,192.168.*` | 命中即直连，不经过任何代理 |
| 排除的后缀 | `.aliyuncs.com,.alicdn.com` | 后缀匹配直连 |
| 排除的 IP | `203.0.113.10` | 精确公网 IP 直连 |

`agentrouter.org` 本机 DNS 被污染到 `127.0.0.1`，且直连真实 IP 时 TLS 会被 RST，因此不做本机 hosts/DNS 修改，统一由 Lightsail 侧解析和访问，出口固定。

`proxyDomains` 字段保留但默认为空（不再使用 7890）。

保存后立即重建 PAC 并递增 `AutoConfigURL` 版本号，强制 Windows 丢弃旧缓存。路由规则同时下发给本地桥，PAC 与桥不会出现两套判断。

注意：PAC 只影响系统代理客户端；直接访问 `127.0.0.1:8088` 的客户端同样经过桥的分流逻辑。

## 关闭与恢复（fail-closed）

- **关闭常驻代理（阻断流量）** / `stop` / `permanentProxyOff`：停止 SSH 和桥，系统代理仍指向 `127.0.0.1:8088`（此时无监听）。Claude 等所有走代理的流量直接失败，不回落到直连，出口 IP 不会漂移。
- **恢复直连（停止阻断）** / `restoreDirect`：清空系统代理，让本机恢复正常直连上网。只有这个动作才会真正放开流量。

## 局限

- 域名命中依赖离线库，库外的新域名会按 DNS 解析结果落入国内网段才判定为境内。
- 仅覆盖 IPv4 网段判断；纯 IPv6 目标按域名库匹配。

## 安装与启用

插件已在当前 profile 注册为本地 bundle：

```json
"dsh-claude-ec2": "link:E:/DSHWork/dsh-claude-ec2"
```

在 DSH 设置 → **Lightsail 代理**：

1. 确认 Lightsail IP、SSH 用户、私钥路径；
2. 按需调整排除规则；
3. 点“启动常驻代理”；
4. 用“测试出口”确认 `Lightsail 出口 IP` 等于配置的 IP；
5. 用“查看活跃链接”检查当前代理连接，用“测试代理延迟”检查经 Lightsail 的链路质量。

## 重启隧道（不动系统代理）

插件重载或调试时，不要用“关闭常驻代理”再“启动”的流程：中间会有一段系统代理指向已停止的桥，其他程序的连接状态会混乱。

改用设置页的 **重启隧道（不动系统代理）**，或 agent 动作：

```text
restartTunnel
```

它只做三件事：

1. 停掉本机 `1080` SSH 与 `8088` 桥；
2. 重新拉起并校验出口 IP；
3. 重写 PAC 文件内容，但 **不改 `AutoConfigURL`**。

结果：`ProxyEnable`、`ProxyServer`、`AutoConfigURL` 全程保持不变，其他程序不会趁机改走别的出口。

状态页的“绕过 PAC 直连原代理的程序”会列出仍直连旧代理端口的进程，刷新这些程序的连接后即可回到 Lightsail。

## 回退 / 恢复上网

- **关闭常驻代理（阻断流量）** / `stop`：停止本地桥/SSH，代理指向死端口，所有代理流量失败（fail-closed，防 IP 漂移）。
- **恢复直连（停止阻断）** / `restoreDirect`：清空系统代理，恢复正常直连上网。
- 手动恢复直连：Windows 设置 → 网络和 Internet → 代理 → 全部关闭。

## Lightsail 侧要求

- `sshd` 允许 TCP 转发：`AllowTcpForwarding yes`、`PermitOpen any`（默认即满足）；
- Lightsail 防火墙允许你的本机公网 IP 访问 22；
- 若要 Claude 组织 IP allowlist，请把 `<YOUR_LIGHTSAIL_IP>/32` 加入允许列表。

## 已清理的旧配置

以下内容已删除，不再使用：

- 旧 EC2 `<OLD_EC2_IP>` / `<OLD_EC2_IP2>` 及其密钥 `<OLD_KEY_FILE>`；
- CloudFront 隧道源站服务与 `<OLD_CLOUDFRONT_DOMAIN>` 配置；
- `vpn-ssh-relay`（7890→SSH 中转）、`cloudfront-tunnel.py`；
- 专用 Edge 窗口、Claude Desktop 专用 profile、登录/外跳临时代理等旧按钮；
- `E:\DSHWork\claude-ec2` 旧 PowerShell 脚本包。
