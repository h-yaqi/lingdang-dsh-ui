// publish-release.mjs — 创建/复用 GitHub Release 并上传资产（经 api/uploads.github.com）
// 用法: node publish-release.mjs <tag> <body> <file...>   （GH_TOKEN 环境变量）
import fs from 'node:fs';

const [tag, body, ...files] = process.argv.slice(2);
const token = process.env.GH_TOKEN;
if (!token) throw new Error('GH_TOKEN 未设置');
const REPO = 'h-yaqi/lingdang-dsh-ui';
const API = `https://api.github.com/repos/${REPO}`;
const UP = `https://uploads.github.com/repos/${REPO}`;

async function call(url, method, { body: b, headers = {}, duplex } = {}) {
  const r = await fetch(url, {
    method,
    headers: { Authorization: 'Bearer ' + token, 'User-Agent': 'dsh-release', ...headers },
    body: b,
    ...(duplex ? { duplex } : {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${url.split('/').slice(-2).join('/')} -> ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  return j;
}

// 复用已存在的 release（如 tag 已创建）
let rel;
try {
  rel = await call(`${API}/releases/tags/${tag}`, 'GET');
  console.log('release reused:', rel.id, rel.html_url);
} catch {
  rel = await call(`${API}/releases`, 'POST', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_name: tag, name: tag, body, draft: false, prerelease: false }),
  });
  console.log('release created:', rel.id, rel.html_url);
}

// 删除同名旧资产后重新上传
const existing = await call(`${API}/releases/${rel.id}/assets`, 'GET');
for (const file of files) {
  const name = file.split(/[\\/]/).pop();
  const old = existing.find((a) => a.name === name);
  if (old) {
    await call(`${API}/releases/assets/${old.id}`, 'DELETE');
    console.log('removed old asset:', name);
  }
  const size = fs.statSync(file).size;
  await call(`${UP}/releases/${rel.id}/assets?name=${encodeURIComponent(name)}`, 'POST', {
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) },
    body: fs.createReadStream(file),
    duplex: 'half',
  });
  console.log('uploaded:', name, '(', Math.round(size / 1e6), 'MB )');
}

console.log('DONE');
