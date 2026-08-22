'use strict';

/**
 * DeepSeek Harness 桌面客户端（Electron）
 *
 * 主进程职责：
 * 1. 解析本机的 node 与 dsh CLI（@deepseek-ai/dsh）入口；
 * 2. 以独立 DSH_HOME（默认 ~/.dsh-desktop，避免与浏览器实例互斥）拉起
 *    `node <dsh>/lib/bin.js web --port 0 --no-open`；
 * 3. 从 stdout 解析 `dsh web: http://127.0.0.1:<port>` 获得 OS 分配的端口；
 * 4. 打开原生窗口加载该地址；退出时用 taskkill 结束整个后端进程树。
 */

const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require('electron');
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const INJECT_SETTINGS_JS = require('./inject-settings.js');

const APP_NAME = 'DeepSeek Harness Desktop';
const BOOT_TIMEOUT_MS = 90_000;
const URL_LINE_RE = /dsh web: (http:\/\/127\.0\.0\.1:\d+)/;
const MAX_LOG = 64 * 1024;

let _logPath = null;
function logPath() {
  if (!_logPath) {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    _logPath = path.join(dir, 'desktop.log');
  }
  return _logPath;
}
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  try {
    const p = logPath();
    // 首次写入带 UTF-8 BOM，方便 Windows 记事本/终端直接读
    fs.appendFileSync(p, (fs.existsSync(p) ? '' : '\uFEFF') + line + '\n');
  } catch {
    /* 日志失败不影响运行 */
  }
}

function exists(p) {
  return fs.promises.access(p).then(() => true, () => false);
}
function execFileAsync(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15_000, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
  });
}

/** 打包后的内置 Node 运行时（extraResources: resources/node/node.exe）；未打包或缺失时返回 null。 */
function bundledNode() {
  if (!app.isPackaged) return null;
  const p = path.join(process.resourcesPath, 'node', 'node.exe');
  return fs.existsSync(p) ? p : null;
}

/** 打包后的内置 dsh CLI（extraResources: resources/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js）；未打包或缺失时返回 null。 */
function bundledDshBin() {
  if (!app.isPackaged) return null;
  const p = path.join(process.resourcesPath, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  return fs.existsSync(p) ? p : null;
}

/** 解析 node 可执行文件：DSH_NODE 环境变量 > where node > 默认安装路径。 */
async function resolveNode() {
  if (process.env.DSH_NODE) {
    const p = path.resolve(process.env.DSH_NODE);
    if (await exists(p)) return p;
  }
  try {
    const out = await execFileAsync('where.exe', ['node']);
    for (const line of out.split(/\r?\n/)) {
      const p = line.trim();
      if (/node\.exe$/i.test(p) && (await exists(p))) return p;
    }
  } catch {
    /* 继续走兜底 */
  }
  const fallback = 'C:\\Program Files\\nodejs\\node.exe';
  if (await exists(fallback)) return fallback;
  throw new Error('未找到 node.exe：请安装 Node.js，或通过环境变量 DSH_NODE 指定路径');
}

/** 由 npm 的 .cmd shim（node_modules/.bin/dsh.cmd）推导 dsh 包的 bin.js。 */
function binJsFromShim(shimPath) {
  return path.join(path.dirname(shimPath), '..', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
}

/**
 * 把用户给的 dsh 入口（bin.js / dsh.cmd / dsh 包目录）解析为 bin.js 绝对路径。
 * @returns {Promise<string|null>} 解析失败返回 null。
 */
async function resolveDshEntryFrom(candidate) {
  const p = path.resolve(String(candidate));
  if (!(await exists(p))) return null;
  if (p.endsWith('bin.js')) return p;
  if (/\.(cmd|bat)$/i.test(p)) {
    const b = binJsFromShim(p);
    if (await exists(b)) return b;
  }
  const alt = path.join(p, 'lib', 'bin.js');
  if (await exists(alt)) return alt;
  return null;
}

/** 读取用户设置（%APPDATA%/dsh-desktop/settings.json），失败返回空对象。 */
function readSettings() {
  try {
    const p = path.join(app.getPath('userData'), 'settings.json');
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, 'utf8')) ?? {};
  } catch {
    return {};
  }
}

