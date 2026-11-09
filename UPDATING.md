# dsh-desktop 更新规则（UPDATING）

> 本文件是本项目「更新什么、依据什么、按什么顺序做」的唯一说明。
> 状态检查命令：`node scripts/check-update.mjs`（只读，不启动进程、不改文件）

## 0. 本更新会话的工作规程

- 用户说「检查更新 / 看下状态」→ 只跑 `check-update.mjs` 汇报，**不动任何文件**。
- 用户说「更新」→ 先给方案（哪一层、目标版本、风险、备份点），确认后按 §5 执行。
- 更新结束后，在 §11 的更新记录里补一行。
- 状态结论只认脚本输出与官方 Release/npm，不凭记忆判断版本。

## 1. 部件分四层，更新方式各不相同

| 层 | 现场位置 | 版本来源 | 更新方式 | 需要重装？ |
| --- | --- | --- | --- | --- |
| ① 桌面壳 | `C:\Program Files\DeepSeek Harness Desktop\`（exe + `resources\app.asar`） | GitHub Release `h-yaqi/lingdang-dsh-ui` | 应用内自动更新 / 下载新 Release 覆盖安装 | 是（应用本身） |
| ② 内置 DSH 核心 | 已安装：`resources\dsh\node_modules`；打包源：`vendor\dsh\node_modules` | npm `@deepseek-ai/dsh` 的 `dist-tags.latest` | 重新打包：`prepare:vendor` → `dist` → 发布 Release → 安装更新 | 是（随安装包） |
| ③ profile 的 bundle / 插件 | `%USERPROFILE%\.dsh-desktop\profiles\web`（`package.json` 的 `dsh.profile.bundles` + pnpm 依赖） | 各 bundle 自身版本；本地插件 = 工作区目录 `link:` | `plugin_manager`（`install_bundle` / `remove_bundle`）或 `dsh plugin --profile web ...` | 否（client 刷新页面，host 需重启应用） |
| ④ 本地插件源码 | `plugins\floating-ball`、`plugins\kanban-board`（git 仓库 dsh-plugins） | 本仓库提交 | 改代码 → 语法检查 + 插件测试 → 刷新/重启 → git 提交推送 | 否 |

② 的版本决定 ③ 里**官方** bundle 的版本：内置 dsh 升级后，`@deepseek-ai/dsh-base`、`dsh-web-app`、`experimental-*` 等随之升级，不要单独安装它们。

## 2. 唯一事实来源（不要猜版本）

- 桌面壳最新版：<https://github.com/h-yaqi/lingdang-dsh-ui/releases/latest>
- DSH 核心最新版：npm `@deepseek-ai/dsh` 的 `dist-tags.latest`（检查时为 `0.2.2-rc.1`，2026-11-04）
- ⚠️ **不要**用 `@deepseek-ai/dsh-base` / `dsh-web-app` 等散包的 `latest` tag 判断版本：它们的 latest 是历史遗留值（例如 `dsh-base` 的 latest 仍是 `0.0.1-rc.1`），正确版本由 `@deepseek-ai/dsh` 的精确依赖带出。
- 本地插件：工作区 `plugins` 仓库 git 记录；安装方式是 `link:` 指向源码目录，改完即生效。

## 3. 检查规则

- 每次「更新部件」会话开始、以及每次发版前：先跑 `node scripts/check-update.mjs`。
- 输出解读：`✅ 最新` / `⚠️ 有新版` / `❓ 未知（网络不可达）`。
- 本机 GitHub 常超时（`desktop.log` 出现过 `net::ERR_TIMED_OUT`）；脚本会先试 npm 官方源再试 npmmirror。GitHub 失败只影响「桌面壳最新版」判断，不影响 ②。
- 发现新版后**不要直接动手**：先过 §4 兼容配对，再按 §5 流程。

## 4. 兼容配对规则（升级前逐条核对）

1. **壳 ↔ 核心**：壳 ≥ `0.1.4` 才解析 `dsh web: http://127.0.0.1:PORT/?token=…`（dsh 从 `0.1.2-rc.1` 起带进程 token；壳 `0.1.3` 及更早只会打开 401 页）。升级核心前确认壳版本不低于它。
2. **内置 Node ↔ dsh engines**：`dsh@0.2.2-rc.1` 要求 `node >=24.9.0`，内置 v24.19.0 满足。若未来 engines 提高，先改 `scripts/prepare-vendor.ps1` 的 `-NodeVersion` 并重新打包，否则内置运行时启动即失败。
3. **URL 行格式**：核心升级前确认新版本仍打印单行 `dsh web: <url>`。0.2.2-rc.1 与 0.2.1-rc.2 已核对一致（`dsh-web-app/lib/index.js` 的 `dsh web: ${authenticatedUrl}` + `dsh-client-connection` 的 `authenticatedUrl()`）；若变了，同步改 `src/main.js` 的 `URL_LINE_RE`。
4. **DSH_HOME 数据**：会话格式是单向迁移（session-format v0→v4）。升级后旧会话自动迁移；降级不保证可读 → 升级前必须备份 DSH_HOME（§6）。
5. **本地插件回归**：升级核心后必须验证 floating-ball / kanban-board（client + host 两半）。它们依赖 `--dsw-alias-*` 主题 token 与公开 API，跨大版本（0.2 → 0.3）时先验证再发版。
6. **并发**：同一 DSH_HOME 不能同时跑两个实例（Windows 上 `cordis.yml` 有文件锁）。升级/替换前先完全退出桌面应用。

