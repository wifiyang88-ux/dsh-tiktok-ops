/**
 * 第三方「OpenAI 兼容」视频生成通道。
 *
 * 对接的是网关在 OpenAI 协议框架下扩展出来的 `/v1/video/generations`：
 *   POST /v1/video/generations        提交任务
 *   GET  /v1/video/generations/{id}   轮询结果（异步计算模式）
 *
 * 这类网关前面通常挂着好几家引擎（火山方舟 / 百炼万相 / 可灵 / 即梦 / Bytefor…），
 * 各家把自己的返回包一层，**字段名并不统一**。所以这里的解析刻意写得**容错**：
 * 任务 id、状态、视频地址都按一组候选字段去找，而不是赌某一个名字。
 * 真找不到时，把原始响应截断带进错误信息里，方便人工一眼看出该怎么加候选。
 *
 * 返回值刻意与顾本 / MiniMax 两条路对齐成 `{ ok, files, task }`，
 * 这样 /task/generate 的失败守卫（files 为空就报错、退回来源状态）三条路能共用一份。
 */
import { join } from 'node:path';
import { downloadTo, normalizeBase, requestJson, sleep, withRetry } from './provider-util.js';

export const THIRD_PARTY_DEFAULT_BASE = 'https://www.whatstoken.ai';
export const THIRD_PARTY_SUBMIT_PATH = '/v1/video/generations';

/** 轮询路径的候选：先按文档家族那条走，再退回 OpenAI 原生形状。 */
export const THIRD_PARTY_QUERY_PATHS = ['/v1/video/generations/{id}', '/v1/videos/{id}'];

/** 分辨率档位（网关会按厂商自动传译，例如可灵 1080p→pro、720p→std）。 */
export const THIRD_PARTY_RESOLUTIONS = ['480p', '720p', '1080p'];
export const THIRD_PARTY_DEFAULT_RESOLUTION = '720p';

const OK_STATUSES = new Set(['succeeded', 'success', 'completed', 'complete', 'done', 'finished']);
const FAIL_STATUSES = new Set(['failed', 'failure', 'error', 'canceled', 'cancelled']);

export function thirdPartyReady(settings) {
  return String(settings?.thirdPartyToken ?? '').trim() !== '';
}

export function normalizeThirdPartyResolution(resolution) {
  const want = String(resolution ?? '').trim().toLowerCase();
  return THIRD_PARTY_RESOLUTIONS.includes(want) ? want : THIRD_PARTY_DEFAULT_RESOLUTION;
}

/** 从嵌套对象里按候选字段路径取值；`a.b[0].c` 这种也认。 */
function pick(obj, paths) {
  for (const path of paths) {
    let cur = obj;
    let ok = true;
    for (const seg of String(path).split('.')) {
      const arr = seg.match(/^([^[\]]*)\[(\d+)\]$/);
      if (arr) {
        cur = cur?.[arr[1]]?.[Number(arr[2])];
      } else {
        cur = cur?.[seg];
      }
      if (cur === undefined || cur === null) {
        ok = false;
        break;
      }
    }
    if (ok && cur !== '') return cur;
  }
  return undefined;
}

/**
 * 各家的字段名不一样，所以这里每个语义都给一组候选。
 * 顺序按「最常见」排，命中即返回。
 */
export function pickTaskId(body) {
  const v = pick(body, ['id', 'task_id', 'taskId', 'request_id', 'data.id', 'data.task_id', 'data.taskId', 'output.id', 'output.task_id', 'result.id']);
  return v === undefined ? '' : String(v);
}

export function pickStatus(body) {
  const v = pick(body, ['status', 'state', 'task_status', 'data.status', 'data.state', 'data.task_status', 'output.status', 'output.task_status', 'result.status']);
  return v === undefined ? '' : String(v).toLowerCase();
}

export function pickVideoUrl(body) {
  const v = pick(body, [
    'url',
    'video_url',
    'output.url',
    'output.video_url',
    'data.url',
    'data.video_url',
    'data.output.url',
    'data.output.video_url',
    'data[0].url',
    'data.data[0].url',
    'result.url',
    'content.url',
    'videos[0].url',
  ]);
  return typeof v === 'string' ? v : '';
}

/** 失败原因：可能是字符串，也可能是 {code,message}，还可能埋在 data 里。 */
export function pickError(body) {
  const v = pick(body, ['error', 'message', 'fail_reason', 'data.error', 'data.message', 'data.fail_reason', 'output.error', 'result.error']);
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') return v.message ?? JSON.stringify(v).slice(0, 200);
  return String(v);
}

/** 归一化成一个「已收官」的判定：'ok' / 'failed' / '' (还在跑)。 */
export function classifyStatus(status) {
  const s = String(status ?? '').toLowerCase();
  if (OK_STATUSES.has(s)) return 'ok';
  if (FAIL_STATUSES.has(s)) return 'failed';
  return '';
}

/** 任务的比例：竖屏 9:16 / 横屏 16:9 / 方形 1:1（文档里 ratio 就收这几个值）。 */
export function ratioOf(aspect) {
  if (aspect === 'landscape') return '16:9';
  if (aspect === 'square') return '1:1';
  return '9:16';
}

/**
 * 组装提交体。
 *
 * 字段名全部来自官方文档：参考图走 `image_urls`（与 `images` 等价），
 * 时长是整数秒 `duration`，画幅是 `ratio`，分辨率是 `resolution`。
 */