/** 选择 node：显式覆盖（环境变量/设置文件）> 内置 > 系统。 */
async function pickNode(settings) {
  const override = process.env.DSH_DESKTOP_NODE || settings.nodePath;
  if (override) {
    const p = path.resolve(String(override));
    if (await exists(p)) {
      log(`node(覆盖): ${p}`);
      return p;
    }
    log(`警告: DSH_DESKTOP_NODE/设置 nodePath 无效，已忽略: ${override}`);
  }
  const bundled = bundledNode();
  if (bundled) {
    log(`node(内置): ${bundled}`);
    return bundled;
  }
  const sys = await resolveNode();
  log(`node(系统): ${sys}`);
  return sys;
}

/** 选择 dsh bin.js：显式覆盖（环境变量/设置文件）> 内置 > 系统。 */
async function pickDsh(settings) {
  const override = process.env.DSH_DESKTOP_DSH || settings.dshPath;
  if (override) {
    const b = await resolveDshEntryFrom(override);
    if (b) {
      log(`dsh(覆盖): ${b}`);
      return b;
    }
    log(`警告: DSH_DESKTOP_DSH/设置 dshPath 无效，已忽略: ${override}`);
  }
  const bundled = bundledDshBin();
  if (bundled) {
    log(`dsh(内置): ${bundled}`);
    return bundled;
  }
  const sys = await resolveDshBin();
  log(`dsh(系统): ${sys}`);
  return sys;
}

