/**
 * MiniMax H3 视频生成驱动。
 *
 * 对接「视频生成 V2」这套异步接口（Hailuo-03 / MiniMax-H3）：
 *   POST /v2/video_generation                    建任务 → task_id
 *   GET  /v2/query/video_generation/{task_id}    轮询 → succeeded 后 content.url 是限时下载地址
 * 文档：https://platform.minimax.cn/docs/api-reference/video-generation-v2-create
 *
 * 这里只做「建任务 → 轮询 → 把产物拉到本地」这一件事；素材怎么取字节由 impl.js 负责
 * （只有它知道顾本作品要怎么下载）。测试可以注入 fetchImpl，不必真联网。
 *
 * 返回值刻意和顾本那条路对齐成 `{ ok, files, task }`，这样 /task/generate 的失败守卫
 * （files 为空就报错、不推进到「视频审核」）两条路能共用一份。
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';

export const MINIMAX_BASE = 'https://api.minimax.cn';

/**
 * 模型档位。H3 支持 2K；H3-Max 是极速档，最高 768P，且没有 4 秒。
 * 时长范围与分辨率档位都按官方文档写死，提交前统一夹取，避免被上游 400 掉。
 */
export const MINIMAX_MODELS = {
  'MiniMax-H3': {
    label: 'MiniMax-H3',
    note: '最高 2K，支持文生视频 / 图生视频 / 多模态参考生视频',
    resolutions: ['768P', '2K'],
    minDuration: 4,
    maxDuration: 15,
  },
  'MiniMax-H3-Max': {
    label: 'MiniMax-H3-Max（极速）',
    note: '480P / 768P，不支持 2K，最快出片',
    resolutions: ['480P', '768P'],
    minDuration: 5,
    maxDuration: 15,
  },
};

export const DEFAULT_MINIMAX_MODEL = 'MiniMax-H3';
export const DEFAULT_MINIMAX_RESOLUTION = '768P';

/** 参考素材数量上限（见文档「输入媒体限制」）。 */
export const MINIMAX_REF_LIMITS = { image: 9, video: 3, audio: 3 };

/**
 * 单个素材内联进请求体的字节上限。
 *
 * 接口限制请求体总大小 ≤ 64MB，而 base64 会放大约 33%，所以这里按 30MB 预检：
 * 超过就跳过并在 materialNotes 里说明，而不是等上游返回一个看不懂的 400。
 */
export const MAX_INLINE_BYTES = 30 * 1024 * 1024;

/** 参考素材的角色与字段名：reference_* 对应「多模态参考生视频」。 */
const REF_TYPES = {
  image: { role: 'reference_image', field: 'image_url' },
  video: { role: 'reference_video', field: 'video_url' },
  audio: { role: 'reference_audio', field: 'audio_url' },
};

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Token 填了才算配置好。 */
export function minimaxReady(settings) {
  return String(settings?.minimaxToken ?? '').trim() !== '';
}

export function normalizeMinimaxModel(model) {
  return Object.prototype.hasOwnProperty.call(MINIMAX_MODELS, String(model)) ? String(model) : DEFAULT_MINIMAX_MODEL;
}

/** 时长夹到该模型的合法区间；非数字/非法值退回下限。 */
export function clampDuration(model, seconds) {
  const spec = MINIMAX_MODELS[normalizeMinimaxModel(model)];
  const n = Math.round(Number(seconds));
  if (!Number.isFinite(n) || n <= 0) return spec.minDuration;
  return Math.min(Math.max(n, spec.minDuration), spec.maxDuration);
}

/** 分辨率必须是该模型支持的档位；非法值退回 768P（两个模型都有这一档）。 */
export function normalizeResolution(model, resolution) {
  const spec = MINIMAX_MODELS[normalizeMinimaxModel(model)];
  const want = String(resolution ?? '').trim();
  if (spec.resolutions.includes(want)) return want;
  return spec.resolutions.includes(DEFAULT_MINIMAX_RESOLUTION) ? DEFAULT_MINIMAX_RESOLUTION : spec.resolutions[0];
}

