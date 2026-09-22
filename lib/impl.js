/**
 * TikTok 运营助手 — 宿主侧实现
 *
 * 心智模型：用户提交的是**选题任务**（选题 + 参考素材 + 时长 + 比例），不是提示词。
 * 提示词由 agent 生成，经人工脚本审核后生成视频，再经审片后发布，最后回采数据与评论。
 *
 * 任务六态：
 *   草稿 draft → 进行中 working → 脚本审核 script_review
 *        → 进行中（生成视频）→ 视频审核 video_review → 待发布 ready → 发布完成 published
 *
 * 安全说明：TikTok 账号密码按需求落盘保存，文件权限 0600。这是明文凭据，仅限本机自用。
 *
 * @module dsh-tiktok-ops
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, createReadStream, createWriteStream, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute, basename, extname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_MINIMAX_MODEL,
  DEFAULT_MINIMAX_RESOLUTION,
  MINIMAX_BASE,
  MINIMAX_MODELS,
  MINIMAX_REF_LIMITS,
  clampDuration as clampMinimaxDuration,
  fileToDataUri,
  generateVideo as generateMinimaxVideo,
  inlineSizeProblem,
  minimaxReady,
  normalizeMinimaxModel,
  normalizeResolution as normalizeMinimaxResolution,
  probeAuth as probeMinimaxAuth,
} from './minimax.js';

const API_PREFIX = '/api/tiktok-ops';
// 必须用 fileURLToPath 解码：插件路径含中文时 URL.pathname 是百分号编码的，
// 直接拿去 existsSync 会永远找不到自带依赖。
const PLUGIN_DIR = fileURLToPath(new URL('..', import.meta.url));

/** 任务状态：key → 中文标签。顺序即流转顺序。 */
export const STATUS = {
  draft: '草稿',
  working: '进行中',
  script_review: '脚本审核',
  video_review: '视频审核',
  ready: '待发布',
  published: '发布完成',
};

/**
 * 目标市场：默认欧美。
 *
 * 官方 Seedance 提示词指南里「台词语言」是单独一项控制；我们的账号面向欧美，
 * 所以默认英语台词 + 欧美语境，任务里另行说明才改。
 */
export const MARKET = {
  'us-eu': { label: '欧美市场', language: '英语', hint: '台词与画面文字使用英语，人物、场景、道具以欧美语境为准' },
  cn: { label: '国内市场', language: '中文', hint: '台词与画面文字使用中文，人物、场景、道具以国内语境为准' },
  other: { label: '其它', language: '', hint: '语言与语境按任务描述' },
};

/** 视频提示词的写作规范（注入给 agent）。 */
/**
 * 注入给 agent 的提示词写作规范。
 *
 * ⚠️ 这里**不能无条件要求加载 sd25-pe**。那个 skill 是 workspace 级的
 * （`.agents/skills/sd25-pe`），从 git 装进来的插件在别人机器上根本没有它——
 * 结果就是 agent 被要求「先加载一个不存在的东西」：要么卡住、要么跳过，
 * 而「不要凭感觉写一句话就提交」这句约束也就跟着落空了。
 *
 * 所以硬要求（语言、不许写参数、要结构化）永远内联；只有在**确实探测到** sd25-pe
 * 的时候，才额外要求先加载它。`hasSd25Pe` 由 apply() 里的 detectSkill() 决定。
 */
function buildPromptGuidance(hasSd25Pe) {
  const lines = [
    '本机已安装「TikTok 运营助手」插件（DSH 侧栏入口）。它管理 TikTok 视频任务的六态流转：',
    '草稿 → 进行中 → 脚本审核 → 视频审核 → 待发布 → 发布完成。',
    '',
    '用 tiktok_ops_tasks 领取任务，用 tiktok_ops_set_prompt 写入提示词。',
    '',
    '【写视频提示词的硬要求】',
  ];
  if (hasSd25Pe) {
    lines.push(
      '先加载 `sd25-pe` skill（火山方舟官方 Seedance 2.5 提示词优化器），按它的模板与自检清单产出提示词。'
    );
  }
  lines.push(
    '提示词里不要写画幅比例、总时长、分辨率（这些由接口参数控制，写进去会被官方规范判为越界）。',
    '必须写清台词与画面文字使用的语言——默认欧美市场就写「使用英语」（官方指南指出：不写明时英语台词容易被生成成中文）。',
    '按结构化模板产出，而不是一句话：主体与场景 → 事件脚本（分阶段，每阶段写明结束状态）→ 镜头与画面 → 声音 → 保持一致。',
    '不要凭感觉写一句话就提交——那样出来的片子质量差很多。',
    ''
  );
  lines.push(
    '【市场与语言默认】',
    '默认面向欧美市场：台词与画面文字用英语，人物、场景、道具以欧美语境为准。',
    '只有任务标了其它市场时才改。'
  );
  return lines.join('\n');
}

/** 没探测到 sd25-pe 时用的默认版本（也是 /diag 里报告的基准文本）。 */
const PROMPT_GUIDANCE = buildPromptGuidance(false);

/**
 * 探测某个 skill 在不在。
 *
 * 用 `ctx.get('skills')` 而不是 `ctx.inject(['skills'])`：`get` 是同步的「偷看」入口，
 * 拿不到就返回 undefined，不需要声明 inject；而且 skills 服务缺失时 inject 的回调
 * 永远不会触发，用它反而要处理「等不到」的情况。
 * 探测失败一律当「不存在」——自包含版说明永远安全，而指向不存在的 skill 一定有害。
 */
async function detectSkill(ctx, name) {
  try {
    const skills = typeof ctx.get === 'function' ? ctx.get('skills') : undefined;
    if (!skills || typeof skills.list !== 'function') return false;
    const items = await skills.list();
    return (Array.isArray(items) ? items : []).some((s) => s?.name === name);
  } catch {
    return false;
  }
}

/** 内联的 sd25-pe skill 在磁盘上的位置。 */
const VENDORED_SD25_DIR = join(PLUGIN_DIR, 'vendor', 'sd25-pe');
const VENDORED_SD25_FILE = join(VENDORED_SD25_DIR, 'SKILL.md');

/**
 * 从 SKILL.md 里抠出 frontmatter 的 name / description。
 *
 * 只认「单行标量」这一种形式（内联的那份正是如此），所以不引 YAML 依赖——
 * 与其为两个字段拖进一个解析器，不如手写十几行、读不到时保守回退。
 */
export function parseSkillFrontmatter(text) {
  const match = String(text ?? '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const out = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-zA-Z_][\w-]*):\s*(.+?)\s*$/);
    if (!kv) continue;
    const value = kv[2];
    // 跳过列表/嵌套块的起始行（`- x`、`{`、`[`），我们只要标量
    if (value.startsWith('-') || value.startsWith('{') || value.startsWith('[')) continue;
    out[kv[1]] = value.replace(/^["']|["']$/g, '');
  }
  return out;
}

/**
 * 把内联的 sd25-pe 注册成运行时 skill——装插件就等于装上了这个 skill。
 *
 * 为什么走 `ctx.skills.register()` 而不是塞进 `PROMPT_GUIDANCE`：skill 是**渐进披露**的，
 * 系统提示里只出现名字与描述，68 KB 正文按需加载，不会撑爆上下文。
 *
 * @returns 是否注册成功。skills 服务不可用时返回 false，插件照常挂载。
 */
function registerVendoredSkill(ctx, disposers) {
  try {
    if (!existsSync(VENDORED_SD25_FILE)) {
      ctx.logger?.warn?.(`tiktok-ops: 内联 skill 不存在：${VENDORED_SD25_FILE}`);
      return false;
    }
    const content = readFileSync(VENDORED_SD25_FILE, 'utf8');
    const meta = parseSkillFrontmatter(content);
    if (!meta.name || !meta.description) {
      ctx.logger?.warn?.('tiktok-ops: 内联 skill 的 frontmatter 缺 name/description，跳过注册');
      return false;
    }
    let registered = false;
    ctx.inject(['skills'], (target) => {
      try {
        disposers.push(
          target.skills.register({
            name: meta.name,
            description: meta.description,
            content,
            source: 'runtime',
            // 正文若引用相对资源，按这个目录解析
            resourceBase: { kind: 'directory', path: VENDORED_SD25_DIR },
          })
        );
        registered = true;
      } catch (error) {
        ctx.logger?.warn?.(`tiktok-ops: 内联 skill 注册失败：${error instanceof Error ? error.message : error}`);
      }
    });
    return registered;
  } catch (error) {
    ctx.logger?.warn?.(`tiktok-ops: 内联 skill 注册异常：${error instanceof Error ? error.message : error}`);
    return false;
  }
}


/** 画面比例：key → { 标签, 顾本 ratio 参数 }。 */
export const ASPECT = {
  portrait: { label: '竖屏', ratio: '9:16' },
  landscape: { label: '横屏', ratio: '16:9' },
  square: { label: '方形', ratio: '1:1' },
};

/**
 * 生视频走哪条路。
 *
 * 两条路的素材语义不同，所以是任务级选择、不是全局开关：
 * 顾本吃「素材 id」（走它的素材库与积分），MiniMax H3 吃请求体里的文本 + 参考图字节。
 * 任务上的 provider 只是默认值，生成时还可以临时覆盖。
 */
export const PROVIDERS = {
  guben: { label: '顾本素材库', hint: '用素材库的积分生成，支持把素材挂成顾本引用' },
  minimax: { label: 'MiniMax-H3', hint: '直连 MiniMax 视频生成 V2，按 MiniMax 账号计费' },
};

export function normalizeProvider(provider) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, String(provider)) ? String(provider) : 'guben';
}

function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  return fromEnv && fromEnv.trim() !== '' ? fromEnv : join(homedir(), '.dsh');
}

const DATA_DIR = join(dshHome(), 'tiktok-ops');
const STATE_FILE = join(DATA_DIR, 'state.json');

// ------------------------------------------------------------------ 状态

/** 探测顾本 CLI 的默认位置（本仓库布局：插件同级目录下的 guben-material）。 */
/**
 * 顾本 CLI 的解析顺序：用户显式配置 > 内联副本 > 同级目录的老布局。
 *
 * 内联副本是为了让「从 npm 装插件」的用户开箱可用——原先只找插件同级目录，
 * 而 npm 装进 node_modules 之后同级什么都没有，顾本通道对新用户就是死的。
 * 用户的显式配置排在最前，所以想用自己那份更新的 CLI 随时可以覆盖。
 */
const VENDORED_GUBEN_SCRIPT = join(PLUGIN_DIR, 'vendor', 'guben.mjs');

function probeGubenScript() {
  const candidates = [
    VENDORED_GUBEN_SCRIPT,
    // 老布局（开发机上 guben-material 与插件同级）保留，兼容现有安装
    join(PLUGIN_DIR, '..', 'guben-material', 'scripts', 'guben.mjs'),
    join(PLUGIN_DIR, 'guben-material', 'scripts', 'guben.mjs'),
  ];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {}
  }
  return '';
}

/**
 * 校验用户手填的顾本 CLI 路径。
 *
 * 空串表示「清掉覆盖、回到自动探测」；非空必须是存在的绝对路径 .mjs/.js 文件——
 * 与其等生成时才报「CLI 脚本不存在」，不如在保存设置的那一刻就拦下来。
 */
function validateGubenScript(value) {
  const script = String(value ?? '').trim();
  if (script === '') return '';
  if (!isAbsolute(script)) throw new Error('顾本 CLI 路径必须是绝对路径');
  if (!existsSync(script)) throw new Error(`顾本 CLI 脚本不存在：${script}`);
  if (!statSync(script).isFile()) throw new Error(`顾本 CLI 路径不是文件：${script}`);
  if (!/\.(mjs|js)$/i.test(script)) throw new Error('顾本 CLI 应该是 .mjs / .js 文件');
  return script;
}

/** 真正拿去执行的那个脚本：用户覆盖优先，否则用探测值。 */
function effectiveGubenScript(settings) {
  const configured = String(settings?.gubenScript ?? '').trim();
  return configured !== '' ? configured : VENDORED_GUBEN_SCRIPT;
}

/**
 * 设置项只有三类：TikTok 账号、顾本素材库凭据、MiniMax 凭据。
 * 其余（CLI 路径、默认分辨率）都属于内部实现细节，自动探测，不暴露给用户。
 */
function defaultSettings() {
  return {
    gubenBase: 'http://yiwu.selleroa.top:18080',
    gubenToken: '',
    // 空 = 用内联副本（vendor/guben.mjs）；填了 = 用用户自己那份 CLI
    gubenScript: '',
    gubenHome: join(DATA_DIR, 'guben-home'),
    agentBrowserBin: '',
    // MiniMax H3（视频生成 V2）。Token 只在服务端用，publicState 里会被打码。
    minimaxBase: MINIMAX_BASE,
    minimaxToken: '',
    minimaxModel: DEFAULT_MINIMAX_MODEL,
    minimaxResolution: DEFAULT_MINIMAX_RESOLUTION,
  };
}

function emptyState() {
  return { version: 2, settings: defaultSettings(), accounts: [], tasks: [], insights: null };
}

function readState() {
  try {
    if (!existsSync(STATE_FILE)) return emptyState();
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    const base = emptyState();
    return {
      ...base,
      ...parsed,
      settings: { ...base.settings, ...(parsed.settings ?? {}) },
      accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
      // 旧版本把生成产物放在 assets 里，这里做一次就地迁移
      tasks: (Array.isArray(parsed.tasks) ? parsed.tasks : []).map((t) => {
        const task = {
          ...t,
          genMaterials: Array.isArray(t.genMaterials) ? t.genMaterials : [],
          outputs: Array.isArray(t.outputs) ? t.outputs : Array.isArray(t.assets) ? t.assets : [],
        };
        // 老数据里「进行中」没记是哪一步操作，按有没有提示词推断一个，
        // 否则这些任务既没有 op.from 可回退，也会被当成「操作进行中」锁死。
        if (task.status === 'working' && !task.op) {
          task.op = task.prompt
            ? { kind: 'video', from: 'script_review', at: task.submittedAt ?? null }
            : { kind: 'prompt', from: 'draft', at: task.submittedAt ?? null };
        }
        if (task.status !== 'working') task.op = null;
        return task;
      }),
    };
  } catch {
    return emptyState();
  }
}

function writeState(state) {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  try {
    chmodSync(STATE_FILE, 0o600);
  } catch {}
}

