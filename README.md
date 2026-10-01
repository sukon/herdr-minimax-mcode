# herdr-minimax-mcode

讓 [MiniMax Code（MCode）](https://github.com/MiniMax-AI/minimax-code) 成為 [herdr](https://herdr.dev/) 的「一級」coding agent。

MCode 在 herdr pane 中執行時，sidebar 會即時顯示 `idle` / `working` / `blocked`，可用 `herdr agent wait` 等指令自動化；herdr server 重啟後會自動以 `mcode --resume <session-id>` 還原同一個 session。

> herdr 內建支援 22 個 agent CLI，但不含 MCode。沒有這個 plugin 時，在 herdr pane 中跑 `mcode` 只是普通終端機，看不到語意狀態，也無法在重啟後還原 session。

## 內容

| 路徑 | 說明 |
| --- | --- |
| [`herdr-bridge/`](./herdr-bridge/) | MCode plugin 本體（安裝、限制與運作原理見 [其 README](./herdr-bridge/README.md)） |
| [`docs/herdr-bridge-design.md`](./docs/herdr-bridge-design.md) | 設計文件：hook event → herdr state 對照、pane 反查方案、resume argv 驗證、failure modes |
| [`tests/herdr-bridge.test.mjs`](./tests/herdr-bridge.test.mjs) | 單元測試（37 項，不需要安裝 herdr） |

## 快速開始

```powershell
# 1. 把 plugin 複製到 MCode 的 local plugin 目錄
Copy-Item -Recurse -Force .\herdr-bridge "$env:USERPROFILE\.minimax\plugins\"

# 2. 重啟 MCode（或 /reload），在 /plugins 面板的 Local 分頁啟用 herdr-bridge

# 3. 在 herdr pane 中執行 mcode，然後確認
herdr pane get $env:HERDR_PANE_ID
```

完整安裝說明（含 macOS / Linux / 自訂 profile data-dir）見 [`herdr-bridge/README.md`](./herdr-bridge/README.md)。

## 執行測試

```powershell
node --test tests/herdr-bridge.test.mjs
```

## 實作要點

MCode 對 plugin hook 子行程做環境變數白名單過濾（`safeHookEnvironment()`），`HERDR_ENV` / `HERDR_BIN_PATH` / `HERDR_PANE_ID` 都不在名單內，而 herdr 的 `pane.report_agent` 要求 `pane_id` 為必填。因此本 plugin 改以 `herdr pane list` 依 cwd 反查 pane，並要求**恰好一個**相符才回報；歧義時一律 no-op，不猜測。已被其他 agent 持有的 pane 不會被搶占。

完整推導、已知限制與 herdr 的 `--seq` 語意，見[設計文件](./docs/herdr-bridge-design.md)。

## 授權

MIT，見 [`herdr-bridge/LICENSE`](./herdr-bridge/LICENSE)。
