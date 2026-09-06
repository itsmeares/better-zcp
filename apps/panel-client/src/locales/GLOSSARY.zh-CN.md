# Simplified Chinese (zh-CN) translation glossary

The panel's Chinese locale was written by several people at once. This file is the shared
vocabulary they worked from. **Use these renderings.** Consistency across screens matters more here
than any individual word being the nicest possible choice — an operator who sees 服务器 on one
screen and 伺服器 on the next has to stop and work out whether they mean the same thing.

If you need a term that is not here and it will appear in more than one namespace, add it to this
file in the same commit as the strings that use it.

## Do not translate

Product and protocol names stay in Latin script:

`Project Zomboid`, `SteamCMD`, `Steam`, `Workshop ID`, `Docker`, `RCON`, `OIDC`, `PanelBridge`,
`Discord`, `SFTP`, `Lua`, `INI`, `UID`, `GID`, `URL`, `API`.

Also never translated: file paths, folder names, environment variable names, error codes
(`EACCES`), command names, and anything inside `{{double braces}}`.

## Core vocabulary

| English | zh-CN | Note |
| --- | --- | --- |
| server | 服务器 | |
| the panel | 面板 | this application, as distinct from the game server |
| player | 玩家 | |
| mod | 模组 | |
| Workshop | 创意工坊 | Steam's, when referring to the storefront rather than an ID |
| save / savegame | 存档 | |
| world | 世界 | |
| world map | 世界地图 | |
| chunk | 区块 | map storage unit |
| region | 区域 | |
| sandbox | 沙盒 | as in SandboxVars |
| backup | 备份 | |
| template | 模板 | |
| schedule / scheduled task | 计划任务 | |
| console | 控制台 | |
| log | 日志 | |
| diagnostics | 诊断 | |
| dashboard | 仪表盘 | |
| settings | 设置 | |
| conflict | 冲突 | |
| dependency | 依赖 | |
| My Servers (nav item) | 我的服务器 | |
| Panel Settings (nav item) | 面板设置 | |
| safehouse | 安全屋 | Project Zomboid player-base concept |
| utilities (water/power) | 水电 | Project Zomboid world-decay system |

## Access control

| English | zh-CN | Note |
| --- | --- | --- |
| user | 用户 | |
| role | 角色 | |
| permission | 权限 | |
| capability | 权限项 | one tickable row in the rights matrix |
| administrator / admin | 管理员 | |
| moderator | 协管员 | deliberately distinct from 管理员 |
| technician | 技术员 | |
| sign in | 登录 | |
| sign out | 退出登录 | |
| password | 密码 | |
| token | 令牌 | |
| session | 会话 | |
| single sign-on | 单点登录 | |

## Actions

| English | zh-CN | Note |
| --- | --- | --- |
| start | 启动 | |
| stop | 停止 | |
| restart | 重启 | |
| install | 安装 | |
| update | 更新 | |
| verify | 校验 | as in verifying game files |
| enable / disable | 启用 / 禁用 | |
| kick | 踢出 | |
| ban / unban | 封禁 / 解封 | |
| whitelist | 白名单 | |
| wipe | 清除 | destructive — never soften to 重置 ("reset") |
| delete | 删除 | |
| save (verb) | 保存 | not 存档, which is the noun above |
| apply | 应用 | |
| retry | 重试 | |

## Status words

| English | zh-CN |
| --- | --- |
| succeeded / success | 成功 |
| failed / failure | 失败 |
| error | 错误 |
| warning | 警告 |
| running | 运行中 |
| stopped | 已停止 |
| unavailable | 不可用 |
| not configured | 未配置 |
| unknown | 未知 |

## Style rules

- **Full-width punctuation.** Use `，。：；？！（）「」` rather than ASCII `,.:;?!()`. The exception is
  punctuation inside a path, code identifier, URL, or placeholder, which stays as written.
- **No space between Chinese characters and Latin text.** Write `安装 SteamCMD` with a single normal
  space around the Latin run — do not add extra spacing, and do not remove it entirely.
- **No plural forms.** Chinese does not inflect for number. Where English has `_one` / `_other`
  variants, both keys must still exist (the parity test requires identical key sets) and both take
  the same Chinese text.
- **Imperative, not polite-formal.** This is an operations tool used mid-incident. `重启服务器`, not
  `请您重启服务器`.
- **Keep destructive wording destructive.** A confirmation dialog that sounds reassuring in Chinese
  when it was alarming in English is a bug, not a translation choice. This has already happened once
  in French, where "Wipe server" was rendered as "reset".

## Discord and PanelBridge (added after the first pass — these recur)

| English | zh-CN | Note |
| --- | --- | --- |
| Bot (the Discord bot) | 机器人 | 30+ occurrences in discord.json alone |
| Guild (Server) ID | 服务器（Guild）ID | keep the Guild parenthetical — it is Discord's own Developer Portal term |
| Intents / Privileged Gateway Intents | 意图 / 特权网关意图 | established Discord bot-developer terminology |
| bridge (generic, lowercase) | 桥接 | but **PanelBridge** the product name stays literal |
| GM | GM | established acronym in Chinese gaming communities; do not expand |
| Overseer / Observer | 监督者 / 观察者 | Project Zomboid access levels |

Left untranslated as game-literal tokens: Project Zomboid's chat scopes (General, Say, Local,
Shout, Q shouts), the `[ADMIN]` / `[SAY]` / `[FACTION]` / `[SAFEHOUSE]` chat tags, `SERVER.INI` and
`SANDBOX` section labels, and `iso` in "iso regions" (the engine's own `Iso*` class prefix).