let counter = 0;
function makeId(prefix) {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}`;
}

function mutate(fn) {
  const state = readState();
  const result = fn(state);
  writeState(state);
  return result;
}

const nowIso = () => new Date().toISOString();

// ------------------------------------------------------------------ 任务模型

/** 新建一条任务记录（选题 + 参考素材 + 时长 + 比例）。 */
function createTask(input, state) {
  const topic = String(input.topic ?? '').trim();
  if (topic === '') throw new Error('选题不能为空');
  const aspect = ASPECT[input.aspect] ? input.aspect : 'portrait';
  const market = MARKET[input.market] ? input.market : 'us-eu';
  // 参考素材：给 agent 写提示词用的上下文。
  // 生视频素材：真正传给生成 AI 的画面参考（是另一个字段，两者默认不互通）。
  const refs = Array.isArray(input.refs) ? input.refs.filter((r) => r && String(r.value ?? '').trim() !== '') : [];
  // 用户明确说「用这些参考素材生成视频」时，才把参考素材也放进生视频素材
  const genMaterials = Array.isArray(input.genMaterials)
    ? input.genMaterials.filter((r) => r && String(r.value ?? '').trim() !== '')
    : input.useRefsForGeneration
      ? refs.filter((r) => r.kind !== 'url')
      : [];
  const task = {
    id: makeId('task'),
    topic,
    refs,
    genMaterials,
    duration: Number(input.duration ?? 15) || 15,
    aspect,
    market,
    // 生视频走哪条路；生成时还能临时覆盖
    provider: normalizeProvider(input.provider),
    status: input.submit ? 'working' : 'draft',
    // 提交 = 发起「生成提示词」这一步操作，来源是草稿（失败就退回草稿）
    op: input.submit ? { kind: 'prompt', from: 'draft', at: nowIso() } : null,
    accountId: input.accountId ?? state.accounts[0]?.id ?? null,
    caption: String(input.caption ?? '').trim(),
    // agent 产出
    prompt: '',
    // 旧提示词留档：脚本审核阶段被改写过（人工或 agent 优化）时，把上一版压进来，最多留 10 版
    promptHistory: [],
    outputs: [],
    // 时间戳
    submittedAt: input.submit ? nowIso() : null,
    scriptApprovedAt: null,
    videoApprovedAt: null,
    publishedAt: null,
    // 审核
    scriptReview: null,
    videoReview: null,
    // 反馈数据
    metrics: null,
    metricsUpdatedAt: null,
    comments: [],
    commentsUpdatedAt: null,
    tiktokVideoId: null,
    url: null,
    log: [{ at: nowIso(), text: input.submit ? '任务已提交' : '任务已创建（草稿）' }],
  };
  state.tasks.unshift(task);
  return task;
}

/**
 * 「进行中」是**过程状态**，不是可以久留的地方。
 *
 * 它只表示「某一步操作正在跑」，所以必须记清楚跑的是哪一步、以及失败后该退回哪里。
 * 这三件事都挂在 `task.op` 上：`{ kind, from, at }`。由此得到两条硬规则：
 *   1. 进行中的任务不能改、不能删（要改就先「取消当前操作」退回来源状态）；
 *   2. 操作失败或取消 → 退回 `op.from`，而不是稀里糊涂地停在「进行中」。
 */
export const OPS = {
  prompt: { label: '生成提示词' },
  video: { label: '生成视频' },
  publish: { label: '发布' },
};

/** 每种操作允许从哪些状态发起；`from` 同时就是失败/取消后的退路。 */
const OP_ORIGINS = {
  prompt: ['draft', 'script_review'],
  video: ['script_review'],
  publish: ['ready'],
};

/** 每种操作成功后落到哪。 */
const OP_TARGETS = {
  prompt: 'script_review',
  video: 'video_review',
  publish: 'published',
};

/**
 * 允许的状态流转，防止 agent 跳步。
 *
 * working 的去向分两类：成功去 OP_TARGETS，失败/取消回 op.from——
 * 后者把 op.from 的全部可能取值都列在这里（draft / script_review / ready）。
 */
const TRANSITIONS = {
  draft: ['working'],
  working: ['script_review', 'video_review', 'published', 'draft', 'ready'],
  script_review: ['working'],
  video_review: ['ready', 'script_review'],
  ready: ['working'],
  published: [],
};

/** 进行中时禁止改动的内容——都从这里判，免得各处漏一个。 */
export function workingLocked(task) {
  return task?.status === 'working';
}

/** 提示词可写的两种情形：脚本审核阶段原地改；或「进行中·生成提示词」时 agent 交作业。 */
export function canEditPrompt(task) {
  if (!task) return false;
  if (task.status === 'script_review') return true;
  return task.status === 'working' && task.op?.kind === 'prompt';
}

function moveTask(state, id, next, note) {
  const task = state.tasks.find((t) => t.id === id);
  if (!task) throw new Error('任务不存在');
  if (!STATUS[next]) throw new Error(`未知状态：${next}`);
  const at = nowIso();
  task.log = Array.isArray(task.log) ? task.log : [];
  // 原地重写：agent 被叫来「优化提示词」时任务已经停在脚本审核，重写提示词不该被判成跳步。
  // 只记一条日志，审核记录与审核时间都不动。
  if (task.status === next) {
    task.log.push({ at, text: note ?? `仍在「${STATUS[next]}」，内容已原地更新` });
    return task;
  }
  const allowed = TRANSITIONS[task.status] ?? [];
  if (!allowed.includes(next)) {
    throw new Error(`不允许从「${STATUS[task.status]}」直接转到「${STATUS[next]}」`);
  }
  // 离开「进行中」就说明这一步操作结束了，标记必须清掉，
  // 否则取消/失败后回到来源状态还会带着「正在生成视频」的假象。
  if (task.status === 'working' && next !== 'working') task.op = null;
  task.status = next;
  if (next === 'working' && !task.submittedAt) task.submittedAt = at;
  if (next === 'script_review') task.scriptReview = null;
  if (next === 'video_review') task.videoReview = null;
  task.log.push({ at, text: note ?? `状态 → ${STATUS[next]}` });
  return task;
}

/**
 * 发起一步操作：任务进入「进行中」，并记下是哪一步、失败退回哪里。
 *
 * 严格校验 (操作, 来源状态) 组合，避免出现「在待发布里去生成提示词」这种脏状态。
 */
function beginOp(state, id, kind, from, note) {
  const spec = OPS[kind];
  if (!spec) throw new Error(`未知操作：${kind}`);
  const task = state.tasks.find((t) => t.id === id);
  if (!task) throw new Error('任务不存在');
  if (!(OP_ORIGINS[kind] ?? []).includes(from)) {
    throw new Error(`「${spec.label}」不能从「${STATUS[from] ?? from}」发起`);
  }
  if (task.status !== from) {
    throw new Error(`任务当前在「${STATUS[task.status]}」，不能按「${STATUS[from]}」的状态发起「${spec.label}」`);
  }
  moveTask(state, id, 'working', note ?? `进行中：${spec.label}`);
  const started = state.tasks.find((t) => t.id === id);
  started.op = { kind, from, at: nowIso() };
  return started;
}

/** 操作成功：从「进行中」落到该操作的终点状态。 */
function finishOp(state, id, note) {
  const task = state.tasks.find((t) => t.id === id);
  if (!task) throw new Error('任务不存在');
  if (task.status !== 'working' || !task.op) throw new Error('任务不在「进行中」，没有可结束的操作');
  const spec = OPS[task.op.kind];
  const to = OP_TARGETS[task.op.kind];
  return moveTask(state, id, to, note ?? `${spec?.label ?? task.op.kind}完成 → 「${STATUS[to]}」`);
}

/**
 * 操作失败/被取消：退回 `op.from`。
 *
 * 这是「进行中不该久留」的落点——失败绝不能停在「进行中」，
 * 否则任务既不能改也不能删，还会让人以为它还在跑。
 */
function failOp(state, id, reason, { cancelled = false } = {}) {
  const task = state.tasks.find((t) => t.id === id);
  if (!task) throw new Error('任务不存在');
  if (task.status !== 'working' || !task.op) throw new Error('任务不在「进行中」，无法回退');
  const { kind, from } = task.op;
  const spec = OPS[kind];
  const target = STATUS[from] ? from : 'draft';
  const detail = String(reason ?? '').trim();
  return moveTask(
    state,
    id,
    target,
    `${cancelled ? '已取消' : '失败'}：${spec?.label ?? kind} → 退回「${STATUS[target]}」${detail ? `｜${detail}` : ''}`
  );
}

// ------------------------------------------------------------------ HTTP

function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJsonBody(req, maxBytes = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('body-too-large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') return {};
  return JSON.parse(raw);
}

function isTrustedRequest(req) {
  const addr = req.socket?.remoteAddress ?? '';
  const loopback = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  if (!loopback) return false;
  const site = String(req.headers['sec-fetch-site'] ?? '').toLowerCase();
  if (site !== '' && site !== 'same-origin' && site !== 'none') return false;
  return true;
}

function jsonRoute(path, handler) {
  return {
    kind: 'exact',
    path: API_PREFIX + path,
    handler: async (req, res) => {
      if (!isTrustedRequest(req)) return writeJson(res, 403, { ok: false, error: 'forbidden' });
      const method = (req.method ?? 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'POST') {
        return writeJson(res, 405, { ok: false, error: 'method-not-allowed' });
      }
      try {
        const body = method === 'POST' ? await readJsonBody(req) : {};
        const result = await handler(body, req);
        writeJson(res, 200, { ok: true, ...(result ?? {}) });
      } catch (error) {
        // 失败也要把最新 state 带回去：像「审核通过 → 生成失败 → 退回脚本审核」这种，
        // 状态已经被 mutate 改过了，前端只看到一句报错、画面还停在旧状态就会很困惑。
        let state = null;
        try {
          state = publicState();
        } catch {}
        writeJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error), state });
      }
    },
  };
}

// ------------------------------------------------------------------ 子进程

function run(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd: options.cwd, env: { ...process.env, ...(options.env ?? {}) } });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const cap = options.maxOutput ?? 8 * 1024 * 1024;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          if (settled) return;
          settled = true;
          try {
            child.kill('SIGKILL');
          } catch {}
          reject(new Error(`命令超时（${Math.round(options.timeoutMs / 1000)}s）：${cmd}`));
        }, options.timeoutMs)
      : undefined;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };
    child.stdout?.on('data', (d) => {
      if (stdout.length < cap) stdout += d.toString();
    });
    child.stderr?.on('data', (d) => {
      if (stderr.length < cap) stderr += d.toString();
    });
    child.on('error', (error) => finish(reject, error));
    child.on('close', (code) => finish(resolve, { code: code ?? -1, stdout, stderr }));
  });
}

function lastJson(text) {
  const lines = String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.startsWith('{') && !line.startsWith('[')) continue;
    try {
      return JSON.parse(line);
    } catch {}
  }
  return null;
}

// ------------------------------------------------------------------ 顾本素材库

function ensureGubenConfig(settings) {
  const home = settings.gubenHome && settings.gubenHome.trim() !== '' ? settings.gubenHome : join(DATA_DIR, 'guben-home');
  const dir = join(home, '.guben');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({ base: settings.gubenBase, token: settings.gubenToken }, null, 2),
    { mode: 0o600 }
  );
  return home;
}

async function guben(settings, args, { timeoutMs = 180000 } = {}) {
  // 用户覆盖优先，否则用内联副本；只有两者都拿不到才报错
  const script = effectiveGubenScript(settings);
  if (script === '' || !existsSync(script)) {
    throw new Error(
      `找不到顾本 CLI 脚本（内联副本 ${VENDORED_GUBEN_SCRIPT} 不存在，也没配置覆盖路径）。` +
        '通常是安装不完整，重新安装插件即可。'
    );
  }
  if (!settings.gubenToken) throw new Error('未配置顾本素材库 API Token，请到「设置」里填写');

  const home = ensureGubenConfig(settings);
  const res = await run(process.execPath, [script, ...args], { env: { HOME: home }, timeoutMs });
  if (res.code !== 0) {
    const parsed = lastJson(res.stderr) ?? lastJson(res.stdout);
    const message = parsed?.message ?? (res.stderr || res.stdout || '').trim().split('\n').slice(-3).join(' ');
    throw new Error(`顾本命令失败：${message || `退出码 ${res.code}`}`);
  }
  const parsed = lastJson(res.stdout);
  if (parsed === null) throw new Error('顾本命令没有返回可解析的 JSON');
  return parsed;
}

/**
 * 顾本的「列表」走只读 HTTP 接口，而不是 CLI。
 *
 * 原因：CLI 的列表命令（works / search）会把 thumbUrl、previewUrl 裁掉，
 * 而素材选择器必须有缩略图；改用 `work <id>` 逐个回查就是 N+1 次进程启动。
 * 写入类操作（上传作品、生视频）仍然只走 CLI——那里有直传、超时和重试逻辑，
 * 不在插件里重造一遍。
 */
async function gubenApi(settings, path, { timeoutMs = 30000 } = {}) {
  const base = String(settings?.gubenBase ?? '').trim().replace(/\/+$/, '');
  const token = String(settings?.gubenToken ?? '').trim();
  if (base === '') throw new Error('未配置顾本素材网地址');
  if (token === '') throw new Error('未配置顾本素材库 API Token，请到「设置 → TikTok 运营助手」里填写');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/api/agent${path}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    if (!res.ok) {
      const message = body?.message ?? (typeof body === 'string' ? body.slice(0, 200) : JSON.stringify(body));
      throw new Error(`顾本接口 HTTP ${res.status}：${message}`);
    }
    return body;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('顾本接口超时，请稍后重试');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** 顾本作品/素材 → 素材选择器要的最小字段（缩略图是必须的）。 */
function toPickerItem(raw) {
  const meta = raw?.metadata ?? {};
  return {
    id: String(raw?.id ?? ''),
    title: String(raw?.title ?? ''),
    type: String(raw?.type ?? ''),
    tags: Array.isArray(raw?.tags) ? raw.tags : [],
    duration: meta.duration ?? null,
    width: meta.width ?? null,
    height: meta.height ?? null,
    aspectRatio: meta.aspectRatio ?? meta.ratio ?? null,
    thumbUrl: raw?.thumbUrl ?? null,
    previewUrl: raw?.previewUrl ?? raw?.playUrl ?? raw?.rawUrl ?? null,
    downloaded: raw?.downloaded === true,
    price: raw?.price ?? null,
    source: raw?.source ?? null,
    createdAt: raw?.createdAt ?? null,
  };
}

/** 列表类查询加一层短 TTL 缓存：切页签别每次都打顾本（预签名地址有效期 1 小时，60 秒缓存安全）。 */
const gubenListCache = new Map();
const GUBEN_LIST_TTL_MS = 60e3;

async function cachedGubenList(key, loader) {
  const hit = gubenListCache.get(key);
  if (hit && Date.now() - hit.at < GUBEN_LIST_TTL_MS) return hit.value;
  const value = await loader();
  gubenListCache.set(key, { at: Date.now(), value });
  if (gubenListCache.size > 64) gubenListCache.delete(gubenListCache.keys().next().value);
  return value;
}

/** 「我的作品」列表——本地上传的素材最后也落在这里。 */
async function listGubenWorks(settings, { search, type, page = 1, limit = 24 } = {}) {
  const params = new URLSearchParams();
  if (search) params.set('search', String(search));
  if (type) params.set('type', String(type));
  params.set('page', String(Math.max(1, Number(page) || 1)));
  params.set('pageSize', String(Math.min(60, Math.max(1, Number(limit) || 24))));
  return cachedGubenList(`works:${settings.gubenBase}:${params.toString()}`, async () => {
    const body = await gubenApi(settings, `/works?${params.toString()}`);
    return {
      total: body?.total ?? 0,
      page: body?.page ?? page,
      pageSize: body?.pageSize ?? limit,
      items: (body?.items ?? []).map(toPickerItem),
    };
  });
}

/**
 * 公共素材列表。
 *
 * `onlyDownloaded` 是插件侧筛的：顾本接口没有「只看已下载」的过滤参数，
 * 而生成时 `--scope downloaded` 只吃下载到本地的素材，所以这里必须只列这些。
 * 公共库当前是几百条量级，拉一大页本地筛足够。
 */
async function listGubenMaterials(settings, { search, type, page = 1, limit = 24, onlyDownloaded = false } = {}) {
  const pageNum = Math.max(1, Number(page) || 1);
  const pageSize = Math.min(60, Math.max(1, Number(limit) || 24));
  const params = new URLSearchParams();
  if (search) params.set('search', String(search));
  if (type) params.set('type', String(type));
  params.set('page', String(onlyDownloaded ? 1 : pageNum));
  params.set('pageSize', String(onlyDownloaded ? 200 : pageSize));

  return cachedGubenList(`materials:${settings.gubenBase}:${onlyDownloaded ? 'dl' : 'all'}:${params.toString()}`, async () => {
    const body = await gubenApi(settings, `/materials?${params.toString()}`);
    const items = (body?.items ?? []).map(toPickerItem);
    if (!onlyDownloaded) {
      return { total: body?.total ?? 0, page: body?.page ?? pageNum, pageSize: body?.pageSize ?? pageSize, items };
    }
    const downloaded = items.filter((i) => i.downloaded);
    const start = (pageNum - 1) * pageSize;
    return {
      total: downloaded.length,
      page: pageNum,
      pageSize,
      items: downloaded.slice(start, start + pageSize),
      note: '只列出已经下载到本地的公共素材（生成时用 downloaded scope，不额外扣积分）',
    };
  });
}

/** 把本地文件收进「我的作品」，返回作品 id——「本地上传」的真正含义。 */
async function uploadLocalMaterial(settings, { sourcePath, title }) {
  const result = await guben(settings, ['upload-work', sourcePath, '--title', title], { timeoutMs: 1800000 });
  const id = result?.work?.id;
  if (id === undefined || id === null) throw new Error('上传到顾本后没有拿到作品 id');
  return { id: String(id), work: result?.work ?? null };
}

/** 把请求体原样落盘，带字节上限；超限时删掉半截文件。 */
function streamToFile(readable, dest, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const out = createWriteStream(dest, { mode: 0o600 });
    const failWith = (error) => {
      if (settled) return;
      settled = true;
      // 删半截文件必须等写流的 fd 真正关闭之后再做：
      // createWriteStream 是**异步打开**文件的，先 destroy() 再同步 rmSync 的话，
      // rmSync 可能跑在文件被创建之前，随后 open 又把文件建了出来，半截文件就留下了
      //（「超限的半截文件被清掉」这条断言以前偶发失败就是这个原因）。
      // 所以清理要等 'close'，并且**清完再 reject**，调用方 await 回来时文件已经没了。
      let cleaned = false;
      const finishFailure = () => {
        if (cleaned) return;
        cleaned = true;
        try {
          rmSync(dest, { force: true });
        } catch {}
        reject(error);
      };
      try {
        readable.destroy?.();
      } catch {}
      out.once('close', finishFailure);
      try {
        out.destroy();
      } catch {
        finishFailure();
      }
      if (out.closed === true) finishFailure();
    };
    readable.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) failWith(new Error(`文件超过上限 ${Math.round(maxBytes / 1024 / 1024)}MB`));
    });
    readable.on('error', failWith);
    out.on('error', failWith);
    out.on('finish', () => {
      if (settled) return;
      settled = true;
      resolve(size);
    });
    readable.pipe(out);
  });
}

// ------------------------------------------------------------------ agent-browser

function agentBrowserBin(settings) {
  const configured = (settings.agentBrowserBin ?? '').trim();
  if (configured !== '') return configured;
  const local = join(PLUGIN_DIR, 'node_modules', '.bin', 'agent-browser');
  if (existsSync(local)) return local;
  return 'agent-browser';
}

async function ab(settings, session, args, { timeoutMs = 180000 } = {}) {
  const bin = agentBrowserBin(settings);
  const res = await run(bin, ['--session', session, ...args], { timeoutMs });
  if (res.code !== 0) {
    const message = (res.stderr || res.stdout || '').trim().split('\n').slice(-2).join(' ') || `退出码 ${res.code}`;
    throw new Error(`agent-browser 失败：${message}`);
  }
  return res.stdout;
}

const sessionOf = (account) => `tkops-${account.id}`;

async function abEval(settings, session, expression, options = {}) {
  const raw = await ab(settings, session, ['eval', expression], options);
  const text = raw.trim();
  if (text === '') return null;
  // 先按「最后一行是 JSON 对象/数组」解析
  const parsed = lastJson(raw);
  if (parsed !== null) return parsed;
  // 再退化到整段 JSON.parse —— 这一支专门处理**裸标量**（"ready" / true / 42）。
  // 漏掉它会让字符串比较永远不成立（'"ready"' !== 'ready'），
  // 登录表单就绪检测、发布上传完成检测都栽在这里。
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function tiktokIsLoggedIn(settings, account) {
  try {
    const raw = await ab(settings, sessionOf(account), ['cookies', 'get'], { timeoutMs: 60000 });
    return /sessionid/.test(raw);
  } catch {
    return false;
  }
}

/**
 * 抓一张现场截图。DOM 采集失配时如果只抛「找不到元素」，排查只能靠猜；
 * 留一张图就能立刻区分「没登录」「被重定向」「页面改版」。
 */
async function captureDiagnostic(settings, session, label) {
  try {
    const dir = join(DATA_DIR, 'diagnostics');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stamp = nowIso().replace(/[:.]/g, '-');
    const file = join(dir, `${stamp}-${label}.png`);
    await ab(settings, session, ['screenshot', file], { timeoutMs: 60000 });
    return existsSync(file) ? file : null;
  } catch {
    return null;
  }
}

async function withDiagnostic(settings, session, label, fn) {
  try {
    return await fn();
  } catch (error) {
    const shot = await captureDiagnostic(settings, session, label);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(shot ? `${message}（现场截图：${shot}）` : message);
  }
}

/**
 * 用账号密码登录 TikTok。
 *
 * 关键经验（都是踩坑换来的）：
 *  1. **不要在宿主侧多轮轮询元素**。每次 agent-browser 调用都要起一个 CLI 进程，
 *     几十轮下来光开销就一分钟，反而错过渲染时机。`eval` 支持 await promise，
 *     所以把「等元素」放进页面里，一次调用等到底。
 *  2. TikTok 登录页渲染很慢，资源常驻会让 `open` 超时——open 的错误吞掉即可。
 *  3. 自动登录不需要有头；只有自动失败、需要人工兜底时才重建成有头窗口。
 *  4. 判成功优先看 URL 是否离开 /login（页面内可观测），再用 cookies 兜底确认。
 */
async function tiktokLogin(settings, account) {
  const session = sessionOf(account);
  const url = 'https://www.tiktok.com/login/phone-or-email/email?lang=zh-Hans';

  /** 在页面内等登录表单渲染出来；一次调用，最多等 waitMs。 */
  const waitForm = (waitMs) =>
    abEval(
      settings,
      session,
      `new Promise((resolve) => {
        const t0 = Date.now();
        const tick = () => {
          const u = document.querySelector('input[name="username"]');
          const p = document.querySelector('input[type="password"]');
          if (u && p) return resolve('ready');
          if (Date.now() - t0 > ${waitMs}) return resolve('timeout');
          setTimeout(tick, 500);
        };
        tick();
      })`,
      { timeoutMs: waitMs + 30000 }
    ).catch(() => 'error');

  /** 提交后在页面内等 URL 离开 /login。 */
  const waitLeaveLogin = (waitMs) =>
    abEval(
      settings,
      session,
      `new Promise((resolve) => {
        const t0 = Date.now();
        const tick = () => {
          if (!/\\/login/.test(location.href)) return resolve('left:' + location.href);
          if (Date.now() - t0 > ${waitMs}) return resolve('still-login');
          setTimeout(tick, 500);
        };
        tick();
      })`,
      { timeoutMs: waitMs + 30000 }
    ).catch(() => 'error');

  // ---- 第一次尝试：无头自动登录 ----
  await ab(settings, session, ['open', url], { timeoutMs: 120000 }).catch(() => {});
  let form = await waitForm(60000);

  // 页面可能还没导航过去，重开一次再等
  if (form !== 'ready') {
    await ab(settings, session, ['open', url], { timeoutMs: 120000 }).catch(() => {});
    form = await waitForm(60000);
  }

  if (form === 'ready') {
    try {
      await ab(settings, session, ['fill', 'input[name="username"]', account.username], { timeoutMs: 60000 });
      await ab(settings, session, ['fill', 'input[type="password"]', account.password], { timeoutMs: 60000 });
      await ab(settings, session, ['click', 'button[type="submit"]'], { timeoutMs: 60000 });
      const left = await waitLeaveLogin(60000);
      if (String(left).startsWith('left:') && (await tiktokIsLoggedIn(settings, account))) {
        return { status: 'ok' };
      }
    } catch {
      // 掉到下面的手动兜底
    }
  }

  // ---- 兜底：重建成有头窗口，让人手动完成 ----
  await ab(settings, session, ['close'], { timeoutMs: 60000 }).catch(() => {});
  await ab(settings, session, ['--headed', 'open', url], { timeoutMs: 120000 }).catch(() => {});
  const headedForm = await waitForm(90000);

  return {
    status: 'need_manual',
    message:
      headedForm === 'ready'
        ? '自动登录未通过（通常是验证码或二次验证）。已经在有头窗口里打开登录页，请手动完成一次登录，之后会复用该会话。'
        : `登录页没能正常渲染（waitForm=${form}/${headedForm}）。请稍后重试，或到「设置」里检查账号密码。`,
  };
}

/**
 * 把「生视频素材」解析成顾本能用的引用。
 *
 * 顾本 `gen --refs` 吃的是素材 id：
 *   - 公共素材库的素材 id → `--scope downloaded`（需已下载过）
 *   - 「我的作品」的作品 id → `--scope private`
 * 所以本地文件/网址要先落盘、再 `upload-work` 换成作品 id。
 *
 * 注意：参考素材（refs，给 agent 写提示词用）不走这里——那是另一个字段。
 */
async function resolveGenerationRefs(settings, materials) {
  const privateIds = [];
  const downloadedIds = [];
  const notes = [];
  const dir = join(DATA_DIR, 'materials');

  for (const m of materials ?? []) {
    const value = String(m?.value ?? '').trim();
    if (value === '') continue;
    const kind = m?.kind;

    if (kind === 'work' || (kind === 'guben' && m?.scope === 'private')) {
      if (/^\d+$/.test(value)) privateIds.push(value);
      else notes.push(`素材「${value}」不是有效的作品 id，已跳过`);
      continue;
    }
    if (kind === 'guben') {
      if (/^\d+$/.test(value)) downloadedIds.push(value);
      else notes.push(`素材「${value}」不是有效的素材 id，已跳过`);
      continue;
    }
    if (kind === 'url') {
      notes.push(`网页「${value}」只能作为写提示词的参考，不能直接当画面素材`);
      continue;
    }
    if (kind === 'image' || kind === 'video' || kind === 'text') {
      let localPath = value;
      if (/^https?:\/\//i.test(localPath)) {
        try {
          mkdirSync(dir, { recursive: true, mode: 0o700 });
          const res = await fetch(localPath);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const buf = Buffer.from(await res.arrayBuffer());
          const name = (localPath.split('?')[0].split('/').pop() || 'material').replace(/[^\w.\-]/g, '_').slice(-60);
          localPath = join(dir, `${Date.now()}-${name}`);
          writeFileSync(localPath, buf, { mode: 0o600 });
        } catch (error) {
          notes.push(`素材「${value}」下载失败：${error instanceof Error ? error.message : error}`);
          continue;
        }
      }
      if (!existsSync(localPath)) {
        notes.push(`素材「${localPath}」不存在，已跳过`);
        continue;
      }
      try {
        const up = await guben(settings, ['upload-work', localPath, '--title', `tiktok-ops-${Date.now()}`], { timeoutMs: 900000 });
        const id = up?.work?.id;
        if (id === undefined || id === null) throw new Error('上传后没拿到作品 id');
        privateIds.push(String(id));
        notes.push(`素材「${value}」已上传为顾本作品 ${id}`);
      } catch (error) {
        notes.push(`素材「${localPath}」上传顾本失败：${error instanceof Error ? error.message : error}`);
      }
      continue;
    }
    notes.push(`未知素材类型「${kind}」，已跳过`);
  }

  return { privateIds, downloadedIds, notes };
}

/**
 * 让 agent 真正动起来：创建一个会话并把提示词投进去。
 *
 * 插件本身没有后台 worker，「进行中」的任务就是在等 agent。之前只能靠用户在对话里说一句，
 * 现在直接通过 typertGateway 建会话 + 投递提示词，提交任务即可自动开工。
 *
 * 走的是任务看板同一套 RPC：session.create → session.rename → session.prompt。
 * 会消耗 API 额度——每提交一条任务就会起一个会话。
 */
const agentRuntime = { gateway: null, workspaces: null };

async function dispatchAgent({ title, prompt }) {
  const gateway = agentRuntime.gateway;
  if (!gateway || typeof gateway.invoke !== 'function') {
    throw new Error('typertGateway 不可用，无法自动唤起 agent（可在对话里让 agent 处理任务队列）');
  }
  let workspaceId;
  try {
    const list = agentRuntime.workspaces?.list?.() ?? [];
    workspaceId = list[0]?.id;
  } catch {}

  const created = await gateway.invoke({
    namespace: 'session',
    method: 'create',
    args: { request: workspaceId === undefined ? {} : { workspaceId } },
  });
  const sessionId = created?.sessionId ?? created?.request?.sessionId;
  if (!sessionId) throw new Error('创建会话后没有拿到 sessionId');

  try {
    await gateway.invoke({
      namespace: 'session',
      method: 'rename',
      args: { request: { sessionId, title: title.slice(0, 80) } },
    });
  } catch {}

  await gateway.invoke({
    namespace: 'session',
    method: 'prompt',
    args: {
      request: {
        sessionId,
        requestId: `tiktok-ops-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        mode: 'queue',
        content: [{ type: 'text', text: prompt }],
      },
    },
  });
  return sessionId;
}

