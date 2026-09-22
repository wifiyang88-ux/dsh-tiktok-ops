/**
 * 离线测试台：用假 cordis ctx 驱动宿主实现，验证路由、任务流转、审核、洞察、工具注册。
 * 不需要启动 dsh web，也不碰任何外部服务（顾本/浏览器都不调用）。
 *
 * 用法：node scripts/test-harness.mjs
 */
import { Readable, Writable } from 'node:stream';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP_HOME = fileURLToPath(new URL('../.harness-home/', import.meta.url));
if (existsSync(TMP_HOME)) rmSync(TMP_HOME, { recursive: true, force: true });
process.env.DSH_HOME = TMP_HOME;

const routes = new Map();
const tools = [];
const logs = [];
const promptSections = [];

const ctx = {
  logger: {
    info: (m) => logs.push(`info: ${m}`),
    warn: (m) => logs.push(`warn: ${m}`),
  },
  webServer: {
    register(route) {
      // 与真实 dsh-host-webserver 一致：重复 (kind, path) 直接抛错，
      // 这样「重复挂载」这个场景在离线测试里就能被复现出来。
      if (routes.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`);
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    },
  },
  tools: {
    register(tool) {
      tools.push(tool);
    },
  },
  systemPrompt: {
    section(options) {
      promptSections.push(options);
      return () => {};
    },
  },
  // 模拟 cordis 的 ctx.inject：目标服务已在就直接调用回调
  inject(names, callback) {
    if (names.includes('systemPrompt')) callback({ systemPrompt: ctx.systemPrompt });
  },
  effect(fn) {
    fn();
    return () => {};
  },
  get(name) {
    if (name === 'clientModules') {
      return { graph: () => ({ rev: 'test', entries: [], batches: [] }), clientPath: () => undefined };
    }
    return undefined;
  },
};

const impl = await import('../lib/impl.js');
const { buildInsights, STATUS } = impl.internals;
await impl.apply(ctx);

// ---------------------------------------------------------------- 假请求

function makeReq(method, body, url) {
  const json = body === undefined ? '' : JSON.stringify(body);
  const stream = Readable.from(json === '' ? [] : [Buffer.from(json)]);
  stream.url = url;
  stream.method = method;
  stream.headers = { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' };
  stream.socket = { remoteAddress: '127.0.0.1' };
  return stream;
}
function makeRes() {
  // 必须是真正的 Writable，否则文件预览路由的 createReadStream().pipe(res) 会挂
  const res = new Writable({
    write(chunk, _enc, cb) {
      res.chunks.push(Buffer.from(chunk));
      cb();
    },
  });
  res.chunks = [];
  res.statusCode = 0;
  res.body = '';
  res.writeHead = function (status, headers) {
    res.statusCode = status;
    res.headers = headers ?? {};
  };
  res.end = function (payload) {
    if (payload !== undefined && payload !== null) res.chunks.push(Buffer.from(payload));
    res.body = res.chunks.length ? Buffer.concat(res.chunks) : '';
    return Writable.prototype.end.call(res);
  };
  return res;
}

async function call(path, { method = 'POST', body } = {}) {
  const [routePath] = path.split('?');
  const route = routes.get('/api/tiktok-ops' + routePath);
  if (!route) throw new Error(`没有注册路由 ${routePath}`);
  const res = makeRes();
  await route.handler(makeReq(method, body, '/api/tiktok-ops' + path), res);
  // 流式响应要等 flush 完再读 body
  if (!res.writableFinished) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 500);
      res.on('finish', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  let json = null;
  const text = Buffer.isBuffer(res.body) ? res.body.toString('utf8') : String(res.body);
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.statusCode, json, bytes: Buffer.isBuffer(res.body) ? res.body.length : 0 };
}

// 测试专用：绕过 HTTP 直接改状态（用于构造冷却等前置条件）
function mutateForTest(fn) {
  const state = impl.internals.readState();
  fn(state);
  impl.internals.writeState(state);
}

// ---------------------------------------------------------------- 断言

let pass = 0;
let fail = 0;
function check(name, condition, detail) {
  if (condition) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 320)}`}`);
  }
}

console.log('\n[注册面]');
check('注册了 /ping', routes.has('/api/tiktok-ops/ping'));
check('注册了 /task/create', routes.has('/api/tiktok-ops/task/create'));
check('注册了 /task/transition', routes.has('/api/tiktok-ops/task/transition'));
check('注册了 /task/review', routes.has('/api/tiktok-ops/task/review'));
check('注册了 /task/prompt', routes.has('/api/tiktok-ops/task/prompt'));
check('注册了 /task/optimize-prompt', routes.has('/api/tiktok-ops/task/optimize-prompt'));
check('注册了 /task/generate', routes.has('/api/tiktok-ops/task/generate'));
check('注册了 /task/publish', routes.has('/api/tiktok-ops/task/publish'));
check('注册了 /guben/works', routes.has('/api/tiktok-ops/guben/works'));
check('注册了 /guben/materials', routes.has('/api/tiktok-ops/guben/materials'));
check('注册了 /material/upload', routes.has('/api/tiktok-ops/material/upload'));
check('注册了 /collect', routes.has('/api/tiktok-ops/collect'));
check('注册了 /insights', routes.has('/api/tiktok-ops/insights'));
check(`注册了模型工具（${tools.length} 个）`, tools.length === 11, tools.map((t) => t?.name));

console.log('\n[设置：只留账号与顾本 Token]');
const saved = await call('/account/save', { body: { account: { label: '运营号', username: 'ops_demo', password: 'pw' } } });
check('保存账号成功', saved.json.ok === true && saved.json.state.accounts.length === 1, saved.json);
check('账号密码不回传', saved.json.state.accounts[0].password === undefined, saved.json.state.accounts[0]);
const accountId = saved.json.state.accounts[0].id;

const setToken = await call('/settings', { body: { settings: { gubenToken: 'guben_demo_token' } } });
check('保存顾本 Token', setToken.json.ok === true, setToken.json);
const maskedToken = await call('/settings', { body: { settings: { gubenToken: '***' } } });
check('掩码值不覆盖真 Token', maskedToken.json.ok === true, maskedToken.json);

console.log('\n[任务：创建]');
const draft = await call('/task/create', { body: { task: { topic: '珠宝打磨特写', duration: 12, aspect: 'portrait', refs: [{ kind: 'guben', value: '2506' }] } } });
check('默认建成草稿', draft.json.task?.status === 'draft', draft.json.task?.status);
check('草稿没有提交时间', draft.json.task?.submittedAt === null, draft.json.task?.submittedAt);
check('记录了选题与时长比例', draft.json.task?.topic === '珠宝打磨特写' && draft.json.task?.duration === 12 && draft.json.task?.aspect === 'portrait', draft.json.task);

const submitted = await call('/task/create', { body: { task: { topic: '镶石近景', duration: 15, aspect: 'portrait', accountId, submit: true }, dispatch: false } });
check('可直接提交（进行中）', submitted.json.task?.status === 'working', submitted.json.task?.status);
check('提交即记录提交时间', typeof submitted.json.task?.submittedAt === 'string', submitted.json.task?.submittedAt);
// 「进行中」是过程状态：必须记清楚在跑哪一步、失败退回哪里
check('进行中带上了操作标记', submitted.json.task?.op?.kind === 'prompt' && submitted.json.task?.op?.from === 'draft', submitted.json.task?.op);
const taskId = submitted.json.task.id;

// 从草稿提交去生成提示词，派活失败就要退回草稿——不能停在「进行中」
const submitFail = await call('/task/create', { body: { task: { topic: '派活失败用例', duration: 15, submit: true } } });
check('派活失败退回草稿', submitFail.json.task?.status === 'draft', submitFail.json.task?.status);
check('退回草稿留下原因', (submitFail.json.task?.log ?? []).some((l) => /派活失败/.test(l.text)), submitFail.json.task?.log?.slice(-1));
check('退回草稿后操作标记被清掉', !submitFail.json.task?.op, submitFail.json.task?.op);

const noTopic = await call('/task/create', { body: { task: { topic: '   ' } } });
check('空选题被拒绝', noTopic.json.ok === false, noTopic.json);

console.log('\n[任务：状态流转]');
// 通用流转只保留「提交」，别的目标一律挡下——不然会推出没有 op 的「进行中」
const illegal = await call('/task/transition', { body: { id: taskId, to: 'published' } });
check('通用流转拒绝非提交目标', illegal.json.ok === false && /不支持的流转目标/.test(illegal.json.error), illegal.json.error);
const illegal2 = await call('/task/transition', { body: { id: taskId, to: 'working' } });
check('已经不是草稿就不能再提交', illegal2.json.ok === false && /只有「草稿」能提交/.test(illegal2.json.error), illegal2.json.error);

const toReview = await call('/task/prompt', { body: { id: taskId, prompt: '珠宝工坊微距，打磨轮抛光 K 金戒指' } });
check('写提示词后进入脚本审核', toReview.json.ok === true && toReview.json.state.tasks.find((t) => t.id === taskId).status === 'script_review', toReview.json.error ?? toReview.json.state?.tasks?.[0]?.status);
check('提示词写完操作标记也清掉', !toReview.json.state.tasks.find((t) => t.id === taskId).op);

const emptyPrompt = await call('/task/prompt', { body: { id: taskId, prompt: '  ' } });
check('空提示词被拒绝', emptyPrompt.json.ok === false, emptyPrompt.json);

// 脚本审核通过 = 授权生成视频，会**直接开跑**。测试里不想真花钱，
// 就把顾本 CLI 指向一个不存在的路径，让生成必定失败——顺便验证
// 「生成失败要退回脚本审核」这条新规则。
const realGubenScript = impl.internals.readState().settings.gubenScript;
mutateForTest((s) => {
  s.settings.gubenScript = '/nonexistent/guben.mjs';
});
const reviewBeforeApprove = await call('/task/review', { body: { id: taskId, stage: 'script', decision: 'approve', note: '可以' } });
const afterScriptApprove = reviewBeforeApprove.json.state.tasks.find((t) => t.id === taskId);
check('脚本通过会直接开始生成', /生成视频|生成失败/.test((afterScriptApprove.log ?? []).map((l) => l.text).join(' ')), afterScriptApprove.log?.slice(-3).map((l) => l.text));
check('生成失败 → 退回脚本审核（不停在进行中）', afterScriptApprove.status === 'script_review', afterScriptApprove.status);
check('退回后没有残留操作标记', !afterScriptApprove.op, afterScriptApprove.op);
check('记录脚本审核时间', typeof afterScriptApprove.scriptApprovedAt === 'string', afterScriptApprove.scriptApprovedAt);
check('失败原因写进流转记录', (afterScriptApprove.log ?? []).some((l) => /失败/.test(l.text)), afterScriptApprove.log?.slice(-2).map((l) => l.text));
check('失败响应也带回最新 state', reviewBeforeApprove.json.state != null && reviewBeforeApprove.json.ok === false, { ok: reviewBeforeApprove.json.ok });
mutateForTest((s) => {
  s.settings.gubenScript = realGubenScript;
});

// 生成这一步必须由脚本审核授权：agent 不能绕过门禁直接烧钱
const noAuthGenerate = await call('/task/generate', { body: { id: draft.json.task.id } });
check('没被授权的任务不能生成', noAuthGenerate.json.ok === false && /进行中·生成视频/.test(noAuthGenerate.json.error), noAuthGenerate.json.error);

const notReadyPublish = await call('/task/publish', { body: { id: taskId } });
check('非「待发布」不能发布', notReadyPublish.json.ok === false && /待发布/.test(notReadyPublish.json.error), notReadyPublish.json.error);

// 审片要「视频审核」这个前置状态；真跑生成要花钱，测试里直接构造
mutateForTest((s) => {
  const t = s.tasks.find((x) => x.id === taskId);
  t.status = 'video_review';
  t.videoReview = null;
  t.outputs = [{ kind: 'video', path: '/tmp/fake.mp4', source: 'guben' }];
});
const rejected = await call('/task/review', { body: { id: taskId, stage: 'video', decision: 'reject', note: '节奏太慢' } });
const afterVideoReject = rejected.json.state.tasks.find((t) => t.id === taskId);
check('审片驳回 → 退回脚本审核', afterVideoReject.status === 'script_review', afterVideoReject.status);
check('驳回不记审片通过时间', afterVideoReject.videoApprovedAt === null, afterVideoReject.videoApprovedAt);

mutateForTest((s) => {
  const t = s.tasks.find((x) => x.id === taskId);
  t.status = 'video_review';
  t.videoReview = null;
});
const approved = await call('/task/review', { body: { id: taskId, stage: 'video', decision: 'approve' } });
const afterVideoApprove = approved.json.state.tasks.find((t) => t.id === taskId);
check('审片通过 → 待发布', afterVideoApprove.status === 'ready', afterVideoApprove.status);
check('记录审片时间', typeof afterVideoApprove.videoApprovedAt === 'string', afterVideoApprove.videoApprovedAt);

check('流转记录完整', (afterVideoApprove.log ?? []).length >= 5, afterVideoApprove.log?.length);

console.log('\n[进行中：只读 + 取消退回来源]');
// 「进行中」是过程状态：既不能改也不能删，但必须留一个「取消当前操作」的逃生口
const lockId = (await call('/task/create', { body: { task: { topic: '进行中只读用例', submit: true }, dispatch: false } })).json.task.id;
await call('/task/prompt', { body: { id: lockId, prompt: 'P' } });
mutateForTest((s) => {
  const t = s.tasks.find((x) => x.id === lockId);
  t.status = 'working';
  t.op = { kind: 'video', from: 'script_review', at: null };
});
const lockedUpdate = await call('/task/update', { body: { id: lockId, patch: { duration: 9 } } });
check('进行中不能改任务信息', lockedUpdate.json.ok === false && /进行中/.test(String(lockedUpdate.json.error)), lockedUpdate.json.error);
const lockedMats = await call('/task/materials', { body: { id: lockId, genMaterials: [] } });
check('进行中不能改素材', lockedMats.json.ok === false && /进行中/.test(String(lockedMats.json.error)), lockedMats.json.error);
const lockedP = await call('/task/prompt', { body: { id: lockId, prompt: '偷改' } });
check('进行中（跑生成视频）不能改提示词', lockedP.json.ok === false && /进行中/.test(String(lockedP.json.error)), lockedP.json.error);
const lockedDel = await call('/task/delete', { body: { id: lockId } });
check('进行中不能删除', lockedDel.json.ok === false && /进行中/.test(String(lockedDel.json.error)), lockedDel.json.error);
const lockedReview = await call('/task/review', { body: { id: lockId, stage: 'video', decision: 'approve' } });
check('进行中不能审核', lockedReview.json.ok === false && /进行中/.test(String(lockedReview.json.error)), lockedReview.json.error);

const cancelled = await call('/task/cancel', { body: { id: lockId, reason: '不跑了' } });
const afterCancel = cancelled.json.state.tasks.find((t) => t.id === lockId);
check('取消后退回来源状态（脚本审核）', afterCancel.status === 'script_review', afterCancel.status);
check('取消清掉操作标记', !afterCancel.op, afterCancel.op);
check('取消写进流转记录', (afterCancel.log ?? []).some((l) => /已取消/.test(l.text)), afterCancel.log?.slice(-1).map((l) => l.text));

console.log('\n[发布失败退回待发布]');
mutateForTest((s) => {
  const t = s.tasks.find((x) => x.id === lockId);
  t.status = 'ready';
  t.op = null;
  t.outputs = [{ kind: 'video', path: '/tmp/fake.mp4', source: 'guben' }];
});
const pubFail = await call('/task/publish', { body: { id: lockId } });
const afterPubFail = pubFail.json.state.tasks.find((t) => t.id === lockId);
check('发布失败退回待发布', pubFail.json.ok === false && afterPubFail.status === 'ready', { ok: pubFail.json.ok, status: afterPubFail.status });
check('发布失败清掉操作标记', !afterPubFail.op, afterPubFail.op);

console.log('\n[老数据迁移：进行中补 op]');
// 老版本没有 op 字段。不补的话这些任务既没有失败退路，又会被当成「操作进行中」锁死。
mutateForTest((s) => {
  const t = s.tasks.find((x) => x.id === lockId);
  t.status = 'working';
  t.prompt = '有提示词';
  delete t.op;
});
const migrated = impl.internals.readState().tasks.find((t) => t.id === lockId);
check('有提示词的老进行中 → 推断为「生成视频」', migrated.op?.kind === 'video' && migrated.op?.from === 'script_review', migrated.op);
mutateForTest((s) => {
  const t = s.tasks.find((x) => x.id === lockId);
  t.status = 'working';
  t.prompt = '';
  delete t.op;
});
const migrated2 = impl.internals.readState().tasks.find((t) => t.id === lockId);
check('没提示词的老进行中 → 推断为「生成提示词」', migrated2.op?.kind === 'prompt' && migrated2.op?.from === 'draft', migrated2.op);

console.log('\n[运营洞察]');
const insights = buildInsights([
  { id: 'a', status: 'published', topic: 'A', duration: 8, aspect: 'portrait', metrics: { views: 1000, likes: 100, comments: 10, shares: 5 } },
  { id: 'b', status: 'published', topic: 'B', duration: 25, aspect: 'landscape', metrics: { views: 200, likes: 10, comments: 2, shares: 0 } },
  { id: 'c', status: 'working', topic: 'C', duration: 15, aspect: 'portrait', metrics: null },
]);
check('只统计已发布且有数据的', insights.totals.count === 2, insights.totals);
check('四项数据求和正确', insights.totals.views === 1200 && insights.totals.likes === 110 && insights.totals.comments === 12 && insights.totals.shares === 5, insights.totals);
check('互动率计算正确', Math.abs(insights.engagementRate - (110 + 12 + 5) / 1200) < 1e-9, insights.engagementRate);
check('按比例分组', insights.byAspect.length === 2 && insights.byAspect[0].key === 'portrait', insights.byAspect);
check('按时长分组', insights.byDuration.length === 2, insights.byDuration.map((b) => b.key));
check('头部作品按播放降序', insights.top[0].id === 'a', insights.top.map((t) => t.id));
check('分享了数据时 sharesAvailable 为真', insights.sharesAvailable === true, insights.sharesAvailable);
check('空输入安全', buildInsights(undefined).totals.count === 0, buildInsights(undefined).totals);

const insightsRoute = await call('/insights', {});
check('/insights 可调用', insightsRoute.json.ok === true && insightsRoute.json.insights.totals.count === 0, insightsRoute.json.insights?.totals);

console.log('\n[工具行为]');
const tasksTool = tools.find((t) => t?.name === 'tiktok_ops_tasks');
const listed = await tasksTool.execute({}, {});
check('tiktok_ops_tasks 可执行', Array.isArray(listed.tasks) && listed.tasks.length >= 2, listed.tasks?.length);
check('brief 里带 currentOp 字段（进行中说清楚在跑哪一步）', listed.tasks.every((t) => 'currentOp' in t), Object.keys(listed.tasks[0] ?? {}));
const LABELS = ['草稿', '进行中', '脚本审核', '视频审核', '待发布', '发布完成'];
check('工具返回中文状态标签', listed.tasks.every((t) => LABELS.includes(t.status)), listed.tasks.map((t) => t.status));
const filtered = await tasksTool.execute({ status: 'ready' }, {});
check('tiktok_ops_tasks 可按状态过滤', filtered.tasks.length === 1 && filtered.tasks[0].status === '待发布', filtered.tasks.map((t) => t.status));

const createTool = tools.find((t) => t?.name === 'tiktok_ops_create_task');
const created = await createTool.execute({ topic: '工具建的选题', duration: 20 }, {});
check('tiktok_ops_create_task 可执行', Boolean(created?.task?.id), created);
check('工具建的任务直接进行中', created?.task?.statusKey === 'working', created?.task?.status);

const insightsTool = tools.find((t) => t?.name === 'tiktok_ops_insights');
const toolInsights = await insightsTool.execute({}, {});
check('tiktok_ops_insights 可执行', toolInsights?.insights?.totals !== undefined, toolInsights);

console.log('\n[登录冷却：防止把账号刷到被锁]');
const { loginBlockRemaining, applyLoginFailure, resetLoginCooldown } = impl.internals;
const fake = { id: 'acc_cool' };
check('新账号没有冷却', loginBlockRemaining(fake) === 0, loginBlockRemaining(fake));

applyLoginFailure(fake);
const first = loginBlockRemaining(fake);
check('第一次失败后退避约 30 分钟', first > 29 * 60000 && first <= 30 * 60000, Math.round(first / 60000) + ' 分钟');

applyLoginFailure(fake);
const second = loginBlockRemaining(fake);
check('第二次失败后退避拉长到约 2 小时', second > 119 * 60000 && second <= 120 * 60000, Math.round(second / 60000) + ' 分钟');

applyLoginFailure(fake);
applyLoginFailure(fake);
const capped = loginBlockRemaining(fake);
check('继续失败封顶在 8 小时', capped > 479 * 60000 && capped <= 480 * 60000, Math.round(capped / 60000) + ' 分钟');

resetLoginCooldown(fake);
check('重置后立即可再试', loginBlockRemaining(fake) === 0 && fake.loginAttempts === 0, fake);

// 冷却期间接口必须在**进入浏览器之前**就拒绝——这样测试不会触发真实登录。
// （真实登录会打 TikTok，测试里绝不能碰。）
const accId = accountId;
const state0 = await call('/state', { method: 'GET' });
check('准备：账号已存在', state0.json.state.accounts.some((a) => a.id === accId), state0.json.state.accounts);

await call('/account/reset-cooldown', { body: { id: accId } });
// 手工把冷却压上去，模拟「刚失败过」
mutateForTest((st) => {
  const a = st.accounts.find((x) => x.id === accId);
  a.loginBlockedUntil = Date.now() + 30 * 60e3;
  a.loginAttempts = 1;
});
const blocked = await call('/account/login', { body: { id: accId } });
check('冷却期间登录被拒绝', blocked.json.ok === false, blocked.json.error);
check('拒绝信息里说明了剩余时间', /冷却中/.test(String(blocked.json.error)) && /分钟/.test(String(blocked.json.error)), blocked.json.error);

const reset = await call('/account/reset-cooldown', { body: { id: accId } });
const resetAcc = reset.json.state.accounts.find((a) => a.id === accId);
check('人工重置后冷却解除', !(Number(resetAcc.loginBlockedUntil ?? 0) > Date.now()), resetAcc.loginBlockedUntil);


console.log('\n[注入给 agent 的使用说明]');
check('注册了 systemPrompt 说明段', promptSections.length === 1, promptSections.map((x) => x.name));
const guidance = String(promptSections[0]?.text ?? '');
check('说明里点名了官方 sd25-pe skill', /sd25-pe/.test(guidance), guidance.slice(0, 80));
check('说明里要求先加载 skill 再写提示词', /先加载/.test(guidance) && /提示词/.test(guidance), 'ok');
check('说明里默认欧美市场 + 英语', /欧美/.test(guidance) && /英语/.test(guidance), 'ok');
check('说明里禁止把画幅/时长写进提示词', /画幅比例/.test(guidance) && /总时长/.test(guidance), 'ok');

const { MARKET } = impl.internals;
check('市场选项含欧美/国内/其它', Object.keys(MARKET).join(',') === 'us-eu,cn,other', Object.keys(MARKET));

console.log('\n[市场默认值]');
const noMarket = await call('/task/create', { body: { task: { topic: '默认市场任务', submit: true } } });
check('未指定市场时默认欧美', noMarket.json.task?.market === 'us-eu', noMarket.json.task?.market);
const cnTask = await call('/task/create', { body: { task: { topic: '国内市场任务', market: 'cn', submit: true } } });
check('可显式指定国内市场', cnTask.json.task?.market === 'cn', cnTask.json.task?.market);
const stateMk = await call('/state', { method: 'GET' });
check('state 暴露市场标签', stateMk.json.state.marketLabels?.['us-eu'] === '欧美市场', stateMk.json.state.marketLabels);

console.log('\n[参考素材 vs 生视频素材：两个字段]');
// 参考素材是给 agent 写提示词的上下文；生视频素材才是传给生成 AI 的画面参考。
const onlyRefs = await call('/task/create', {
  body: { task: { topic: '只给参考素材', submit: true, refs: [{ kind: 'url', value: 'https://example.com/a' }] } },
});
check('默认不把参考素材当生视频素材', (onlyRefs.json.task?.genMaterials ?? []).length === 0, onlyRefs.json.task?.genMaterials);
check('参考素材本身保留', (onlyRefs.json.task?.refs ?? []).length === 1, onlyRefs.json.task?.refs);

const useRefs = await call('/task/create', {
  body: { task: { topic: '明确要求用参考素材生成', submit: true, useRefsForGeneration: true, refs: [
    { kind: 'image', value: '/tmp/pic.jpg' },
    { kind: 'url', value: 'https://example.com/page' },
  ] } },
});
check('明确要求时才复制到生视频素材', (useRefs.json.task?.genMaterials ?? []).length === 1, useRefs.json.task?.genMaterials);
check('网页素材不进生视频素材（不能当画面参考）', (useRefs.json.task?.genMaterials ?? []).every((m) => m.kind !== 'url'), useRefs.json.task?.genMaterials);

const setMat = await call('/task/materials', { body: { id: useRefs.json.task.id, genMaterials: [{ kind: 'guben', value: '2506' }] } });
const afterSet = setMat.json.state.tasks.find((t) => t.id === useRefs.json.task.id);
check('可单独设置生视频素材', afterSet?.genMaterials?.length === 1 && afterSet.genMaterials[0].value === '2506', afterSet?.genMaterials);

const { buildRefArgs } = impl.internals;
const n1 = [];
check('作品 id 用 private scope', buildRefArgs(['1', '2'], [], n1).join(' ') === '--refs 1,2 --scope private', buildRefArgs(['1', '2'], [], n1));
const n2 = [];
check('公共素材 id 用 downloaded scope', buildRefArgs([], ['2506'], n2).join(' ') === '--refs 2506 --scope downloaded', buildRefArgs([], ['2506'], n2));
const n3 = [];
const mixed = buildRefArgs(['9'], ['2506'], n3);
check('两种 scope 不混用', mixed.includes('private') && !mixed.includes('downloaded'), mixed);
check('让位的一方会留下说明', n3.some((x) => /scope/.test(x)), n3);
check('没有素材时不传 refs', buildRefArgs([], [], []).length === 0, buildRefArgs([], [], []));

console.log('\n[生成失败要能说出原因]');
const { generationFailureReason } = impl.internals;
// 顾本 CLI 任务失败时仍然正常退出，失败信息只在 JSON 里，所以要能从 task.error 取出来
const failReason = generationFailureReason({
  ok: false,
  files: [],
  task: { status: 'failed', error: '参考素材疑似含「真实人物」，方舟拒绝受理：第 1 个参考素材 @图片1', pointsHeld: 25.5, pointsCharged: 0 },
  message: '生成失败：……（预扣积分已退回）',
});
check('取的是 task.error 而不是笼统的 message', /真实人物/.test(failReason), failReason);
check('带上任务状态', /failed/.test(failReason), failReason);
check('带上积分（预扣已退回就能看出来）', /预扣 25\.5 分/.test(failReason) && /实扣 0 分/.test(failReason), failReason);
// task.error 缺失时退回到 message，再不行也不能是空的
check('没有 task.error 时退回 message', /超时/.test(generationFailureReason({ files: [], message: '生成失败：等待超时' })), generationFailureReason({ files: [], message: '生成失败：等待超时' }));
check('什么都没有时也给得出字符串', generationFailureReason({}).length > 0, generationFailureReason({}));

// MiniMax 的错误是对象（{ code, message }），顾本是字符串——两种都得认，
// 否则流转记录里只会出现 [object Object]。
const mmReason = generationFailureReason({
  ok: false,
  files: [],
  task: { status: 'failed', error: { code: '1026', message: 'video description contains sensitive content' } },
});
check('认得出 MiniMax 的对象型 error', /1026/.test(mmReason) && /sensitive content/.test(mmReason) && !/object Object/.test(mmReason), mmReason);

console.log('\n[MiniMax H3 驱动]');
const mm = await import('../lib/minimax.js');
check('识别 H3 与 H3-Max', Object.keys(mm.MINIMAX_MODELS).join(',') === 'MiniMax-H3,MiniMax-H3-Max', Object.keys(mm.MINIMAX_MODELS));
// 文档：H3 是 4~15 秒、H3-Max 是 5~15 秒；分辨率 H3 支持 2K，Max 最高 768P
check('H3 时长下限 4 秒', mm.clampDuration('MiniMax-H3', 1) === 4, mm.clampDuration('MiniMax-H3', 1));
check('H3-Max 没有 4 秒，抬到 5', mm.clampDuration('MiniMax-H3-Max', 4) === 5, mm.clampDuration('MiniMax-H3-Max', 4));
check('超长夹到 15 秒', mm.clampDuration('MiniMax-H3', 99) === 15, mm.clampDuration('MiniMax-H3', 99));
check('非法时长退回下限', mm.clampDuration('MiniMax-H3', 'abc') === 4, mm.clampDuration('MiniMax-H3', 'abc'));
check('未知模型退回 H3', mm.normalizeMinimaxModel('gpt-video') === 'MiniMax-H3', mm.normalizeMinimaxModel('gpt-video'));
check('H3 允许 2K', mm.normalizeResolution('MiniMax-H3', '2K') === '2K', mm.normalizeResolution('MiniMax-H3', '2K'));
check('H3-Max 不支持 2K，退回 768P', mm.normalizeResolution('MiniMax-H3-Max', '2K') === '768P', mm.normalizeResolution('MiniMax-H3-Max', '2K'));
check('分辨率非法时退回 768P', mm.normalizeResolution('MiniMax-H3', '4K') === '768P', mm.normalizeResolution('MiniMax-H3', '4K'));

// 参考素材用 reference_* 角色，而不是 first_frame：用首帧会把宽高比锁成 adaptive
const content = mm.buildContentItems('一段提示词', [
  { type: 'image', url: 'data:image/png;base64,AAAA' },
  { type: 'video', url: 'https://example.com/a.mp4' },
]);
check('content 第一项是 text', content[0].type === 'text' && content[0].text === '一段提示词', content[0]);
check('图片挂 reference_image', content[1].type === 'image_url' && content[1].role === 'reference_image', content[1]);
check('视频挂 reference_video', content[2].type === 'video_url' && content[2].role === 'reference_video', content[2]);
check('空 url 的素材被丢掉', mm.buildContentItems('p', [{ type: 'image', url: '  ' }]).length === 1, mm.buildContentItems('p', [{ type: 'image', url: '  ' }]));
check('图片超过 9 张后截断', mm.buildContentItems('p', Array.from({ length: 12 }, () => ({ type: 'image', url: 'u' }))).length === 10, mm.buildContentItems('p', Array.from({ length: 12 }, () => ({ type: 'image', url: 'u' }))).length);
check('纯文生视频不能用 adaptive', mm.resolveRatio('adaptive', [{ type: 'text', text: 'p' }]) === '16:9', mm.resolveRatio('adaptive', [{ type: 'text', text: 'p' }]));
check('有参考素材时保留指定比例', mm.resolveRatio('9:16', content) === '9:16', mm.resolveRatio('9:16', content));
check('扩展名认 mime', mm.guessMime('/tmp/a.JPG') === 'image/jpeg' && mm.guessMime('/tmp/a.mp4') === 'video/mp4', mm.guessMime('/tmp/a.JPG'));

// 用注入的假 fetch 跑通「建任务 → 轮询 → 下载」整条链路，不联网
const mmOut = fileURLToPath(new URL('../.harness-home/mm/', import.meta.url));
mkdirSync(mmOut, { recursive: true });
const calls = [];
let pollCount = 0;
const fakeFetch = async (url, init) => {
  calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body });
  if (String(url).endsWith('/v2/video_generation')) {
    return new Response(JSON.stringify({ task_id: '424010985738629' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (String(url).includes('/v2/query/video_generation/')) {
    pollCount += 1;
    const task = pollCount === 1
      ? { id: 't', status: 'running' }
      : { id: 't', status: 'succeeded', content: { url: 'https://cdn.example.com/out.mp4' }, resolution: '768P', duration: 15 };
    return new Response(JSON.stringify({ task }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response(Buffer.from('fake-mp4-bytes'), { status: 200 });
};
const genOut = await mm.generateVideo(
  { minimaxToken: 'sk-test', minimaxBase: 'https://api.minimax.cn' },
  { prompt: '一条测试提示词', duration: 15, ratio: '9:16', resolution: '2K', model: 'MiniMax-H3', refs: [{ type: 'image', url: 'data:image/png;base64,AAAA' }], outDir: mmOut, fetchImpl: fakeFetch, pollIntervalMs: 1 }
);
check('生成成功时返回本地文件', genOut.ok === true && genOut.files.length === 1 && existsSync(genOut.files[0]), genOut.files);
const posted = JSON.parse(calls.find((c) => c.url.endsWith('/v2/video_generation')).body);
check('提交体带上 model/resolution/duration/ratio', posted.model === 'MiniMax-H3' && posted.resolution === '2K' && posted.duration === 15 && posted.ratio === '9:16', posted);
check('提交体里的参考图是 reference_image', posted.content[1].role === 'reference_image', posted.content[1]);

// 轮询期间偶发网络抖动不能把整单判失败——任务已经在上游跑起来了、钱已经花了。
// 实测踩过：15s/768P 跑到第 224 秒一次 fetch failed，任务被判失败，而上游其实还在正常跑。
let flakyQuery = 0;
const retried = [];
const flakyFetch = async (url) => {
  const u = String(url);
  if (u.endsWith('/v2/video_generation')) return new Response(JSON.stringify({ task_id: 't-flaky' }), { status: 200 });
  if (u.includes('/v2/query/video_generation/')) {
    flakyQuery += 1;
    if (flakyQuery === 2) throw new Error('fetch failed'); // 第二次查询抖一下
    const task = flakyQuery === 1
      ? { id: 't-flaky', status: 'running' }
      : { id: 't-flaky', status: 'succeeded', content: { url: 'https://cdn.example.com/f.mp4' } };
    return new Response(JSON.stringify({ task }), { status: 200 });
  }
  return new Response(Buffer.from('ok'), { status: 200 });
};
const flakyOut = await mm.generateVideo(
  { minimaxToken: 'sk-test' },
  { prompt: 'p', duration: 4, ratio: '9:16', outDir: mmOut, fetchImpl: flakyFetch, pollIntervalMs: 1, retryBaseDelayMs: 1, onRetry: (n, m) => retried.push(`${n}:${m}`) }
);
check('轮询遇到一次网络抖动还能跑完', flakyOut.ok === true && flakyOut.files.length === 1, { ok: flakyOut.ok, files: flakyOut.files?.length });
check('重试会通过 onRetry 上报', retried.some((r) => /fetch failed/.test(r)), retried);

// 一直抖就真的放弃（别无限重试把请求堆死）
const alwaysFlaky = async (url) => {
  const u = String(url);
  if (u.endsWith('/v2/video_generation')) return new Response(JSON.stringify({ task_id: 't-dead' }), { status: 200 });
  throw new Error('fetch failed');
};
let flakyErr = null;
try {
  await mm.generateVideo({ minimaxToken: 'sk-test' }, { prompt: 'p', duration: 4, ratio: '9:16', outDir: mmOut, fetchImpl: alwaysFlaky, pollIntervalMs: 1, retryBaseDelayMs: 1, retryCount: 2 });
} catch (error) {
  flakyErr = error;
}
check('持续网络失败最终仍会抛错（不会无限重试）', flakyErr !== null && /fetch failed/.test(String(flakyErr.message)), String(flakyErr?.message));

// 失败路径：必须返回 files: [] 且把上游 error 带回来，让 /task/generate 的守卫能报出原因
const failFetch = async (url, init) => {
  if (String(url).endsWith('/v2/video_generation')) return new Response(JSON.stringify({ task_id: 'x1' }), { status: 200 });
  return new Response(JSON.stringify({ task: { id: 'x1', status: 'failed', error: { code: '1026', message: 'sensitive content' } } }), { status: 200 });
};
const genFail = await mm.generateVideo({ minimaxToken: 'sk-test' }, { prompt: 'p', duration: 15, ratio: '9:16', outDir: mmOut, fetchImpl: failFetch, pollIntervalMs: 1 });
check('失败时 files 为空', genFail.ok === false && genFail.files.length === 0, genFail.files);
check('失败时把上游 error 带回来', /sensitive content/.test(generationFailureReason(genFail)), generationFailureReason(genFail));

// 没配 Token 就别发请求
let noTokenErr = null;
try {
  await mm.createTask({ minimaxToken: '' }, { model: 'MiniMax-H3' }, { fetchImpl: fakeFetch });
} catch (error) {
  noTokenErr = error;
}
check('没配 Token 时报错而不是发请求', noTokenErr !== null && /Token/.test(String(noTokenErr.message)), String(noTokenErr?.message));

// 连接自检：走只读查询接口，靠 401/403 与「参数错」区分 Token 到底能不能用
const probeWith = (status, bodyText) =>
  mm.probeAuth({ minimaxToken: 'sk-x', minimaxBase: 'https://api.minimax.cn' }, {
    fetchImpl: async () => new Response(bodyText, { status }),
  });
const probeBad = await probeWith(401, JSON.stringify({ error: { message: 'login fail: Please carry the API secret key (1004)' } }));
check('401 判为 Token 不可用', probeBad.ok === false && probeBad.httpStatus === 401, probeBad);
check('401 会提示平台/区可能选错', /api\.minimax\.io/.test(String(probeBad.hint)), probeBad.hint);
const probeGood = await probeWith(400, JSON.stringify({ error: { message: 'invalid task_id' } }));
check('400 判为鉴权其实通过了', probeGood.ok === true, probeGood);
const probeDown = await mm.probeAuth({ minimaxToken: 'sk-x' }, { fetchImpl: async () => { throw new Error('fetch failed'); } });
check('连不上时给出网络提示', probeDown.ok === false && probeDown.httpStatus === 0, probeDown);

console.log('\n[生成通道选择]');
check('默认走顾本', impl.internals.normalizeProvider(undefined) === 'guben', impl.internals.normalizeProvider(undefined));
check('认得出 minimax', impl.internals.normalizeProvider('minimax') === 'minimax', impl.internals.normalizeProvider('minimax'));
check('乱填的值退回顾本', impl.internals.normalizeProvider('sora') === 'guben', impl.internals.normalizeProvider('sora'));

// 走一遍真实的 /settings 路由：Token 只进不出（publicState 打码），打码值回写不会覆盖
const mmSave = await call('/settings', { body: { settings: { minimaxToken: 'sk-live-secret', minimaxModel: 'MiniMax-H3-Max', minimaxResolution: '2K' } } });
check('保存 MiniMax Token 成功', mmSave.json?.ok === true, mmSave.json?.error);
check('state 里的 Token 被打码', mmSave.json?.state?.settings?.minimaxToken === '***', mmSave.json?.state?.settings?.minimaxToken);
check('原始 Token 不出现在响应里', !JSON.stringify(mmSave.json).includes('sk-live-secret'));
// H3-Max 不支持 2K，保存时就被夹回 768P
check('H3-Max 存 2K 会被夹成 768P', mmSave.json?.state?.settings?.minimaxResolution === '768P', mmSave.json?.state?.settings?.minimaxResolution);
const mmMasked = await call('/settings', { body: { settings: { minimaxToken: '***' } } });
check('打码值回写不覆盖真 Token', impl.internals.readState().settings.minimaxToken === 'sk-live-secret', impl.internals.readState().settings.minimaxToken);
const mmBlank = await call('/settings', { body: { settings: { minimaxToken: '' } } });
check('空串也不覆盖真 Token', impl.internals.readState().settings.minimaxToken === 'sk-live-secret');
const mmDiag = await call('/diag', { method: 'GET' });
check('/diag 报告 MiniMax 已配置', mmDiag.json?.resolved?.minimaxToken === 'set', mmDiag.json?.resolved);
// 收尾：别把测试 Token 留给后面的用例
impl.internals.writeState({ ...impl.internals.readState(), settings: { ...impl.internals.readState().settings, minimaxToken: '' } });

// 任务上的通道也要能存下来，并且非法值退回顾本
const mmTask = await call('/task/create', { body: { task: { topic: '通道用例', duration: 15, aspect: 'portrait', provider: 'minimax' } } });
check('建任务能带 provider', impl.internals.readState().tasks.find((t) => t.id === mmTask.json?.task?.id)?.provider === 'minimax', mmTask.json?.task?.provider);
const badProviderTask = await call('/task/create', { body: { task: { topic: '通道用例2', provider: 'sora' } } });
check('非法 provider 落库时退回顾本', impl.internals.readState().tasks.find((t) => t.id === badProviderTask.json?.task?.id)?.provider === 'guben');
const noPromptMm = await call('/task/generate', { body: { id: badProviderTask.json?.task?.id, provider: 'minimax' } });
check('未获授权的任务不能生成', noPromptMm.json?.ok === false && /进行中·生成视频/.test(String(noPromptMm.json?.error)), noPromptMm.json?.error);

// 端到端：走 impl → lib/minimax.js 整条路（把 fetch 换掉，不联网）
console.log('\n[生成通道：MiniMax 端到端]');
const origFetch = globalThis.fetch;
try {
  mutateForTest((s) => {
    s.settings.minimaxToken = 'sk-test';
    s.settings.minimaxModel = 'MiniMax-H3';
    s.settings.minimaxResolution = '768P';
    s.tasks.push({
      id: 'task_mm_e2e', topic: 'MiniMax 端到端', refs: [], genMaterials: [],
      duration: 15, aspect: 'portrait', market: 'us-eu', provider: 'minimax',
      status: 'working', op: { kind: 'video', from: 'script_review', at: null },
      prompt: '一条测试提示词', outputs: [], log: [],
    });
  });
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/v2/video_generation')) return new Response(JSON.stringify({ task_id: 't-1' }), { status: 200 });
    if (u.includes('/v2/query/video_generation/')) {
      return new Response(JSON.stringify({ task: { id: 't-1', status: 'succeeded', content: { url: 'https://cdn.example.com/o.mp4' } } }), { status: 200 });
    }
    return new Response(Buffer.from('fake-video-bytes'), { status: 200 });
  };
  await impl.internals.startVideoGeneration('task_mm_e2e', 'minimax');
  const afterMm = impl.internals.readState().tasks.find((x) => x.id === 'task_mm_e2e');
  check('MiniMax 生成后推到视频审核', afterMm.status === 'video_review', afterMm.status);
  check('产物来源标成 minimax', afterMm.outputs?.[0]?.source === 'minimax', afterMm.outputs);
  check('产物文件真的落地了', existsSync(afterMm.outputs?.[0]?.path ?? ''), afterMm.outputs?.[0]?.path);
  check('素材处理里写明了出片规格', (afterMm.materialNotes ?? []).some((n) => /MiniMax 出片规格/.test(n)), afterMm.materialNotes);
  check('provider 落库到任务上', afterMm.provider === 'minimax', afterMm.provider);

  // 失败路径：必须退回来源状态（脚本审核）并把上游 error 写进流转记录
  mutateForTest((s) => {
    const x = s.tasks.find((y) => y.id === 'task_mm_e2e');
    x.status = 'working';
    x.outputs = [];
  });
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/v2/video_generation')) return new Response(JSON.stringify({ task_id: 't-2' }), { status: 200 });
    return new Response(JSON.stringify({ task: { id: 't-2', status: 'failed', error: { code: '1026', message: 'sensitive content' } } }), { status: 200 });
  };
  let mmErr = null;
  try {
    await impl.internals.startVideoGeneration('task_mm_e2e', 'minimax');
  } catch (error) {
    mmErr = error;
  }
  const afterFail = impl.internals.readState().tasks.find((x) => x.id === 'task_mm_e2e');
  check('失败时抛错而不是静默推进', mmErr !== null, String(mmErr?.message));
  check('失败时退回来源状态（脚本审核）', afterFail.status === 'script_review', afterFail.status);
  check('失败时没有留下产物', (afterFail.outputs ?? []).length === 0, afterFail.outputs);
  check('失败原因写进流转记录', (afterFail.log ?? []).some((l) => /sensitive content/.test(l.text)), (afterFail.log ?? []).slice(-1));

  // 另一类失败：上游直接抛异常（凭据错、网络不通）。也必须留痕，
  // 否则任务记录里干干净净，事后完全看不出为什么没生成——401 那次就是这样。
  mutateForTest((s) => {
    const x = s.tasks.find((y) => y.id === 'task_mm_e2e');
    x.status = 'working';
    x.outputs = [];
    x.log = [];
  });
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: { type: 'authorized_error', message: 'login fail: Please carry the API secret key (1004)' } }),
    { status: 401 }
  );
  let throwErr = null;
  try {
    await impl.internals.startVideoGeneration('task_mm_e2e', 'minimax');
  } catch (error) {
    throwErr = error;
  }
  const afterThrow = impl.internals.readState().tasks.find((x) => x.id === 'task_mm_e2e');
  check('上游抛异常时也抛出来', throwErr !== null && /401/.test(String(throwErr.message)), String(throwErr?.message));
  check('抛异常时也退回来源状态（脚本审核）', afterThrow.status === 'script_review', afterThrow.status);
  check('抛异常也写进流转记录（不是只闪一个 toast）', (afterThrow.log ?? []).some((l) => /生成失败.*401/.test(l.text)), afterThrow.log);
} finally {
  globalThis.fetch = origFetch;
  mutateForTest((s) => {
    s.settings.minimaxToken = '';
    s.tasks = s.tasks.filter((x) => x.id !== 'task_mm_e2e');
  });
}

console.log('\n[素材文件预览：白名单]');
const realFile = fileURLToPath(new URL('../package.json', import.meta.url));
await call('/task/materials', { body: { id: useRefs.json.task.id, genMaterials: [{ kind: 'image', value: realFile }] } });
const okFile = await call('/file?path=' + encodeURIComponent(realFile), { method: 'GET' });
check('任务素材里的本地文件可预览', okFile.status === 200 && okFile.bytes > 0, { status: okFile.status, bytes: okFile.bytes });
const badFile = await call('/file?path=' + encodeURIComponent('/etc/passwd'), { method: 'GET' });
check('不在任务素材里的路径被拒绝', badFile.json?.ok === false && /拒绝读取/.test(String(badFile.json?.error)), badFile.json);

console.log('\n[提交即派活给 agent]');
const { dispatchAgent, dispatchPrompt } = impl.internals;

// 测试环境里没有 typertGateway，正好用来验证失败路径不会把创建任务搞挂
let dispatchErr = null;
try {
  await dispatchAgent({ title: 't', prompt: 'p' });
} catch (error) {
  dispatchErr = error;
}
check('网关不可用时给出可读的错误', dispatchErr !== null && /typertGateway/.test(String(dispatchErr.message)), String(dispatchErr?.message));
check('错误里提示了退路', /对话里让 agent 处理/.test(String(dispatchErr?.message)), String(dispatchErr?.message));

const autoDispatch = await call('/task/create', { body: { task: { topic: '自动派活任务', submit: true } } });
check('派活失败不会让创建任务失败', autoDispatch.json.ok === true && Boolean(autoDispatch.json.task?.id), autoDispatch.json.error);
check('失败原因写进了流转记录', (autoDispatch.json.task?.log ?? []).some((l) => /自动派活失败/.test(l.text)), autoDispatch.json.task?.log);

const noDispatch = await call('/task/create', { body: { task: { topic: '不派活任务', submit: true }, dispatch: false } });
check('可以显式关掉自动派活', noDispatch.json.ok === true && (noDispatch.json.task?.log ?? []).every((l) => !/派给 agent/.test(l.text)), noDispatch.json.task?.log);

const draftNoDispatch = await call('/task/create', { body: { task: { topic: '草稿不派活' } } });
check('存草稿不会派活', draftNoDispatch.json.ok === true && (draftNoDispatch.json.task?.log ?? []).every((l) => !/派给 agent/.test(l.text)), draftNoDispatch.json.task?.log);

const dp = dispatchPrompt({ id: 'x1', topic: '测试选题', duration: 15, aspect: 'portrait', market: 'us-eu', refs: [{ value: 'https://a' }] });
check('派活提示词点名官方 skill', /sd25-pe/.test(dp), dp.slice(0, 60));
check('派活提示词带上选题与市场', /测试选题/.test(dp) && /欧美/.test(dp), dp.slice(0, 120));
check('派活提示词要求停在脚本审核', /脚本审核/.test(dp) && /不要自己往下走/.test(dp), dp.slice(-60));

console.log('\n[脚本审核：改提示词 / 改时长 / 换素材]');
const rw = await call('/task/create', { body: { task: { topic: '提示词改写测试', submit: true }, dispatch: false } });
const rwId = rw.json.task.id;
check('新任务默认没有历史版本', (rw.json.task.promptHistory ?? []).length === 0, rw.json.task.promptHistory);

await call('/task/prompt', { body: { id: rwId, prompt: '第一版提示词' } });
const rewritten = await call('/task/prompt', { body: { id: rwId, prompt: '第二版提示词' } });
const afterRewrite = rewritten.json.state.tasks.find((t) => t.id === rwId);
check('脚本审核阶段可原地重写提示词', afterRewrite.status === 'script_review' && afterRewrite.prompt === '第二版提示词', { status: afterRewrite.status, prompt: afterRewrite.prompt });
check('旧提示词留档', afterRewrite.promptHistory?.[0]?.prompt === '第一版提示词', afterRewrite.promptHistory);
check('留档带时间戳', typeof afterRewrite.promptHistory?.[0]?.at === 'string', afterRewrite.promptHistory?.[0]);
check('重复写同一版不重复留档', await (async () => {
  const again = await call('/task/prompt', { body: { id: rwId, prompt: '第二版提示词' } });
  return (again.json.state.tasks.find((t) => t.id === rwId).promptHistory ?? []).length === 1;
})());
check('流转记录写明是原地更新', (afterRewrite.log ?? []).some((l) => /提示词已更新，仍在脚本审核/.test(l.text)), afterRewrite.log?.map((l) => l.text));

// agent 优化提示词走的是同一条写入路径，提示词里也必须带上「只改提示词」的约束
const { optimizePromptPrompt, applyPrompt, canEditPrompt } = impl.internals;
const opPrompt = optimizePromptPrompt({ id: 'x9', topic: '测试选题', duration: 15, aspect: 'portrait', market: 'us-eu', prompt: '旧提示词', refs: [{ value: 'https://a' }] }, '开头三秒先给钻戒微距');
check('优化派活点名 sd25-pe skill', /sd25-pe/.test(opPrompt), opPrompt.slice(0, 60));
check('优化派活带上任务 id 与当前提示词', /x9/.test(opPrompt) && /旧提示词/.test(opPrompt), 'ok');
check('优化派活带上人工优化要求', /开头三秒先给钻戒微距/.test(opPrompt), 'ok');
check('优化派活禁止生成视频/改状态/改参数', /不要生成视频/.test(opPrompt) && /不要改时长/.test(opPrompt), 'ok');
check('优化派活提醒时长比例不写进提示词', /不要写进提示词/.test(opPrompt), 'ok');
check(
  '提示词只在脚本审核 / 进行中·生成提示词时可写',
  canEditPrompt({ status: 'script_review' }) === true &&
    canEditPrompt({ status: 'working', op: { kind: 'prompt' } }) === true &&
    canEditPrompt({ status: 'working', op: { kind: 'video' } }) === false &&
    canEditPrompt({ status: 'draft' }) === false,
  'canEditPrompt'
);

const fakeTask = { prompt: 'A' };
applyPrompt(fakeTask, 'B');
check('applyPrompt 留档旧版本', fakeTask.prompt === 'B' && fakeTask.promptHistory[0].prompt === 'A', fakeTask);
let emptyErr = null;
try {
  applyPrompt(fakeTask, '   ');
} catch (error) {
  emptyErr = error;
}
check('applyPrompt 拒绝空提示词', emptyErr !== null && /不能为空/.test(String(emptyErr.message)), String(emptyErr?.message));

const durUpdated = await call('/task/update', { body: { id: rwId, patch: { duration: 22 } } });
const afterDur = durUpdated.json.state.tasks.find((t) => t.id === rwId);
check('审核阶段可改时长', afterDur.duration === 22, afterDur.duration);
check('时长改动写进流转记录', (afterDur.log ?? []).some((l) => /时长 15 → 22/.test(l.text)), afterDur.log?.map((l) => l.text));
check('/task/update 不再直接改提示词', await (async () => {
  await call('/task/update', { body: { id: rwId, patch: { prompt: '偷改的提示词' } } });
  return (await call('/state', { method: 'GET' })).json.state.tasks.find((t) => t.id === rwId).prompt === '第二版提示词';
})());

const noGateway = await call('/task/optimize-prompt', { body: { id: rwId, hint: '加特写' } });
check('没网关时「让 agent 优化」给出可读错误', noGateway.json.ok === false && /typertGateway/.test(String(noGateway.json.error)), noGateway.json.error);

// 通用流转不再接受任意目标了，这里直接构造「视频审核」前置状态
mutateForTest((s) => {
  const t = s.tasks.find((x) => x.id === rwId);
  t.status = 'video_review';
  t.videoReview = null;
  t.outputs = [{ kind: 'video', path: '/tmp/fake.mp4', source: 'guben' }];
});
const lockedPrompt = await call('/task/prompt', { body: { id: rwId, prompt: '视频审核阶段偷改' } });
check('视频审核阶段不能改提示词', lockedPrompt.json.ok === false && /只有/.test(String(lockedPrompt.json.error)), lockedPrompt.json.error);
const lockedOptimize = await call('/task/optimize-prompt', { body: { id: rwId } });
check('视频审核阶段不能派 agent 优化', lockedOptimize.json.ok === false && /只有/.test(String(lockedOptimize.json.error)), lockedOptimize.json.error);
const lockedDuration = await call('/task/update', { body: { id: rwId, patch: { duration: 9 } } });
check('时长在视频审核阶段仍可改（驳回前先改）', lockedDuration.json.ok === true && lockedDuration.json.state.tasks.find((t) => t.id === rwId).duration === 9, lockedDuration.json.error);

console.log('\n[顾本素材库：选择器接口]');
const { toPickerItem } = impl.internals;
const mapped = toPickerItem({
  id: 2622,
  title: '钻戒微距',
  type: 'video',
  tags: ['戒指'],
  metadata: { duration: 15, width: 720, height: 1280, ratio: '9:16' },
  thumbUrl: 'https://cdn/thumb.jpg',
  playUrl: 'https://cdn/play.mp4',
  downloaded: true,
});
check('素材映射保留缩略图', mapped.thumbUrl === 'https://cdn/thumb.jpg', mapped.thumbUrl);
check('素材映射保留预览地址', mapped.previewUrl === 'https://cdn/play.mp4', mapped.previewUrl);
check('素材映射保留时长与比例', mapped.duration === 15 && mapped.aspectRatio === '9:16', mapped);
check('素材映射保留已下载标记', mapped.downloaded === true, mapped);
check('素材 id 统一成字符串', mapped.id === '2622', mapped.id);
check('空输入不炸', toPickerItem(undefined).id === '' && toPickerItem(undefined).thumbUrl === null, toPickerItem(undefined));

// 没配 Token 时必须在打到网络之前就拒绝（离线测试绝不能碰顾本）
const originalToken = (await call('/state', { method: 'GET' })).json.state.settings.gubenToken;
mutateForTest((st) => {
  st.settings.gubenToken = '';
});
const noTokenWorks = await call('/guben/works', { body: {} });
check('没配 Token 时「我的作品」列表给出可读错误', noTokenWorks.json.ok === false && /Token/.test(String(noTokenWorks.json.error)), noTokenWorks.json.error);
const noTokenMaterials = await call('/guben/materials', { body: { onlyDownloaded: true } });
check('没配 Token 时公共素材列表给出可读错误', noTokenMaterials.json.ok === false && /Token/.test(String(noTokenMaterials.json.error)), noTokenMaterials.json.error);
mutateForTest((st) => {
  st.settings.gubenToken = 'guben_demo_token';
});
check('Token 已还原（后续用例不受影响）', (await call('/state', { method: 'GET' })).json.state.settings.gubenToken === originalToken, originalToken);

console.log('\n[本地上传：先落盘再进「我的作品」]');
const uploadGet = await call('/material/upload?filename=a.mp4', { method: 'GET' });
check('上传接口只收 POST', uploadGet.status === 405, uploadGet.status);
const uploadEmpty = await call('/material/upload?filename=empty.mp4', {});
check('空内容被拒绝', uploadEmpty.json.ok === false && /上传内容为空/.test(String(uploadEmpty.json.error)), uploadEmpty.json.error);

const { streamToFile, MAX_UPLOAD_BYTES } = impl.internals;
const tmpDir = fileURLToPath(new URL('../.harness-home/tmp/', import.meta.url));
mkdirSync(tmpDir, { recursive: true });
const okPath = join(tmpDir, 'ok.bin');
const written = await streamToFile(Readable.from([Buffer.alloc(1024), Buffer.alloc(512)]), okPath, 10 * 1024);
check('流式落盘字节数正确', written === 1536 && statSync(okPath).size === 1536, { written });
const bigPath = join(tmpDir, 'big.bin');
let capErr = null;
try {
  await streamToFile(Readable.from([Buffer.alloc(4096)]), bigPath, 1024);
} catch (error) {
  capErr = error;
}
check('超过字节上限时报错', capErr !== null && /超过上限/.test(String(capErr.message)), String(capErr?.message));
check('超限的半截文件被清掉', !existsSync(bigPath), existsSync(bigPath));
check('字节上限是个合理的大文件值', MAX_UPLOAD_BYTES === 300 * 1024 * 1024, MAX_UPLOAD_BYTES);

console.log('\n[顾本 CLI：内联副本 + 可选覆盖]');
const { effectiveGubenScript, validateGubenScript, probeGubenScript, VENDORED_GUBEN_SCRIPT } = impl.internals;
const vendored = VENDORED_GUBEN_SCRIPT;
check('内联副本存在', existsSync(vendored), vendored);
check('自动探测优先命中内联副本', probeGubenScript() === vendored, probeGubenScript());
check('没配置覆盖时就用内联副本', effectiveGubenScript({}) === vendored, effectiveGubenScript({}));
check('配了覆盖就用覆盖', effectiveGubenScript({ gubenScript: '/tmp/my-guben.mjs' }) === '/tmp/my-guben.mjs');
// 内联副本必须和同级源文件一致，否则说明改了源却忘了同步（同级不存在时跳过，用户侧没有这个目录）
const gubenSource = join(impl.internals.PLUGIN_DIR, '..', 'guben-material', 'scripts', 'guben.mjs');
if (existsSync(gubenSource)) {
  const hashOf = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
  check('内联副本与源文件一致（改了源要同步 vendor）', hashOf(vendored) === hashOf(gubenSource), { vendored: hashOf(vendored), source: hashOf(gubenSource) });
  check('内联副本没有夹带 config.json（里面是真 Token）', !existsSync(join(impl.internals.PLUGIN_DIR, 'vendor', 'config.json')));
  // 发布白名单：package.json 的 files 漏了 vendor 的话，npm 包里就没有内联 CLI，
  // 「用户不用再装 guben-material」这件事会在发布那一刻静默失效。
  const pkg = JSON.parse(readFileSync(join(impl.internals.PLUGIN_DIR, 'package.json'), 'utf8'));
  check('发布白名单包含 vendor（否则内联 CLI 不会进 npm 包）', (pkg.files ?? []).includes('vendor'), pkg.files);
  check('发布白名单包含 lib 与补丁文件', (pkg.files ?? []).includes('lib') && (pkg.files ?? []).includes('cordis.patch.yml'), pkg.files);

  // 团队从 git 仓库装插件时，靠的就是这份 manifest。这几项漏了会静默坏掉：
  // agent-browser 是「发布/采集/登录」用的二进制，插件是当可执行文件调的（不是 import），
  // 所以必须进 dependencies，否则队友装上后浏览器功能全废。
  check('声明了 agent-browser 依赖（浏览器功能靠它）', Boolean(pkg.dependencies?.['agent-browser']), pkg.dependencies);
  // @deepseek-ai/dsh-tools 是运行时唯一的宿主依赖（动态 import），由宿主提供 → peer
  check('声明了 dsh-tools 为 peerDependency', Boolean(pkg.peerDependencies?.['@deepseek-ai/dsh-tools']), pkg.peerDependencies);
  check('node_modules 不会被提交（.gitignore 必须有）', (() => {
    const gi = readFileSync(join(impl.internals.PLUGIN_DIR, '.gitignore'), 'utf8');
    return /^node_modules\/?$/m.test(gi) && /\.harness-home/.test(gi);
  })());
} else {
  check('同级源文件不存在（用户侧的正常情况），跳过一致性比对', true);
}

check('空串表示清掉覆盖', validateGubenScript('') === '');
check('相对路径被拒', (() => { try { validateGubenScript('vendor/guben.mjs'); return false; } catch { return true; } })());
check('不存在的路径被拒', (() => { try { validateGubenScript('/nope/guben.mjs'); return false; } catch { return true; } })());
check('非 .mjs/.js 被拒', (() => { try { validateGubenScript(vendored.replace('.mjs', '.txt')); return false; } catch { return true; } })());
check('合法路径通过', validateGubenScript(vendored) === vendored);

const badScript = await call('/settings', { body: { settings: { gubenScript: '/nope/guben.mjs' } } });
check('保存非法 CLI 路径被拒', badScript.json.ok === false && /不存在/.test(String(badScript.json.error)), badScript.json.error);
const goodScript = await call('/settings', { body: { settings: { gubenScript: vendored } } });
check('保存合法 CLI 路径成功', goodScript.json.ok === true && goodScript.json.state.settings.gubenScript === vendored, goodScript.json.state?.settings?.gubenScript);
check('publicState 暴露最终生效的 CLI', goodScript.json.state.gubenScriptResolved === vendored, goodScript.json.state.gubenScriptResolved);
const clearScript = await call('/settings', { body: { settings: { gubenScript: '' } } });
check('空串能把覆盖清掉', clearScript.json.ok === true && clearScript.json.state.settings.gubenScript === '', clearScript.json.state?.settings?.gubenScript);
const diagScript = await call('/diag', { method: 'GET' });
check('/diag 报告最终生效的 CLI', diagScript.json?.resolved?.gubenScript === vendored, diagScript.json?.resolved?.gubenScript);

console.log('\n[顾本工具：给 agent 的素材入口]');
const gubenTools = tools.filter((t) => String(t?.name ?? '').startsWith('tiktok_ops_guben'));
check('注册了三个顾本工具', gubenTools.length === 3, gubenTools.map((t) => t.name));

// 搜索/作品列表走只读 HTTP 接口，把 fetch 换掉即可离线跑
const origGubenFetch = globalThis.fetch;
try {
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    const u = String(url);
    if (/\/materials\?/.test(u)) {
      return new Response(JSON.stringify({ total: 2, page: 1, pageSize: 12, items: [
        { id: 11, title: '电镀特写', type: 'video', metadata: { duration: 8, width: 1920, height: 1080 }, thumbUrl: 'https://cdn/t11.jpg', downloaded: true, price: 3 },
        { id: 12, title: '钻戒白底', type: 'image', metadata: { width: 1024, height: 1024 }, thumbUrl: 'https://cdn/t12.jpg', downloaded: false, price: 1 },
      ] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (/\/works\/77/.test(u)) {
      return new Response(JSON.stringify({ id: 77, title: '金属打磨', type: 'video', metadata: { duration: 15 }, aiPrompt: '打磨轮特写', aiRefs: [{ materialId: 11 }] }), { status: 200 });
    }
    if (/\/works\?/.test(u)) {
      return new Response(JSON.stringify({ total: 1, page: 1, pageSize: 20, items: [
        { id: 88, title: '我的作品A', type: 'video', metadata: { duration: 12, width: 720, height: 1280 }, thumbUrl: 'https://cdn/t88.jpg', createdAt: '2026-09-01T00:00:00.000Z' },
      ] }), { status: 200 });
    }
    return new Response(JSON.stringify({ total: 0, items: [] }), { status: 200 });
  };

  const searchTool = gubenTools.find((t) => t.name === 'tiktok_ops_guben_search');
  const found = await searchTool.execute({ search: '电镀', type: 'video', limit: 12 }, {});
  check('搜索返回条数与映射后的字段', found.total === 2 && found.items.length === 2, found);
  check('搜索带上关键词与类型', seen.some((u) => /search=%E7%94%B5%E9%95%80/.test(u) && /type=video/.test(u)), seen[0]);
  check('搜索映射出尺寸与是否已下载', found.items[0].size === '1920x1080' && found.items[0].downloaded === true, found.items[0]);

  const worksTool = gubenTools.find((t) => t.name === 'tiktok_ops_guben_works');
  const listed = await worksTool.execute({ limit: 20 }, {});
  check('作品列表返回条目', listed.total === 1 && listed.items[0].id === '88', listed);
  const detail = await worksTool.execute({ id: '77' }, {});
  check('作品详情带回当初的提示词', detail.work?.id === '77' && detail.aiPrompt === '打磨轮特写', detail);

  // 下载走 CLI：写一个假 CLI，让真实的 spawn/JSON 解析路径跑一遍
  const fakeCliDir = fileURLToPath(new URL('../.harness-home/fakecli/', import.meta.url));
  mkdirSync(fakeCliDir, { recursive: true });
  const fakeCli = join(fakeCliDir, 'guben.mjs');
  writeFileSync(
    fakeCli,
    [
      "import { writeFileSync } from 'node:fs';",
      'const args = process.argv.slice(2);',
      "const ids = args.slice(1).filter((a) => /^\\d+$/.test(a));",
      "const i = args.indexOf('--out');",
      "const dir = i >= 0 ? args[i + 1] : '.';",
      "const files = ids.map((id) => { const f = `${dir}/fake-${id}.mp4`; writeFileSync(f, 'x'); return { id: Number(id), file: f }; });",
      "console.log(JSON.stringify({ ok: true, dir, files }));",
      '',
    ].join('\n')
  );
  await call('/settings', { body: { settings: { gubenScript: fakeCli } } });
  const downloadTool = gubenTools.find((t) => t.name === 'tiktok_ops_guben_download');
  const got = await downloadTool.execute({ ids: ['11', '12'], scope: 'work' }, {});
  check('下载返回落地文件', got.files.length === 2 && got.files.every((f) => existsSync(f.path)), got);
  check('work 范围不扣积分', got.charged === false, got.charged);
  const tooMany = await (async () => { try { await downloadTool.execute({ ids: Array.from({ length: 11 }, (_, i) => String(i)) }, {}); return null; } catch (e) { return e; } })();
  check('一次最多 10 个', tooMany !== null && /最多下载 10 个/.test(String(tooMany.message)), String(tooMany?.message));
  const noIds = await (async () => { try { await downloadTool.execute({ ids: [] }, {}); return null; } catch (e) { return e; } })();
  check('空 id 列表被拒', noIds !== null && /至少要给一个/.test(String(noIds.message)), String(noIds?.message));
  await call('/settings', { body: { settings: { gubenScript: '' } } });
} finally {
  globalThis.fetch = origGubenFetch;
}

console.log('\n[重复挂载保护]');
const routesAfterFirstMount = routes.size;
let secondError = null;
try {
  await impl.apply(ctx);
} catch (error) {
  secondError = error;
}
check('第二次 apply 不抛错', secondError === null, secondError ? String(secondError.message) : null);
// 写成「和第一次挂载后一致」而不是写死数字：加路由时不必回来改测试
check('路由没有被重复注册', routes.size === routesAfterFirstMount, { now: routes.size, before: routesAfterFirstMount });
check('第二次挂载打了跳过日志', logs.some((l) => /已在本进程中挂载过/.test(l)), logs.slice(-2));

console.log('\n[日志]');
for (const line of logs) console.log('  · ' + line);

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
rmSync(TMP_HOME, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
