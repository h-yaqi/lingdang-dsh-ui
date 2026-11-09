#!/usr/bin/env node
/**
 * check-update.mjs — 只读更新检查（不修改任何文件，不拉起进程）
 *
 * 一次性对比四处版本，判断「桌面壳 / 内置 DSH 核心 / 内置 Node / profile 插件」的更新状态：
 *   1. 已安装桌面壳版本（app.asar 里的 package.json，读不到则回退 exe 旁边）
 *   2. 最新桌面壳版本（GitHub Release: h-yaqi/lingdang-dsh-ui）
 *   3. 已安装内置 DSH 版本（resources/dsh）与本地 vendor 版本（vendor/dsh）
 *   4. npm 上 @deepseek-ai/dsh 的 latest 版本（含发布时间与 engines.node 要求）
 *
 * 用法：
 *   node scripts/check-update.mjs
 *   node scripts/check-update.mjs --json                 # 机器可读
 *   node scripts/check-update.mjs --app "D:\apps\DeepSeek Harness Desktop"
 *   node scripts/check-update.mjs --home "$env:USERPROFILE\.dsh-desktop"
 *
 * 约定：永远不把 @deepseek-ai/dsh-* 散包单独安装/比较——
 *   dsh-base / dsh-web-app 等包的 dist-tag 不可信（例如 dsh-base 的 latest 仍是 0.0.1-rc.1），
 *   只以 @deepseek-ai/dsh 的版本为唯一事实，其余版本由它的精确依赖带出。
 *
 * 注意：本脚本只用文件系统 + 网络（node fetch），不 spawn 子进程，
 * 因此在 DSH 沙箱会话里也能安全运行。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SHELL_REPO = 'h-yaqi/lingdang-dsh-ui';
const CORE_PKG = '@deepseek-ai/dsh';
const NPM_REGISTRIES = ['https://registry.npmjs.org', 'https://registry.npmmirror.com'];
const GITHUB_API = 'https://api.github.com';
const TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// 参数与环境
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { json: false, app: null, home: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--app') out.app = argv[++i];
    else if (a === '--home') out.home = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`未知参数: ${a}`);
  }
  return out;
}

function findAppDir(explicit) {
  const candidates = [
    explicit,
    process.env.DSH_DESKTOP_APP,
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'DeepSeek Harness Desktop') : null,
    process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'DeepSeek Harness Desktop') : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness Desktop') : null,
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isDirectory()) return c;
    } catch {
      /* 候选不存在，继续 */
    }
  }
  return null;
}

function dshHomeOf(explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.DSH_DESKTOP_HOME) return path.resolve(process.env.DSH_DESKTOP_HOME);
  return path.join(os.homedir(), '.dsh-desktop');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 读取已安装信息（纯文件读取）
// ---------------------------------------------------------------------------