/** 派活给 agent 时投递的提示词：明确要求先加载官方 skill。 */
function dispatchPrompt(task) {
  return [
    `处理 TikTok 运营助手里的这条任务（id=${task.id}）。`,
    `选题：${task.topic}`,
    task.refs?.length ? `参考素材（只用于写提示词）：${task.refs.map((r) => `${r.value}`).join('；')}` : '',
    `目标市场：${MARKET[task.market]?.label ?? '欧美市场'}${task.market === 'cn' ? '（中文）' : '（英语）'}`,
    `时长 ${task.duration}s，比例 ${ASPECT[task.aspect]?.label ?? task.aspect}。`,
    '',
    '步骤：先加载 sd25-pe skill 按官方规范写出提示词，用 tiktok_ops_set_prompt 写入并推到脚本审核，',
    '然后停下来等人工审核，不要自己往下走。',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * 让 agent 重写提示词时投递的提示词——脚本审核阶段的人工入口。
 *
 * 与 dispatchPrompt 的区别：那条是「新任务开局写提示词，写完推到脚本审核」；
 * 这条是「已经停在脚本审核，只重写提示词」，所以明确禁止改状态、改参数、生成视频。
 */
function optimizePromptPrompt(task, hint) {
  return [
    `优化 TikTok 运营助手任务（id=${task.id}）的视频生成提示词。`,
    `选题：${task.topic}`,
    task.refs?.length ? `参考素材（只用于写提示词）：${task.refs.map((r) => `${r.value}`).join('；')}` : '',
    `目标市场：${MARKET[task.market]?.label ?? '欧美市场'}${task.market === 'cn' ? '（中文）' : '（英语）'}`,
    `时长 ${task.duration}s，比例 ${ASPECT[task.aspect]?.label ?? task.aspect}——这两个是接口参数，不要写进提示词。`,
    hint ? `本次优化要求：${hint}` : '',
    '',
    '当前提示词：',
    String(task.prompt ?? '').trim() || '（还没有提示词，按选题从头写一条）',
    '',
    '步骤：',
    '1. 先加载 sd25-pe skill，按官方规范重写这条提示词；保持选题意图、主体与数量、事件因果和结局不变。',
    '2. 用 tiktok_ops_set_prompt 写回同一条任务。它已经在「脚本审核」，重写是原地更新，不会跳步、不会重新提交。',
    '3. 只改提示词：不要生成视频，不要改时长、素材和状态。',
    '4. 写完停下来等人工审核。',
  ]
    .filter(Boolean)
    .join('\n');
}

/** 生视频素材拼成顾本参数；两种 scope 不能混用，优先「我的作品」并说明被让位的。 */
function buildRefArgs(privateIds, downloadedIds, notes) {
  if (privateIds.length > 0) {
    if (downloadedIds.length > 0) notes.push(`顾本一次只能用一个 scope，本次只用「我的作品」；公共素材 ${downloadedIds.join(',')} 未参与`);
    return ['--refs', privateIds.join(','), '--scope', 'private'];
  }
  if (downloadedIds.length > 0) return ['--refs', downloadedIds.join(','), '--scope', 'downloaded'];
  return [];
}

/**
 * 把各家的错误字段统一成一句话。
 *
 * 顾本给的是字符串（`参考素材疑似含「真实人物」…`），
 * MiniMax 给的是对象（`{ code: '1026', message: 'video description contains sensitive content' }`），
 * 这里两种都得认，否则人工在流转记录里只会看到 `[object Object]`。
 */
function stringifyGenerationError(error) {
  if (error === undefined || error === null) return '';
  if (typeof error === 'string') return error.trim();
  if (typeof error === 'object') {
    const code = error.code === undefined || error.code === null || String(error.code) === '' ? '' : `[${error.code}] `;
    const message = typeof error.message === 'string' ? error.message.trim() : '';
    const text = `${code}${message}`.trim();
    return text !== '' ? text : JSON.stringify(error).slice(0, 200);
  }
  return String(error);
}

/**
 * 生成失败时，从返回值里取一句人能看懂的原因。
 *
 * 顾本 CLI 在任务失败时**仍然是正常退出**（退出码 0），失败信息只放在 JSON 里：
 * `{ ok: false, files: [], task: { status: 'failed', error, pointsHeld, pointsCharged }, message }`。
 * MiniMax 那条路由 lib/minimax.js 归一化成同一个形状。所以只看 files 是不够的，必须把 task.error 一起读出来。
 */
function generationFailureReason(result) {
  const task = result?.task ?? {};
  const parts = [];
  const reason = stringifyGenerationError(task.error) || stringifyGenerationError(result?.message) || (result?.timeout ? '等待超时' : '未知原因');
  parts.push(reason);
  if (task.status) parts.push(`任务状态 ${task.status}`);
  if (typeof task.pointsHeld === 'number') parts.push(`预扣 ${task.pointsHeld} 分`);
  if (typeof task.pointsCharged === 'number') parts.push(`实扣 ${task.pointsCharged} 分`);
  return parts.join('；');
}

/**
 * 把顾本作品/素材下载到本地，返回文件路径。
 *
 * MiniMax 要的是「字节或公网 URL」，不像顾本那样直接吃素材 id，所以得先把文件拿到手。
 * 作品（我的作品）和公共素材库走的是两个不同的子命令。
 */
async function downloadGubenMaterial(settings, kind, value) {
  const dir = join(DATA_DIR, 'materials');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const args = kind === 'work' ? ['download-work', value, '--out', dir] : ['download', value, '--out', dir];
  const out = await guben(settings, args, { timeoutMs: 600000 });
  const file = out?.files?.[0]?.file;
  if (!file || !existsSync(file)) throw new Error(`下载后没有拿到本地文件（${JSON.stringify(out).slice(0, 200)}）`);
  return file;
}

/**
 * 生视频素材 → MiniMax 的参考素材列表。
 *
 * 与顾本那条路的根本区别：顾本要「素材 id」，MiniMax 要能取到的字节或公网地址。
 * 所以：公网 URL 直接透传（省一次 base64），本地文件转 data URI，顾本素材先下载再转。
 */
async function resolveMinimaxRefs(settings, materials, notes) {
  const refs = [];
  for (const m of materials ?? []) {
    const value = String(m?.value ?? '').trim();
    if (value === '') continue;
    const kind = m?.kind;

    if (kind === 'url') {
      notes.push(`网页「${value}」只能作为写提示词的参考，不能当画面素材`);
      continue;
    }

    // 素材类型：优先看 materialKind，其次按扩展名猜
    const isVideo = m?.mediaKind === 'video' || /\.(mp4|mov)$/i.test(value);
    const type = isVideo ? 'video' : 'image';

    if (kind === 'image' || kind === 'video') {
      if (/^https?:\/\//i.test(value)) {
        refs.push({ type, url: value, from: value });
        continue;
      }
      if (!existsSync(value)) {
        notes.push(`素材「${value}」不存在，已跳过`);
        continue;
      }
      const problem = inlineSizeProblem(value);
      if (problem) {
        notes.push(`素材「${value}」${problem}，已跳过（MiniMax 请求体上限 64MB）`);
        continue;
      }
      refs.push({ type, url: fileToDataUri(value), from: value });
      continue;
    }

    if (kind === 'work' || kind === 'guben') {
      // 上传时留下的本地副本优先，省一次下载
      const local = typeof m?.path === 'string' && existsSync(m.path) ? m.path : null;
      let file = local;
      if (!file) {
        try {
          file = await downloadGubenMaterial(settings, kind, value);
        } catch (error) {
          notes.push(`素材 #${value} 下载失败：${error instanceof Error ? error.message : error}`);
          continue;
        }
      }
      const problem = inlineSizeProblem(file);
      if (problem) {
        notes.push(`素材 #${value} ${problem}，已跳过（MiniMax 请求体上限 64MB）`);
        continue;
      }
      refs.push({ type, url: fileToDataUri(file), from: `#${value}` });
      continue;
    }

    notes.push(`未知素材类型「${kind}」，已跳过`);
  }
  return refs;
}

/** 按 MiniMax 的设置把一条任务生成的参数算好，再交给 lib/minimax.js。 */
async function generateWithMinimax(settings, task, { ratio, notes }) {
  if (!minimaxReady(settings)) {
    throw new Error('未配置 MiniMax API Token，请到「设置 → TikTok 运营助手 → MiniMax H3」里填写');
  }
  const model = normalizeMinimaxModel(settings.minimaxModel);
  const resolution = normalizeMinimaxResolution(model, settings.minimaxResolution);
  const duration = clampMinimaxDuration(model, task.duration);
  if (duration !== Number(task.duration)) {
    notes.push(`MiniMax ${model} 的时长范围是 ${MINIMAX_MODELS[model].minDuration}~${MINIMAX_MODELS[model].maxDuration} 秒，已按 ${duration} 秒提交`);
  }
  const refs = await resolveMinimaxRefs(settings, task.genMaterials, notes);
  notes.push(
    `MiniMax 出片规格：${model} / ${resolution} / ${duration} 秒 / ${ratio}；参考素材 ${refs.length} 条（上限：图 ${MINIMAX_REF_LIMITS.image} 张、视频 ${MINIMAX_REF_LIMITS.video} 段）`
  );

  return generateMinimaxVideo(settings, {
    prompt: task.prompt,
    duration,
    ratio,
    resolution,
    model,
    refs,
    outDir: join(DATA_DIR, 'outputs'),
  });
}

/**
 * 跑一次视频生成（顾本 / MiniMax 两条路都从这里走）。
 *
 * 调用前任务必须已经在「进行中·生成视频」——也就是说**生成这一步得先被授权**
 *（人工通过脚本审核，或从「通过」入口进来）。这保证了 agent 不能绕过脚本审核直接烧钱。
 *
 * 三条出口都落在状态机上：
 *   成功 → finishOp 落到「视频审核」；
 *   上游抛异常 → failOp 退回脚本审核（不是稀里糊涂停在「进行中」）；
 *   返回但没有产物文件 → 同上，也要退回。
 */
async function startVideoGeneration(id, requestedProvider) {
  const state = readState();
  const task = state.tasks.find((t) => t.id === id);
  if (!task) throw new Error('任务不存在');
  if (task.status !== 'working' || task.op?.kind !== 'video') {
    throw new Error(
      `生成视频需要任务处于「进行中·生成视频」（由脚本审核通过触发），当前是「${STATUS[task.status]}` +
        (task.op ? `·${OPS[task.op.kind]?.label ?? task.op.kind}` : '') +
        '」'
    );
  }
  if (!task.prompt) throw new Error('该任务还没有提示词，请先写提示词并过脚本审核');

  const settings = state.settings;
  const provider = normalizeProvider(requestedProvider ?? task.provider);
  const ratio = ASPECT[task.aspect]?.ratio ?? '9:16';
  const materialNotes = [];
  const label = PROVIDERS[provider].label;

  let result;
  try {
    if (provider === 'minimax') {
      result = await generateWithMinimax(settings, task, { ratio, notes: materialNotes });
    } else {
      const { privateIds, downloadedIds, notes } = await resolveGenerationRefs(settings, task.genMaterials);
      materialNotes.push(...notes);
      const refArgs = buildRefArgs(privateIds, downloadedIds, materialNotes);
      result = await guben(
        settings,
        ['gen', 'video', task.prompt, '--resolution', '720p', '--duration', String(task.duration), '--ratio', ratio, '--out', join(DATA_DIR, 'outputs'), ...refArgs],
        { timeoutMs: 1800000 }
      );
    }
  } catch (error) {
    // 凭据错、网络不通、参数被上游拒……这些都走异常路径（不是「返回 files 为空」那条）。
    // 也必须留痕并退回来源状态，否则页面上只闪一个 toast，事后完全看不出为什么没生成。
    const reason = error instanceof Error ? error.message : String(error);
    const rolled = mutate((s) => {
      const t = findTask(s, id);
      t.log = Array.isArray(t.log) ? t.log : [];
      t.log.push({ at: nowIso(), text: `生成失败（${label}）：${reason}` });
      return failOp(s, id, `${label}：${reason}`);
    });
    throw Object.assign(new Error(`生成失败，已退回「${STATUS[rolled.status]}」。${label} 返回：${reason}`), {
      status: rolled.status,
      reason,
    });
  }

  const files = Array.isArray(result?.files) ? result.files : [];
  if (files.length === 0) {
    const reason = generationFailureReason(result);
    const rolled = mutate((s) => {
      const t = findTask(s, id);
      t.log = Array.isArray(t.log) ? t.log : [];
      t.log.push({ at: nowIso(), text: `生成失败（${label}），未产出视频：${reason}` });
      return failOp(s, id, `${label} 未产出视频：${reason}`);
    });
    throw Object.assign(new Error(`生成未产出视频文件，已退回「${STATUS[rolled.status]}」。${label} 返回：${reason}`), {
      status: rolled.status,
      reason,
    });
  }

  const updated = mutate((s) => {
    const t = findTask(s, id);
    t.outputs = files.map((f) => ({ kind: 'video', path: f, source: provider }));
    t.provider = provider;
    t.materialNotes = materialNotes;
    if (result?.task?.outputs?.[0]?.materialId) t.gubenMaterialId = result.task.outputs[0].materialId;
    finishOp(s, id, `视频已生成（${label}），等待审片`);
    return t;
  });
  return { result, materialNotes, provider, task: updated };
}

/**
 * 发布/采集前的登录态前置检查。
 *
 * 不加这一层的话，未登录时上传页会重定向或空白，脚本只会在找不到 input[type=file]
 * 之后抛一句「Element not found」——用户完全看不出真实原因是没有登录。
 */
async function requireLogin(settings, account, action) {
  if (!(await tiktokIsLoggedIn(settings, account))) {
    throw new Error(
      `账号「${account.label || account.username}」当前未登录（或登录已失效），无法${action}。` +
        '请先到「设置 → TikTok 运营助手」点「登录」完成一次登录；自动登录被验证码拦住时，请在弹出的窗口里手动登录。'
    );
  }
}

/** 在页面内等某个选择器出现；一次调用等到底，避免宿主侧多轮轮询的开销。 */
async function waitForSelector(settings, session, selector, waitMs) {
  const result = await abEval(
    settings,
    session,
    `new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        if (document.querySelector(${JSON.stringify(selector)})) return resolve('ready');
        if (Date.now() - t0 > ${waitMs}) return resolve('timeout');
        setTimeout(tick, 500);
      };
      tick();
    })`,
    { timeoutMs: waitMs + 30000 }
  ).catch(() => 'error');
  return result;
}

async function tiktokPublish(settings, account, { videoPath, caption }) {
  const session = sessionOf(account);
  if (!existsSync(videoPath)) throw new Error(`视频文件不存在：${videoPath}`);
  await requireLogin(settings, account, '发布视频');
  return await withDiagnostic(settings, session, 'publish', async () => {
    await ab(settings, session, ['open', 'https://www.tiktok.com/tiktokstudio/upload?lang=zh-Hans'], { timeoutMs: 180000 });

    // 上传页渲染慢，先等文件输入框真的出现再操作（否则会报「Element not found」）
    const ready = await waitForSelector(settings, session, 'input[type="file"]', 60000);
    if (ready !== 'ready') {
      throw new Error(
        `上传页没能渲染出文件选择框（waitForSelector=${ready}）。常见原因：登录已失效、页面被重定向、或网络过慢。`
      );
    }

    await ab(settings, session, ['upload', 'input[type="file"]', videoPath], { timeoutMs: 600000 });

    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 5000));
      const ready = await abEval(settings, session, `/已上传|替换/.test(document.body.innerText)`, { timeoutMs: 60000 });
      if (ready === true) break;
    }

    // 清空自动带入的文件名：DraftJS 只认真实按键，execCommand 会把编辑器打崩
    await abEval(
      settings,
      session,
      `(() => {
        const el = document.querySelector('div.public-DraftEditor-content');
        if (!el) return 'no-editor';
        el.focus();
        const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
        return 'ok';
      })()`,
      { timeoutMs: 60000 }
    );
    for (let i = 0; i < 60; i += 1) {
      await ab(settings, session, ['press', 'Backspace'], { timeoutMs: 30000 }).catch(() => {});
    }
    if (caption) {
      await abEval(
        settings,
        session,
        `(() => { const el = document.querySelector('div.public-DraftEditor-content'); if (el) el.focus(); return 'ok'; })()`,
        { timeoutMs: 60000 }
      );
      await ab(settings, session, ['keyboard', 'inserttext', caption], { timeoutMs: 60000 });
    }

    const box = await abEval(
      settings,
      session,
      `(() => {
        const b = [...document.querySelectorAll('button')].find((x) => (x.innerText || '').trim() === '发布');
        if (!b) return null;
        b.scrollIntoView({ block: 'center' });
        const r = b.getBoundingClientRect();
        return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
      })()`,
      { timeoutMs: 60000 }
    );
    const point = typeof box === 'string' ? JSON.parse(box) : box;
    if (!point) throw new Error('找不到「发布」按钮');
    await ab(settings, session, ['mouse', 'move', String(point.x), String(point.y)], { timeoutMs: 30000 });
    await ab(settings, session, ['mouse', 'down'], { timeoutMs: 30000 });
    await ab(settings, session, ['mouse', 'up'], { timeoutMs: 30000 });
    await new Promise((r) => setTimeout(r, 20000));
    const url = (await ab(settings, session, ['get', 'url'], { timeoutMs: 60000 })).trim();
    return { url };
  });
}

