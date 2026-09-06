# Traditional Chinese, Taiwan (zh-TW) translation glossary

The panel already ships Simplified Chinese (`zh-CN`). This locale is Traditional
Chinese with Taiwan usage, converted from zh-CN then overlaid with the table
below. **Use these renderings.** Consistency across screens matters more here
than any individual word being the nicest possible choice — an operator who sees
伺服器 on one screen and 服務器 on the next has to stop and work out whether they
mean the same thing.

If you need a term that is not here and it will appear in more than one namespace, add it to this
file in the same change as the strings that use it.

## Do not translate

Product and protocol names stay in Latin script:

`Project Zomboid`, `SteamCMD`, `Steam`, `Workshop ID`, `Docker`, `RCON`, `OIDC`, `PanelBridge`,
`Discord`, `SFTP`, `Lua`, `INI`, `UID`, `GID`, `URL`, `API`.

Also never translated: file paths, folder names, environment variable names, error codes
(`EACCES`), command names, and anything inside `{{double braces}}`.

## Core vocabulary

| English | zh-TW | Note |
| --- | --- | --- |
| server | 伺服器 | not 服務器 |
| the panel | 面板 | this application, as distinct from the game server |
| player | 玩家 | |
| mod | 模組 | |
| Workshop | 創意工坊 | Steam's, when referring to the storefront rather than an ID |
| save / savegame | 存檔 | |
| world | 世界 | |
| world map | 世界地圖 | |
| chunk | 區塊 | map storage unit |
| region | 區域 | |
| sandbox | 沙盒 | as in SandboxVars |
| zombie | 殭屍 | not 喪屍 (matches whole panel and Taiwan community usage) |
| backup | 備份 | |
| template | 模板 | |
| schedule / scheduled task | 排程任務 | zh-CN uses 计划任务; Taiwan UI says 排程 |
| console | 主控台 | |
| log | 日誌 | |
| diagnostics | 診斷 | |
| dashboard | 儀表板 | not 儀表盤 |
| settings | 設定 | not 設置 |
| conflict | 衝突 | |
| dependency | 相依 | |
| My Servers (nav item) | 我的伺服器 | |
| Panel Settings (nav item) | 面板設定 | |
| safehouse | 安全屋 | Project Zomboid player-base concept |
| utilities (water/power) | 水電 | Project Zomboid world-decay system |
| file | 檔案 | not 文件 |
| folder | 資料夾 | not 文件夾 |
| default | 預設 | not 默認 |
| software | 軟體 | not 軟件 |
| network | 網路 | not 網絡 |
| information | 資訊 | not 信息 |
| data | 資料 | not 數據 |
| memory | 記憶體 | not 內存 |
| program | 程式 | not 程序 when meaning software |
| quality | 品質 | not 質量 |
| video | 影片 | not 視頻 |
| configuration (noun) | 設定 / 設定檔 / 組態 | avoid 配置; use 設定 for general configuration, 設定檔 for config files/profiles |
| general (settings / group) | 一般 | not 常規 (zh-CN uses 常规; Taiwan UI says 一般) |
| navigation | 導覽 / 移動 | not 導航 unless referring to vehicular/GPS navigation; use 導覽 for menus/sections and 移動 for list keyboard cues |

## Access control

| English | zh-TW | Note |
| --- | --- | --- |
| user | 使用者 | not 用戶 |
| role | 角色 | |
| permission | 權限 | |
| capability | 權限項目 | one tickable row in the rights matrix |
| administrator / admin | 管理員 | |
| moderator | 協管員 | deliberately distinct from 管理員 |
| technician | 技術員 | |
| sign in | 登入 | not 登錄 |
| sign out | 登出 | zh-CN 退出登录 → 登出 |
| password | 密碼 | |
| token | 權杖 | OpenCC may emit 令牌; overlay to 權杖 only if it does not already appear as an established 令牌 in a protocol sense. Prefer 權杖 for UI. If a string is clearly the OIDC/API token noun next to `OIDC`, 權杖 is still correct. |
| session | 工作階段 | |
| single sign-on | 單一登入 | |

## Actions

| English | zh-TW | Note |
| --- | --- | --- |
| start | 啟動 | |
| stop | 停止 | |
| restart | 重新啟動 | zh-CN 重启 → 重新啟動 |
| install | 安裝 | |
| update | 更新 | |
| verify | 校驗 | as in verifying game files |
| enable / disable | 啟用 / 停用 | 停用 not 禁用 |
| kick | 踢出 | |
| ban / unban | 封鎖 / 解除封鎖 | |
| whitelist | 白名單 | |
| wipe | 清除 | destructive — never soften to 重置 ("reset") |
| delete | 刪除 | |
| save (verb) | 儲存 | not 存檔, which is the noun above; not 保存 |
| apply | 套用 | |
| retry | 重試 | |

## Status words

| English | zh-TW |
| --- | --- |
| succeeded / success | 成功 |
| failed / failure | 失敗 |
| error | 錯誤 |
| warning | 警告 |
| running | 執行中 |
| stopped | 已停止 |
| unavailable | 無法使用 |
| not configured | 尚未設定 |
| unknown | 未知 |

## Style rules

- **Full-width punctuation.** Use `，。：；？！（）「」` rather than ASCII `,.:;?!()`. The exception is
  punctuation inside a path, code identifier, URL, or placeholder, which stays as written.
- **One space between Chinese characters and Latin text.** Write `安裝 SteamCMD` with a single normal
  space around the Latin run — do not add extra spacing, and do not remove it entirely.
- **No plural forms.** Chinese does not inflect for number. Where English has `_one` / `_other`
  variants, both keys must still exist (the parity test requires identical key sets) and both take
  the same Chinese text.
- **Imperative, not polite-formal.** This is an operations tool used mid-incident. `重新啟動伺服器`, not
  `請您重新啟動伺服器`.
- **Keep destructive wording destructive.** A confirmation dialog that sounds reassuring in Chinese
  when it was alarming in English is a bug, not a translation choice. This has already happened once
  in French, where "Wipe server" was rendered as "reset".

## Discord and PanelBridge (added after the first pass — these recur)

| English | zh-TW | Note |
| --- | --- | --- |
| Bot (the Discord bot) | 機器人 | 30+ occurrences in discord.json alone |
| Guild (Server) ID | 伺服器（Guild）ID | keep the Guild parenthetical — it is Discord's own Developer Portal term |
| Intents / Privileged Gateway Intents | 意圖 / 特權閘道意圖 | established Discord bot-developer terminology |
| PanelBridge | PanelBridge | keep literal; do not translate as 橋接 (only keep 橋接 when used as a verb for Discord chat bridging) |
| GM | GM | established acronym in Chinese gaming communities; do not expand |
| Overseer / Observer | 監督者 / 觀察者 | Project Zomboid access levels |

Left untranslated as game-literal tokens: Project Zomboid's chat scopes (General, Say, Local,
Shout, Q shouts), the `[ADMIN]` / `[SAY]` / `[FACTION]` / `[SAFEHOUSE]` chat tags, `SERVER.INI` and
`SANDBOX` section labels, and `iso` in "iso regions" (the engine's own `Iso*` class prefix).