## 5. 标准升级流程

### A. 只更新桌面壳（改壳代码或壳依赖）

1. 改 `src/`，把 `package.json` 的 version 递增（壳版本独立，不必跟 dsh 版本）
2. `npm run dist`（网络慢先设 `ELECTRON_BUILDER_BINARIES_MIRROR`）
3. 本机安装验证：`powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-install.ps1 -Root "C:\Program Files\DeepSeek Harness Desktop"`，再打开应用
4. 发布：
   ```powershell
   $env:GH_TOKEN = "<classic PAT>"
   node scripts/publish-release.mjs v0.1.5 "说明" dist/dsh-desktop-setup-0.1.5.exe dist/latest.yml dist/dsh-desktop-setup-0.1.5.exe.blockmap
   ```
5. 发布后复跑 `check-update.mjs` 确认 latest 与产物一致

### B. 更新内置 DSH 核心（示例：0.2.1-rc.2 → 0.2.2-rc.1，已于 2026-11-09 完成）

> 前置：完全退出桌面应用；§4 全部通过；§6 已备份。

1. 取新闭包到临时目录（**npm 缓存必须放在工作区内**，沙箱只允许写工作区；不要装到全局；必须加 `--ignore-scripts`）：
   ```powershell
   $ver = "0.2.2-rc.1"
   npm install --prefix .\vendor\dsh.new --cache .\.npm-cache --no-audit --no-fund --prefer-offline --ignore-scripts "@deepseek-ai/dsh@$ver"
   ```
2. 冒烟（内置 node + 临时 DSH_HOME，看到地址行即成功，Ctrl+C 退出）：
   ```powershell
   $env:DSH_HOME = "$env:TEMP\dsh-smoke"
   .\vendor\node\node.exe .\vendor\dsh.new\node_modules\@deepseek-ai\dsh\lib\bin.js web --port 0 --no-open
   # 期望输出: dsh web: http://127.0.0.1:<port>/?token=<...>
   ```
