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
| `DSH_DESKTOP_DEVTOOLS` | 设为 `1` 时启动即打开开发者工具 | 关闭 |

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
├── package.json
└── README.md
```

## 已知限制 / 后续计划

- 当前为**开发可运行**形态，依赖系统已装的 Node 与 dsh CLI；
- 下一步可用 electron-builder 打包为独立 `.exe` 安装包（届时把 node 与 dsh CLI 一并打进应用，做到完全免依赖）；
- 托盘图标、系统通知、开机自启等可在打包阶段一并加入。
