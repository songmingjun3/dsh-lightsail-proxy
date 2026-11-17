# dsh-claude-ec2 · Lightsail 常驻代理

DeepSeek Harness 插件：把 Windows 系统代理固定指向本机 HTTP 桥，再由 SSH SOCKS5 从 **AWS Lightsail** 出网。支持“排除规则”：本机/局域网直连，指定公网域名改走原代理，其余流量（含 Claude、GitHub 等）全部走 Lightsail。

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
  -> 系统 PAC（本机 DIRECT，排除的公网域名走原代理）
  -> 127.0.0.1:8088 HTTP CONNECT 桥
  -> 127.0.0.1:1080 SSH SOCKS5
  -> Lightsail <YOUR_LIGHTSAIL_IP>
  -> 目标站点
```

## 功能

- **常驻代理**：系统代理长期指向本机桥，不需要在 `7890` / `8088` 之间来回切换。
- **排除规则**：在设置页配置域名、后缀、IP；本机/局域网命中后 `DIRECT`，公网排除项走原代理（默认 `127.0.0.1:7890`），其余走 Lightsail。
- **fail-closed**：Lightsail 或本地桥断开时访问失败，不会偷偷回落到其他 VPN，出口 IP 保持稳定。
- **一键恢复**：关闭常驻代理时恢复原始系统代理（默认 `127.0.0.1:7890`，可在设置页修改）。
- **状态与测试**：显示 SSH/桥/出口 IP、PAC 路径、当前排除规则，并可测试 `claude.ai`、`api.anthropic.com`、`api.github.com`。
- **活跃链接**：查看当前经 `8088` 桥的 CONNECT/HTTP 链接：目标域名、端口、持续时间、收发字节、最近结束的 30 条连接。
- **代理延迟**：多次经 `8088 → SOCKS5 → Lightsail` 探测 HTTPS 目标，统计代理连接耗时、TLS 握手、TTFB、总延迟、最小/最大/P50/P95/抖动。
- **agent 工具**：`claude_lightsail_proxy`，动作 `status`、`saveSettings`、`startTunnel`、`permanentProxyOn`、`permanentProxyOff`、`stop`、`test`、`connections`、`latency`、`log`。

## 自动分流（境内 / 境外）

路由决策由本地 `8088` 桥统一完成，PAC 只负责把本机与局域网放行直连：

```text
localhost / 127.* / 10.* / 172.16-31.* / 192.168.* / .local -> DIRECT
中国域名 / 中国 IP（离线库）        -> 原代理 127.0.0.1:7890
用户排除规则命中的公网域名/后缀/IP  -> 原代理 127.0.0.1:7890
其他所有流量（Claude / GitHub 等）  -> Lightsail <YOUR_LIGHTSAIL_IP>
```

离线分流库位于 `data/china-routes.json`，由两份公开列表生成：

| 数据 | 来源 | 规模 |
|---|---|---|
| 中国 IPv4 段 | `17mon/china_ip_list` | 约 4,700 个合并网段 |
| 中国域名 | `felixonmars/dnsmasq-china-list` | 约 10.9 万条 |

本地桥对域名做后缀匹配、对 IPv4 字面量做区间二分查找、对普通域名先用本机 DNS 解析再判断是否落在国内网段。因此无需手工把 `baidu.com`、`qq.com`、`aliyuncs.com` 等逐个写进排除规则。

已实测：

```text
www.baidu.com      -> fallback 127.0.0.1:7890
www.qq.com         -> fallback 127.0.0.1:7890
223.5.5.5          -> fallback 127.0.0.1:7890
api.github.com     -> lightsail
chatgpt.com        -> lightsail
```

## 排除规则写法（可选覆盖）

自动分流已覆盖绝大多数境内站点，排除规则用于纠正误判或强制指定：

| 字段 | 示例 | 含义 |
|---|---|---|
| 排除的域名 / 网段 | `agentrouter.org` | 命中即走原代理，不走 Lightsail |
| 排除的后缀 | `.aliyuncs.com,.alicdn.com` | 后缀匹配走原代理 |
| 排除的 IP | `203.0.113.10` | 精确公网 IP 走原代理 |

保存后立即重建 PAC 并递增 `AutoConfigURL` 版本号，强制 Windows 丢弃旧缓存。排除规则同时下发给本地桥，PAC 与桥不会出现两套判断。

注意：PAC 只影响系统代理客户端；直接访问 `127.0.0.1:8088` 的客户端同样经过桥的分流逻辑。

## 局限

- 域名命中依赖离线库，库外的新域名会按 DNS 解析结果落入国内网段才判定为境内。
- 仅覆盖 IPv4 网段判断；纯 IPv6 目标按域名库匹配。
- 若原代理 `7890` 不可用，境内流量会失败，不会改走 Lightsail。

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

插件重载或调试时，不要用“关闭常驻代理”再“启动”的流程：中间会有一段系统代理被恢复成 `127.0.0.1:7890`，Chrome、ChatGPT、Codex 等程序会在这个窗口内建立长连接，之后即使 PAC 恢复也会继续复用旧连接，看起来像“分流失效”。

改用设置页的 **重启隧道（不动系统代理）**，或 agent 动作：

```text
restartTunnel
```

它只做三件事：

1. 停掉本机 `1080` SSH 与 `8088` 桥；
2. 重新拉起并校验出口 IP；
3. 重写 PAC 文件内容，但 **不改 `AutoConfigURL`**。

结果：`ProxyEnable`、`ProxyServer`、`AutoConfigURL` 全程保持不变，其他程序不会趁机改走原代理。

状态页的“绕过 PAC 直连原代理的程序”会列出仍直连 `7890` 的进程（Chrome、MOTTY、PyCharm 等），刷新这些程序的连接后即可回到 Lightsail。

## 回退

- 点“关闭常驻代理并恢复”：恢复原始系统代理并停止本地桥/SSH。
- 手动恢复：设置 → 网络代理改为 `127.0.0.1:7890`，清空 PAC。

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