export function guessMime(path) {
  return MIME_BY_EXT[extname(String(path)).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * 本地文件 → data URI。
 *
 * MiniMax 的 image_url.url 收公网 URL、mm_file://file_id 或 data URI 三种；
 * 我们的素材常在本机或顾本私库里，直传 data URI 最省事、也不依赖上游能不能访问我们的内网。
 */
export function fileToDataUri(path) {
  const buf = readFileSync(path);
  return `data:${guessMime(path)};base64,${buf.toString('base64')}`;
}

/**
 * 文本 + 参考素材 → 接口要求的 content 数组。
 *
 * 参考素材统一用 reference_* 角色，而不是 first_frame：文档明确「图生视频与多模态参考生视频互斥」，
 * 而且一旦用了首帧，宽高比就被图片锁死成 adaptive，我们就没法强按任务的竖屏/横屏比例出片。
 */
export function buildContentItems(prompt, refs = []) {
  const text = String(prompt ?? '').trim();
  const items = text === '' ? [] : [{ type: 'text', text }];
  const used = { image: 0, video: 0, audio: 0 };
  for (const ref of refs ?? []) {
    const type = String(ref?.type ?? '');
    const spec = REF_TYPES[type];
    const url = String(ref?.url ?? '').trim();
    if (!spec || url === '') continue;
    if (used[type] >= MINIMAX_REF_LIMITS[type]) continue;
    used[type] += 1;
    items.push({ type: spec.field, [spec.field]: { url }, role: spec.role });
  }
  return items;
}

/**
 * 决定提交用的 ratio。
 *
 * 文档：文生视频（content 只有 text）时 ratio 必填且不能是 adaptive；
 * 多模态参考场景才能用 adaptive。这里始终给具体比例（调用方按任务画幅算好传入）。
 */
export function resolveRatio(ratio, contentItems) {
  const want = String(ratio ?? '').trim();
  const hasRefs = (contentItems ?? []).length > 1;
  if (want === '') return hasRefs ? 'adaptive' : '16:9';
  if (want === 'adaptive' && !hasRefs) return '16:9';
  return want;
}

async function request(settings, path, { method = 'GET', body, fetchImpl, timeoutMs = 60000 } = {}) {
  const token = String(settings?.minimaxToken ?? '').trim();
  if (token === '') throw new Error('未配置 MiniMax API Token，请到「设置 → TikTok 运营助手」里填写');
  const base = String(settings?.minimaxBase ?? '').trim().replace(/\/+$/, '') || MINIMAX_BASE;
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') throw new Error('当前运行环境没有 fetch，无法调用 MiniMax');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }
    if (!res.ok) {
      // 错误体是 OpenAI 风格：{ error: { type, message, http_code } }
      const message =
        parsed?.error?.message ?? (typeof parsed === 'string' ? parsed.slice(0, 300) : JSON.stringify(parsed).slice(0, 300));
      throw new Error(`MiniMax HTTP ${res.status}：${message}`);
    }
    return parsed;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`MiniMax 请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** 建任务；返回 task_id。 */
export async function createTask(settings, payload, opts = {}) {
  const body = await request(settings, '/v2/video_generation', { method: 'POST', body: payload, ...opts });
  const taskId = body?.task_id;
  if (taskId === undefined || taskId === null || String(taskId).trim() === '') {
    throw new Error(`MiniMax 建任务没有返回 task_id：${JSON.stringify(body).slice(0, 200)}`);
  }
  return String(taskId);
}

/** 查询单个任务；返回文档里的 task 对象。 */
export async function queryTask(settings, taskId, opts = {}) {
  const body = await request(settings, `/v2/query/video_generation/${encodeURIComponent(taskId)}`, opts);
  return body?.task ?? null;
}

/**
 * 零成本验一下 Token 通不通（建任务前先自检）。
 *
 * 用「查询一个不存在的老任务」这个只读接口来判定：鉴权不过上游一定回 401/403；
 * 鉴权通过则会回 400 之类的「task_id 无效」。所以只要不是 401/403，就说明 Key 可用。
 * 这条路径**不会创建任务、不产生任何费用**，可以随便点。
 *
 * 之所以需要它：Token 存进去了也可能早就失效，或者拿错了平台——
 * api.minimax.cn 与 api.minimax.io 的 Key 不通用，而「已配置」三个字看不出来这件事。
 */
export async function probeAuth(settings, { fetchImpl } = {}) {
  const base = String(settings?.minimaxBase ?? '').trim().replace(/\/+$/, '') || MINIMAX_BASE;
  try {
    const raw = await request(settings, '/v2/query/video_generation/0', { fetchImpl, timeoutMs: 20000 });
    return { ok: true, base, httpStatus: 200, message: '鉴权通过', raw };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = Number((message.match(/HTTP (\d{3})/) ?? [])[1] ?? 0);
    if (status === 401 || status === 403) {
      return {
        ok: false,
        base,
        httpStatus: status,
        message,
        hint:
          'Token 不被这个域名接受。确认复制的是「账户管理 → 接口密钥」，且与域名同区：' +
          '国内平台用 api.minimax.cn，国际平台用 api.minimax.io——两边的 Key 不通用。',
      };
    }
    if (status > 0) {
      // 400 之类：鉴权其实已经过了，只是我们故意查了个不存在的 task_id，这正是期望结果
      return { ok: true, base, httpStatus: status, message: '鉴权通过（task_id 无效是预期的）' };
    }
    return { ok: false, base, httpStatus: 0, message, hint: '连不上：检查网络，或 minimaxBase 是否写错' };
  }
}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

/** 下载产物到本地。产物 URL 有时效，所以成功就立刻落盘。 */
async function downloadTo(url, dest, fetchImpl) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  const res = await doFetch(url);
  if (!res.ok) throw new Error(`下载产物失败：HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
  writeFileSync(dest, buf, { mode: 0o600 });
  return dest;
}

/**
 * 轮询与下载这类「已经花过钱」的后续动作，必须扛得住偶发网络抖动。
 *
 * 任务已经在跑、费用已经产生，一次 `fetch failed` 就放弃的话，钱花了、产物也丢了
 *（实测踩过：15s/768P 的任务跑了 3 分多钟，轮询到第 224 秒时一次网络抖动，
 * 整个生成就被判失败，而实际上游那边还在正常跑）。
 *
 * 重试策略：网络层错误（没有 HTTP 状态码）、429、5xx 重试；其余 4xx 是业务性失败，直接抛。
 */
async function withRetry(fn, { retries = 4, baseDelayMs = 2000, label = '请求', onRetry } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const status = Number((message.match(/HTTP (\d{3})/) ?? [])[1] ?? 0);
      const retryable = status === 0 || status === 429 || status >= 500;
      if (!retryable || attempt === retries) throw error;
      onRetry?.(attempt + 1, message);
      await sleep(baseDelayMs * 2 ** attempt);
    }
  }
  throw lastError;
}

