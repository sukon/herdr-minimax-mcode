# herdr-bridge

讓 [MiniMax Code（MCode）](https://github.com/MiniMax-AI/minimax-code) 成為 [herdr](https://herdr.dev/) 的「一級」coding agent——sidebar 即時顯示 `idle` / `working` / `blocked`，可使用 `herdr agent wait` 等指令，herdr server 重啟後自動 `mcode --resume <session-id>` 還原同一個 session。

## 為什麼需要這個 plugin

herdr 預設支援 22 個 agent CLI（[清單](https://herdr.dev/docs/agents/)），但 MCode 不在其中。沒有這個 plugin 時，在 herdr pane 中跑 `mcode` 只是一個普通 shell，看不到語意狀態，也無法在 herdr 重啟後自動還原 session。

## 安裝

### 前置需求

| 項目 | 需求 |
| --- | --- |
| MCode | 已安裝且 `mcode --version` 可執行 |
| herdr | v0.9.2 以上（建議 v0.9.3 取得最佳 native 處理） |
| Node.js | 22.19+ / 24.2+ / 25 / 26（沿用 MCode 需求） |

### 安裝步驟

1. **複製 plugin 目錄到 MCode 的 local plugin 目錄**：

   MCode 的 local plugin 根目錄是 `<data-dir>/plugins/`。預設 data-dir 為：

   - macOS / Linux / WSL：`~/.minimax/plugins/`
   - Windows：`%USERPROFILE%\.minimax\plugins\`

   將整個 `herdr-bridge/` 目錄複製（或用 symbolic link）到該路徑下：

   ```bash
   # POSIX
   mkdir -p ~/.minimax/plugins
   cp -R /path/to/herdr-bridge ~/.minimax/plugins/

   # Windows PowerShell
   New-Item -ItemType Directory -Force "$env:USERPROFILE\.minimax\plugins"
   Copy-Item -Recurse -Force .\herdr-bridge "$env:USERPROFILE\.minimax\plugins\"
   ```

   結果路徑：

   - POSIX：`~/.minimax/plugins/herdr-bridge/.minimax-plugin/plugin.json`
   - Windows：`%USERPROFILE%\.minimax\plugins\herdr-bridge\.minimax-plugin\plugin.json`

2. **重啟 MCode**（或 `/reload`）讓 plugin 被掃描。

3. **在 TUI 內啟用**：開 `/plugins` 面板，`Tab` 切到 Local，找到 `herdr-bridge`，按 `Space` 啟用。

4. **驗證**：在 herdr pane 中跑 `mcode`，sidebar 的 agent 列應即時顯示 `mcode` 與 `idle` / `working` / `blocked`。

### 自訂安裝位置（非預設 data-dir）

如果 MCode 用了 `--profile` 或 `MINIMAX_DATA_DIR` / `MAVIS_DATA_DIR` 環境變數，請把 plugin 放在該 profile 的 `plugins/` 子目錄下，例如：

```bash
export MINIMAX_DATA_DIR=~/.minimax-dev
mkdir -p ~/.minimax-dev/plugins
cp -R ./herdr-bridge ~/.minimax-dev/plugins/
```

## 解除安裝

```bash
rm -rf ~/.minimax/plugins/herdr-bridge
# 或
Remove-Item -Recurse -Force "$env:USERPROFILE\.minimax\plugins\herdr-bridge"
```

重啟 MCode 後 plugin 從 `/plugins` 面板消失。

## 運作原理

MCode 在每個 lifecycle 事件觸發時，會 spawn 這個 plugin 的 bridge script 並把 JSON payload 透過 stdin 餵進去（見 `docs/hooks.md`）。bridge script：

1. 讀 stdin 的 hook payload（含 `hook_event_name` / `session_id` / `cwd` / 事件專屬欄位）
2. 遞增 `--seq` 計數器（持久化於 `$PLUGIN_DATA/state.json`）
3. 決定要回報到哪個 herdr pane（見下方「Pane 怎麼找出來」）
4. 驗證 resume argv 符合 herdr 規則；不合規則降級為「只回報狀態」
5. 在背景 spawn `$HERDR_BIN_PATH pane report-agent ...`，2 秒逾時保護；不阻塞 MCode turn
6. `SessionStart` 同時回報 `agent_session_id` 與 resume argv `mcode --resume <id>`，讓 herdr 重啟後能自動還原

### Pane 怎麼找出來

這是本 plugin 最關鍵的一段。herdr 的 `pane.report_agent` 要求 `pane_id`，正常情況由 `HERDR_PANE_ID` 提供——但 **MCode 不會把 `HERDR_*` 傳給 plugin hook 子行程**（`safeHookEnvironment()` 只放行 17 個系統變數加上 `PLUGIN_*`，見設計文件）。所以 bridge 改用 `herdr pane list` 以 cwd 反查：

1. 若 `HERDR_PANE_ID` 存在則直接採用（保留給上游未來支援）
2. 否則查 `state.json` 的 `session_id → pane_id` 快取
3. 否則 `herdr pane list`，挑 `cwd` 與本 session 相符且**恰好一個**的 pane

比對必須唯一，否則一律 no-op——回報錯 pane 會跟別的 agent 搶狀態權。已被其他 agent 持有的 pane 不會被搶占。結果會快取，每個 session 只探測一次。

`--seq` 刻意是**跨 pane 共用的單一計數器**，且首次啟動以 `Date.now()` 起算而非 0：herdr 記憶的「最後接受 seq」與 `state.json` 無關，從 1 開始會在 plugin data 被清除後被整批靜默丟棄。

## 開發

### 執行單元測試

測試位於 repo 根目錄（依工作區治理規則不放進 plugin 內），請在 **repo 根目錄**執行：

```bash
node --test tests/herdr-bridge.test.mjs
```

測試不需要 herdr 安裝；以 Node.js 產生 fake herdr CLI（fake-herdr.cmd + fake-herdr.mjs）攔截 `pane report-agent` 的 argv 並寫入 log，斷言 hook payload 對應到正確的 herdr CLI 參數。fake herdr 同時能應答 `pane list`，用來測試 pane 反查。

涵蓋範圍（33 個測試）：
- 每個 MCode event 對應的 herdr state 與 message
- SessionStart 的 `--agent-session-id` 與 resume argv 形狀
- resume argv 驗證：session id 含撇號或控制字元時降級為僅回報狀態
- `--seq` 單調遞增 + 持久化往返 + 損壞容錯 + 首次以 timestamp 起算
- `state.json` 原子寫入（不留下 `.tmp` 殘留檔）
- Pane 反查：cwd 唯一匹配、歧義 no-op、子目錄 fallback、不搶他人持有的 pane、快取不重複探測
- HERDR_ENV gating（脫離 herdr 時 no-op）
- stdin 損壞 / 空 / 非 JSON / 未知 event 名稱時 graceful no-op

## 限制

- herdr 0.9.2 之前的版本會忽略 resume command，但 state report 仍可運作
- SessionEnd 在 herdr 端是 best-effort 觸發，文件有標示
- MCode 的 `PermissionRequest` / `PreToolUse` 等事件只有在啟用對應 hook 設定時才會觸發；本 plugin 預設全部註冊
- **同一 workspace 開兩個 pane 跑同一目錄時 pane 反查會歧義 → no-op**。此時 sidebar 不會顯示 mcode，是刻意的安全降級
- 普通終端機（非 herdr pane）裡的 MCode 若 cwd 恰好對應到一個空閒 herdr pane，仍會認領它；`SessionEnd` 會釋放
- herdr 對外顯示的狀態可能是 `done` 而非 `idle`：bridge 送的是 `idle`，herdr 在偵測到一輪結束時自行衍生為 `done`。這正是 `herdr agent wait --until done` 所等待的狀態

## 參考資料

- 設計文件：`docs/herdr-bridge-design.md`（位於 repo 內，不隨 plugin 安裝）
- herdr Add Herdr support：https://herdr.dev/docs/add-herdr-support/
- herdr Socket API：https://herdr.dev/docs/socket-api/
- MCode hooks 文件：https://github.com/MiniMax-AI/minimax-code/blob/main/docs/hooks.md

## 授權

MIT，見 [`LICENSE`](LICENSE)