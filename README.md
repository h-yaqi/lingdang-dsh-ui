# dsh-desktop — DeepSeek Harness 桌面客户端

把 DeepSeek Harness 的 Web GUI 封装成 Windows 原生桌面应用：

- 应用启动时**自动拉起** DSH 后端服务（`dsh web --port 0 --no-open`，OS 随机分配端口）；
- 在原生窗口中加载 GUI，无需手动开浏览器；
- 退出应用时自动 **taskkill 整个后端进程树**，不留残留；
- 使用**独立 DSH_HOME**（默认 `~/.dsh-desktop`），与浏览器中运行的实例互不干扰，可同时运行。

## 环境要求

- Node.js（开发机已验证 v24）
- dsh CLI（`@deepseek-ai/dsh`）已可用：本机 `where dsh` 能解析到即可；否则见下方 `DSH_CLI` 配置
- Windows 10/11

## 安装与运行

```powershell
cd dsh-desktop

# 首次安装依赖（Electron 二进制约 115MB；国内网络建议加镜像变量）
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
npm install

# 启动桌面客户端
npm start
```

启动后会自动完成：解析 dsh CLI → 以独立 DSH_HOME 拉起后端 → 解析 `dsh web: http://127.0.0.1:<port>` → 打开窗口。关闭窗口即退出应用并结束后端。

> 若 `npm install` 因沙箱/权限写不了系统 npm 缓存，可把缓存指到项目内：
> `npm install --cache .npm-cache`

## 配置（环境变量）

| 变量 | 作用 | 默认 |
|---|---|---|
| `DSH_DESKTOP_HOME` | 桌面端使用的 DSH_HOME | `~/.dsh-desktop` |
| `DSH_CLI` | 手动指定 dsh 入口（`bin.js`、`dsh.cmd` 或 dsh 包目录） | 自动：`where dsh` → npx 缓存兜底 |
| `DSH_NODE` | 手动指定 node.exe 路径 | 自动：`where node` |
| `DSH_DESKTOP_DSH` | 覆盖 dsh：优先于内置版本使用外部 dsh（如全局安装的新版） | 内置 dsh |
| `DSH_DESKTOP_NODE` | 覆盖 node：优先于内置版本使用外部 node.exe | 内置 node |
| `DSH_DESKTOP_DEVTOOLS` | 设为 `1` 时启动即打开开发者工具 | 关闭 |

> 解析优先级：**显式覆盖（环境变量或设置文件）> 内置（打包版）> 系统（开发模式）**。
> 除了环境变量，也可以写设置文件 `%APPDATA%\dsh-desktop\settings.json`：
> ```json
> { "dshPath": "C:\\Users\\you\\...\\@deepseek-ai\\dsh\\lib\\bin.js", "nodePath": "C:\\...\\node.exe" }
> ```

### dsh 发新版后，怎么让已安装的应用用上新版？

内置 dsh 是构建时冻结的（不会自动更新）。三种方式：

1. **外部覆盖（最快，无需重装应用）**：单独更新 dsh 后指给它
   ```powershell
   npm install -g @deepseek-ai/dsh          # 或 npx -y @deepseek-ai/dsh@latest
   # 找到新版 dsh 的 bin.js（全局安装在 %APPDATA%\npm\node_modules\@deepseek-ai\dsh\lib\bin.js），
   # 写入 %APPDATA%\dsh-desktop\settings.json 的 dshPath，重启应用即生效
   ```
   ⚠️ 用外部 dsh 时注意 node 版本：新版 dsh 若由更高版本 Node 安装（原生模块 ABI 不同），
   需同时设置 `DSH_DESKTOP_NODE`/`nodePath` 指向对应的 node.exe。
2. **重新打包重装**：`npm run prepare:vendor && npm run dist` → 安装新安装包（内置 dsh 随之更新）。
3. **整包自动更新（规划中）**：接入 electron-updater + GitHub Release，应用自动检测并更新，用户无感。

### 想复用现有的 `~/.dsh`（会话/配置/凭据）？