// ------------------------------------------------------------------ 指标解析

/** "1.2万" / "1,234" / "12.3K" → number；解析不了返回 null。 */
export function parseCompactNumber(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return null;
  const m = text.match(/^([\d,]+(?:\.\d+)?)\s*([万亿KMkm]?)$/);
  if (!m) return null;
  const base = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(base)) return null;
  const unit = m[2];
  const scale = unit === '万' ? 1e4 : unit === '亿' ? 1e8 : unit === 'K' || unit === 'k' ? 1e3 : unit === 'M' ? 1e6 : 1;
  return base * scale;
}

/**
 * 解析创作中心「内容」列表里的一行。
 *
 * 实测形状：`00:15 <描述> 9月21日 12:27 所有人 0 0 0`
 * 即 时长 → 描述 → 时间或审查状态 → 可见范围 → 数据列（默认 播放/点赞/评论，开了分享列会多一个）。
 */
export function parseStudioRow(raw) {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (text === '') return null;
  const pattern =
    /^(\d{1,2}:\d{2})\s+(.+?)\s+((?:\d{4}年)?\d{1,2}月\d{1,2}日(?:\s+\d{1,2}:\d{2})?|内容审查中|审核中|未通过|审核未通过)\s+(所有人|仅自己|好友|互关朋友|仅好友|公开|私密)\s+([\d.,]+\s*[万亿KMkm]?)(?:\s+([\d.,]+\s*[万亿KMkm]?))?(?:\s+([\d.,]+\s*[万亿KMkm]?))?(?:\s+([\d.,]+\s*[万亿KMkm]?))?$/;
  const m = text.match(pattern);
  if (!m) return null;
  const nums = [m[5], m[6], m[7], m[8]].filter((v) => v !== undefined);
  const isDate = /\d+月/.test(m[3]);
  return {
    duration: m[1],
    caption: m[2].trim(),
    publishedAt: isDate ? m[3] : null,
    status: isDate ? 'published' : m[3],
    privacy: m[4],
    // 默认视图是 播放/点赞/评论；若页面开了分享列则有第 4 个数字
    views: parseCompactNumber(nums[0]),
    likes: parseCompactNumber(nums[1]),
    comments: parseCompactNumber(nums[2]),
    shares: nums.length >= 4 ? parseCompactNumber(nums[3]) : null,
    columnCount: nums.length,
  };
}

