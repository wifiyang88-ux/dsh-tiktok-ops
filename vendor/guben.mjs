#!/usr/bin/env node
/**
 * 顾本素材网 Agent CLI（零依赖，Node 18+）
 *
 * 通过个人 API Token 访问素材网 /api/agent/*，供 Claude Agent Skill 调用。
 * 配置保存在 ~/.guben/config.json（也支持 skill 目录下的 config.json）。
 *
 * 能力：公共素材库搜/下/传 · 我的作品增/查/下 · AI 生图 · AI 生视频
 * 用法见 SKILL.md，或运行 `node guben.mjs`（不带参数）查看帮助。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, createWriteStream, createReadStream, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME_CONFIG = join(homedir(), '.guben', 'config.json');
const LOCAL_CONFIG = join(__dirname, 'config.json');

function loadConfig() {
  for (const p of [HOME_CONFIG, LOCAL_CONFIG]) {
    try {
      if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
    } catch {}
  }
  return null;
}
function saveConfig(cfg) {
  mkdirSync(dirname(HOME_CONFIG), { recursive: true });
  writeFileSync(HOME_CONFIG, JSON.stringify(cfg, null, 2));
}

function out(o) {
  console.log(JSON.stringify(o));
}
function fail(msg) {
  console.error('❌ ' + msg);
  process.exit(1);
}

async function api(cfg, path, opts = {}) {
  if (!cfg || !cfg.base || !cfg.token) {
    fail('未配置。请先运行：node scripts/guben.mjs config --base <素材网地址> --token <API Token>');
  }
  const res = await fetch(cfg.base.replace(/\/+$/, '') + '/api/agent' + path, {
    ...opts,
    headers: { Authorization: 'Bearer ' + cfg.token, ...(opts.headers || {}) },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) {
    const msg = body?.message ?? (typeof body === 'string' ? body : JSON.stringify(body));
    fail(`HTTP ${res.status}${body?.statusCode === 402 ? '（额度不足）' : ''}: ${msg}`);
  }
  return body;
}

function json(opts) {
  return { headers: { 'Content-Type': 'application/json' }, ...opts };
}

function parseArgs(args) {
  const o = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      o[key] = next && !next.startsWith('--') ? args[++i] : true;
    } else {
      o._.push(a);
    }
  }
  return o;
}

/** 逗号分隔的 id 列表 → [{materialId, scope}] */
function refList(o) {
  if (!o.refs || o.refs === true) return [];
  return String(o.refs)
    .split(/[,，]/)
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)
    .map((materialId) => ({ materialId, scope: String(o.scope || 'private') }));
}

