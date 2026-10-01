# herdr-bridge 設計文件

> 一個 MCode plugin（MINIMAX-format），讓 MCode 主動對 [herdr](https://herdr.dev/) 回報 session id 與 lifecycle state，使 MCode 成為 herdr 的一級 agent。

## 1. 背景與目標

### 問題

herdr（v0.9.3，2026-09）內建支援 22 個 coding agent CLI（[Agents 文件](https://herdr.dev/docs/agents/)），但**不含 MiniMax Code（MCode）**。在 herdr pane 中執行 `mcode` 目前只能當一般終端機使用，沒有：

- `idle` / `working` / `blocked` 狀態偵測
- `herdr agent wait` 可等待的語意狀態
- herdr server 重啟後的 native session restore

### 目標

讓 `mcode` 在 herdr pane 中**與其他一級 agent 同等對待**：sidebar 顯示狀態、變動時通知、可用 `herdr agent wait` 等待、server 重啟後自動 `mcode --resume <session-id>` 還原。

### 採取方向（已決策）

**MCode 自己整合 herdr**（方向 1）。理由：

- 上游 PR 等 herdr 加 manifest 排進版本；本方案不用等上游
- 不修改 MCode 核心，依賴其既有的 plugin / hook 機制
- herdr 官方 [Add Herdr support to your agent](https://herdr.dev/docs/add-herdr-support/) 明確推薦此模式：「If you maintain your agent, owning the integration yourself means you can fix it on your own release schedule」

## 2. 架構

```
┌─────────────────┐    stdin JSON     ┌──────────────────────────┐    spawn    ┌─────────────────┐
│  MCode runtime   │ ────────────────► │  hooks/all-hooks.json   │ ──────────► │  bridge script   │
│  (local hook     │                   │  註冊 11 個 lifecycle    │             │  herdr-bridge.mjs│
│   invoker)       │                   │  事件到同一個腳本         │             └────────┬─────────┘
└─────────────────┘                   └──────────────────────────┘                      │
                                                                                       │ spawn
                                                                                       ▼
                                                                        ┌─────────────────────────┐
                                                                        │  $HERDR_BIN_PATH        │
                                                                        │  pane report-agent …   │
                                                                        │  pane release-agent …  │
                                                                        └─────────────────────────┘
```

- **入口**：`herdr-bridge/.minimax-plugin/plugin.json`（manifest，`sourceFormat: MINIMAX`）
- **掛鉤**：`herdr-bridge/hooks/all-hooks.json`（hook config 結構沿用 Claude 風格，但經 `.minimax-plugin/plugin.json` 註冊後由 MINIMAX reader 以 `sourceFormat: MINIMAX` 解析，見 `packages/local-runtime-v2/src/service/plugin-system/plugin/package/minimax-reader.ts:115`；每個事件都跑同一個 `node bridge script`）
- **邏輯**：`herdr-bridge/scripts/herdr-bridge.mjs`（純 Node.js、無第三方依賴）
- **狀態保存**：`$PLUGIN_DATA/state.json`（herdr 注入的 per-plugin 私有目錄，存放 `--seq` 計數器）

## 3. Hook event → herdr state 對應

| MCode event | herdr state | 訊息 | resume? | 備註 |
| --- | --- | --- | --- | --- |
| `SessionStart` (source=startup/resume) | `idle` | （無） | ✓ 帶 `--agent-session-id` + resume_argv | 註冊 session；herdr 之後用 `mcode --resume <id>` 還原 |
| `UserPromptSubmit` | `working` | （無） |  | 使用者送出 prompt；模型開始處理 |
| `PreToolUse` | `working` | `tool: <name>` |  | 工具即將執行 |
| `PermissionRequest` | `blocked` | `awaiting permission: <tool>` |  | 等使用者決策 |
| `PostToolUse` | `working` | （無） |  | 工具完成，可能還有後續處理 |
| `SubagentStart` | `working` | `subagent: <type>` |  | 子代理啟動 |
| `SubagentStop` | `working` | （無） |  | 子代理完成，父代理繼續 |
| `Stop` | `idle` | （無） |  | 回合結束 |
| `PreCompact` | `working` | `compacting` |  | 自動壓縮 |
| `PostCompact` | `working` | （無） |  | 壓縮完成 |
| `SessionEnd` | `release-agent` | — |  | 清除 pane 上的 agent 註冊，並移除該 session 的 pane 快取項 |

### 不做的事

- 不解析工具輸出內容（避免把祕密 / 路徑送進 herdr）
- 不實作媒合模式（`matcher`），所有事件對同一個腳本一律觸發
- 不寫 herdr plugin manifest（即不在 herdr 端加 screen-detection manifest）——這留給方向 2 或上游處理

## 4. 識別與參數

- `--agent mcode`（herdr sidebar 顯示名稱；herdr 要求用自己的 agent 名，不要沿用 herdr 已支援的 agent 名）
- `--source mcode-herdr-bridge`（herdr 文件：「Don't start it with `herdr:`」）
- `--seq`：單調遞增計數器，持久化於 `$PLUGIN_DATA/state.json`
- resume argv：`['mcode', '--resume', '<session_id>']`（沿用 MCode `--resume` hidden alias，等同 `--session <id>`，見 `packages/tui/src/cli/contract.ts:48`）

### `--seq` 語意（已對 herdr 0.9.3 文件查證）

herdr 對每個 `--source` 只保留「最後接受的數值」，並丟棄不高於它的 report：

> `--seq` is optional but recommended. It must increase with every report from your source, including across sessions and restarts of your agent. **A timestamp works well.** Herdr ignores reports whose number is not higher than the last one it accepted.

由此得出三個設計決定：

1. **單一共用計數器，不 per-pane 分檔。** herdr 的 seq 是 per-source 的全域時鐘，不是 per-pane。兩個 pane 交錯送出 5,6,7,8 時各自看到的就是嚴格遞增，無需分檔；共用計數器同時讓 `Date.now()` 成為合法替代值。
2. **首次啟動以 `Date.now()` 種子，而非 0。** herdr 記憶的「最後接受值」與 `state.json` 無關，因此清除 plugin data 或重裝後若從 1 開始，所有 report 都會被當成過期**靜默丟棄**。這是端對端實測才浮現的缺陷——單元測試用假 herdr，不會重現 herdr 的記憶行為。
3. **`state.json` 損壞時 fallback 到 `Date.now()` 是正確而非退讓。** 該值必然高於任何先前的計數器，herdr 明文認可 timestamp，所以恢復無縫。

### Resume argv 驗證

herdr 對 resume command 有硬性規則，違反時回 `invalid_resume_argv` 並**丟棄整份 report**（連狀態一起丟）：

- 第一個字必須是 PATH 上的裸指令名，不能是路徑
- 任何引數不得含撇號或控制字元
- 最多 64 個引數、總計 8 KiB

因此 bridge 在送出前驗證 argv；不合規則**降級為只回報狀態、附帶 `--agent-session-id`，但省略 `--` resume argv**。注意 herdr 的限制只針對 resume command，`--agent-session-id` 本身不受此限。

## 5. herdr 環境變數依賴 —— 與一個必須解決的落差

herdr 在受管 pane 中注入（見 [herdr add-herdr-support docs](https://herdr.dev/docs/add-herdr-support/)）：

| 變數 | 用法 |
| --- | --- |
| `HERDR_ENV=1` | gating：脫離 herdr 時整個腳本 no-op |
| `HERDR_PANE_ID` | `--pane` 參數 |
| `HERDR_BIN_PATH` | `spawn` 來跑的 herdr CLI 路徑 |
| `HERDR_SOCKET_PATH` | herdr API socket |
| `PLUGIN_ROOT` | MCode 注入 plugin 目錄 |
| `PLUGIN_DATA` | MCode 注入 plugin 私有資料目錄；存 `state.json` |

### 關鍵落差：MCode 不會把 `HERDR_*` 傳給 hook 子行程

`pane.report_agent` 的 `pane_id` 是必填欄位，沒有「推斷目前 pane」的管道，因此 `HERDR_PANE_ID` 是整個設計的關鍵。但 MCode 對 plugin hook 子行程做環境變數白名單過濾：

`packages/agent-modules/plugin-hooks/src/runner.ts` 的 `safeHookEnvironment()` 只放行 17 個變數（`PATH` / `HOME` / `LANG` / `TERM` / `SHELL` / `USER` / `TMPDIR` / `TEMP` / `TMP` / `PATHEXT` / `SystemRoot` / `ComSpec` / `USERPROFILE` / `HOMEDRIVE` / `HOMEPATH` / `APPDATA` / `LOCALAPPDATA`），再加上它自己注入的 `PLUGIN_*` 與 `*_PROJECT_DIR`。**`HERDR_*` 一個都不在內**，hook handler 也沒有 `env` 欄位可擴充，`docs/hooks.md` 未記載任何傳遞機制。

實測結果：安裝後 bridge 在第一道 `HERDR_ENV !== '1'` 就 return，herdr 端 `agent_status` 永遠是 `unknown`。

### 解法：以 cwd 反查 pane

`PATH` 有被放行，所以 `herdr` 這支指令取得得到。`herdr pane current` 不是答案——沒有 `HERDR_PANE_ID` 時它會回退到 **focused pane**，實測在多 pane 情境下回傳的是別的 pane。

因此改以 `herdr pane list` 反查：

1. 先看 `HERDR_PANE_ID`：若上游未來把 `HERDR_*` 加進白名單，直接採用並跳過所有探測（保留此路徑是刻意的）
2. `SessionStart` 時先重新 `herdr pane list` 探測一次（見下方「快取的失效與自癒」）；探測無定論才退回 `state.json` 內 `session_id → pane_id` 快取
3. 其餘事件直接用 `state.json` 快取

**比對規則刻意嚴格：必須恰好一個相符，否則什麼都不回報。** 回報到錯誤的 pane 會與另一個 agent 爭奪狀態權，比沉默嚴重得多。細節：

- 只考慮**未被其他 agent 持有**的 pane（`agent` 欄位為空或就是 `mcode` 自己）。因為 `HERDR_ENV` gate 已無法使用，普通終端機裡的 MCode 與 pane 內的 MCode 從 bridge 視角無法區分，沒有這道過濾就會去搶同目錄的 herdr pane
- 完全不相符時，允許退而比對「pane cwd 是 session cwd 的祖先」（session 在 pane 目錄的子目錄啟動），同樣要求唯一
- 結果寫入 `state.json` 快取，因此每個 session 只在 `SessionStart` 探測一次，`PreToolUse` / `PostToolUse` 這類高頻事件不會每次都 spawn

### 快取的失效與自癒

pane id 不是永久有效的：pane 關閉後 herdr 會回收 id，而被還原的 session 也可能落在另一個 pane。若 `state.json` 留著一個指向已消失 pane 的 `session_id → pane_id`，後續回報會得到 `pane_not_found`；bridge 刻意吞掉 herdr 的失敗（不阻塞 turn），於是這個 session 的所有事件都會靜默消失，而且**永不自行恢復**——因為快取命中後從不驗證、也沒有任何重新探測的機會。

對策有兩道，刻意都收斂在低成本的位置：

- **`SessionEnd` 連帶清除快取項**。釋放 pane 的同時把 `panes[sessionId]` 從 `state.json` 移除，讓映射不會比它指向的 pane 活得久。
- **只有 `SessionStart` 重新探測**。這是唯一「session 可能已經換了 pane」的時刻——被還原的 session 正是靠 `SessionStart` 帶著同一個 `session_id` 在新 pane 重新上線。新探測結果會覆寫快取；若探測歧義或無結果（無法證明快取是錯的），則保留快取不動。

其餘事件不做驗證：session 存活期間 process 不會搬家，每個事件重新探測只會換來同樣的答案，代價是每個 `PreToolUse` / `PostToolUse` 都多一次 round-trip。`SessionStart` 探測無定論時「寧可保留舊值」也是刻意的——丟掉一個多半仍然正確的映射，比留著一個可能錯的更糟。

### 已知限制

- 同一 workspace 開兩個 pane 跑同一目錄 → 歧義 → no-op（實測 `wY:p1` / `wY:p5` 即為此情形）
- 普通終端機的 MCode 若 cwd 恰好對應到一個空閒 herdr pane，仍會認領它；`SessionEnd` 會釋放，屬可自癒的輕微干擾
- herdr 的 `agent_status` 合法值為 `idle` / `working` / `blocked` / `done` / `unknown`。bridge 送 `idle`，herdr 在偵測到一輪結束時會對外顯示 `done`——這是 server 端衍生語意，且正是 `herdr agent wait --until done` 所等待的狀態，非缺陷

## 6. 失敗處理

依 herdr 文件 [Keep it out of the way](https://herdr.dev/docs/add-herdr-support/#keep-it-out-of-the-way)：

- 用 `child_process.spawn` 背景跑 herdr CLI，2 秒逾時保護，不阻塞 MCode 主流程
- `herdr pane list`（pane 反查）用 `spawnSync`，1.5 秒逾時；實測延遲約 13ms，且每 session 只跑一次
- 攔截 `stderr` 與 `stdout` 拋棄，避免 herdr 短暫離線造成 plugin 噪音
- herdr 子行程只繼承 `PATH`（避免把 MCode session 的 API key / token 交給 herdr CLI）；Windows 上額外 allow-list `SystemRoot` / `ComSpec` / `TEMP` 等系統變數
- `state.json` 以 write-then-rename **原子寫入**，多 pane 同時回報時不會留下半截檔案
- `state.json` 遺失或損壞時都以 `Date.now()` 重新起算，不中斷 hook 流程
- pane 反查無法唯一決定時 no-op，絕不猜測
- resume argv 違反 herdr 規則時降級為只回報狀態，不送出會被整份丟棄的 report
- `pluginDataDir` 無法寫入時，整個 report 跳過，不中斷 MCode

## 7. 測試策略

- 單元測試：`tests/herdr-bridge.test.mjs`（repo 根目錄），Node.js `--test` runner
- 不依賴 herdr 真實安裝；以 `node:child_process.spawn` 包一個 fake `HERDR_BIN_PATH` 攔截呼叫
- 涵蓋（共 33 個測試）：
  - Payload 解析（`hook_event_name` / `session_id` / `cwd` / event-specific fields）
  - 狀態對應表（每個 event 對到正確的 herdr CLI 子命令）
  - Resume argv 形狀
  - Resume argv 驗證（session id 含撇號 / 控制字元 → 降級為僅回報狀態）
  - `--seq` 計數器單調遞增 + 持久化往返 + 損壞 state.json 容錯 + 首次以 timestamp 起算
  - `state.json` 原子寫入（不留下 `.tmp` 殘留檔）
  - Pane 反查：cwd 唯一匹配、歧義 no-op、子目錄 fallback、不搶他人持有的 pane、`session_id` 快取不重複探測、未映射事件不探測
  - 快取失效與自癒：`SessionEnd` 清除快取項、被還原的 session 在 `SessionStart` 重新解析到新 pane、探測無定論時保留快取、存活 session 不因 pane 列表變動被重新指向
  - `HERDR_PANE_ID` 快路徑優先於反查
  - stdin 損壞 / 空 / 非 JSON 時 graceful exit

## 8. 安裝

詳見 `herdr-bridge/README.md`。

## 9. 未來工作（不在此次範圍）

- herdr 端 screen-detection manifest（方向 2）——可讓脫離 hook 的 mcode 仍有 screen 狀態
- SessionEnd 識別的精細度（herdr 文件標示「best-effort」，本次接受）
- 為官方 marketplace 發佈版本（需補 `icon` / `displayName` / `exampleQueries` 等欄位）