export function parseStudioRows(rows) {
  const parsed = [];
  const unparsed = [];
  for (const raw of Array.isArray(rows) ? rows : []) {
    const row = parseStudioRow(raw);
    if (row) parsed.push(row);
    else unparsed.push(String(raw ?? ''));
  }
  return { parsed, unparsed };
}

/** 用描述把指标行挂到任务上；描述对不上时退化为按序对位，保证不丢数据。 */
export function matchMetricsToTasks(tasks, parsedRows) {
  const remaining = [...parsedRows];
  const result = new Map();
  for (const task of tasks) {
    const caption = String(task.caption ?? '').trim();
    let index = -1;
    if (caption !== '') {
      index = remaining.findIndex((row) => row.caption && (row.caption === caption || row.caption.startsWith(caption.slice(0, 20))));
    }
    if (index < 0 && remaining.length > 0) index = 0;
    result.set(task.id, index >= 0 ? remaining.splice(index, 1)[0] : null);
  }
  return result;
}

async function tiktokMetrics(settings, account) {
  await requireLogin(settings, account, '采集数据');
  const session = sessionOf(account);
  await ab(settings, session, ['open', 'https://www.tiktok.com/tiktokstudio/content'], { timeoutMs: 180000 });
  await new Promise((r) => setTimeout(r, 6000));
  const raw = await abEval(
    settings,
    session,
    `(() => {
      const rows = [...document.querySelectorAll('tr')].map((tr) => tr.innerText.replace(/\\s+/g, ' ').trim()).filter(Boolean);
      const links = [...document.querySelectorAll('a')].map((a) => a.href).filter((h) => /\\/video\\/\\d+/.test(h));
      return JSON.stringify({ rows, links: [...new Set(links)] });
    })()`,
    { timeoutMs: 60000 }
  );
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const { parsed, unparsed } = parseStudioRows(data?.rows);
  // 一行都没解析出来是静默失败（没登录/被重定向/改版），留图让它自己暴露
  const screenshot = parsed.length === 0 ? await captureDiagnostic(settings, session, 'metrics-empty') : null;
  return { rows: data?.rows ?? [], links: data?.links ?? [], parsed, unparsed, screenshot };
}

async function tiktokComments(settings, account) {
  await requireLogin(settings, account, '采集评论');
  const session = sessionOf(account);
  await ab(settings, session, ['open', 'https://www.tiktok.com/tiktokstudio/comment?lang=zh-Hans'], { timeoutMs: 180000 });
  await new Promise((r) => setTimeout(r, 6000));
  const raw = await abEval(
    settings,
    session,
    `(() => {
      const text = document.body.innerText.slice(0, 8000);
      const rows = [...document.querySelectorAll('[class*=comment],[class*=Comment]')]
        .map((n) => (n.innerText || '').replace(/\\s+/g, ' ').trim())
        .filter((t) => t.length > 0 && t.length < 400);
      return JSON.stringify({ text, rows: [...new Set(rows)].slice(0, 100) });
    })()`,
    { timeoutMs: 60000 }
  );
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const screenshot = await captureDiagnostic(settings, session, 'comments');
  return { text: data?.text ?? '', rows: data?.rows ?? [], screenshot };
}

// ------------------------------------------------------------------ 运营洞察

/**
 * 把已发布任务的数据聚合成一份运营洞察：整体表现、按比例/时长分组的对比、
 * 头部作品。它只做**确定性统计**，不做主观判断——「下一条该拍什么」交给 agent 去推理。
 */
export function buildInsights(tasks) {
  const published = (Array.isArray(tasks) ? tasks : []).filter((t) => t.status === 'published' && t.metrics);
  const sum = (list, key) => list.reduce((acc, t) => acc + (Number(t.metrics?.[key]) || 0), 0);
  const totals = {
    count: published.length,
    views: sum(published, 'views'),
    likes: sum(published, 'likes'),
    comments: sum(published, 'comments'),
    shares: sum(published, 'shares'),
  };
  const engagement = totals.views > 0 ? (totals.likes + totals.comments + totals.shares) / totals.views : null;

  const groupBy = (keyFn, labelFn) => {
    const buckets = new Map();
    for (const task of published) {
      const key = keyFn(task);
      if (key === null || key === undefined) continue;
      if (!buckets.has(key)) buckets.set(key, { key, label: labelFn(task), tasks: [] });
      buckets.get(key).tasks.push(task);
    }
    return [...buckets.values()]
      .map((b) => ({
        key: b.key,
        label: b.label,
        count: b.tasks.length,
        views: sum(b.tasks, 'views'),
        likes: sum(b.tasks, 'likes'),
        comments: sum(b.tasks, 'comments'),
        shares: sum(b.tasks, 'shares'),
        avgViews: Math.round(sum(b.tasks, 'views') / b.tasks.length),
      }))
      .sort((a, b) => b.avgViews - a.avgViews);
  };

  const durationBucket = (d) => {
    const n = Number(d) || 0;
    if (n <= 10) return '≤10s';
    if (n <= 20) return '11-20s';
    if (n <= 30) return '21-30s';
    return '>30s';
  };

  const top = [...published]
    .sort((a, b) => (Number(b.metrics.views) || 0) - (Number(a.metrics.views) || 0))
    .slice(0, 5)
    .map((t) => ({
      id: t.id,
      topic: t.topic,
      duration: t.duration,
      aspect: t.aspect,
      views: t.metrics.views ?? null,
      likes: t.metrics.likes ?? null,
      comments: t.metrics.comments ?? null,
      shares: t.metrics.shares ?? null,
      url: t.url ?? null,
    }));

  return {
    generatedAt: nowIso(),
    totals,
    engagementRate: engagement,
    byAspect: groupBy((t) => t.aspect, (t) => ASPECT[t.aspect]?.label ?? t.aspect),
    byDuration: groupBy((t) => durationBucket(t.duration), (t) => durationBucket(t.duration)),
    top,
    /** 分享列没开时 shares 恒为 0，这里显式说明，避免把「没数据」误读成「没人分享」。 */
    sharesAvailable: published.some((t) => t.metrics?.shares !== null && t.metrics?.shares !== undefined),
  };
}

// ------------------------------------------------------------------ 落地页数据

function publicState() {
  const state = readState();
  return {
    ...state,
    accounts: state.accounts.map((a) => ({ ...a, password: undefined, hasPassword: Boolean(a.password) })),
    settings: {
      ...state.settings,
      gubenToken: state.settings.gubenToken ? '***' : '',
      minimaxToken: state.settings.minimaxToken ? '***' : '',
    },
    providerLabels: Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, v.label])),
    opLabels: Object.fromEntries(Object.entries(OPS).map(([k, v]) => [k, v.label])),
    // 界面上要显示「最终用的是哪个顾本 CLI」：内联副本还是用户覆盖的那份
    gubenScriptResolved: effectiveGubenScript(state.settings),
    gubenScriptVendored: VENDORED_GUBEN_SCRIPT,

    statusLabels: STATUS,
    aspectLabels: Object.fromEntries(Object.entries(ASPECT).map(([k, v]) => [k, v.label])),
    marketLabels: Object.fromEntries(Object.entries(MARKET).map(([k, v]) => [k, v.label])),
  };
}

/**
 * 登录冷却：失败后指数退避。
 *
 * 为什么必须有：TikTok 会对频繁的自动化登录直接锁定账号。调试期间我手动触发过几次，
 * 已经被锁过一次——所以这里强制加退避，避免人手或 agent 连续重试把账号刷废。
 */
const LOGIN_BACKOFF_MS = [30 * 60e3, 2 * 3600e3, 8 * 3600e3];

/** 距离可以再次尝试登录还有多少毫秒；0 表示现在可以试。 */
export function loginBlockRemaining(account, now = Date.now()) {
  const until = Number(account?.loginBlockedUntil ?? 0);
  return Number.isFinite(until) && until > now ? until - now : 0;
}

/** 记一次失败并按次数退避。 */
function applyLoginFailure(account, at = Date.now()) {
  account.loginAttempts = Number(account.loginAttempts ?? 0) + 1;
  const idx = Math.min(account.loginAttempts - 1, LOGIN_BACKOFF_MS.length - 1);
  account.lastLoginAttemptAt = new Date(at).toISOString();
  account.loginBlockedUntil = at + LOGIN_BACKOFF_MS[idx];
}

/** 登录成功或人工确认后清掉冷却。 */
function resetLoginCooldown(account) {
  account.loginAttempts = 0;
  account.loginBlockedUntil = null;
}

function findAccount(state, id) {
  const account = state.accounts.find((a) => a.id === id) ?? state.accounts[0];
  if (!account) throw new Error('还没有配置 TikTok 账号，请先到「设置」里添加');
  return account;
}

function findTask(state, id) {
  const task = state.tasks.find((t) => t.id === id);
  if (!task) throw new Error('任务不存在');
  return task;
}

/**
 * 写入提示词：人工在脚本审核里直接改，或 agent 优化后回写，都走这里。
 *
 * 被替换掉的旧版本压进 promptHistory（最多 10 版）——脚本审核阶段最容易反复，
 * 留档才能对比「改之前是什么样」。状态流转不在这里做。
 */
function applyPrompt(task, prompt) {
  const next = String(prompt ?? '').trim();
  if (next === '') throw new Error('提示词不能为空');
  const previous = String(task.prompt ?? '').trim();
  if (previous !== '' && previous !== next) {
    task.promptHistory = Array.isArray(task.promptHistory) ? task.promptHistory : [];
    task.promptHistory.unshift({ at: nowIso(), prompt: previous });
    task.promptHistory = task.promptHistory.slice(0, 10);
  }
  task.prompt = next;
  return task;
}

/**
 * 能改提示词的判断已收敛到 canEditPrompt()：脚本审核阶段原地改，
 * 或者「进行中·生成提示词」时 agent 交作业。进行中跑别的操作时改不了。
 */

/** /task/update 的字段中文名，用来把改动写清楚进流转记录。 */
const FIELD_LABEL = {
  topic: '选题',
  caption: '发布文案',
  duration: '时长',
  aspect: '比例',
  accountId: 'TikTok 账号',
  provider: '生视频通道',
};

/** 本地上传的字节上限。顾本一条素材够用，也避免有人误传整个片子工程。 */
const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;

// ------------------------------------------------------------------ 路由

