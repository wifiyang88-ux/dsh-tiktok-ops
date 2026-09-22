/**
 * dsh-tiktok-ops — 宿主侧入口（薄壳）
 *
 * 这一层只做一件事：把真正的实现从 `impl.js` 以「带时间戳的动态 import」载入。
 * 原因：cordis 的 profile patch 监听只重读补丁文件，不会重新 import 已缓存的
 * ESM 模块（缓存按模块说明符命中）。加了 `?t=` 之后，每次重新挂载该插件行都会
 * 重新执行 apply，从而拿到 impl.js 的最新代码。
 *
 * @module dsh-tiktok-ops
 */

export const name = 'tiktok-ops';
// systemPrompt: 往 agent 的系统提示里注入一段本插件的使用说明
//（其中最关键的一条：写视频提示词前必须先加载 sd25-pe 官方 skill）
//
// tools: 注册 tiktok_ops_* 模型工具所必需。cordis 4.x 对「没声明 inject 就访问服务」
// 是**直接抛错**（cannot get property "tools" without inject），不是返回 undefined。
// 以前这里漏了 'tools'，于是 11 个工具全部注册失败、又被逐条 try/catch 吞掉，
// 最后还打印「已注册 11 个模型工具」——把排查彻底带偏。
export const inject = ['webServer', 'systemPrompt', 'tools'];

/**
 * 载入最新实现并执行。
 * @param {any} ctx cordis 上下文
 * @param {any} config 插件配置
 */
export async function apply(ctx, config) {
  const url = new URL(`./impl.js?t=${Date.now()}`, import.meta.url).href;
  const impl = await import(url);
  return await impl.apply(ctx, config);
}