function num(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/** 把预签名 URL 流式落到本地目录，返回文件路径 */
async function saveTo(url, dir, fileName) {
  mkdirSync(dir, { recursive: true });
  const safe = String(fileName || 'guben-file').replace(/[\\/:*?"<>|]+/g, '_');
  const dest = join(dir, safe);
  const res = await fetch(url);
  if (!res.ok || !res.body) fail(`下载失败 HTTP ${res.status}（${safe}）`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  return dest;
}

const HELP = `顾本素材网 Agent CLI

【配置】
  node guben.mjs config --base <地址> --token <API Token>       配置（只需一次）

【账号】
  node guben.mjs groups                                         分组列表
  node guben.mjs points                                         积分余额与消耗构成

【公共素材库】（下载扣积分，上传进审核）
  node guben.mjs search <关键词> [--type video|image|audio] [--group <id>] [--limit n]
  node guben.mjs get <素材id>                                    素材详情
  node guben.mjs download <id1> [id2 ...] [--out <目录>]         下载到本地（默认 ./guben-materials）
  node guben.mjs upload <文件> --title <标题> --groups <分组id,...> [--tags "a,b"] [--contentType <mime>]

【我的作品】（仅本人可见，不审核；下载免费不扣分）
  node guben.mjs works [--search <关键词>] [--type image|video|audio] [--tag <标签>] [--limit n]
  node guben.mjs work <作品id>                                   作品详情（含提示词与引用素材）
  node guben.mjs download-work <id1> [id2 ...] [--out <目录>]    下载作品（默认 ./guben-works）
  node guben.mjs upload-work <文件> [--title <标题>] [--tags "a,b"]   上传为作品

【AI 生成】（消耗积分，1 积分 = 1 元；受该 API Token 的消耗额度约束）
  node guben.mjs quote image [--model <key>] [--resolution 1K|2K] [--ratio 16:9] [--count 1-4]
  node guben.mjs quote video [--resolution 480p|720p|1080p] [--duration <秒|-1>] [--refs <素材id,...>]
  node guben.mjs refs image|video [--scope private|downloaded] [--search <关键词>] [--limit n]
  node guben.mjs gen image "<提示词>" [--model <key>] [--resolution 1K] [--ratio 16:9] [--count 1]
                     [--refs <作品id,...>] [--scope private] [--share] [--no-wait] [--out <目录>]
  node guben.mjs gen video "<提示词>" --resolution 720p --duration 5 [--ratio adaptive|16:9|9:16|1:1|4:3|3:4|21:9]
                     [--refs <素材id,...>] [--scope private] [--generate-audio] [--use-assistant] [--share]
                     [--no-wait] [--out <目录>]
  node guben.mjs tasks image|video [--limit n] [--status queued,generating,succeeded,failed,canceled]
  node guben.mjs task image|video <任务id>                        查单个任务状态
  node guben.mjs wait image|video <任务id> [--timeout 900] [--interval 5] [--out <目录>]
  node guben.mjs cancel image|video <任务id>                      取消（全额退款；上游已开始则可能撤不回）

说明：
  · gen 默认会等待生成完成并把产物下载到 ./guben-outputs，加 --no-wait 只提交任务拿 id。
  · --refs 引用的素材默认取自「我的作品」(scope=private)；引用下载过的公共素材加 --scope downloaded。
  · 生成的作品默认**不**分享到灵感广场，需要分享显式加 --share。
`;

// ---- 子命令实现 ----

async function cmdConfig(o) {
  const base = o.base || o._[0];
  const token = o.token || o._[1];
  if (!base || !token) fail('用法：config --base <素材网地址> --token <API Token>');
  saveConfig({ base: String(base).replace(/\/+$/, ''), token: String(token) });
  out({ ok: true, message: '配置已保存到 ' + HOME_CONFIG });
}

async function cmdGroups(cfg) {
  out(await api(cfg, '/groups'));
}

async function cmdPoints(cfg) {
  out(await api(cfg, '/points'));
}

async function cmdSearch(cfg, query, o) {
  const params = new URLSearchParams();
  if (query) params.set('search', query);
  if (o.type) params.set('type', String(o.type));
  if (o.group) params.set('groupId', String(o.group));
  params.set('pageSize', String(o.limit || 10));
  const body = await api(cfg, '/materials?' + params.toString());
  out({
    total: body.total,
    page: body.page,
    pageSize: body.pageSize,
    items: (body.items || []).map((m) => ({
      id: m.id,
      title: m.title,
      type: m.type,
      tags: m.tags,
      price: m.price,
      duration: m.metadata?.duration ?? null,
      width: m.metadata?.width ?? null,
      height: m.metadata?.height ?? null,
      aspectRatio: m.metadata?.aspectRatio ?? null,
      downloadCount: m.downloadCount ?? 0,
      aiSummary: m.aiSummary ?? null,
      downloaded: m.downloaded ?? false,
    })),
  });
}

async function cmdGet(cfg, id) {
  const d = await api(cfg, '/materials/' + id);
  out({
    id: d.id,
    title: d.title,
    type: d.type,
    tags: d.tags,
    price: d.price,
    status: d.status,
    metadata: d.metadata,
    aiSummary: d.aiSummary,
    previewUrl: d.previewUrl,
    thumbUrl: d.thumbUrl,
    downloaded: d.downloaded,
    groups: d.groups,
  });
}

async function cmdDownload(cfg, ids, o) {
  if (!ids.length) fail('请提供要下载的素材 id');
  const dir = String(o.out || './guben-materials');
  const results = [];
  for (const id of ids) {
    const info = await api(cfg, `/materials/${id}/download`, { method: 'POST' });
    const dest = await saveTo(info.url, dir, info.fileName || `material-${id}`);
    results.push({ id: Number(id), file: dest, price: info.price, charged: info.charged });
  }
  out({ ok: true, dir, files: results });
}

/**
 * 上传文件到 OSS（素材与作品共用同一套直传），返回 { key, type }。
 * 用流式 PUT + 显式 Content-Length：不把整个文件读进内存，几百 MB 的视频也能传。
 * 注：分片/断点续传目前只有桌面客户端在用（/materials/multipart/*），
 * 且其 complete 会顺带登记为公共素材，语义与「上传作品」不同，故 Agent 侧不暴露。
 */
async function uploadFile(cfg, file, contentType) {
  if (!existsSync(file)) fail('文件不存在：' + file);
  const fileName = basename(file);
  const size = statSync(file).size;
  const presign = await api(cfg, '/upload/presign', json({ method: 'POST', body: JSON.stringify({ fileName, contentType }) }));
  const up = await fetch(presign.uploadUrl, {
    method: 'PUT',
    duplex: 'half',
    body: Readable.toWeb(createReadStream(file)),
    headers: { 'Content-Type': contentType || 'application/octet-stream', 'Content-Length': String(size) },
  });
  if (!up.ok) fail(`文件上传失败 HTTP ${up.status}${up.status === 403 ? '（预签名地址过期或 Content-Type 不匹配，请重试）' : ''}`);
  return { key: presign.key, type: presign.type };
}

async function cmdUpload(cfg, file, o) {
  if (!o.title) fail('用法：upload <文件> --title <标题> [--groups <分组id,...>] [--tags "a,b"]');
  const { key, type } = await uploadFile(cfg, file, o.contentType);
  const created = await api(cfg, '/materials', json({
    method: 'POST',
    body: JSON.stringify({
      type,
      ossKey: key,
      title: String(o.title),
      tags: splitList(o.tags),
      groupIds: splitList(o.groups).map(Number).filter(Boolean),
    }),
  }));
  out({ ok: true, message: '已提交到公共素材库，等待管理员审核', material: created });
}

function splitList(v) {
  if (!v || v === true) return [];
  return String(v).split(/[,，]/).map((s) => s.trim()).filter(Boolean);
}

async function cmdUploadWork(cfg, file, o) {
  const { key, type } = await uploadFile(cfg, file, o.contentType);
  const created = await api(cfg, '/works', json({
    method: 'POST',
    body: JSON.stringify({ type, ossKey: key, title: o.title ? String(o.title) : undefined, tags: splitList(o.tags) }),
  }));
  out({ ok: true, message: '已存入「我的作品」（不进公共库、不需审核）', work: created });
}

async function cmdWorks(cfg, o) {
  const params = new URLSearchParams();
  if (o.search && o.search !== true) params.set('search', String(o.search));
  if (o.type) params.set('type', String(o.type));
  if (o.tag) params.set('tag', String(o.tag));
  if (o.sort) params.set('sort', String(o.sort));
  params.set('pageSize', String(o.limit || 20));
  const body = await api(cfg, '/works?' + params.toString());
  out({
    total: body.total,
    page: body.page,
    pageSize: body.pageSize,
    items: (body.items || []).map((m) => ({
      id: m.id,
      title: m.title,
      type: m.type,
      tags: m.tags,
      source: m.source,
      createdAt: m.createdAt,
      width: m.metadata?.width ?? null,
      height: m.metadata?.height ?? null,
      duration: m.metadata?.duration ?? null,
    })),
  });
}

async function cmdWorkTags(cfg) {
  out(await api(cfg, '/works/tags'));
}

async function cmdWork(cfg, id) {
  out(await api(cfg, '/works/' + id));
}

async function cmdDownloadWork(cfg, ids, o) {
  if (!ids.length) fail('请提供要下载的作品 id');
  const dir = String(o.out || './guben-works');
  const results = [];
  for (const id of ids) {
    const info = await api(cfg, `/works/${id}/download`);
    const dest = await saveTo(info.url, dir, info.fileName || `work-${id}`);
    results.push({ id: Number(id), file: dest });
  }
  out({ ok: true, dir, files: results, note: '作品属于本人，下载不扣积分' });
}

// ---- AI 生成 ----

async function cmdQuote(cfg, kind, o) {
  if (kind === 'image') {
    const p = new URLSearchParams();
    if (o.model) p.set('model', String(o.model));
    if (o.resolution) p.set('resolution', String(o.resolution));
    if (o.ratio) p.set('ratio', String(o.ratio));
    p.set('count', String(o.count || 1));
    const q = await api(cfg, '/ai-image/quote?' + p.toString());
    out({
      balance: q.balance,
      points: q.points,
      unitPoints: q.unitPoints,
      maxCount: q.maxCount,
      budget: q.budget,
      current: q.current,
      models: (q.models || []).map((m) => ({
        key: m.key,
        label: m.label,
        points: m.points,
        maxRefs: m.maxRefs,
        // 只报「哪个分辨率支持哪些比例」：像素尺寸由后端按档位换算，无需 Agent 关心
        supported: Object.fromEntries(Object.entries(m.sizes || {}).map(([res, byRatio]) => [res, Object.keys(byRatio)])),
        note: m.note,
      })),
    });
    return;
  }
  if (kind !== 'video') fail('quote 只支持 image / video');
  const p = new URLSearchParams();
  if (o.resolution) p.set('resolution', String(o.resolution));
  p.set('duration', String(o.duration ?? 5));
  if (o.refs && o.refs !== true) p.set('refs', String(o.refs));
  out(await api(cfg, '/ai-video/quote?' + p.toString()));
}

async function cmdRefs(cfg, kind, o) {
  if (kind !== 'image' && kind !== 'video') fail('refs 只支持 image / video');
  const p = new URLSearchParams();
  p.set('scope', String(o.scope || 'private'));
  if (o.search && o.search !== true) p.set('search', String(o.search));
  if (o.type && kind === 'video') p.set('type', String(o.type));
  p.set('pageSize', String(o.limit || 20));
  const body = await api(cfg, `/ai-${kind}/refs?` + p.toString());
  out({
    total: body.total,
    items: (body.items || []).map((m) => ({ id: m.id, title: m.title, type: m.type, thumbUrl: m.thumbUrl, duration: m.metadata?.duration ?? null })),
  });
}

/** 产物标题往往就是提示词、不带扩展名；从 URL 路径补上真实扩展名，避免落盘文件无法打开 */
function withExt(name, url) {
  if (/\.[A-Za-z0-9]{1,5}$/.test(name)) return name;
  let path = '';
  try {
    path = new URL(url).pathname;
  } catch {
    return name;
  }
  const m = path.match(/\.([A-Za-z0-9]{1,5})$/);
  return m ? `${name}.${m[1].toLowerCase()}` : name;
}

/** 把任务里的产物 URL 抽出来（生图 outputs[]，生视频 videoUrl） */
function taskOutputs(kind, t) {
  if (kind === 'image') {
    return (t.outputs || []).map((o, i) => ({
      materialId: o.id,
      url: o.url,
      fileName: withExt(o.title || `guben-image-${t.id}-${i + 1}`, o.url),
    }));
  }
  return t.videoUrl
    ? [{ materialId: t.materialId, url: t.videoUrl, fileName: withExt(`guben-video-${t.id}`, t.videoUrl) }]
    : [];
}

async function cmdWait(cfg, kind, id, o) {
  const timeout = num(o.timeout, 900);
  const interval = Math.max(2, num(o.interval, 5));
  const deadline = Date.now() + timeout * 1000;
  let t = null;
  for (;;) {
    t = await api(cfg, `/ai-${kind}/tasks/${id}`);
    if (t.status !== 'queued' && t.status !== 'generating') break;
    if (Date.now() > deadline) {
      out({ ok: false, timeout: true, task: briefTask(kind, t), message: `等待超过 ${timeout} 秒，任务仍在进行；可稍后再用 task/wait 查询` });
      return;
    }
    await new Promise((r) => setTimeout(r, interval * 1000));
  }
  const outputs = taskOutputs(kind, t);
  const files = [];
  if (outputs.length) {
    const dir = String(o.out || './guben-outputs');
    for (const item of outputs) {
      if (!item.url) continue;
      files.push(await saveTo(item.url, dir, item.fileName));
    }
  }
  out({
    ok: t.status === 'succeeded',
    task: briefTask(kind, t),
    files,
    message:
      t.status === 'succeeded'
        ? `生成完成，产物已存入「我的作品」并下载到本地${t.inspirationShared ? '' : '（未分享到灵感广场）'}`
        : t.status === 'canceled'
          ? '任务已取消，预扣积分已退回'
          : `生成失败：${t.error || '未知原因'}（预扣积分已退回）`,
  });
}

function briefTask(kind, t) {
  return {
    id: t.id,
    status: t.status,
    prompt: t.prompt,
    pointsHeld: t.pointsHeld,
    pointsCharged: t.pointsCharged ?? null,
    error: t.error ?? null,
    outputs: taskOutputs(kind, t).map((x) => ({ materialId: x.materialId, url: x.url })),
    inspirationShared: t.inspirationShared ?? (t.outputs || []).some((x) => x.inspirationShared),
    createdAt: t.createdAt,
  };
}

async function cmdGen(cfg, kind, o) {
  if (kind !== 'image' && kind !== 'video') fail('gen 只支持 image / video');
  const prompt = o._[1];
  if (!prompt) fail(`用法：gen ${kind} "<提示词>" [参数]`);
  const refs = refList(o);

  if (kind === 'image') {
    const body = {
      prompt: String(prompt),
      model: o.model ? String(o.model) : undefined,
      resolution: o.resolution ? String(o.resolution) : undefined,
      ratio: o.ratio ? String(o.ratio) : undefined,
      count: o.count ? num(o.count, 1) : undefined,
      refs: refs.length ? refs : undefined,
      shareToInspiration: o.share === true,
    };
    return afterGen(cfg, 'image', await api(cfg, '/ai-image/tasks', json({ method: 'POST', body: JSON.stringify(body) })), o);
  }

  if (!o.resolution) fail('生视频必须指定 --resolution（480p / 720p / 1080p）；先跑 quote video 看报价');
  if (!o.duration) fail('生视频必须指定 --duration（秒，-1 表示智能时长）；先跑 quote video 看报价');
  const body = {
    prompt: String(prompt),
    resolution: String(o.resolution),
    ratio: o.ratio ? String(o.ratio) : undefined,
    duration: num(o.duration, 5),
    generateAudio: o['generate-audio'] === true ? true : undefined,
    refs: refs.length ? refs : undefined,
    useAssistant: o['use-assistant'] === true ? true : undefined,
    shareToInspiration: o.share === true,
  };
  return afterGen(cfg, 'video', await api(cfg, '/ai-video/tasks', json({ method: 'POST', body: JSON.stringify(body) })), o);
}

async function afterGen(cfg, kind, task, o) {
  if (o['no-wait']) {
    out({ ok: true, submitted: true, task: briefTask(kind, task), message: '任务已提交（预扣已记账）。用 wait/task 查询进度' });
    return;
  }
  return cmdWait(cfg, kind, String(task.id), o);
}

async function cmdTasks(cfg, kind, o) {
  if (kind !== 'image' && kind !== 'video') fail('tasks 只支持 image / video');
  const p = new URLSearchParams();
  if (o.status && o.status !== true) p.set('status', String(o.status));
  if (o.search && o.search !== true) p.set('search', String(o.search));
  p.set('pageSize', String(o.limit || 12));
  const body = await api(cfg, `/ai-${kind}/tasks?` + p.toString());
  out({ total: body.total, items: (body.items || []).map((t) => briefTask(kind, t)) });
}

async function cmdTask(cfg, kind, id) {
  if (kind !== 'image' && kind !== 'video') fail('task 只支持 image / video');
  out(briefTask(kind, await api(cfg, `/ai-${kind}/tasks/${id}`)));
}

async function cmdCancel(cfg, kind, id) {
  if (kind !== 'image' && kind !== 'video') fail('cancel 只支持 image / video');
  out(await api(cfg, `/ai-${kind}/tasks/${id}/cancel`, { method: 'POST' }));
}

// ---- 分发 ----

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(HELP);
    return;
  }
  const o = parseArgs(rest);
  const cfg = cmd === 'config' ? null : loadConfig();

  switch (cmd) {
    case 'config': return cmdConfig(o);
    case 'groups': return cmdGroups(cfg);
    case 'points': return cmdPoints(cfg);
    case 'search': return cmdSearch(cfg, o._[0] || '', o);
    case 'get': return cmdGet(cfg, o._[0]);
    case 'download': return cmdDownload(cfg, o._, o);
    case 'upload': return cmdUpload(cfg, o._[0], o);
    case 'works': return cmdWorks(cfg, o);
    case 'work-tags': return cmdWorkTags(cfg);
    case 'work': return cmdWork(cfg, o._[0]);
    case 'download-work': return cmdDownloadWork(cfg, o._, o);
    case 'upload-work': return cmdUploadWork(cfg, o._[0], o);
    case 'quote': return cmdQuote(cfg, o._[0], o);
    case 'refs': return cmdRefs(cfg, o._[0], o);
    case 'gen': return cmdGen(cfg, o._[0], o);
    case 'tasks': return cmdTasks(cfg, o._[0], o);
    case 'task': return cmdTask(cfg, o._[0], o._[1]);
    case 'wait': return cmdWait(cfg, o._[0], o._[1], o);
    case 'cancel': return cmdCancel(cfg, o._[0], o._[1]);
    default:
      console.log(HELP);
      fail('未知命令：' + cmd);
  }
}

main().catch((e) => fail(e?.message || String(e)));