function buildRoutes(ctx) {
  const routes = [];

  routes.push({
    kind: 'exact',
    path: `${API_PREFIX}/ping`,
    handler: (req, res) => {
      if (!isTrustedRequest(req)) return writeJson(res, 403, { ok: false, error: 'forbidden' });
      writeJson(res, 200, { ok: true, plugin: 'dsh-tiktok-ops', title: 'TikTok 运营助手', dataDir: DATA_DIR, pluginDir: PLUGIN_DIR });
    },
  });

  routes.push({
    kind: 'exact',
    path: `${API_PREFIX}/diag`,
    handler: (req, res) => {
      if (!isTrustedRequest(req)) return writeJson(res, 403, { ok: false, error: 'forbidden' });
      let clientInfo = null;
      try {
        const cm = ctx.get('clientModules');
        const graph = cm?.graph?.();
        const entries = Array.isArray(graph?.entries) ? graph.entries : [];
        clientInfo = {
          hasService: Boolean(cm),
          entryCount: entries.length,
          mine: entries.filter((e) => /tiktok/.test(String(e?.id ?? ''))),
          clientPath: cm?.clientPath?.('dsh-tiktok-ops') ?? null,
        };
      } catch (error) {
        clientInfo = { error: error instanceof Error ? error.message : String(error) };
      }
      const settings = readState().settings;
      writeJson(res, 200, {
        ok: true,
        clientModules: clientInfo,
        guidance: { ...guidanceState, mentionsSkill: Boolean(guidanceState.sd25Pe) },
        dispatch: {
          // 能不能主动建会话把任务推给 agent，全看这两个
          gateway: Boolean(agentRuntime.gateway),
          workspaces: Boolean(agentRuntime.workspaces),
        },
        resolved: {
          gubenScript: effectiveGubenScript(settings),
          gubenScriptOverride: String(settings.gubenScript ?? '').trim() || null,
          gubenToken: settings.gubenToken ? 'set' : 'missing',
          minimaxToken: settings.minimaxToken ? 'set' : 'missing',
          minimaxModel: normalizeMinimaxModel(settings.minimaxModel),
          minimaxResolution: normalizeMinimaxResolution(settings.minimaxModel, settings.minimaxResolution),
          agentBrowserBin: agentBrowserBin(settings),
        },
      });
    },
  });

  /**
   * 本地素材预览。
   *
   * 只服务「出现在某个任务素材字段里」的本地路径——不做任意文件读取。
   * 浏览器没法直接加载任意本地路径，所以详情页的图片/视频预览要走这里。
   */
  routes.push({
    kind: 'exact',
    path: `${API_PREFIX}/file`,
    handler: (req, res) => {
      if (!isTrustedRequest(req)) return writeJson(res, 403, { ok: false, error: 'forbidden' });
      const target = new URL(req.url, 'http://127.0.0.1').searchParams.get('path') ?? '';
      const allowed = new Set();
      for (const t of readState().tasks) {
        for (const list of [t.refs, t.genMaterials, t.outputs]) {
          for (const m of list ?? []) {
            if (typeof m?.path === 'string') allowed.add(m.path);
            if (typeof m?.value === 'string' && m.value.startsWith('/')) allowed.add(m.value);
          }
        }
      }
      if (!allowed.has(target)) {
        return writeJson(res, 403, { ok: false, error: '该路径不在任何任务的素材字段里，拒绝读取' });
      }
      let stat;
      try {
        stat = statSync(target);
      } catch {
        return writeJson(res, 404, { ok: false, error: '文件不存在' });
      }
      if (!stat.isFile()) return writeJson(res, 400, { ok: false, error: '不是文件' });

      const ext = (target.split('.').pop() ?? '').toLowerCase();
      const types = {
        mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', m4v: 'video/x-m4v',
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
      };
      res.writeHead(200, {
        'content-type': types[ext] ?? 'application/octet-stream',
        'content-length': stat.size,
        'cache-control': 'no-store',
      });
      createReadStream(target).pipe(res);
      return undefined;
    },
  });

  routes.push(jsonRoute('/state', () => ({ state: publicState() })));

  // ---- 设置：TikTok 账号 + 顾本 Token + MiniMax Token ----
  routes.push(
    jsonRoute('/settings', (body) => {
      mutate((state) => {
        const patch = body.settings ?? {};
        if (typeof patch.gubenToken === 'string' && patch.gubenToken !== '***' && patch.gubenToken.trim() !== '') {
          state.settings.gubenToken = patch.gubenToken.trim();
        }
        if (typeof patch.gubenBase === 'string' && patch.gubenBase.trim() !== '') {
          state.settings.gubenBase = patch.gubenBase.trim();
        }
        // 顾本 CLI 路径是可选的覆盖项：空串表示「回到内联副本」，非空必须是有效的 .mjs/.js
        if (patch.gubenScript !== undefined) {
          state.settings.gubenScript = validateGubenScript(patch.gubenScript);
        }
        // 与顾本 Token 同一套规则：打码占位符和空串都不覆盖已存的值
        if (typeof patch.minimaxToken === 'string' && patch.minimaxToken !== '***' && patch.minimaxToken.trim() !== '') {
          state.settings.minimaxToken = patch.minimaxToken.trim();
        }
        if (typeof patch.minimaxBase === 'string' && patch.minimaxBase.trim() !== '') {
          state.settings.minimaxBase = patch.minimaxBase.trim();
        }
        if (typeof patch.minimaxModel === 'string' && patch.minimaxModel.trim() !== '') {
          state.settings.minimaxModel = normalizeMinimaxModel(patch.minimaxModel.trim());
        }
        if (typeof patch.minimaxResolution === 'string' && patch.minimaxResolution.trim() !== '') {
          state.settings.minimaxResolution = normalizeMinimaxResolution(
            state.settings.minimaxModel,
            patch.minimaxResolution.trim()
          );
        }
      });
      return { state: publicState() };
    })
  );

  /**
   * 试一下 MiniMax 凭据通不通。
   *
   * 走只读的查询接口，不建任务、不花钱，所以设置页可以随便点。
   * 之所以要有它：「Token 已配置」并不代表 Token 能用——可能早就失效，
   * 也可能拿错了平台（api.minimax.cn 与 api.minimax.io 的 Key 不通用）。
   */
  routes.push(
    jsonRoute('/minimax/test', async (body) => {
      const settings = { ...readState().settings };
      // 允许带上未保存的 base/token 先试后存
      if (typeof body?.minimaxBase === 'string' && body.minimaxBase.trim() !== '') settings.minimaxBase = body.minimaxBase.trim();
      if (typeof body?.minimaxToken === 'string' && body.minimaxToken !== '***' && body.minimaxToken.trim() !== '') {
        settings.minimaxToken = body.minimaxToken.trim();
      }
      if (!minimaxReady(settings)) throw new Error('还没配置 MiniMax API Token');
      const probe = await probeMinimaxAuth(settings);
      return { probe };
    })
  );

  routes.push(
    jsonRoute('/account/save', (body) => {
      const account = body.account ?? {};
      if (!account.username) throw new Error('缺少 TikTok 账号用户名');
      mutate((state) => {
        if (account.id) {
          const existing = state.accounts.find((a) => a.id === account.id);
          if (!existing) throw new Error('账号不存在');
          Object.assign(existing, {
            label: account.label ?? existing.label,
            username: account.username ?? existing.username,
            password: account.password ? account.password : existing.password,
            updatedAt: nowIso(),
          });
        } else {
          state.accounts.push({
            id: makeId('acc'),
            label: account.label ?? account.username,
            username: account.username,
            password: account.password ?? '',
            status: 'unknown',
            note: '',
            createdAt: nowIso(),
          });
        }
      });
      return { state: publicState() };
    })
  );

  routes.push(
    jsonRoute('/account/delete', (body) => {
      if (!body.id) throw new Error('缺少账号 id');
      mutate((state) => {
        state.accounts = state.accounts.filter((a) => a.id !== body.id);
      });
      return { state: publicState() };
    })
  );

  routes.push(
    jsonRoute('/account/login', async (body) => {
      const state = readState();
      const account = findAccount(state, body.id);
      if (!account.password) throw new Error('该账号没有保存密码，无法自动登录');

      // 冷却闸门：被平台锁定过就别再刷了
      const remaining = loginBlockRemaining(account);
      if (remaining > 0) {
        const mins = Math.ceil(remaining / 60000);
        const until = new Date(Number(account.loginBlockedUntil)).toLocaleString();
        throw new Error(`登录冷却中：还有约 ${mins} 分钟（可重试时间 ${until}）。频繁重试会让 TikTok 锁定账号。`);
      }

      const result = await tiktokLogin(state.settings, account);
      mutate((s) => {
        const target = s.accounts.find((a) => a.id === account.id);
        if (!target) return;
        target.status = result.status;
        target.note = result.message ?? '';
        target.lastLoginAt = nowIso();
        if (result.status === 'ok') resetLoginCooldown(target);
        else applyLoginFailure(target);
      });
      return { result, state: publicState() };
    })
  );

  /** 人工确认可以重试时，清掉冷却（比如平台锁定已解除）。 */
  routes.push(
    jsonRoute('/account/reset-cooldown', (body) => {
      mutate((state) => {
        const account = findAccount(state, body.id);
        resetLoginCooldown(account);
        account.status = 'unknown';
        account.note = '冷却已由人工重置';
      });
      return { state: publicState() };
    })
  );

  // ---- 任务 ----
  routes.push(
    jsonRoute('/task/create', async (body) => {
      const task = mutate((state) => createTask(body.task ?? {}, state));
      // 提交即派活：不然任务会一直停在「进行中·生成提示词」等人
      let dispatched = null;
      let dispatchError = null;
      if (task.status === 'working' && task.op?.kind === 'prompt' && body.dispatch !== false) {
        try {
          dispatched = await dispatchAgent({ title: `TikTok 任务：${task.topic.slice(0, 40)}`, prompt: dispatchPrompt(task) });
          mutate((s) => {
            const t = s.tasks.find((x) => x.id === task.id);
            if (t) {
              t.dispatchedSessionId = dispatched;
              t.log = Array.isArray(t.log) ? t.log : [];
              t.log.push({ at: nowIso(), text: `已派给 agent（会话 ${dispatched}）` });
            }
          });
        } catch (error) {
          // 派活失败 = 「生成提示词」这一步失败 → 退回草稿（这张任务是从草稿提交来的）。
          // 不能让它停在「进行中」：那既不能改也不能删，还会让人以为 agent 正在干活。
          dispatchError = error instanceof Error ? error.message : String(error);
          mutate((s) => failOp(s, task.id, `自动派活失败：${dispatchError}`));
        }
      }
      // mutate 会重新读盘，所以这里要回读最新记录，不能返回改动前的旧对象
      return { task: readState().tasks.find((t) => t.id === task.id) ?? task, dispatched, dispatchError, state: publicState() };
    })
  );

  /** 手动把某条任务派给 agent（自动派活失败、或任务卡在「进行中·生成提示词」时用）。 */
  routes.push(
    jsonRoute('/task/dispatch', async (body) => {
      const state = readState();
      const task = findTask(state, body.id);
      if (!(task.status === 'working' && task.op?.kind === 'prompt')) {
        throw new Error(
          `只有「进行中·生成提示词」的任务能派给 agent，当前是「${STATUS[task.status]}` +
            (task.op ? `·${OPS[task.op.kind]?.label ?? task.op.kind}` : '') +
            '」'
        );
      }
      try {
        const sessionId = await dispatchAgent({
          title: `TikTok 任务：${task.topic.slice(0, 40)}`,
          prompt: dispatchPrompt(task),
        });
        mutate((s) => {
          const t = findTask(s, body.id);
          t.dispatchedSessionId = sessionId;
          t.log = Array.isArray(t.log) ? t.log : [];
          t.log.push({ at: nowIso(), text: `已派给 agent（会话 ${sessionId}）` });
        });
        return { sessionId, state: publicState() };
      } catch (error) {
        // 派活失败 = 这一步操作失败 → 退回来源状态（从草稿提交的就回草稿）
        const reason = error instanceof Error ? error.message : String(error);
        const rolled = mutate((s) => failOp(s, body.id, `派活失败：${reason}`));
        throw Object.assign(new Error(`派活失败，已退回「${STATUS[rolled.status]}」。${reason}`), { status: rolled.status });
      }
    })
  );

  routes.push(
    jsonRoute('/task/update', (body) => {
      const patch = body.patch ?? {};
      mutate((state) => {
        const task = findTask(state, body.id);
        // 进行中是过程状态：这期间改了参数，正在跑的那一步就不知道按哪版参数算了
        if (workingLocked(task)) {
          throw new Error(
            `任务正在「进行中·${OPS[task.op?.kind]?.label ?? '未知操作'}」，这期间不能改任务信息；要改请先「取消当前操作」`
          );
        }
        const changes = [];
        for (const key of ['topic', 'caption', 'duration', 'aspect', 'accountId']) {
          if (patch[key] === undefined) continue;
          if (String(task[key] ?? '') === String(patch[key])) continue;
          changes.push(`${FIELD_LABEL[key] ?? key} ${task[key] ?? '—'} → ${patch[key]}`);
          task[key] = key === 'duration' ? Number(patch[key]) || task[key] : patch[key];
        }
        // prompt 不在这里改：它有专门的入口（会留档旧版本，并保证状态流转正确）
        if (Array.isArray(patch.refs)) {
          task.refs = patch.refs;
          changes.push(`参考素材 → ${patch.refs.length} 条`);
        }
        task.log = Array.isArray(task.log) ? task.log : [];
        task.log.push({ at: nowIso(), text: changes.length ? `任务信息已修改：${changes.join('；')}` : '任务信息已修改（无变化）' });
      });
      return { state: publicState() };
    })
  );

  routes.push(
    jsonRoute('/task/delete', (body) => {
      mutate((state) => {
        const task = findTask(state, body.id);
        // 进行中不能删：删了那一刻正在跑的操作就没了落点，回来的产物无处可写
        if (workingLocked(task)) {
          throw new Error(
            `任务正在「进行中·${OPS[task.op?.kind]?.label ?? '未知操作'}」，这期间不能删除；要删请先「取消当前操作」`
          );
        }
        state.tasks = state.tasks.filter((t) => t.id !== body.id);
      });
      return { state: publicState() };
    })
  );

  /**
   * 通用流转只保留「提交」这一个动作。
   *
   * 提交 = 发起「生成提示词」这一步操作（进行中·生成提示词，失败退回草稿）。
   * 生成 / 发布 / 审核都走各自的接口，免得有人拿这个口子把任务推到「进行中」却不带 op——
   * 那样既没有失败退路，又会被当成「操作进行中」锁住。
   */
  routes.push(
    jsonRoute('/task/transition', (body) => {
      mutate((state) => {
        const task = findTask(state, body.id);
        if (body.to !== 'working') {
          throw new Error(`不支持的流转目标「${body.to}」：提交请传 working，生成/发布/审核请用各自的接口`);
        }
        if (task.status !== 'draft') throw new Error(`只有「草稿」能提交，当前是「${STATUS[task.status]}」`);
        beginOp(state, task.id, 'prompt', 'draft', '已提交 → 进行中：生成提示词');
      });
      return { state: publicState() };
    })
  );

  /**
   * 审核：通过或驳回，记审核时间与意见。
   *
   * 脚本审核「通过」= 授权生成视频，所以它会**直接开始跑生成**（进行中·生成视频），
   * 失败就退回脚本审核——不能再停留在「进行中」。
   * 「审片驳回」退回脚本审核（提示词可改），而不是就地重生成，免得无条件再烧一次钱。
   */
  routes.push(
    jsonRoute('/task/review', async (body) => {
      const decision = body.decision === 'approve' ? 'approve' : 'reject';
      const stage = body.stage === 'script' ? 'script' : 'video';
      const shouldGenerate = mutate((state) => {
        const task = findTask(state, body.id);
        if (workingLocked(task)) {
          throw new Error(`任务正在「进行中·${OPS[task.op?.kind]?.label ?? '未知操作'}」，这期间不能审核`);
        }
        const at = nowIso();
        const record = { decision, note: String(body.note ?? ''), at };
        task.log = Array.isArray(task.log) ? task.log : [];
        if (stage === 'script') {
          task.scriptReview = record;
          if (decision === 'approve') {
            task.scriptApprovedAt = at;
            task.log.push({ at, text: '脚本审核通过' });
            beginOp(state, task.id, 'video', 'script_review', '脚本通过 → 进行中：生成视频');
            return true;
          }
          task.log.push({ at, text: `脚本被驳回：${record.note || '无意见'}` });
          beginOp(state, task.id, 'prompt', 'script_review', '脚本驳回 → 进行中：重新生成提示词');
          return false;
        }
        task.videoReview = record;
        if (decision === 'approve') {
          task.videoApprovedAt = at;
          task.log.push({ at, text: '审片通过' });
          moveTask(state, task.id, 'ready', '审片通过，等待发布');
        } else {
          task.log.push({ at, text: `审片驳回：${record.note || '无意见'}` });
          moveTask(state, task.id, 'script_review', '审片驳回，退回脚本审核（可改提示词后重新生成）');
        }
        return false;
      });

      if (!shouldGenerate) return { state: publicState(), generated: false };
      const gen = await startVideoGeneration(body.id, body.provider);
      return { ...gen, generated: true, state: publicState() };
    })
  );

  /** 设置/追加「生视频素材」（真正传给生成 AI 的画面参考）。 */
  routes.push(
    jsonRoute('/task/materials', (body) => {
      mutate((state) => {
        const task = findTask(state, body.id);
        if (workingLocked(task)) {
          throw new Error(
            `任务正在「进行中·${OPS[task.op?.kind]?.label ?? '未知操作'}」，这期间不能改素材；要改请先「取消当前操作」`
          );
        }
        const next = Array.isArray(body.genMaterials) ? body.genMaterials : [];
        const before = (task.genMaterials ?? []).length;
        task.genMaterials = next.filter((m) => m && String(m.value ?? '').trim() !== '');
        task.log = Array.isArray(task.log) ? task.log : [];
        task.log.push({
          at: nowIso(),
          text: before === task.genMaterials.length ? `生视频素材更新为 ${task.genMaterials.length} 条（内容有改动）` : `生视频素材 ${before} → ${task.genMaterials.length} 条`,
        });
      });
      return { state: publicState() };
    })
  );

  /**
   * 写提示词。
   *
   * 两条路径共用：
   *   1. agent 交作业——任务正处在「进行中·生成提示词」，写完这一步操作就算完成，落到脚本审核；
   *   2. 人工在脚本审核阶段原地改，状态不变。
   * 进行中跑的是别的操作（生成视频/发布）时，改提示词会被挡下——这就是「进行中不能改」。
   */
  routes.push(
    jsonRoute('/task/prompt', (body) => {
      mutate((state) => {
        const task = findTask(state, body.id);
        if (!canEditPrompt(task)) {
          throw new Error(
            workingLocked(task)
              ? `任务正在「进行中·${OPS[task.op?.kind]?.label ?? '未知操作'}」，这期间不能改提示词；要改请先「取消当前操作」`
              : `只有「脚本审核」或「进行中·生成提示词」的任务能改提示词，当前是「${STATUS[task.status]}」`
          );
        }
        const completing = task.status === 'working';
        applyPrompt(task, body.prompt);
        task.outputs = Array.isArray(body.outputs) ? body.outputs : task.outputs;
        if (completing) {
          finishOp(state, task.id, '提示词已生成，等待脚本审核');
        } else {
          moveTask(state, task.id, 'script_review', '提示词已更新，仍在脚本审核');
        }
      });
      return { state: publicState() };
    })
  );

  /**
   * 让 agent 重写提示词（脚本审核阶段的人工入口）。
   *
   * 插件自己不做文本优化：这里只负责把「这条任务 + 当前提示词 + 人工要求」交给一个
   * 新会话，由它加载 sd25-pe skill 按官方规范重写，再用 tiktok_ops_set_prompt 回写。
   */
  routes.push(
    jsonRoute('/task/optimize-prompt', async (body) => {
      const state = readState();
      const task = findTask(state, body.id);
      if (!canEditPrompt(task)) {
        throw new Error(
          workingLocked(task)
            ? `任务正在「进行中·${OPS[task.op?.kind]?.label ?? '未知操作'}」，这期间不能改提示词`
            : `只有「脚本审核」或「进行中·生成提示词」的任务能改提示词，当前是「${STATUS[task.status]}」`
        );
      }
      const hint = String(body.hint ?? '').trim();
      const sessionId = await dispatchAgent({
        title: `优化提示词：${task.topic.slice(0, 30)}`,
        prompt: optimizePromptPrompt(task, hint),
      });
      mutate((s) => {
        const t = findTask(s, body.id);
        t.dispatchedSessionId = sessionId;
        t.log = Array.isArray(t.log) ? t.log : [];
        t.log.push({ at: nowIso(), text: `已派 agent 优化提示词（会话 ${sessionId}）${hint ? `｜要求：${hint}` : ''}` });
      });
      return { sessionId, state: publicState() };
    })
  );

  /**
   * 继续一次**已被授权**的视频生成。
   *
   * 生成这一步的授权来自人工通过脚本审核（那条路会自己跑，见 /task/review）。
   * 这里只接受已经处于「进行中·生成视频」的任务——也就是说 agent 不能绕过脚本审核直接烧钱。
   */
  routes.push(
    jsonRoute('/task/generate', async (body) => {
      const { result, materialNotes, provider, task: updated } = await startVideoGeneration(body.id, body.provider);
      return { result, materialNotes, provider, task: updated, state: publicState() };
    })
  );

  /**
   * 取消「进行中」的那一步操作，退回它的来源状态。
   *
   * 为什么必须有：进行中禁止改/删，一旦操作卡死（agent 一直没来、生成超时、网络卡住），
   * 没有这个出口任务就成了既不能改也不能删的死局。插件没有后台 worker，也做不了自动超时。
   */
  routes.push(
    jsonRoute('/task/cancel', (body) => {
      const rolled = mutate((state) => failOp(state, body.id, String(body.reason ?? '').trim(), { cancelled: true }));
      return { task: rolled, state: publicState() };
    })
  );

  routes.push(
    jsonRoute('/task/publish', async (body) => {
      // 发布也是一步操作：先进「进行中·发布」，成功落「发布完成」，失败退回「待发布」
      mutate((state) => {
        const task = findTask(state, body.id);
        if (task.status !== 'ready') throw new Error(`只有「待发布」状态才能发布，当前是「${STATUS[task.status]}」`);
        const videoPath = task.outputs?.find((a) => a.kind === 'video')?.path;
        if (!videoPath) throw new Error('该任务还没有生成视频');
        beginOp(state, body.id, 'publish', 'ready', '开始发布 → 进行中：发布');
      });

      const state = readState();
      const task = findTask(state, body.id);
      const account = findAccount(state, task.accountId);
      try {
        const result = await tiktokPublish(state.settings, account, {
          videoPath: task.outputs?.find((a) => a.kind === 'video')?.path,
          caption: task.caption || task.topic,
        });
        const updated = mutate((s) => {
          const t = findTask(s, body.id);
          t.url = result.url;
          t.tiktokVideoId = (String(result.url).match(/\/video\/(\d+)/) ?? [])[1] ?? null;
          t.publishedAt = nowIso();
          finishOp(s, body.id, '已发布到 TikTok');
          return t;
        });
        return { task: updated, state: publicState() };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const rolled = mutate((s) => failOp(s, body.id, `发布失败：${reason}`));
        throw Object.assign(new Error(`发布失败，已退回「${STATUS[rolled.status]}」。${reason}`), { status: rolled.status });
      }
    })
  );

  // ---- 顾本素材库：素材选择器（生视频素材的来源） ----

  /** 「我的作品」列表。本地上传的素材也落在这里。 */
  routes.push(
    jsonRoute('/guben/works', async (body) => {
      const state = readState();
      return { list: await listGubenWorks(state.settings, body ?? {}) };
    })
  );

  /** 公共素材库列表。onlyDownloaded=true 时只给已经下载到本地的（生成时用 downloaded scope）。 */
  routes.push(
    jsonRoute('/guben/materials', async (body) => {
      const state = readState();
      return { list: await listGubenMaterials(state.settings, body ?? {}) };
    })
  );

  /**
   * 本地上传：直接把请求体当文件收下来，再进顾本「我的作品」。
   *
   * 不走 jsonRoute：视频动辄几十 MB，JSON 那条路有 2MB 上限。
   * 上传成功后返回的是**作品 id**，所以任务里存的一直是顾本 id，
   * 同时把本地路径也带上，详情页就能直接预览（/file 有素材白名单）。
   */
  routes.push({
    kind: 'exact',
    path: `${API_PREFIX}/material/upload`,
    handler: async (req, res) => {
      if (!isTrustedRequest(req)) return writeJson(res, 403, { ok: false, error: 'forbidden' });
      const method = (req.method ?? 'GET').toUpperCase();
      if (method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' });
      const query = new URL(req.url, 'http://127.0.0.1').searchParams;
      const rawName = query.get('filename') ?? 'upload.bin';
      const safeName = basename(rawName).replace(/[^\w.\-]+/g, '_').slice(-80) || 'upload.bin';
      const ext = extname(safeName).toLowerCase().replace('.', '');
      const mediaKind = ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext) ? 'image' : 'video';
      const dir = join(DATA_DIR, 'materials');
      const dest = join(dir, `upload-${Date.now()}-${safeName}`);
      try {
        const declared = Number(req.headers?.['content-length'] ?? 0);
        if (declared > MAX_UPLOAD_BYTES) {
          throw new Error(`文件 ${(declared / 1024 / 1024).toFixed(1)}MB 超过上限 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB`);
        }
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const bytes = await streamToFile(req, dest, MAX_UPLOAD_BYTES);
        if (bytes === 0) throw new Error('上传内容为空');

        const settings = readState().settings;
        const title = (query.get('title') || safeName).slice(0, 120);
        const { id } = await uploadLocalMaterial(settings, { sourcePath: dest, title });
        // 封面是异步生成的，刚上传时可能还没有；拿不到就让前端用本地文件预览
        const detail = await gubenApi(settings, `/works/${id}`).catch(() => null);
        const item = toPickerItem(detail ?? { id, title });
        return writeJson(res, 200, {
          ok: true,
          material: {
            kind: 'work',
            value: id,
            title,
            path: dest,
            mediaKind: item.type === 'image' || item.type === 'video' ? item.type : mediaKind,
            thumbUrl: item.thumbUrl,
            previewUrl: item.previewUrl,
            bytes,
          },
        });
      } catch (error) {
        try {
          if (existsSync(dest)) rmSync(dest, { force: true });
        } catch {}
        return writeJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    },
  });

  // ---- 数据与评论 ----
  routes.push(
    jsonRoute('/collect', async (body) => {
      const state = readState();
      const account = findAccount(state, body.accountId);
      const out = { metrics: null, comments: null, errors: [] };

      try {
        const data = await tiktokMetrics(state.settings, account);
        const published = state.tasks.filter((t) => t.status === 'published');
        const matched = matchMetricsToTasks(published, data.parsed ?? []);
        mutate((s) => {
          s.tasks = s.tasks.map((t) => {
            if (t.status !== 'published') return t;
            const row = matched.get(t.id);
            if (!row) return t;
            return {
              ...t,
              metrics: { views: row.views, likes: row.likes, comments: row.comments, shares: row.shares },
              metricsUpdatedAt: nowIso(),
              metricsRaw: data.rows ?? [],
            };
          });
          s.lastMetricsScreenshot = data.screenshot ?? null;
        });
        out.metrics = { matched: matched.size, screenshot: data.screenshot ?? null, unparsed: data.unparsed?.length ?? 0 };
      } catch (error) {
        out.errors.push(`数据采集：${error instanceof Error ? error.message : String(error)}`);
      }

      try {
        const data = await tiktokComments(state.settings, account);
        mutate((s) => {
          s.commentsRaw = data.text ?? '';
          s.commentsRows = data.rows ?? [];
          s.commentsScreenshot = data.screenshot ?? null;
          s.commentsUpdatedAt = nowIso();
        });
        out.comments = { rows: data.rows?.length ?? 0, screenshot: data.screenshot ?? null };
      } catch (error) {
        out.errors.push(`评论采集：${error instanceof Error ? error.message : String(error)}`);
      }

      const insights = mutate((s) => {
        s.insights = buildInsights(s.tasks);
        return s.insights;
      });
      out.insights = insights;
      return { result: out, state: publicState() };
    })
  );

  routes.push(
    jsonRoute('/insights', () => {
      const state = readState();
      const insights = buildInsights(state.tasks);
      mutate((s) => {
        s.insights = insights;
      });
      return { insights, state: publicState() };
    })
  );

  return routes;
}

// ------------------------------------------------------------------ 模型工具

async function registerTools(ctx) {
  let defineTool;
  try {
    ({ defineTool } = await import('@deepseek-ai/dsh-tools'));
  } catch {
    ctx.logger?.warn?.('tiktok-ops: 无法载入 @deepseek-ai/dsh-tools，跳过工具注册');
    return;
  }
  // DSH 的 schema 校验要求每个 object 显式声明 additionalProperties
  const withAdditional = (node) => {
    if (Array.isArray(node)) return node.map(withAdditional);
    if (node === null || typeof node !== 'object') return node;
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = withAdditional(v);
    if (out.type === 'object' && out.additionalProperties === undefined) out.additionalProperties = true;
    return out;
  };
  const textOut = (props) => ({
    schema: withAdditional({ type: 'object', properties: { ...props } }),
    render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  });

  /**
   * defineTool + schema 归一化。
   * 参数和输出里的每个 object（含数组元素）都必须显式声明 additionalProperties，
   * 漏一个 defineTool 就会抛 JsonSchemaError，整个工具注册全挂——所以统一在这里补。
   */
  const define = (spec) =>
    defineTool({
      ...spec,
      parameters: withAdditional(spec.parameters ?? {}),
      output: { ...spec.output, schema: withAdditional(spec.output.schema) },
    });

  /** 给 agent 看的任务摘要（不含大字段）。 */
  const brief = (t) => ({
    id: t.id,
    topic: t.topic,
    status: STATUS[t.status] ?? t.status,
    statusKey: t.status,
    // 进行中是过程状态，必须带上「在跑哪一步、失败了退回哪里」，否则调度方看不出它在忙什么
    currentOp: t.op ? { kind: t.op.kind, label: OPS[t.op.kind]?.label ?? t.op.kind, from: STATUS[t.op.from] ?? t.op.from, at: t.op.at } : null,
    duration: t.duration,
    aspect: ASPECT[t.aspect]?.label ?? t.aspect,
    market: MARKET[t.market]?.label ?? t.market ?? '欧美市场',
    provider: PROVIDERS[normalizeProvider(t.provider)].label,
    providerKey: normalizeProvider(t.provider),
    refs: t.refs,
    prompt: t.prompt || null,
    caption: t.caption || null,
    metrics: t.metrics,
    url: t.url ?? null,
    scriptReview: t.scriptReview,
    videoReview: t.videoReview,
    times: {
      提交: t.submittedAt,
      脚本审核: t.scriptApprovedAt,
      审片: t.videoApprovedAt,
      发布: t.publishedAt,
    },
  });

  const tools = [
    define({
      name: 'tiktok_ops_tasks',
      description:
        '查看 TikTok 运营助手的任务清单。用户提交的是「选题」任务（选题+参考素材+时长+比例），不是提示词。用 status 过滤出该干的活：working=进行中（该写提示词或生成视频）、ready=待发布。开始任何工作前先调这个。',
      parameters: {
        status: { type: 'string', description: '按状态过滤：draft/working/script_review/video_review/ready/published，不传返回全部' },
      },
      output: textOut({ tasks: { type: 'array', required: true }, counts: { type: 'object', required: true } }),
      async execute(args) {
        const state = readState();
        const counts = {};
        for (const t of state.tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;
        const list = (args.status ? state.tasks.filter((t) => t.status === args.status) : state.tasks).map(brief);
        return { tasks: list, counts };
      },
    }),
    define({
      name: 'tiktok_ops_create_task',
      description: '替用户创建一条视频任务。参数是选题方向而不是提示词；提示词由你后续生成。',
      parameters: {
        topic: { type: 'string', required: true, description: '选题 / 创作方向' },
        duration: { type: 'number', description: '视频时长（秒）' },
        aspect: { type: 'string', description: 'portrait=竖屏 / landscape=横屏 / square=方形' },
        market: { type: 'string', description: "目标市场：us-eu=欧美（默认） / cn=国内 / other=其它" },
        refs: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string' }, value: { type: 'string' }, note: { type: 'string' } } }, description: '参考素材列表（图片/视频/网页）' },
        provider: { type: 'string', description: '生视频走哪条路：guben=顾本素材库（默认） / minimax=MiniMax-H3' },
        caption: { type: 'string', description: '发布文案' },
      },
      output: textOut({ task: { type: 'object', required: true } }),
      async execute(args) {
        const task = mutate((state) => createTask({ ...args, submit: true }, state));
        return { task: brief(task) };
      },
    }),
    define({
      name: 'tiktok_ops_set_prompt',
      description:
        '给任务写入生成视频的提示词，并把状态推到「脚本审核」等用户确认。' +
        '任务已经在「脚本审核」时是原地更新提示词（人工在审核页点「让 agent 优化提示词」走的就是这条路径），不会跳步。' +
        '写之前必须先加载 `sd25-pe` skill（火山方舟官方 Seedance 2.5 提示词优化器），按它的模板产出结构化提示词，不要随手写一句。' +
        '提示词里不要写画幅比例、总时长、分辨率（由接口参数控制）。' +
        '默认面向欧美市场：台词与画面文字用英语，人物与场景用欧美语境，并明确写出「使用英语」；任务标了其它市场时才改。',
      parameters: {
        id: { type: 'string', required: true, description: '任务 id' },
        prompt: { type: 'string', required: true, description: '生成视频的提示词' },
      },
      output: textOut({ task: { type: 'object', required: true } }),
      async execute(args) {
        if (!String(args.prompt ?? '').trim()) throw new Error('提示词不能为空');
        const task = mutate((state) => {
          const t = findTask(state, args.id);
          if (!canEditPrompt(t)) {
            throw new Error(
              workingLocked(t)
                ? `任务正在「进行中·${OPS[t.op?.kind]?.label ?? '未知操作'}」，这期间不能改提示词`
                : `只有「脚本审核」或「进行中·生成提示词」的任务能改提示词，当前是「${STATUS[t.status]}」`
            );
          }
          const completing = t.status === 'working';
          applyPrompt(t, args.prompt);
          if (completing) finishOp(state, t.id, '提示词已生成，等待脚本审核');
          else moveTask(state, t.id, 'script_review', '提示词已更新，仍在脚本审核');
          return t;
        });
        return { task: brief(task) };
      },
    }),
    define({
      name: 'tiktok_ops_set_materials',
      description:
        '设置任务的「生视频素材」——真正传给生成 AI 的画面参考。注意它与「参考素材」是两个字段：' +
        '参考素材（refs）只是给你写提示词用的上下文，不会传给模型；只有这里的素材会影响画面。' +
        'kind 取值：guben=公共素材库 id（需已下载）、work=我的作品 id、image/video=本地绝对路径或图片/视频网址（会自动上传成作品）、url=网页（不能当画面素材）。',
      parameters: {
        id: { type: 'string', required: true, description: '任务 id' },
        materials: {
          type: 'array',
          items: { type: 'object', properties: { kind: { type: 'string' }, value: { type: 'string' }, note: { type: 'string' } } },
          description: '生视频素材列表',
        },
      },
      output: textOut({ task: { type: 'object', required: true } }),
      async execute(args) {
        const updated = mutate((state) => {
          const t = findTask(state, args.id);
          t.genMaterials = (args.materials ?? []).filter((m) => m && String(m.value ?? '').trim() !== '');
          t.log = Array.isArray(t.log) ? t.log : [];
          t.log.push({ at: nowIso(), text: `生视频素材更新为 ${t.genMaterials.length} 条` });
          return t;
        });
        return { task: brief(updated) };
      },
    }),
    define({
      name: 'tiktok_ops_guben_search',
      description:
        '搜索顾本公共素材库（只读、不扣积分）。用来给选题找参考画面，或找能当「生视频素材」的图片/视频。' +
        '返回素材 id、标题、类型、时长/尺寸、是否已下载到本地。' +
        '要真把文件拿到本地，再用 tiktok_ops_guben_download（那一步会扣积分）。',
      parameters: {
        search: { type: 'string', description: '关键词，例如「钻戒 特写」「电镀」' },
        type: { type: 'string', description: '限定类型：video / image / audio，不传则全部' },
        limit: { type: 'number', description: '返回条数，默认 12，最多 40' },
      },
      output: textOut({ total: { type: 'number', required: true }, items: { type: 'array', required: true } }),
      async execute(args) {
        const settings = readState().settings;
        const list = await listGubenMaterials(settings, {
          search: args.search,
          type: args.type,
          limit: Math.min(40, Math.max(1, Number(args.limit) || 12)),
        });
        return {
          total: list.total ?? 0,
          items: (list.items ?? []).map((i) => ({
            id: i.id,
            title: i.title,
            type: i.type,
            duration: i.duration,
            size: i.width && i.height ? `${i.width}x${i.height}` : null,
            downloaded: i.downloaded,
            price: i.price,
            thumbUrl: i.thumbUrl,
          })),
        };
      },
    }),
    define({
      name: 'tiktok_ops_guben_works',
      description:
        '查看顾本「我的作品」（只读、不扣积分）：不传 id 就列出作品，传 id 就返回单个作品的详情（含当初的提示词与引用素材）。' +
        '本地上传给插件当素材的文件也落在「我的作品」里；那里拿到的 id 可以直接当任务素材（kind=work），生成时不用再上传。',
      parameters: {
        id: { type: 'string', description: '作品 id；传了就返回这一个的详情' },
        search: { type: 'string', description: '按关键词过滤作品' },
        type: { type: 'string', description: '限定类型：video / image / audio' },
        limit: { type: 'number', description: '列表条数，默认 20，最多 60' },
      },
      output: textOut({ total: { type: 'number' }, items: { type: 'array' }, work: { type: 'object' } }),
      async execute(args) {
        const settings = readState().settings;
        const id = String(args.id ?? '').trim();
        if (id !== '') {
          const work = await gubenApi(settings, `/works/${encodeURIComponent(id)}`);
          return { work: toPickerItem(work), aiPrompt: work?.aiPrompt ?? null, aiRefs: work?.aiRefs ?? [] };
        }
        const list = await listGubenWorks(settings, {
          search: args.search,
          type: args.type,
          limit: Math.min(60, Math.max(1, Number(args.limit) || 20)),
        });
        return {
          total: list.total ?? 0,
          items: (list.items ?? []).map((i) => ({
            id: i.id,
            title: i.title,
            type: i.type,
            duration: i.duration,
            size: i.width && i.height ? `${i.width}x${i.height}` : null,
            thumbUrl: i.thumbUrl,
            createdAt: i.createdAt,
          })),
        };
      },
    }),
    define({
      name: 'tiktok_ops_guben_download',
      description:
        '把顾本素材下载到本地。⚠️ **public 素材会扣顾本积分**，只在确实要用时才调，别拿它试搜索。' +
        '「我的作品」的下载免费（scope=work）。' +
        '返回的本地绝对路径可以直接交给 tiktok_ops_set_materials（kind 用 image 或 video，value 填该路径）。',
      parameters: {
        ids: { type: 'array', items: { type: 'string' }, required: true, description: '要下载的素材 id，最多 10 个' },
        scope: { type: 'string', description: 'public=公共素材库（扣积分，默认）/ work=我的作品（免费）' },
      },
      output: textOut({ files: { type: 'array', required: true }, failed: { type: 'array', required: true } }),
      async execute(args) {
        const ids = (Array.isArray(args.ids) ? args.ids : []).map((v) => String(v ?? '').trim()).filter(Boolean);
        if (ids.length === 0) throw new Error('至少要给一个素材 id');
        if (ids.length > 10) throw new Error(`一次最多下载 10 个（收到 ${ids.length} 个）`);
        const settings = readState().settings;
        const kind = String(args.scope ?? '').trim() === 'work' ? 'work' : 'guben';
        const files = [];
        const failed = [];
        for (const id of ids) {
          try {
            files.push({ id, path: await downloadGubenMaterial(settings, kind, id) });
          } catch (error) {
            failed.push({ id, error: error instanceof Error ? error.message : String(error) });
          }
        }
        return { files, failed, scope: kind, charged: kind === 'guben' };
      },
    }),
    define({
      name: 'tiktok_ops_generate',
      description:
        '继续一次**已被授权**的视频生成（推到「视频审核」等人工审片）。' +
        '生成必须由人工通过脚本审核来授权：通过后任务会进入「进行中·生成视频」，那条路会自己跑完。' +
        '所以只有任务已经处于「进行中·生成视频」时这个工具才能调用——agent 不能绕过脚本审核直接花钱。' +
        '可以用 provider 参数覆盖生成通道：guben=顾本素材库、minimax=MiniMax-H3。' +
        '上游失败时任务会退回脚本审核并把原因写进流转记录，不会假装生成成功。',
      parameters: {
        id: { type: 'string', required: true, description: '任务 id' },
        provider: { type: 'string', description: '临时指定生成通道：guben=顾本素材库 / minimax=MiniMax-H3；不传则用任务上存的' },
      },
      output: textOut({ task: { type: 'object', required: true } }),
      async execute(args) {
        const { provider, task: updated } = await startVideoGeneration(args.id, args.provider);
        return { task: brief(updated), provider };
      },
    }),
    define({
      name: 'tiktok_ops_publish',
      description: '发布任务视频到它绑定的 TikTok 账号。只有「待发布」状态可发布，且必须已过审片。',
      parameters: { id: { type: 'string', required: true, description: '任务 id' } },
      output: textOut({ task: { type: 'object', required: true } }),
      async execute(args) {
        const state = readState();
        const task = findTask(state, args.id);
        if (task.status !== 'ready') throw new Error(`只有「待发布」才能发布，当前是「${STATUS[task.status]}」`);
        const videoPath = task.outputs?.find((a) => a.kind === 'video')?.path;
        if (!videoPath) throw new Error('该任务还没有生成视频');
        const account = findAccount(state, task.accountId);
        const result = await tiktokPublish(state.settings, account, { videoPath, caption: task.caption || task.topic });
        const updated = mutate((s) => {
          const t = findTask(s, args.id);
          t.url = result.url;
          t.tiktokVideoId = (String(result.url).match(/\/video\/(\d+)/) ?? [])[1] ?? null;
          moveTask(s, t.id, 'published', '已发布到 TikTok');
          t.publishedAt = nowIso();
          return t;
        });
        return { task: brief(updated) };
      },
    }),
    define({
      name: 'tiktok_ops_collect',
      description:
        '周期巡检：采集已发布视频的观看/点赞/评论/分享数据，抓取评论内容，并重算运营洞察。可配 DSH 任务看板的 cron 定时调用这一个工具。',
      parameters: {},
      output: textOut({ result: { type: 'object', required: true } }),
      async execute() {
        const state = readState();
        const account = findAccount(state, null);
        const out = { metrics: null, comments: null, errors: [] };
        try {
          const data = await tiktokMetrics(state.settings, account);
          const published = state.tasks.filter((t) => t.status === 'published');
          const matched = matchMetricsToTasks(published, data.parsed ?? []);
          mutate((s) => {
            s.tasks = s.tasks.map((t) => {
              if (t.status !== 'published') return t;
              const row = matched.get(t.id);
              if (!row) return t;
              return {
                ...t,
                metrics: { views: row.views, likes: row.likes, comments: row.comments, shares: row.shares },
                metricsUpdatedAt: nowIso(),
              };
            });
          });
          out.metrics = { matched: matched.size, screenshot: data.screenshot ?? null };
        } catch (error) {
          out.errors.push(String(error instanceof Error ? error.message : error));
        }
        try {
          const data = await tiktokComments(state.settings, account);
          mutate((s) => {
            s.commentsRaw = data.text ?? '';
            s.commentsRows = data.rows ?? [];
            s.commentsScreenshot = data.screenshot ?? null;
            s.commentsUpdatedAt = nowIso();
          });
          out.comments = { rows: data.rows?.length ?? 0, screenshot: data.screenshot ?? null };
        } catch (error) {
          out.errors.push(String(error instanceof Error ? error.message : error));
        }
        const insights = mutate((s) => {
          s.insights = buildInsights(s.tasks);
          return s.insights;
        });
        return { result: { ...out, insights } };
      },
    }),
    define({
      name: 'tiktok_ops_insights',
      description:
        '取运营洞察：各视频的观看/点赞/评论/分享汇总、互动率、按画面比例与时长分组的平均播放对比、头部作品。基于它给下一轮选题建议，让创作有数据支撑。',
      parameters: {},
      output: textOut({ insights: { type: 'object', required: true } }),
      async execute() {
        const state = readState();
        return { insights: buildInsights(state.tasks) };
      },
    }),
  ];

  const registered = [];
  const failed = [];
  for (const tool of tools) {
    try {
      ctx.tools.register(tool);
      registered.push(tool?.name);
    } catch (error) {
      failed.push(`${tool?.name ?? '?'}：${error instanceof Error ? error.message : error}`);
    }
  }
  if (failed.length > 0) {
    // 以前这里逐条 warn 之后就没了，信息淹没在噪音里；汇总一条才看得出严重程度
    ctx.logger?.warn?.(`tiktok-ops: ${failed.length}/${tools.length} 个模型工具注册失败：${failed.join('；')}`);
  }
  // 这条以前是**无条件**打印 `${tools.length}`，工具全丢时照样说「已注册 11 个」，
  // 直接把排查带偏（真实踩过：inject 漏了 'tools'，11 个全失败却报全成功）。
  ctx.logger?.info?.(`tiktok-ops: 已注册 ${registered.length}/${tools.length} 个模型工具`);
  if (registered.length === 0 && tools.length > 0) {
    ctx.logger?.warn?.(
      "tiktok-ops: 一个模型工具都没注册成功——多半是 'tools' 服务没声明进 inject（见 lib/index.js）"
    );
  }
}

// ------------------------------------------------------------------ 入口

/**
 * 进程级挂载去重：webServer.register 对重复 (kind, path) 抛错，
 * 所以插件一旦被挂载两次，第二次注册就会把整个插件搞崩。
 */
const MOUNTED_KEY = Symbol.for('dsh-tiktok-ops.mounted');

/** 使用说明的注入结果，供 /diag 报告（不然「有没有注入成功」无从观测）。 */
const guidanceState = { registered: false, reason: 'not-attempted' };

export async function apply(ctx) {
  const registry = globalThis;
  const mounted = (registry[MOUNTED_KEY] ??= new Set());
  if (mounted.has(API_PREFIX)) {
    ctx.logger?.warn?.('tiktok-ops: 已在本进程中挂载过，跳过重复挂载');
    return;
  }
  mounted.add(API_PREFIX);

  const disposers = [];
  try {
    for (const route of buildRoutes(ctx)) disposers.push(ctx.webServer.register(route));
  } catch (error) {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch {}
    }
    mounted.delete(API_PREFIX);
    throw error;
  }

  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch {}
    }
    mounted.delete(API_PREFIX);
  }, 'tiktok-ops: routes');

  // 注入给 agent 的说明。没有这段的话，agent 拿到任务只会随手写一句提示词，
  // 不会去用官方 sd25-pe skill，出来的片子质量差很多。
  //
  // 这里用 ctx.inject([...]) 而不是在 shim 里静态声明 inject：静态声明会被
  // ESM 模块缓存锁死（插件行重新挂载也不会重新 import 外层模块），而 ctx.inject
  // 是按运行时的服务可用性决定的——服务不在时插件照常挂载，只是跳过这段。
  // 先注册内联的 sd25-pe，再决定注入哪一版说明。
  // 顺序很重要：注册成功后它就在 skills 目录里了，探测自然命中，
  // 说明里那条「先加载 sd25-pe」也就有了着落，而不是指向一个不存在的东西。
  const vendoredSkillRegistered = registerVendoredSkill(ctx, disposers);
  guidanceState.vendoredSkill = vendoredSkillRegistered;

  const hasSd25Pe = vendoredSkillRegistered || (await detectSkill(ctx, 'sd25-pe'));
  guidanceState.sd25Pe = hasSd25Pe;

  const registerGuidance = (target) => {
    try {
      disposers.push(
        target.systemPrompt.section({ name: 'plugin:tiktok-ops', order: 220, text: buildPromptGuidance(hasSd25Pe) })
      );
      guidanceState.registered = true;
      guidanceState.reason = 'ok';
    } catch (error) {
      guidanceState.reason = String(error);
      ctx.logger?.warn?.(`tiktok-ops: 使用说明注入失败：${error}`);
    }
  };
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['systemPrompt'], registerGuidance);
      // 运行时取网关：这样才能主动建会话把任务推给 agent
      ctx.inject(['typertGateway'], (svc) => {
        agentRuntime.gateway = svc.typertGateway ?? null;
      });
      ctx.inject(['workspaceRegistry'], (svc) => {
        agentRuntime.workspaces = svc.workspaceRegistry ?? null;
      });
    } else {
      guidanceState.reason = 'ctx.inject 不可用';
    }
  } catch (error) {
    guidanceState.reason = String(error);
    ctx.logger?.warn?.(`tiktok-ops: 使用说明注入异常：${error}`);
  }

  await registerTools(ctx).catch((error) => {
    ctx.logger?.warn?.(`tiktok-ops: 工具注册异常：${error}`);
  });

  ctx.logger?.info?.(`tiktok-ops: mounted, data dir ${DATA_DIR}`);
}

