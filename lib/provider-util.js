/**
 * 两个 HTTP 视频通道（MiniMax / 第三方 OpenAI 兼容）共用的底层件。
 *
 * 抽出来是因为它们的语义完全一致：
 *   - 鉴权都是 `Authorization: Bearer <token>`
 *   - 错误体都是 OpenAI 风格 `{"error": {"code", "message", "type"}}`
 *   - 建任务都是异步的，都要「提交 → 轮询 → 下载产物」
 *   - 轮询和下载都发生在**钱已经花掉之后**，都必须扛得住网络抖动
 *
 * 所以把这些写在两处只会让它们各自腐烂。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 把 base 规范化成不带尾斜杠的形式；空值退回 fallback。 */
export function normalizeBase(base, fallback) {
  const trimmed = String(base ?? '').trim().replace(/\/+$/, '');
  return trimmed !== '' ? trimmed : String(fallback ?? '').replace(/\/+$/, '');
}

/**
 * 发一次 JSON 请求并解析响应。
 *
 * 非 2xx 时抛错，错误信息里一定带 `HTTP <状态码>`——上层（比如连接自检）就是靠这个
 * 正则区分「鉴权失败」和「参数错」的，所以格式不能随意改。
 */
export async function requestJson(base, token, path, { method = 'GET', body, fetchImpl, timeoutMs = 60000, label = '请求' } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') throw new Error('当前运行环境没有 fetch，无法发起请求');

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
      // OpenAI 风格错误体；拿不到结构就退回截断的原文
      const message =
        parsed?.error?.message ?? (typeof parsed === 'string' ? parsed.slice(0, 300) : JSON.stringify(parsed).slice(0, 300));
      throw new Error(`${label} HTTP ${res.status}：${message}`);
    }
    return parsed;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`${label}请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 重试包装：只重试「可能是抖动」的失败。
 *
 * 网络层错误（没有 HTTP 状态码）、429、5xx 重试；其余 4xx 是业务性失败，直接抛。
 * 这条策略的来历：一个 15s/768P 的任务在上游正常跑，本地轮询到第 224 秒时一次
 * `fetch failed`，旧代码就把整单判成失败——而钱已经花了。
 */
export async function withRetry(fn, { retries = 4, baseDelayMs = 2000, label = '请求', onRetry } = {}) {
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

/** 把产物下载到本地。产物 URL 往往有时效，所以成功就立刻落盘。 */
export async function downloadTo(url, dest, fetchImpl) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  const res = await doFetch(url);
  if (!res.ok) throw new Error(`下载产物失败：HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
  writeFileSync(dest, buf, { mode: 0o600 });
  return dest;
}
