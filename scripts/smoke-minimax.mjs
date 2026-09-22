#!/usr/bin/env node
/**
 * MiniMax H3 真实联调冒烟测试（会花钱，默认只跑最便宜的一档）。
 *
 * 为什么单独有这个脚本：
 *   插件那条路要经过「建任务 → 脚本审核 → 生成」，验证一次 MiniMax 接线太重；
 *   而且宿主是旧进程时（改了代码还没重启 dsh web）根本走不到 MiniMax。
 *   这个脚本绕开宿主，直接调 lib/minimax.js，能单独确认「Token 能不能用、接口通不通、
 *   产物能不能下载下来」。
 *
 * Token 来源（按优先级）：
 *   1. 环境变量 MINIMAX_API_KEY
 *   2. MINIMAX_API_KEY_FILE 指向的文件（内容就是 token，首行即可）
 *   3. $DSH_HOME/tiktok-ops/state.json 里的 settings.minimaxToken
 *
 * 用法：
 *   node scripts/smoke-minimax.mjs                       # 4 秒 / 768P / 9:16（最便宜）
 *   node scripts/smoke-minimax.mjs --duration 6 --resolution 2K
 *   node scripts/smoke-minimax.mjs --ref /path/to/a.png  # 带上参考图（走 reference_image）
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileToDataUri, generateVideo, guessMime, inlineSizeProblem } from '../lib/minimax.js';

const args = process.argv.slice(2);
const flag = (name, fallback = undefined) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const STATE_FILE = join(DSH_HOME, 'tiktok-ops', 'state.json');

function readToken() {
  const fromEnv = String(process.env.MINIMAX_API_KEY ?? '').trim();
  if (fromEnv !== '') return { token: fromEnv, from: '环境变量 MINIMAX_API_KEY' };
  const keyFile = String(process.env.MINIMAX_API_KEY_FILE ?? '').trim();
  if (keyFile !== '') {
    try {
      const token = readFileSync(keyFile, 'utf8').split('\n')[0].trim();
      if (token !== '') return { token, from: keyFile };
    } catch (error) {
      console.error(`✗ 读不到 MINIMAX_API_KEY_FILE=${keyFile}：${error instanceof Error ? error.message : error}`);
    }
  }
  try {
    const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    const token = String(state?.settings?.minimaxToken ?? '').trim();
    if (token !== '') return { token, from: STATE_FILE };
  } catch {}
  return { token: '', from: null };
}

const { token, from } = readToken();
if (token === '') {
  console.error('✗ 没找到 MiniMax Token。三种给法任选：');
  console.error('  1) MINIMAX_API_KEY=sk-xxx node scripts/smoke-minimax.mjs');
  console.error('  2) MINIMAX_API_KEY_FILE=/path/to/key node scripts/smoke-minimax.mjs');
  console.error(`  3) 让插件把它存进 ${STATE_FILE} 的 settings.minimaxToken（需要宿主是新代码）`);
  process.exit(1);
}
console.log(`Token 来源：${from}（${token.slice(0, 6)}…，长度 ${token.length}）`);

const duration = Number(flag('duration', 4));
const resolution = flag('resolution', '768P');
const model = flag('model', 'MiniMax-H3');
const ratio = flag('ratio', '9:16');
const prompt = flag('prompt', '一只橘猫慢悠悠走过洒满阳光的木地板，镜头缓慢跟随，浅景深，画面干净');
const refPath = flag('ref');

const refs = [];
if (refPath) {
  if (!existsSync(refPath)) {
    console.error(`✗ 参考图不存在：${refPath}`);
    process.exit(1);
  }
  const problem = inlineSizeProblem(refPath);
  if (problem) {
    console.error(`✗ 参考图不能内联：${problem}`);
    process.exit(1);
  }
  refs.push({ type: guessMime(refPath).startsWith('video') ? 'video' : 'image', url: fileToDataUri(refPath) });
  console.log(`参考素材：${refPath}（${guessMime(refPath)}，已转 data URI）`);
}

console.log(`提交：${model} / ${resolution} / ${duration} 秒 / ${ratio} / 参考素材 ${refs.length} 条`);
console.log('生成中（最长等 30 分钟）…');

const started = Date.now();
try {
  const result = await generateVideo(
    { minimaxToken: token, minimaxBase: process.env.MINIMAX_BASE || undefined },
    {
      prompt,
      duration,
      resolution,
      model,
      ratio,
      refs,
      outDir: fileURLToPath(new URL('../.smoke-outputs/', import.meta.url)),
      onProgress: (status) => console.log(`  …状态：${status}（${Math.round((Date.now() - started) / 1000)}s）`),
    }
  );

  if (!result.ok) {
    console.error(`\n✗ 生成失败：${JSON.stringify(result.task?.error ?? result.task, null, 2)}`);
    if (result.taskId) console.error(`  任务 id：${result.taskId}（可用 task video ${result.taskId} 复查）`);
    process.exit(1);
  }

  console.log(`\n✓ 成功，用时 ${Math.round((Date.now() - started) / 1000)} 秒`);
  console.log(`  任务 id：${result.taskId}`);
  console.log(`  产物：${result.files[0]}`);
  console.log(`  用量：${JSON.stringify(result.task?.usage ?? {})}`);
  console.log('\n提交体（确认 role 与档位）：');
  console.log(JSON.stringify({ ...result.payload, content: result.payload.content.map((c) => ({ ...c, ...(c.image_url ? { image_url: { url: `${String(c.image_url.url).slice(0, 42)}…（已截断）` } } : {}) })) }, null, 2));
} catch (error) {
  console.error(`\n✗ 调用异常：${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