```powershell
$env:DSH_DESKTOP_HOME = "$env:USERPROFILE\.dsh"
npm start
```

⚠️ 注意：同一 profile 在同一 DSH_HOME 下**不能并发运行**（Windows 上 `cordis.yml` 有文件锁）。
如果浏览器里已有一个 `dsh web` 实例在跑，桌面端会启动失败——先关掉其中一个。

## 日志

- 运行日志：`%APPDATA%\dsh-desktop\logs\desktop.log`
- 后端 stdout/stderr 出错时会带在错误对话框的详细信息里

## 目录结构

```
dsh-desktop/
├── src/
│   └── main.js        # Electron 主进程（后端拉起/端口探测/窗口/退出清理）
├── scripts/
│   └── prepare-vendor.ps1   # 生成 vendor/（内置 node + dsh CLI）
├── build/
│   └── icon.png       # 应用图标（electron-builder 自动转 .ico）
├── vendor/            # 打包用内置运行时（.gitignore 排除，由脚本生成）
├── package.json
└── README.md
```

## 打包为独立 Windows 安装程序

打包产物会**内置 node.exe 与 dsh CLI**，目标机器无需安装 Node.js 或 dsh，即可独立运行。

```powershell
# 1. 准备内置运行时（下载 node.exe、复制 dsh 依赖闭包，约 230MB，仅需一次）
npm run prepare:vendor
#    国内网络下脚本默认从 npmmirror 下载 node；dsh 闭包自动从本机 where dsh 解析

# 2. 打包（国内网络建议先设镜像）
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
npm run dist

# 产物
#   dist/dsh-desktop-setup-0.1.1.exe    NSIS 安装程序（可自选安装目录）
#   dist/win-unpacked/                  免安装绿色版，可直接运行
#   dist/latest.yml + *.blockmap        自动更新元数据
```

说明：

- 应用启动时优先使用**内置运行时**（`resources/node/node.exe` + `resources/dsh/...`），未打包的开发模式（`npm start`）仍回退到系统 Node 与 dsh CLI；
- 安装程序**未签名**，首次运行 Windows SmartScreen 会提示"更多信息 → 仍要运行"；
- 图标可自行替换 `build/icon.png`（512×512）。

## 自动更新（v0.1.1 起）

应用内置 **electron-updater**：启动 10 秒后静默检查更新，发现新版自动下载并弹出"立即重启安装"。

- 设置 → 通用设置 里显示「关于 dsh-desktop」卡片：**桌面端版本 / dsh 版本 / Node 版本**，
  以及 **检查更新** 按钮（一键触发真实检查并显示结果，v0.1.2 起）；
- 默认更新源：GitHub Release（`publish` 配置 → 生成的 `app-update.yml`）；
- **发布新版流程**：
  ```powershell
  # 1. 修改 package.json 的 version（如 0.1.2）
  npm run dist
  # 2. 发布到 GitHub Release（脚本在 scripts/publish-release.mjs）
  $env:GH_TOKEN = "你的 classic PAT"
  node scripts/publish-release.mjs v0.1.2 "版本说明" dist/dsh-desktop-setup-0.1.2.exe dist/latest.yml dist/dsh-desktop-setup-0.1.2.exe.blockmap
  ```
- **国内网络**：github.com 波动时更新检查可能失败（仅记录日志，不影响使用）。可把更新源指向自建/镜像的 generic 源：
  `$env:DSH_DESKTOP_UPDATE_URL = "https://你的服务器/updates"`（需提供 `latest.yml` + 安装包 + blockmap，格式同 `dist/latest.yml`）；
- ⚠️ 0.1.0 及更早版本**不含**更新代码，需手动安装一次 v0.1.1 后，后续版本才能自动更新。

## 已知限制 / 后续计划

- 安装包较大（约 250MB，主要来自内置 dsh 依赖闭包）；
- 托盘图标、系统通知、开机自启、代码签名等可作为后续迭代；
- dsh CLI 升级：重新执行 `npm run prepare:vendor` 即可刷新内置版本。