/** 解析 dsh CLI 的 bin.js：DSH_CLI 环境变量 > where dsh > npx 缓存兜底。 */
async function resolveDshBin() {
  if (process.env.DSH_CLI) {
    const b = await resolveDshEntryFrom(process.env.DSH_CLI);
    if (b) return b;
    throw new Error(`DSH_CLI 无法识别：${process.env.DSH_CLI}`);
  }
  try {
    const out = await execFileAsync('where.exe', ['dsh']);
    for (const line of out.split(/\r?\n/)) {
      const p = line.trim();
      if (!p) continue;
      if (/\.cmd$/i.test(p) && (await exists(p))) {
        const b = binJsFromShim(p);
        if (await exists(b)) return b;
      }
      if (p.endsWith('bin.js') && (await exists(p))) return p;
    }
  } catch {
    /* 继续走兜底 */
  }
  // npx 缓存兜底：扫描 _npx/*/node_modules/@deepseek-ai/dsh/lib/bin.js
  const npxRoot = path.join(os.homedir(), 'AppData', 'Local', 'npm-cache', '_npx');
  try {
    const dirs = await fs.promises.readdir(npxRoot);
    const found = [];
    for (const d of dirs) {
      const b = path.join(npxRoot, d, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
      if (await exists(b)) found.push(b);
    }
    if (found.length > 0) return found[0];
  } catch {
    /* 忽略 */
  }
  throw new Error(
    '未找到 dsh CLI（@deepseek-ai/dsh）。请先执行 `npx -y @deepseek-ai/dsh` 安装，' +
      '或通过环境变量 DSH_CLI 指定 dsh 的 bin.js / dsh.cmd 路径',
  );
}

/** 解析桌面端使用的 DSH_HOME：DSH_DESKTOP_HOME > 默认 ~/.dsh-desktop（隔离，避免与浏览器实例互斥）。 */
function resolveDshHome() {
  return process.env.DSH_DESKTOP_HOME
    ? path.resolve(process.env.DSH_DESKTOP_HOME)
    : path.join(os.homedir(), '.dsh-desktop');
}

// ---------------------------------------------------------------------------
// 后端生命周期
// ---------------------------------------------------------------------------

let child = null;
let backendUrl = null;
let booted = false;
let quitting = false;
/** 当前生效的运行时（供版本查询/更新功能使用）。 */
let activeNodePath = null;
let activeDshBin = null;

/**
 * 启动 `node <bin.js> web --port 0 --no-open` 并等待其打印监听地址。
 * @returns {Promise<string>} 完整 URL，如 http://127.0.0.1:54321
 */
function startBackend() {
  return new Promise((resolve, reject) => {
    let timer = null;
    (async () => {
      const settings = readSettings();
      const nodePath = await pickNode(settings);
      const binJs = await pickDsh(settings);
      activeNodePath = nodePath;
      activeDshBin = binJs;
      const home = resolveDshHome();
      fs.mkdirSync(home, { recursive: true });
      log(`后端: ${nodePath} ${binJs} web --port 0 --no-open`);
      log(`DSH_HOME: ${home}`);

      let settled = false;
      let out = '';
      let err = '';
      timer = setTimeout(() => {
        if (settled || backendUrl) return;
        settled = true;
        try {
          child?.kill();
        } catch {
          /* ignore */
        }
        reject(new Error(`后端启动超时（${BOOT_TIMEOUT_MS / 1000}s）。最后输出：\n${tail(err) || tail(out) || '(无输出)'}`));
      }, BOOT_TIMEOUT_MS);

      child = spawn(nodePath, [binJs, 'web', '--port', '0', '--no-open'], {
        env: { ...process.env, DSH_HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      child.stdout.on('data', (d) => {
        out = (out + d.toString()).slice(-MAX_LOG);
        const m = out.match(URL_LINE_RE);
        if (m && !settled) {
          settled = true;
          backendUrl = m[1];
          booted = true;
          clearTimeout(timer);
          log(`监听地址: ${backendUrl}`);
          resolve(backendUrl);
        }
      });
      child.stderr.on('data', (d) => {
        err = (err + d.toString()).slice(-MAX_LOG);
      });
      child.on('exit', (code, signal) => {
        clearTimeout(timer);
        log(`后端进程退出 code=${code} signal=${signal}`);
        if (!settled && !backendUrl) {
          settled = true;
          reject(new Error(`后端在输出监听地址前退出（code=${code}）。stderr：\n${tail(err) || tail(out) || '(无输出)'}`));
          return;
        }
        if (booted && !quitting) backendDied(code);
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(new Error(`无法启动后端进程：${error.message}`));
        }
      });
    })().catch((error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
  });
}

function tail(s) {
  return s.trim().split(/\r?\n/).slice(-25).join('\n');
}

/** 后端在窗口存活期间意外退出时的处理。 */
async function backendDied(code) {
  if (quitting) return;
  const { response } = await dialog.showMessageBox(win, {
    type: 'error',
    title: '后端服务已退出',
    message: `DSH 后端进程意外退出（code=${code}）。`,
    detail: '可以尝试重新启动。',
    buttons: ['重新启动', '退出'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) restartApp();
  else app.quit();
}

/** 重启整个后端 + 窗口。 */
async function restartApp() {
  backendUrl = null;
  booted = false;
  child = null;
  try {
    const url = await startBackend();
    if (win && !win.isDestroyed()) win.loadURL(url);
    else createWindow(url);
  } catch (error) {
    fatalError(error);
  }
}

/** 结束后端进程树（Windows 用 taskkill /t /f）。 */
function stopBackend() {
  const pid = child?.pid;
  child = null;
  if (!pid) return;
  log(`结束后端进程树 pid=${pid}`);
  try {
    spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore',
    });
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// 窗口与菜单
// ---------------------------------------------------------------------------

let win = null;

function createWindow(url) {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: APP_NAME,
    backgroundColor: '#0e1116',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  win.loadURL(url);
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('did-finish-load', () => {
    log(`GUI 已加载: ${win.webContents.getURL()}`);
    // 等待 SPA 就绪后注入设置页卡片（卡片本身带 MutationObserver 自动重试）
    setTimeout(injectSettingsUI, 3000);
  });
  installDomDump();
  win.on('closed', () => {
    win = null;
  });
  if (process.env.DSH_DESKTOP_DEVTOOLS === '1') {
    win.webContents.openDevTools({ mode: 'detach' });
  }
}

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '重新加载', accelerator: 'CmdOrCtrl+R', click: () => win?.webContents.reload() },
        { label: '开发者工具', accelerator: 'F12', click: () => win?.webContents.toggleDevTools() },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    { role: 'editMenu', label: '编辑' },
    { role: 'viewMenu', label: '视图' },
    { role: 'windowMenu', label: '窗口' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function fatalError(error) {
  log('致命错误:', error && error.message ? error.message : String(error));
  await dialog.showMessageBox({
    type: 'error',
    title: '启动失败',
    message: String(error && error.message ? error.message : error),
    detail: `日志文件：${logPath()}`,
    buttons: ['退出'],
  });
  app.exit(1);
}

// ---------------------------------------------------------------------------
// IPC：设置页"关于 dsh-desktop"卡片（版本显示 + 检查更新）
// ---------------------------------------------------------------------------

/** 从 bin.js 路径推导 dsh 包版本（…/@deepseek-ai/dsh/lib/bin.js → …/@deepseek-ai/dsh/package.json）。 */
async function dshVersionOf(binJs) {
  if (!binJs) return '未知';
  try {
    const pkg = path.join(path.dirname(binJs), '..', 'package.json');
    return JSON.parse(fs.readFileSync(pkg, 'utf8')).version ?? '未知';
  } catch {
    return '未知';
  }
}

/** 查询 node 运行时版本。 */
async function nodeVersionOf(nodePath) {
  if (!nodePath) return '未知';
  try {
    return (await execFileAsync(nodePath, ['--version'])).trim();
  } catch {
    return '未知';
  }
}

/** 注册渲染进程 IPC 处理器（设置页卡片使用）。 */
function setupIpc() {
  ipcMain.handle('dsh-desktop:get-versions', async () => ({
    appVersion: app.getVersion(),
    dshVersion: await dshVersionOf(activeDshBin),
    nodeVersion: await nodeVersionOf(activeNodePath),
    dshHome: resolveDshHome(),
  }));

  ipcMain.handle('dsh-desktop:check-update', async () => {
    if (!app.isPackaged || !updater) {
      return { status: 'dev', message: '开发模式不支持自动更新（打包版可用）' };
    }
    try {
      const result = await updater.checkForUpdates();
      if (result && result.updateInfo) {
        const message = `发现新版本 ${result.updateInfo.version}，正在后台下载，完成后会提示安装`;
        log(`手动检查更新: ${message}`);
        return { status: 'available', version: result.updateInfo.version, message };
      }
      const message = `已是最新版本（${app.getVersion()}）`;
      log(`手动检查更新: ${message}`);
      return { status: 'current', message };
    } catch (err) {
      log(`手动检查更新失败: ${err && err.message ? err.message : err}`);
      return { status: 'error', message: `检查失败：${err && err.message ? err.message : err}` };
    }
  });
}

/** 向设置页注入"关于 dsh-desktop"卡片（main world 脚本）。 */
function injectSettingsUI() {
  win?.webContents.executeJavaScript(INJECT_SETTINGS_JS).catch(() => {
    /* 页面未就绪/注入失败不影响主流程 */
  });
}

/** 调试工具：DSH_DESKTOP_DUMP_DOM=1 时把设置页 DOM 结构写到日志目录，便于排查注入选择器。 */
function installDomDump() {
  if (process.env.DSH_DESKTOP_DUMP_DOM !== '1' || !win) return;
  win.webContents.on('did-finish-load', async () => {
    try {
      await new Promise((r) => setTimeout(r, 5000));
      const result = await win.webContents.executeJavaScript(`(async () => {
        const out = {};
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const allEls = () => [...document.querySelectorAll('*')];
        const vis = (e) => e.offsetParent !== null && (e.textContent || '').trim().length > 0;
        const items = allEls().filter(vis).map((e) => ({
          tag: e.tagName,
          text: (e.textContent || '').trim().slice(0, 40),
          cls: (e.className || '').toString().slice(0, 40),
          role: e.getAttribute && e.getAttribute('role'),
        }));
        out.items = items.filter((x) => /设置|Settings/.test(x.text)).slice(0, 20);
        out.buttons = items.filter((x) => x.tag === 'BUTTON' || x.role === 'button').slice(0, 30);
        const clickCandidates = allEls().filter((e) => vis(e) && (e.textContent || '').trim() === '设置' && e.children.length === 0);
        out.candidates = clickCandidates.length;
        for (const el of clickCandidates.slice(0, 3)) {
          el.click();
          await sleep(2500);
        }
        await sleep(1500);
        out.url = location.href;
        out.title = document.title;
        out.headings = allEls().filter((e) => /^H[1-6]$/.test(e.tagName) || (e.getAttribute && e.getAttribute('role') === 'heading')).map((e) => (e.textContent || '').trim().slice(0, 60)).slice(0, 30);
        const tong = allEls().filter((e) => e.children.length <= 1 && /通用/.test(e.textContent || '')).slice(0, 5);
        out.tongyong = tong.map((e) => ({ tag: e.tagName, text: (e.textContent || '').trim().slice(0, 60), html: e.outerHTML.slice(0, 400) }));
        out.text = document.body.innerText.slice(0, 2500);
        // 自动点击"检查更新"按钮并读取状态（验证按钮 → IPC → 更新检查链路）
        const cardBtn = document.getElementById('dshd-checkbtn');
        if (cardBtn) {
          cardBtn.click();
          await sleep(5000);
          out.updateStatus = (document.getElementById('dshd-status') || {}).textContent || '(none)';
          out.updateBtnDisabled = cardBtn.disabled;
          out.cardText = (document.getElementById('dsh-desktop-about-card') || {}).innerText || '(card gone)';
        } else {
          out.updateStatus = '(card button not found)';
        }
        return JSON.stringify(out, null, 1);
      })()`);
      const dumpPath = path.join(app.getPath('userData'), 'logs', 'dom-dump.txt');
      fs.writeFileSync(dumpPath, result, 'utf8');
      log(`DOM dump 已写入 ${dumpPath}`);
    } catch (e) {
      log(`DOM dump 失败: ${e.message}`);
    }
  });
}

// ---------------------------------------------------------------------------
// 自动更新（仅打包版生效；更新源默认取 resources/app-update.yml 的 GitHub 配置，
// 可用环境变量 DSH_DESKTOP_UPDATE_URL 覆盖为任意 generic 源，便于自建源/测试）
// ---------------------------------------------------------------------------

let updater = null;

function setupAutoUpdater() {
  if (!app.isPackaged) {
    log('自动更新: 开发模式跳过');
    return;
  }
  try {
    const { autoUpdater } = require('electron-updater');
    updater = autoUpdater;
    if (process.env.DSH_DESKTOP_UPDATE_URL) {
      log(`自动更新: 使用自定义更新源 ${process.env.DSH_DESKTOP_UPDATE_URL}`);
      updater.setFeedURL({ provider: 'generic', url: process.env.DSH_DESKTOP_UPDATE_URL });
    }
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.on('checking-for-update', () => log('自动更新: 开始检查更新'));
    updater.on('update-available', (info) => log(`自动更新: 发现新版本 ${info.version}`));
    updater.on('update-not-available', (info) => log(`自动更新: 已是最新 (${info.version})`));
    updater.on('error', (err) => log(`自动更新: 出错 ${err && err.message ? err.message : err}`));
    updater.on('update-downloaded', async (info) => {
      log(`自动更新: 新版本 ${info.version} 下载完成，询问安装`);
      const { response } = await dialog.showMessageBox(win, {
        type: 'info',
        title: '发现新版本',
        message: `新版本 ${info.version} 已下载完成。`,
        detail: '点击"立即重启安装"将关闭应用并完成更新。',
        buttons: ['立即重启安装', '稍后'],
        defaultId: 0,
        cancelId: 1,
      });
      if (response === 0) updater.quitAndInstall();
    });
    // 等窗口起来后再检查，避免启动即弹窗
    setTimeout(() => {
      updater.checkForUpdates().catch((e) => log(`自动更新: 检查失败 ${e.message}`));
    }, 10_000);
  } catch (err) {
    log(`自动更新: 初始化失败 ${err && err.message ? err.message : err}`);
  }
}

// ---------------------------------------------------------------------------
// 应用生命周期
// ---------------------------------------------------------------------------

app.setName('dsh-desktop');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.on('before-quit', () => {
    quitting = true;
  });
  app.on('will-quit', () => {
    stopBackend();
  });
  app.on('window-all-closed', () => {
    app.quit();
  });

  app.whenReady().then(async () => {
    buildMenu();
    setupIpc();
    try {
      const url = await startBackend();
      createWindow(url);
      setupAutoUpdater();
    } catch (error) {
      fatalError(error);
    }
  });
}