/**
 * 建任务 → 轮询 → 下载产物。
 *
 * 无论成功失败都返回结构化结果（而不是一路抛错），让上层能用同一套
 * 「files 为空就是失败」的判断，并把 task.error 原样带给人工看。
 */
export async function generateVideo(settings, opts = {}) {
  const {
    prompt,
    duration,
    ratio,
    resolution,
    model,
    refs = [],
    outDir,
    fetchImpl,
    pollIntervalMs = 5000,
    timeoutMs = 30 * 60 * 1000,
    onProgress,
    onRetry,
    retryCount = 4,
    retryBaseDelayMs = 2000,
  } = opts;

  const useModel = normalizeMinimaxModel(model);
  const content = buildContentItems(prompt, refs);
  if (content.length === 0) throw new Error('MiniMax 要求 content 里必须有一个非空 text（提示词不能为空）');

  const payload = {
    model: useModel,
    content,
    resolution: normalizeResolution(useModel, resolution),
    duration: clampDuration(useModel, duration),
    ratio: resolveRatio(ratio, content),
  };

  const taskId = await createTask(settings, payload, { fetchImpl });
  const deadline = Date.now() + timeoutMs;
  let task = null;

  for (;;) {
    // 轮询必须能扛住网络抖动：任务已经在上游跑了、钱已经花了，
    // 一次 fetch failed 就整单放弃是最亏的失败方式。
    task = await withRetry(() => queryTask(settings, taskId, { fetchImpl }), {
      label: '轮询',
      onRetry,
      retries: retryCount,
      baseDelayMs: retryBaseDelayMs,
    });
    const status = String(task?.status ?? '');
    if (TERMINAL.has(status)) break;
    if (Date.now() > deadline) {
      return {
        ok: false,
        files: [],
        taskId,
        payload,
        task: { id: taskId, status: status || 'unknown', error: `等待超过 ${Math.round(timeoutMs / 1000)} 秒仍未完成` },
      };
    }
    onProgress?.(status);
    await sleep(pollIntervalMs);
  }

  if (String(task?.status) !== 'succeeded' || !task?.content?.url) {
    const fallback =
      String(task?.status) === 'cancelled' ? '任务已取消' : '任务未成功，也没返回产物地址';
    return {
      ok: false,
      files: [],
      taskId,
      payload,
      task: { ...task, id: taskId, error: task?.error ?? fallback },
    };
  }

  const dest = join(outDir, `minimax-video-${taskId}.mp4`);
  // 产物 URL 是限时的，下载更要重试：这会儿放弃等于把已经花钱生成的片子丢掉
  await withRetry(() => downloadTo(task.content.url, dest, fetchImpl), {
    label: '下载产物',
    onRetry,
    retries: retryCount,
    baseDelayMs: retryBaseDelayMs,
  });
  return { ok: true, files: [dest], taskId, payload, task };
}

/** 内联前的体积预检，返回 null 表示可以内联。 */
export function inlineSizeProblem(path) {
  try {
    const bytes = statSync(path).size;
    if (bytes > MAX_INLINE_BYTES) {
      return `${(bytes / 1024 / 1024).toFixed(1)}MB，超过内联上限 ${Math.round(MAX_INLINE_BYTES / 1024 / 1024)}MB`;
    }
    return null;
  } catch (error) {
    return `读取失败：${error instanceof Error ? error.message : error}`;
  }
}