3. 替换：`vendor\dsh` 改名为 `vendor\dsh-<旧版本>.bak`，`vendor\dsh.new` 改名为 `vendor\dsh`（`prepare:vendor` 之后会因 bin.js 已存在而跳过，属预期）
4. 自检：`node scripts/check-update.mjs`（vendor 行应为最新）→ 打包：
   ```powershell
   # 本机推荐：复用本地 Electron（避免联网下载超时），临时目录放工作区（沙箱）
   New-Item -ItemType Directory -Force .\.tmp-build | Out-Null
   $env:TMP = "$PWD\.tmp-build"; $env:TEMP = $env:TMP
   node .\node_modules\electron-builder\out\cli\cli.js --win "--config.electronDist=$PWD\node_modules\electron\dist"
   ```
   产物：`dist\dsh-desktop-setup-<ver>.exe` + `.blockmap` + `latest.yml`
5. 安装新包 → `verify-install.ps1 -Root ...` → 按 §7 验证
6. 发布 Release（同 A.4），说明里必须写「内置 dsh 0.2.2-rc.1」

### C. 只更新 profile 里的插件

- 官方 bundle：随 ② 自动升级，无需操作
- 第三方包：`plugin_manager` → `install_bundle`（target 用包 spec 或目录绝对路径）；卸载用 `remove_bundle`
- 本地插件：源码在 `plugins\`，以 `link:` 安装，改完即生效；若改了 `package.json` 的 `dsh.bundle` / `dsh.client` 或 `cordis.patch.yml`，需要重新 `install_bundle` 一次
- 每次改完：`node --check plugins\<name>\index.js`、`node --check plugins\<name>\client.js`、跑插件自带测试
- 仓库同步：`git -C plugins status` → 提交 → 推送 `ssh://git@ssh.github.com:443/h-yaqi/dsh-plugins.git`

## 6. 备份与回滚

升级核心前必须备份：

```powershell
$ts  = Get-Date -Format yyyyMMdd-HHmmss
$bak = "$env:USERPROFILE\.dsh-desktop-backup-$ts"
Copy-Item "$env:USERPROFILE\.dsh-desktop\sessions"  "$bak\sessions"  -Recurse
Copy-Item "$env:USERPROFILE\.dsh-desktop\storages"  "$bak\storages"  -Recurse
Copy-Item "$env:USERPROFILE\.dsh-desktop\settings.yaml"     $bak
Copy-Item "$env:USERPROFILE\.dsh-desktop\.credentials.yaml" $bak
```

- 回滚壳：重装旧安装包（Release 里有历史版本）或恢复备份的 `resources`
- 回滚核心：退出应用 → 换回备份的 `resources\dsh\node_modules`（或重装旧包）→ **同时恢复 DSH_HOME 备份**
- 不要在缺少 DSH_HOME 备份时降级 dsh

## 7. 验证清单（每次更新后逐项打勾）

- [ ] 应用能启动，窗口加载的是 `http://127.0.0.1:<port>/?token=...`（不是 401 页）
- [ ] `%APPDATA%\dsh-desktop\logs\desktop.log` 无「致命错误 / 后端在输出监听地址前退出」
- [ ] 设置 → 通用设置 →「关于 dsh-desktop」卡片显示的 桌面端 / 内置 dsh / Node 版本符合预期
- [ ]「检查更新」按钮可用（GitHub 网络受限时报错属已知）
- [ ] 设置 → 插件页能看到 floating-ball / kanban-board，两个页面都能打开
- [ ] 打开一个历史会话可继续对话；能新建会话
- [ ] `verify-install.ps1 -Root "C:\Program Files\DeepSeek Harness Desktop"` 全项正常
- [ ] `node scripts/check-update.mjs` 输出与本次目标一致

## 8. 本机已知坑