export function buildSubmitBody({ model, prompt, duration, ratio, resolution, imageUrls = [], videoUrls = [], audioUrls = [], generateAudio = false }) {
  const body = { model: String(model ?? '').trim(), prompt: String(prompt ?? '').trim() };
  if (body.model === '') throw new Error('未配置第三方通道的模型名，请到「设置 → TikTok 运营助手 → 第三方视频通道」里填写');
  if (body.prompt === '') throw new Error('提示词不能为空');
  if (Array.isArray(imageUrls) && imageUrls.length > 0) body.image_urls = imageUrls;
  if (Array.isArray(videoUrls) && videoUrls.length > 0) body.videos = videoUrls;
  if (Array.isArray(audioUrls) && audioUrls.length > 0) body.audios = audioUrls;
  if (resolution) body.resolution = resolution;
  if (ratio) body.ratio = ratio;
  const seconds = Math.round(Number(duration));
  if (Number.isFinite(seconds) && seconds > 0) body.duration = seconds;
  if (generateAudio) body.generate_audio = true;
  return body;
}

/** 提交任务，返回 taskId。 */
export async function submitTask(settings, payload, opts = {}) {
  const base = normalizeBase(settings?.thirdPartyBase, THIRD_PARTY_DEFAULT_BASE);
  const body = await requestJson(base, String(settings.thirdPartyToken).trim(), THIRD_PARTY_SUBMIT_PATH, {
    method: 'POST',
    body: payload,
    label: '第三方视频',
    ...opts,
  });
  const taskId = pickTaskId(body);
  if (taskId === '') {
    throw new Error(`第三方接口没返回任务 id（已试过 id / task_id / data.id 等候选）。原始响应：${JSON.stringify(body).slice(0, 300)}`);
  }
  return taskId;
}

/**
 * 轮询任务。
 *
 * 两条候选路径都试：先 `/v1/video/generations/{id}`（文档家族），再 `/v1/videos/{id}`（OpenAI 原生）。
 * 只有 404 才换下一条——其它错误（401、422…）说明路径是对的、是别的问题，直接抛出去更有用。
 */
export async function queryTask(settings, taskId, opts = {}) {
  const base = normalizeBase(settings?.thirdPartyBase, THIRD_PARTY_DEFAULT_BASE);
  const token = String(settings.thirdPartyToken).trim();
  let lastError = null;
  for (const template of THIRD_PARTY_QUERY_PATHS) {
    const path = template.replace('{id}', encodeURIComponent(taskId));
    try {
      return await requestJson(base, token, path, { label: '第三方视频', ...opts });
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!/HTTP 404/.test(message)) throw error;
    }
  }
  throw lastError;
}

/**
 * 提交 → 轮询 → 下载产物。
 *
 * 无论成功失败都返回结构化结果（而不是一路抛错），让上层能用同一套
 * 「files 为空就是失败」的判断，并把错误原样带给人工看。
 */
export async function generateVideo(settings, opts = {}) {
  const {
    model,
    prompt,
    duration,
    ratio,
    resolution,
    imageUrls = [],
    videoUrls = [],
    audioUrls = [],
    generateAudio = false,
    outDir,
    fetchImpl,
    pollIntervalMs = 5000,
    timeoutMs = 30 * 60 * 1000,
    onProgress,
    onRetry,
    retryCount = 4,
    retryBaseDelayMs = 2000,
  } = opts;

  const payload = buildSubmitBody({ model, prompt, duration, ratio, resolution, imageUrls, videoUrls, audioUrls, generateAudio });
  const taskId = await submitTask(settings, payload, { fetchImpl });
  const deadline = Date.now() + timeoutMs;
  let body = null;

  for (;;) {
    // 轮询必须扛得住网络抖动：任务已经在上游跑了、钱已经花了
    body = await withRetry(() => queryTask(settings, taskId, { fetchImpl }), {
      label: '轮询',
      onRetry,
      retries: retryCount,
      baseDelayMs: retryBaseDelayMs,
    });
    const verdict = classifyStatus(pickStatus(body));
    if (verdict !== '') break;
    if (Date.now() > deadline) {
      return {
        ok: false,
        files: [],
        taskId,
        payload,
        task: { id: taskId, status: pickStatus(body) || 'unknown', error: `等待超过 ${Math.round(timeoutMs / 1000)} 秒仍未完成` },
      };
    }
    onProgress?.(pickStatus(body) || 'pending');
    await sleep(pollIntervalMs);
  }

  const verdict = classifyStatus(pickStatus(body));
  const url = pickVideoUrl(body);
  if (verdict !== 'ok' || url === '') {
    const reason =
      pickError(body) ||
      (verdict === 'failed'
        ? '上游任务失败但没给原因'
        : `任务已成功但没找到视频地址（已试过 url / video_url / data[0].url 等候选）：${JSON.stringify(body).slice(0, 300)}`);
    return { ok: false, files: [], taskId, payload, task: { id: taskId, status: pickStatus(body), error: reason } };
  }

  const dest = join(outDir, `thirdparty-video-${taskId}.mp4`);
  // 产物地址往往限时，下载更要重试：这会儿放弃等于把已经花钱生成的片子丢掉
  await withRetry(() => downloadTo(url, dest, fetchImpl), {
    label: '下载产物',
    onRetry,
    retries: retryCount,
    baseDelayMs: retryBaseDelayMs,
  });
  return { ok: true, files: [dest], taskId, payload, task: { id: taskId, status: pickStatus(body), url } };
}