export const internals = {
  run,
  readState,
  writeState,
  makeId,
  dshHome,
  DATA_DIR,
  API_PREFIX,
  PLUGIN_DIR,
  STATUS,
  ASPECT,
  MARKET,
  PROMPT_GUIDANCE,
  buildPromptGuidance,
  detectSkill,
  parseSkillFrontmatter,
  VENDORED_SD25_FILE,
  buildInsights,
  loginBlockRemaining,
  requireLogin,
  waitForSelector,
  resolveGenerationRefs,
  dispatchAgent,
  dispatchPrompt,
  optimizePromptPrompt,
  applyPrompt,

  gubenApi,
  listGubenWorks,
  listGubenMaterials,
  downloadGubenMaterial,
  probeGubenScript,
  validateGubenScript,
  effectiveGubenScript,
  VENDORED_GUBEN_SCRIPT,
  toPickerItem,
  uploadLocalMaterial,
  streamToFile,
  gubenListCache,
  MAX_UPLOAD_BYTES,
  agentRuntime,
  buildRefArgs,
  generationFailureReason,
  stringifyGenerationError,
  normalizeProvider,
  PROVIDERS,
  resolveMinimaxRefs,
  generateWithMinimax,
  minimaxReady,
  probeMinimaxAuth,
  applyLoginFailure,
  resetLoginCooldown,
  createTask,
  moveTask,
  beginOp,
  finishOp,
  failOp,
  OPS,
  workingLocked,
  canEditPrompt,
  startVideoGeneration,
  guben,
  tiktokLogin,
  tiktokPublish,
  tiktokMetrics,
  tiktokComments,
  captureDiagnostic,
  parseCompactNumber,
  parseStudioRow,
  parseStudioRows,
  matchMetricsToTasks,
};