- **没有全局 dsh**（`where dsh` 为空），npx 缓存里只有旧的 `0.1.1-rc.2` → `prepare-vendor.ps1` 自动解析会失败，必须用 §5.B 的 `--prefix` 方式或 `-DshRoot` 指定闭包目录。
- **npm 缓存**：沙箱会话只允许写工作区，所有 npm 命令都要带 `--cache <工作区路径>`。
- **npm 安装闭包必须加 `--ignore-scripts`**：沙箱下原生依赖的 install/rebuild 会 `spawn EPERM`；本闭包的原生模块（sharp / node-pty / koffi / sherpa / node-addon-*）都自带预编译 `.node`，跳过脚本不影响运行。安装后核对 `node_modules` 里 12 个 `.node` 是否齐全。
- **打包需要一次性放宽权限**：electron-builder 要启动 `7za`/`makensis`/`signtool` 子进程，workspace-write 沙箱会 `spawn EPERM`，需对打包命令做一次 `danger-full-access` 授权（或在本机普通 PowerShell 里跑）。
- **Electron 下载**：electron-builder 默认从 GitHub 下 Electron，常 600s 超时；加 `--config.electronDist=node_modules/electron/dist` 用本地已装 Electron（33.2.1）即可离线打包。
- **NSIS 临时文件**：makensis 在 DSH 会话临时目录下会报 `!tempfile: Unable to create temporary file!`；打包前把 `TMP`/`TEMP` 指到工作区内目录（如 `.tmp-build`）。
- **PowerShell HTTPS**：本会话 `Invoke-WebRequest/Invoke-RestMethod` 访问 HTTPS 会失败（「接收时发生错误」）；用 node 的 `fetch`（`check-update.mjs` 即如此）。
- **安装位置**：应用装在 `C:\Program Files\...`（per-machine），直接替换已安装文件通常需要管理员权限；正规路径是重新打包 + 安装包覆盖。
- **profile 残留**：`~/.dsh-desktop/profiles/node_modules` 里有 164 个断链 junction，指向已卸载的旧安装位置（`LOCALAPPDATA\Programs`），当前不影响运行；要清理就完全退出应用后删掉该目录（可由 dsh 重建）。
- **更新源**：发布依赖 GitHub 连通性；`DSH_DESKTOP_UPDATE_URL` 可指向自建 generic 源（需 `latest.yml` + 安装包 + blockmap）。

## 9. 发布纪律

- 每次 Release 必须附 3 个产物：`dsh-desktop-setup-<ver>.exe`、同版 `.blockmap`、`latest.yml`（缺 latest.yml 自动更新即失效）
- `latest.yml` 的 version / sha512 / size 必须与 exe 实际一致（electron-builder 生成后不要手改）
- Release 说明写清：壳版本、内置 dsh 版本、内置 Node 版本、兼容性提示
- 版本号：壳 `0.1.x` 独立递增，不要借用 dsh 的版本号

## 10. 禁止事项

- ❌ 运行中替换 `resources\dsh` 或 `app.asar`
- ❌ 单独 `npm install @deepseek-ai/dsh-base@latest`，或按散包 latest 判断版本
- ❌ 跳过备份降级 dsh
- ❌ 两个实例共享同一个 DSH_HOME 并发运行
- ❌ 改了 `vendor\` 却不重新打包就宣称「已更新」
- ❌ 用 0.1.3 及更早的壳配 0.1.2-rc.1+ 的 dsh

## 11. 更新记录

| 日期 | 桌面壳 | 内置 dsh | 说明 |
| --- | --- | --- | --- |
| 2026-10-21 | 0.1.4 | 0.2.1-rc.2 | 支持 token 鉴权地址；内置 dsh 升至 0.2.1-rc.2，发布 v0.1.4 |
| 2026-11-08 | 0.1.4 | 0.2.1-rc.2 | 检查：壳已最新；npm latest `0.2.2-rc.1`（2026-11-04）可用，**未升级** |
| 2026-11-09 | 0.1.5 | 0.2.2-rc.1 | 升级内置 dsh 至 0.2.2-rc.1；生成 `dist\dsh-desktop-setup-0.1.5.exe`（278,571,561 字节）；待手动安装并发布 Release |