/** 从 app.asar 头部读出打包时写入的 package.json（即桌面壳版本）。 */
function shellVersionFromAsar(asarPath) {
  let fd;
  try {
    fd = fs.openSync(asarPath, 'r');
    const sizeBuf = Buffer.alloc(8);
    fs.readSync(fd, sizeBuf, 0, 8, 0);
    const headerPickleSize = sizeBuf.readUInt32LE(4);
    const headerBuf = Buffer.alloc(headerPickleSize);
    fs.readSync(fd, headerBuf, 0, headerPickleSize, 8);
    const jsonLen = headerBuf.readUInt32LE(4);
    const header = JSON.parse(headerBuf.toString('utf8', 8, 8 + jsonLen));
    const entry = header?.files?.['package.json'];
    const entryOffset = Number(entry?.offset);
    if (!entry || !Number.isFinite(entryOffset)) return null;
    const dataOffset = 8 + headerPickleSize + entryOffset;
    const fileBuf = Buffer.alloc(entry.size);
    fs.readSync(fd, fileBuf, 0, entry.size, dataOffset);
    return readJsonText(fileBuf.toString('utf8'))?.version ?? null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

function readJsonText(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 内置 node.exe 的版本：node.exe 里写死了 `v<major>.<minor>.<patch>` 字符串，直接扫描二进制即可，
 * 无需执行子进程（沙箱里 spawn + 管道会 EPERM）。
 */
function nodeVersionFromExe(exePath) {
  try {
    const buf = fs.readFileSync(exePath);
    const text = buf.toString('latin1');
    const re = /v(\d{2})\.(\d{1,2})\.(\d{1,3})/g;
    const found = new Map();
    let m;
    while ((m = re.exec(text))) {
      const major = Number(m[1]);
      if (major >= 18 && major <= 40) found.set(m[0], (found.get(m[0]) ?? 0) + 1);
    }
    if (found.size === 0) return null;
    return [...found.entries()].sort((a, b) => b[1] - a[1])[0][0].replace(/^v/, '');
  } catch {
    return null;
  }
}

/** profile/node_modules 里指向已卸载安装位置的断链 junction 数量（旧安装残留）。 */
function brokenLinksIn(dir) {
  const result = { total: 0, broken: 0 };
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    result.total++;
    try {
      fs.realpathSync(path.join(dir, e.name));
    } catch {
      result.broken++;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// 版本比较（支持 -alpha.N / -rc.N 预发布后缀）
// ---------------------------------------------------------------------------
function parseVersion(value) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)\.?(\d+)?)?/i.exec(String(value ?? '').trim());
  if (!m) return null;
  const channel = (m[4] ?? '').toLowerCase();
  const channelRank = channel === 'alpha' ? 0 : channel === 'rc' ? 1 : channel === '' ? 3 : 2;
  return [Number(m[1]), Number(m[2]), Number(m[3]), channelRank, Number(m[5] ?? 0)];
}

function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < pa.length; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/** 解析 engines.node（如 ">=24.9.0"），判断给定 node 版本是否满足；无法解析返回 null。 */
function satisfiesEngine(nodeVersion, range) {
  if (!nodeVersion || !range) return null;
  const m = /^>=\s*(\d+)\.(\d+)\.(\d+)$/.exec(String(range).trim());
  if (!m) return null;
  return (compareVersions(nodeVersion, `${m[1]}.${m[2]}.${m[3]}`) ?? 0) >= 0;
}

// ---------------------------------------------------------------------------
// 网络
// ---------------------------------------------------------------------------
async function fetchJson(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'User-Agent': 'dsh-desktop-check-update', Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchNpmLatest(pkg) {
  const encoded = pkg.replace('/', '%2f');
  const errors = [];
  for (const base of NPM_REGISTRIES) {
    try {
      const doc = await fetchJson(`${base}/${encoded}`);
      const latest = doc?.['dist-tags']?.latest;
      if (!latest) throw new Error('缺少 dist-tags.latest');
      const manifest = doc?.versions?.[latest] ?? {};
      return {
        version: latest,
        publishedAt: doc?.time?.[latest] ?? null,
        enginesNode: manifest?.engines?.node ?? null,
        registry: base,
        distTags: doc?.['dist-tags'] ?? {},
      };
    } catch (error) {
      errors.push(`${base}: ${error.message}`);
    }
  }
  return { error: errors.join(' / ') };
}

async function fetchShellLatest() {
  try {
    const release = await fetchJson(`${GITHUB_API}/repos/${SHELL_REPO}/releases/latest`);
    return {
      tag: release?.tag_name ?? null,
      version: String(release?.tag_name ?? '').replace(/^v/, '') || null,
      publishedAt: release?.published_at ?? null,
      assets: Array.isArray(release?.assets) ? release.assets.map((a) => a.name) : [],
    };
  } catch (error) {
    return { error: error.message };
  }
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
function collectLocal(args) {
  const appDir = findAppDir(args.app);
  const dshHome = dshHomeOf(args.home);
  const local = { appDir, dshHome, installed: {}, vendor: {}, profile: null };

  if (appDir) {
    const resDir = path.join(appDir, 'resources');
    local.installed.shellVersion = shellVersionFromAsar(path.join(resDir, 'app.asar'));
    local.installed.dshVersion = readJson(
      path.join(resDir, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    )?.version ?? null;
    local.installed.nodeVersion = nodeVersionFromExe(path.join(resDir, 'node', 'node.exe'));
  }

  const vendorPkg = readJson(path.join(REPO, 'vendor', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'));
  local.vendor.dshVersion = vendorPkg?.version ?? null;

  const profileDir = path.join(dshHome, 'profiles', 'web');
  const profilePkg = readJson(path.join(profileDir, 'package.json'));
  if (profilePkg) {
    const bundles = profilePkg?.dsh?.profile?.bundles ?? [];
    const deps = profilePkg?.dependencies ?? {};
    const localPlugins = Object.entries(deps)
      .filter(([name]) => name.startsWith('@local/'))
      .map(([name, spec]) => {
        const target = String(spec).replace(/^link:/, '');
        return { name, spec, exists: fs.existsSync(path.resolve(profileDir, target)) };
      });
    local.profile = {
      dir: profileDir,
      bundles,
      localPlugins,
      brokenLinks: brokenLinksIn(path.join(dshHome, 'profiles', 'node_modules')),
    };
  }

  return local;
}

function statusOf(installed, latest) {
  if (!installed || !latest) return 'unknown';
  const cmp = compareVersions(installed, latest);
  if (cmp === null) return 'unknown';
  if (cmp === 0) return 'current';
  return cmp < 0 ? 'behind' : 'ahead';
}

function statusLabel(status) {
  return { current: '✅ 最新', behind: '⚠️ 有新版', ahead: 'ℹ️ 本地更新', unknown: '❓ 未知' }[status] ?? '❓ 未知';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法: node scripts/check-update.mjs [--json] [--app <安装目录>] [--home <DSH_HOME>]');
    return;
  }

  const [npmLatest, shellLatest] = await Promise.all([fetchNpmLatest(CORE_PKG), fetchShellLatest()]);
  const local = collectLocal(args);

  const shellStatus = shellLatest.version
    ? statusOf(local.installed.shellVersion, shellLatest.version)
    : 'unknown';
  const coreStatus = npmLatest.version ? statusOf(local.installed.dshVersion, npmLatest.version) : 'unknown';
  const vendorStatus = npmLatest.version ? statusOf(local.vendor.dshVersion, npmLatest.version) : 'unknown';
  const nodeOk = satisfiesEngine(local.installed.nodeVersion, npmLatest.enginesNode);

  const updatesAvailable = [shellStatus, coreStatus, vendorStatus].includes('behind');
  const report = {
    checkedAt: new Date().toISOString(),
    installed: local.installed,
    installedAppDir: local.appDir,
    dshHome: local.dshHome,
    vendor: local.vendor,
    shellLatest,
    coreLatest: npmLatest,
    profile: local.profile,
    status: { shell: shellStatus, core: coreStatus, vendor: vendorStatus, nodeSatisfiesEngines: nodeOk },
    updatesAvailable,
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const line = (label, value) => console.log(`${label.padEnd(14, ' ')} ${value}`);
  console.log('=== dsh-desktop 更新检查（只读）===');
  line('检查时间', new Date().toLocaleString('zh-CN', { hour12: false }));
  line('安装目录', local.appDir ?? '(未找到已安装应用，可用 --app 指定)');
  line('DSH_HOME', local.dshHome);

  console.log('\n--- 桌面壳 ---');
  line('已安装', local.installed.shellVersion ? `${local.installed.shellVersion}  ${statusLabel(shellStatus)}` : '未知（读不到 app.asar）');
  line(
    '最新发布',
    shellLatest.version
      ? `${shellLatest.version}  (${shellLatest.publishedAt ?? '时间未知'}, GitHub ${SHELL_REPO})`
      : `未知（GitHub 不可达：${shellLatest.error}）`,
  );
  if (shellLatest.assets?.length) line('发布产物', shellLatest.assets.join(' / '));

  console.log('\n--- 内置 DSH 核心 ---');
  line('已安装', local.installed.dshVersion ? `${local.installed.dshVersion}  ${statusLabel(coreStatus)}` : '未知（未找到 resources/dsh）');
  line('vendor', local.vendor.dshVersion ? `${local.vendor.dshVersion}  ${statusLabel(vendorStatus)}` : '未知（vendor/ 未生成）');
  if (npmLatest.version) {
    line('npm latest', `${npmLatest.version}  (${npmLatest.publishedAt ?? '时间未知'}, ${npmLatest.registry})`);
    line('npm 全部 tag', Object.entries(npmLatest.distTags).map(([k, v]) => `${k}=${v}`).join('  '));
  } else {
    line('npm latest', `未知（npm 不可达：${npmLatest.error}）`);
  }

  console.log('\n--- 运行时 ---');
  line('内置 Node', local.installed.nodeVersion ? `v${local.installed.nodeVersion}` : '未知（未找到 resources/node/node.exe）');
  if (npmLatest.enginesNode) {
    line(
      'dsh engines',
      `node ${npmLatest.enginesNode}  ${nodeOk === null ? '❓ 无法判断' : nodeOk ? '✅ 满足' : '⚠️ 不满足（打包前必须先升级内置 node）'}`,
    );
  }

  console.log('\n--- profile（DSH_HOME/profiles/web）---');
  if (local.profile) {
    line('bundles', `${local.profile.bundles.length} 个`);
    line(
      '本地插件',
      local.profile.localPlugins.length
        ? local.profile.localPlugins.map((p) => `${p.name}${p.exists ? '' : '（⚠️ link 目标不存在）'}`).join('  ')
        : '(无)',
    );
    line(
      '残留链接',
      local.profile.brokenLinks.broken > 0
        ? `⚠️ ${local.profile.brokenLinks.broken}/${local.profile.brokenLinks.total} 个断链（旧安装位置残留，可选清理）`
        : '✅ 无断链',
    );
  } else {
    line('profile', `未找到 ${path.join(local.dshHome, 'profiles', 'web', 'package.json')}`);
  }

  console.log('\n--- 结论 ---');
  if (updatesAvailable) {
    console.log('⚠️ 有可更新的部件。');
    if (coreStatus === 'behind' || vendorStatus === 'behind') {
      console.log(
        `   内置 DSH 可从 ${local.installed.dshVersion ?? '?'} 升级到 ${npmLatest.version}；` +
          '内置运行时是打包时冻结的，需重新打包并发布（见 UPDATING.md）。',
      );
    }
    if (shellStatus === 'behind') {
      console.log('   桌面壳有新版本：优先用应用内「设置 → 关于 → 检查更新」自动更新，失败再手动装 GitHub Release。');
    }
  } else if (shellStatus === 'current' && coreStatus === 'current') {
    console.log('✅ 桌面壳与内置 DSH 均为最新。');
  } else {
    console.log('❓ 检查不完整（网络不可达）。GitHub 通常需要代理；npm 已自动尝试官方源与 npmmirror。');
  }
}

main().catch((error) => {
  console.error(`检查失败: ${error && error.message ? error.message : error}`);
  process.exitCode = 1;
});
