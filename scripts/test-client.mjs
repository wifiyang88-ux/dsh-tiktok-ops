#!/usr/bin/env node
/**
 * 客户端离线冒烟测试：不装 React、不开浏览器，把 lib/client.js 真跑一遍。
 *
 * 做法：手写一个最小 React（createElement / useState / useEffect / useSyncExternalStore），
 * 用它把组件函数调用成一棵元素树；断言分两类——
 *   1) 渲染内容：审核阶段该出现 / 不该出现哪些控件；
 *   2) 交互结果：点「保存提示词 / 让 agent 优化 / 加入任务」时，发出去的请求体对不对。
 *
 * 为什么值得写：客户端半只有真正重启 dsh web 才会加载，改坏了要到用户那里才发现。
 *
 * 用法：node scripts/test-client.mjs
 */
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------- 最小 React

const isFn = (v) => typeof v === 'function';
let hookStore = new Map(); // 组件路径 → hooks
let currentPath = '';
let pendingEffects = [];
let rerenderRequested = false;
// 每轮渲染记录遇到的函数组件类型引用，用来检测「组件被内联定义导致反复重挂载」——
// 那会让输入框每打一个字就丢焦点。
let typeLog = [];

const React = {
  createElement(type, props, ...children) {
    // 与 React 一致：多个子节点给数组，单个子节点直接给那个值
    const flat = children.length > 1 ? children : children[0];
    return { __el: true, type, props: { ...(props ?? {}), children: flat } };
  },
  useState(initial) {
    const entry = hookStore.get(currentPath) ?? { hooks: [], cursor: 0 };
    hookStore.set(currentPath, entry);
    const index = entry.cursor++;
    if (!(index in entry.hooks)) entry.hooks[index] = isFn(initial) ? initial() : initial;
    const set = (next) => {
      const value = isFn(next) ? next(entry.hooks[index]) : next;
      if (Object.is(value, entry.hooks[index])) return;
      entry.hooks[index] = value;
      rerenderRequested = true;
    };
    return [entry.hooks[index], set];
  },
  useEffect(create, deps) {
    const entry = hookStore.get(currentPath) ?? { hooks: [], cursor: 0 };
    hookStore.set(currentPath, entry);
    const index = entry.cursor++;
    const previous = entry.hooks[index];
    const same =
      Boolean(previous) &&
      Array.isArray(deps) &&
      Array.isArray(previous.deps) &&
      deps.length === previous.deps.length &&
      deps.every((d, i) => Object.is(d, previous.deps[i]));
    if (!same) {
      // 注意：不能在这里立刻执行 cleanup——真 React 只在依赖变化或卸载时清理，
      // 提前清掉会把 effect 里的 setTimeout 一起取消（素材列表就是这么丢的）。
      entry.hooks[index] = { deps, cleanup: undefined };
      pendingEffects.push({ entry, index, create, deps });
    }
  },
  useSyncExternalStore(subscribe, getSnapshot) {
    if (isFn(subscribe)) subscribe(() => {});
    return getSnapshot();
  },
};

globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      globalThis.__spec = spec;
    },
  },
};

await import(fileURLToPath(new URL('../lib/client.js', import.meta.url)));
const spec = globalThis.__spec;
if (!spec) throw new Error('client.js 没有调用 window.__ModuleLoader__.load');
const client = spec.factory((name) => {
  if (name === 'react') return React;
  throw new Error(`客户端不该 require(${name})`);
});
const { TaskDetailModal, TaskCard, MaterialPickerModal, MaterialRow, NewTaskModal, SettingsTab, parseRefs, materialKey } = client.internals;

// ---------------------------------------------------------------- 渲染器

/** 子节点可能是单个元素 / 元素数组 / 嵌套数组，统一拍平——漏拍平会丢整棵子树。 */
const asList = (value) => {
  if (value === null || value === undefined || value === false || value === true) return [];
  return Array.isArray(value) ? value.flatMap(asList) : [value];
};

/** 把元素树展开成可断言的形状；函数组件会被真的调用。 */
function render(node, path = 'root') {
  if (node === null || node === undefined || node === false || node === true) return null;
  if (Array.isArray(node)) {
    const list = node.map((child, i) => render(child, `${path}[${i}]`)).filter(Boolean);
    return list.length ? list : null;
  }
  if (typeof node === 'string' || typeof node === 'number') return { text: String(node), props: {}, children: [] };
  if (!node.__el) return null;

  const { type, props } = node;
  if (isFn(type)) {
    const name = type.name || 'anon';
    // 记下这一轮渲染里每个函数组件的**类型引用**。React 按引用做协调：
    // 引用变了就当成另一个组件，整棵子树卸载重建 —— 输入框会因此丢焦点。
    typeLog.push({ name, type });
    const childPath = `${path}>${name}`;
    const previous = currentPath;
    currentPath = childPath;
    let out;
    try {
      out = type(props);
    } finally {
      currentPath = previous;
    }
    const rendered = render(out, childPath);
    return rendered ? { ...rendered, component: name } : { text: '', props: {}, children: [], component: name };
  }
  return { text: '', props: props ?? {}, children: asList(render(props?.children, path)), tag: String(type) };
}

const textOf = (node) => (!node ? '' : [node.text, ...(node.children ?? []).map(textOf)].join(' '));

/** 深度优先找第一个满足条件的节点。 */
function find(node, predicate) {
  if (!node) return null;
  if (predicate(node)) return node;
  for (const child of node.children ?? []) {
    const hit = find(child, predicate);
    if (hit) return hit;
  }
  return null;
}

const findAll = (node, predicate, acc = []) => {
  if (!node) return acc;
  if (predicate(node)) acc.push(node);
  for (const child of node.children ?? []) findAll(child, predicate, acc);
  return acc;
};

/** 按可见文字找按钮 / 任意节点。 */
const findDeep = (tree, predicate) => findAll(tree, predicate).pop() ?? null;
const labelOf = (node) => textOf(node).trim();
const findButton = (tree, label) => find(tree, (n) => n.tag === 'button' && labelOf(n).includes(label));
const findTag = (tree, tag) => find(tree, (n) => n.tag === tag);
const findInput = (tree, predicate) => find(tree, (n) => n.tag === 'input' && predicate(n));

let rootElement = null;

const resetCursors = () => {
  for (const entry of hookStore.values()) entry.cursor = 0;
};

/** 跑一遍渲染 + 副作用 + 因 setState 触发的重渲染。 */
async function renderPass() {
  rerenderRequested = false;
  pendingEffects = [];
  typeLog = [];
  resetCursors();
  const tree = render(rootElement);
  for (const item of pendingEffects) {
    const previous = item.entry.hooks[item.index];
    if (isFn(previous?.cleanup)) previous.cleanup();
    const cleanup = item.create();
    item.entry.hooks[item.index] = { deps: item.deps, cleanup };
  }
  // 让 effect 里的 promise 回调（假的 fetch 等）有机会跑完
  await new Promise((resolve) => setTimeout(resolve, 0));
  return tree;
}

/** 挂载一个新实例。 */
async function mount(element) {
  hookStore = new Map();
  rootElement = element;
  let tree = await renderPass();
  let rounds = 0;
  while (rerenderRequested && rounds < 12) {
    rounds += 1;
    tree = await renderPass();
  }
  return tree;
}

/** 触发一次交互（调用事件处理），并把随之而来的重渲染跑完。 */
async function act(fn) {
  fn();
  let tree = await renderPass();
  let rounds = 0;
  while (rerenderRequested && rounds < 12) {
    rounds += 1;
    tree = await renderPass();
  }
  return tree;
}

// ---------------------------------------------------------------- 假宿主接口

const calls = [];
let routes = {};

globalThis.fetch = async (url, options = {}) => {
  const path = String(url).replace('/api/tiktok-ops', '');
  let body;
  if (options.body !== undefined) body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
  calls.push({ path, method: options.method ?? 'GET', body });
  const handler = routes[path.split('?')[0]];
  const payload = handler ? handler(body, path) : { ok: true, state: baseState() };
  return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
};

function baseState() {
  return {
    tasks: [],
    accounts: [{ id: 'acc_1', label: '运营号' }],
    settings: {},
    statusLabels: { draft: '草稿', working: '进行中', script_review: '脚本审核', video_review: '视频审核', ready: '待发布', published: '发布完成' },
    marketLabels: { 'us-eu': '欧美市场' },
  };
}

const taskBase = {
  id: 'task_demo',
  topic: '给妻子定制钻戒',
  refs: [],
  genMaterials: [],
  duration: 15,
  aspect: 'portrait',
  market: 'us-eu',
  caption: '',
  prompt: '原始提示词',
  promptHistory: [],
  outputs: [],
  log: [],
};

const run = async (_label, fn) => await fn();
const noop = () => {};
const detail = (patch) => ({
  task: { ...taskBase, ...patch },
  state: baseState(),
  run,
  busy: false,
  open: true,
  onClose: noop,
});

// ---------------------------------------------------------------- 断言

let pass = 0;
let fail = 0;
function check(name, condition, detailInfo) {
  if (condition) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detailInfo === undefined ? '' : ` — ${JSON.stringify(detailInfo).slice(0, 400)}`}`);
  }
}

// ---------------------------------------------------------------- 用例

console.log('\n[模块与导出]');
check('client.js 注册了 ModuleLoader bundle', spec.id === 'dsh-tiktok-ops', spec.id);
check('导出了 apply 与 inject', isFn(client.apply) && Array.isArray(client.inject), Object.keys(client));
check('导出了内部件供离线测试', isFn(TaskDetailModal) && isFn(MaterialPickerModal) && isFn(MaterialRow));
const refs = parseRefs('123\nhttps://a/b.jpg\nhttps://a/page');
check('parseRefs 仍按内容猜类型', refs[0].kind === 'guben' && refs[1].kind === 'image' && refs[2].kind === 'url', refs);
check('素材键区分来源', materialKey({ kind: 'work', value: '1' }) !== materialKey({ kind: 'guben', value: '1' }));

console.log('\n[详情弹窗：脚本审核 = 可改提示词 / 时长 / 素材]');
let tree = await mount(React.createElement(TaskDetailModal, detail({ status: 'script_review' })));
check('显示可编辑提示词框', Boolean(findTag(tree, 'textarea')));
check('提示词框带出当前提示词', findTag(tree, 'textarea')?.props?.value === '原始提示词', findTag(tree, 'textarea')?.props?.value);
check('有「保存提示词」按钮', Boolean(findButton(tree, '保存提示词')));
check('有「让 agent 优化提示词」按钮', Boolean(findButton(tree, '让 agent 优化提示词')));
check('有优化要求输入框', Boolean(findInput(tree, (n) => /优化要求/.test(String(n.props?.placeholder ?? '')))));
check('时长可编辑（有保存时长按钮）', Boolean(findButton(tree, '保存时长')));
check('时长输入框带出当前时长', findInput(tree, (n) => String(n.props?.value) === '15') !== null);
check('素材可以加（打开顾本选择器）', Boolean(findButton(tree, '从顾本素材库添加')));

// 关键字/输入框每打一个字都会触发一次重渲染。如果组件类型引用变了，React 会把整棵子树
// 卸载重建，输入框就会「打一个字光标被踢出去」——这里盯的就是这个。
const typesBefore = typeLog.slice();
const typedOnce = await act(() => findTag(tree, 'textarea').props.onChange({ target: { value: '原' } }));
check('输入一个字后重渲染成功', findTag(typedOnce, 'textarea')?.props?.value === '原', findTag(typedOnce, 'textarea')?.props?.value);
const typesAfter = typeLog.slice();
const sameComponentTypes =
  typesBefore.length === typesAfter.length && typesBefore.every((x, i) => x.name === typesAfter[i].name && x.type === typesAfter[i].type);
check(
  '重渲染时组件类型引用不变（否则输入框会丢焦点）',
  sameComponentTypes,
  { before: typesBefore.map((x) => x.name), after: typesAfter.map((x) => x.name) }
);
// 把两轮里同名组件的引用逐一对比，直接点出是谁被内联定义了
const unstable = typesBefore.filter((x, i) => typesAfter[i] && x.name === typesAfter[i].name && x.type !== typesAfter[i].type);
check('没有组件被内联定义（内联的那个就是丢焦点的元凶）', unstable.length === 0, unstable.map((x) => x.name));

console.log('\n[交互：改提示词 → 保存]');
calls.length = 0;
tree = await act(() => findTag(tree, 'textarea').props.onChange({ target: { value: '人工改过的提示词' } }));
tree = await act(() => findButton(tree, '保存提示词').props.onClick());
const savePromptCall = calls.find((c) => c.path === '/task/prompt');
check('保存提示词打到 /task/prompt', Boolean(savePromptCall), calls.map((c) => c.path));
check('保存的是编辑框里的内容', savePromptCall?.body?.prompt === '人工改过的提示词', savePromptCall?.body);
check('保存请求带上任务 id', savePromptCall?.body?.id === 'task_demo', savePromptCall?.body);

console.log('\n[交互：让 agent 优化 / 改时长]');
calls.length = 0;
tree = await mount(React.createElement(TaskDetailModal, detail({ status: 'script_review' })));
const hintInput = findInput(tree, (n) => /优化要求/.test(String(n.props?.placeholder ?? '')));
tree = await act(() => hintInput.props.onChange({ target: { value: '开头先给钻戒微距' } }));
tree = await act(() => findButton(tree, '让 agent 优化提示词').props.onClick());
const optimizeCall = calls.find((c) => c.path === '/task/optimize-prompt');
check('优化请求打到 /task/optimize-prompt', Boolean(optimizeCall), calls.map((c) => c.path));
check('优化请求带上人工要求', optimizeCall?.body?.hint === '开头先给钻戒微距', optimizeCall?.body);
check('优化请求带上任务 id', optimizeCall?.body?.id === 'task_demo', optimizeCall?.body);

calls.length = 0;
tree = await mount(React.createElement(TaskDetailModal, detail({ status: 'script_review' })));
const durationInput = findInput(tree, (n) => String(n.props?.value) === '15');
tree = await act(() => durationInput.props.onChange({ target: { value: '20' } }));
tree = await act(() => findButton(tree, '保存时长').props.onClick());
const durationCall = calls.find((c) => c.path === '/task/update');
check('改时长打到 /task/update', Boolean(durationCall), calls.map((c) => c.path));
check('时长转成数字提交', durationCall?.body?.patch?.duration === 20, durationCall?.body);

console.log('\n[交互：从顾本素材库挑素材]');
routes = {
  '/guben/works': () => ({
    ok: true,
    list: {
      total: 2,
      page: 1,
      pageSize: 24,
      items: [
        { id: '2622', title: '钻戒微距', type: 'video', duration: 15, thumbUrl: 'https://cdn/t1.jpg', downloaded: false },
        { id: '2609', title: '白金密镶戒指', type: 'image', thumbUrl: 'https://cdn/t2.jpg', downloaded: false },
      ],
    },
  }),
  '/guben/materials': () => ({
    ok: true,
    list: {
      total: 1,
      page: 1,
      pageSize: 24,
      note: '只列出已经下载到本地的公共素材（生成时用 downloaded scope，不额外扣积分）',
      items: [{ id: '2506', title: '执模镶嵌', type: 'video', thumbUrl: 'https://cdn/t3.jpg', downloaded: true }],
    },
  }),
  '/material/upload': () => ({ ok: true, material: { kind: 'work', value: '9001', title: '本地片头.mp4', path: '/tmp/x.mp4', mediaKind: 'video', thumbUrl: null } }),
};

let picked = null;
calls.length = 0;
let pickerTree = await mount(React.createElement(MaterialPickerModal, { open: true, onClose: noop, onConfirm: (p) => (picked = p) }));
const pickerText = textOf(pickerTree);
check('选择器有「我的作品」页签', pickerText.includes('我的作品'));
check('选择器有「公共素材（已下载）」页签', pickerText.includes('公共素材（已下载）'));
check('选择器有「本地上传」页签', pickerText.includes('本地上传'));
check('打开时按「我的作品」拉列表', calls.some((c) => c.path === '/guben/works'), calls.map((c) => c.path));
const worksCall = calls.find((c) => c.path === '/guben/works');
check('列表请求带分页参数', worksCall?.body?.limit === 24 && worksCall?.body?.page === 1, worksCall?.body);
check('缩略图渲染成 img', Boolean(find(pickerTree, (n) => n.tag === 'img' && n.props?.src === 'https://cdn/t1.jpg')));
check('卡片显示素材标题与 id', pickerText.includes('钻戒微距') && pickerText.includes('#2622'));
check('卡片显示类型与分辨率信息位', pickerText.includes('视频'));

// 用 findDeep：外层遮罩和弹窗容器也带 onClick，浅层匹配会点到「关闭」而不是卡片
const card = findDeep(pickerTree, (n) => isFn(n.props?.onClick) && textOf(n).includes('钻戒微距'));
pickerTree = await act(() => card.props.onClick());
check('点卡片后出现「已选」', textOf(pickerTree).includes('已选'), textOf(pickerTree).slice(0, 200));
const confirmBtn = findButton(pickerTree, '加入任务');
check('确认按钮带数量', textOf(confirmBtn ?? {}).includes('1'), textOf(confirmBtn ?? {}));
pickerTree = await act(() => confirmBtn.props.onClick());
check('确认回调给出「我的作品」素材', picked?.[0]?.kind === 'work' && picked[0].value === '2622', picked);
check('回调里带缩略图（详情页要用）', picked?.[0]?.thumbUrl === 'https://cdn/t1.jpg', picked?.[0]);

// 公共素材页签：生成时只能吃已下载的，所以这里必须只列已下载
calls.length = 0;
pickerTree = await mount(React.createElement(MaterialPickerModal, { open: true, onClose: noop, onConfirm: noop }));
pickerTree = await act(() => find(pickerTree, (n) => n.tag === 'button' && labelOf(n) === '公共素材（已下载）').props.onClick());
const matCall = calls.find((c) => c.path === '/guben/materials');
check('切到公共素材页签时请求只列已下载', matCall?.body?.onlyDownloaded === true, matCall?.body);
check('渲染出已下载素材', textOf(pickerTree).includes('执模镶嵌'), textOf(pickerTree).slice(0, 300));
check('已下载素材卡片可点（存成 guben 类型）', Boolean(findDeep(pickerTree, (n) => isFn(n.props?.onClick) && textOf(n).includes('执模镶嵌'))));

// 本地上传页签：选文件 → 先传顾本「我的作品」，再自动进已选
calls.length = 0;
pickerTree = await act(() => find(pickerTree, (n) => n.tag === 'button' && labelOf(n) === '本地上传').props.onClick());
const fileInput = findInput(pickerTree, (n) => n.props?.type === 'file');
check('本地上传页签有文件选择框', Boolean(fileInput));
pickerTree = await act(() => fileInput.props.onChange({ target: { files: [{ name: '本地片头.mp4', size: 2048, type: 'video/mp4' }], value: '' } }));
const uploadCall = calls.find((c) => c.path.startsWith('/material/upload'));
check('上传打到 /material/upload 并带文件名', Boolean(uploadCall) && uploadCall.path.includes('filename='), uploadCall?.path);
check('上传用 POST', uploadCall?.method === 'POST', uploadCall?.method);
check('上传结果直接进已选', textOf(pickerTree).includes('我的作品') && textOf(pickerTree).includes('9001'), textOf(pickerTree).slice(-260));

console.log('\n[详情弹窗：生视频素材的展示与移除]');
routes['/task/materials'] = (b) => ({ ok: true, state: { ...baseState(), tasks: [{ ...taskBase, genMaterials: b.genMaterials }] } });
calls.length = 0;
tree = await mount(
  React.createElement(
    TaskDetailModal,
    detail({ status: 'script_review', genMaterials: [{ kind: 'work', value: '9001', title: '本地片头.mp4', path: '/tmp/x.mp4', mediaKind: 'video' }] })
  )
);
check('素材行标题可见', textOf(tree).includes('本地片头.mp4'));
const videoEl = find(tree, (n) => n.tag === 'video');
check('本地 path 走 /file 预览', String(videoEl?.props?.src ?? '').includes('/file?path=%2Ftmp%2Fx.mp4'), videoEl?.props?.src);
tree = await act(() => find(tree, (n) => n.tag === 'span' && labelOf(n) === '移除').props.onClick());
const removeCall = calls.find((c) => c.path === '/task/materials');
check('移除素材打到 /task/materials', Boolean(removeCall), calls.map((c) => c.path));
check('移除后素材列表为空', Array.isArray(removeCall?.body?.genMaterials) && removeCall.body.genMaterials.length === 0, removeCall?.body);

console.log('\n[详情弹窗：其它状态下的读写权限]');
tree = await mount(React.createElement(TaskDetailModal, detail({ status: 'video_review' })));
check('视频审核阶段提示词只读', !findButton(tree, '保存提示词') && !findButton(tree, '让 agent 优化提示词'));
check('视频审核阶段仍显示提示词内容', textOf(tree).includes('原始提示词'));
check('视频审核阶段仍可改时长', Boolean(findButton(tree, '保存时长')));
check('视频审核阶段仍可换素材', Boolean(findButton(tree, '从顾本素材库添加')));

tree = await mount(React.createElement(TaskDetailModal, detail({ status: 'published' })));
check('发布完成后不再出现编辑入口', !findButton(tree, '保存提示词') && !findButton(tree, '保存时长') && !findButton(tree, '从顾本素材库添加'));

let nullError = null;
try {
  await mount(React.createElement(TaskDetailModal, { task: null, state: baseState(), run, busy: false, open: false, onClose: noop }));
} catch (error) {
  nullError = error;
}
check('task 为空时不抛错（hook 数量恒定）', nullError === null, String(nullError?.message));

console.log('\n[提示词历史版本]');
tree = await mount(
  React.createElement(TaskDetailModal, detail({ status: 'script_review', promptHistory: [{ at: '2026-09-21T11:00:00.000Z', prompt: '上一版提示词' }] }))
);
check('显示历史版本折叠区', textOf(tree).includes('历史版本（1）'), textOf(tree).slice(0, 200));
check('历史版本可回填', textOf(tree).includes('上一版提示词') && textOf(tree).includes('回填到编辑框'));
const backfill = find(tree, (n) => n.tag === 'span' && labelOf(n) === '回填到编辑框');
tree = await act(() => backfill.props.onClick());
check('回填后编辑框变成旧版本', findTag(tree, 'textarea')?.props?.value === '上一版提示词', findTag(tree, 'textarea')?.props?.value);

console.log('\n[素材行：缩略图与兜底]');
const rowRemote = await mount(
  React.createElement(MaterialRow, {
    item: { kind: 'guben', value: '2506', title: '执模镶嵌', mediaKind: 'video', previewUrl: 'https://cdn/p3.mp4', thumbUrl: 'https://cdn/t3.jpg' },
  })
);
const remoteVideo = find(rowRemote, (n) => n.tag === 'video');
check('视频素材用 previewUrl 播放', String(remoteVideo?.props?.src ?? '') === 'https://cdn/p3.mp4', remoteVideo?.props?.src);
check('缩略图当封面（poster）', String(remoteVideo?.props?.poster ?? '') === 'https://cdn/t3.jpg', remoteVideo?.props?.poster);
// 以前播放器写死 muted:true，导致 H3 生成的有声成片在详情页放着没声音（不是模型没生成音频）
check('视频默认不静音（否则有声音的成片也会被听成没声）', remoteVideo?.props?.muted === false, remoteVideo?.props?.muted);
check('静音可以显式打开', (await mount(React.createElement(MaterialRow, {
  muted: true,
  item: { kind: 'guben', value: '2506', mediaKind: 'video', previewUrl: 'https://cdn/p3.mp4' },
}))).children?.find?.((n) => n.tag === 'video')?.props?.muted !== false);
const outRow = await mount(React.createElement(MaterialRow, {
  size: 'full',
  item: { kind: 'video', value: '/tmp/output.mp4' },
}));
const outVideo = find(outRow, (n) => n.tag === 'video');
check('成片用大一点的播放器（竖屏才看得清）', Number(String(outVideo?.props?.style?.maxHeight ?? '0').replace('px', '')) >= 400, outVideo?.props?.style);
const rowCoverOnly = await mount(
  React.createElement(MaterialRow, { item: { kind: 'guben', value: '2507', mediaKind: 'video', thumbUrl: 'https://cdn/t4.jpg' } })
);
check('只有封面时退化成一张图，不硬塞给 video', Boolean(find(rowCoverOnly, (n) => n.tag === 'img' && n.props?.src === 'https://cdn/t4.jpg')) && !find(rowCoverOnly, (n) => n.tag === 'video'));
const rowImage = await mount(React.createElement(MaterialRow, { item: { kind: 'guben', value: '2609', mediaKind: 'image', thumbUrl: 'https://cdn/t2.jpg' } }));
check('图片素材渲染成 img', Boolean(find(rowImage, (n) => n.tag === 'img' && n.props?.src === 'https://cdn/t2.jpg')));
const rowPlain = await mount(React.createElement(MaterialRow, { item: { kind: 'guben', value: '1234' } }));
check('没有缩略图时不炸、也不给错地址', Boolean(textOf(rowPlain).includes('1234')) && !find(rowPlain, (n) => n.tag === 'img' || n.tag === 'video'));
const rows = findAll(rowPlain, (n) => n.tag === 'div');
check('素材行仍然完整渲染', rows.length > 0, rows.length);

console.log('\n[生成通道：顾本 / MiniMax H3]');
// 通道选择挂在「脚本审核」上：通过 = 授权生成，所以通道要在点「通过」之前选好
const genTree = await mount(React.createElement(TaskDetailModal, detail({ status: 'script_review' })));
check('详情页显示生视频通道', Boolean(find(genTree, (n) => n.tag === 'span' && labelOf(n).includes('生视频通道'))));
const providerSelect = find(genTree, (n) => n.tag === 'select' && n.props?.value === 'guben');
check('通道下拉默认选中顾本', Boolean(providerSelect), providerSelect?.props?.value);
check('通道下拉有 MiniMax 选项', findAll(genTree, (n) => n.tag === 'option').some((o) => labelOf(o).includes('MiniMax-H3')));

// 换成 MiniMax 后点「脚本通过并生成视频」，请求体里必须带上 provider
calls.length = 0;
const pickedTree = await act(() => providerSelect.props.onChange({ target: { value: 'minimax' } }));
const approveBtn = findButton(pickedTree, '脚本通过并生成视频');
check('脚本审核阶段给的是「通过并生成视频」', Boolean(approveBtn));
await act(() => approveBtn.props.onClick());
const genCall = calls.find((c) => c.path === '/task/review');
check('通过时带上 provider=minimax', genCall?.body?.provider === 'minimax' && genCall?.body?.decision === 'approve', genCall?.body);

// 任务上存的是 minimax 时，下拉要跟着显示 minimax
const mmTaskTree = await mount(React.createElement(TaskDetailModal, { ...detail({ status: 'script_review', provider: 'minimax' }), state: { ...baseState(), providerLabels: { guben: '顾本素材库', minimax: 'MiniMax-H3' }, settings: { minimaxModel: 'MiniMax-H3', minimaxResolution: '2K', minimaxToken: '***' } } }));
check('任务存 minimax 时下拉跟着走', Boolean(find(mmTaskTree, (n) => n.tag === 'select' && n.props?.value === 'minimax')));
check('详情页显示通道与规格', textOf(mmTaskTree).includes('MiniMax-H3') && textOf(mmTaskTree).includes('2K'));

console.log('\n[进行中：只读 + 取消逃生口]');
// 进行中是过程状态：不给改的入口，只给「取消当前操作」
const lockTree = await mount(React.createElement(TaskDetailModal, detail({ status: 'working', prompt: '已写好的提示词', op: { kind: 'video', from: 'script_review' } })));
check('进行中不提供「生成视频」（取消按钮里带这几个字不算）', findAll(lockTree, (n) => n.tag === 'button' && labelOf(n).trim() === '生成视频').length === 0);
check('进行中不提供「脚本通过」', !findButton(lockTree, '脚本通过'));
check('进行中说清楚在跑哪一步', textOf(lockTree).includes('生成视频'), textOf(lockTree).slice(0, 90));
const cancelBtn = findButton(lockTree, '取消当前操作');
check('进行中提供取消逃生口', Boolean(cancelBtn));
calls.length = 0;
await act(() => cancelBtn.props.onClick());
check('取消打到 /task/cancel', calls.some((c) => c.path === '/task/cancel'), calls.map((c) => c.path));
// 进行中不能删：卡片上的「删除」不再是可点入口
const lockCard = await mount(React.createElement(TaskCard, { task: { ...taskBase, status: 'working', op: { kind: 'video', from: 'script_review' } }, state: baseState(), run, busy: false, onOpen: noop }));
const del = findDeep(lockCard, (n) => labelOf(n) === '删除');
check('进行中的卡片不给可点的删除', Boolean(del) && typeof del.props?.onClick !== 'function', typeof del?.props?.onClick);

console.log('\n[设置页：MiniMax Token 与档位]');
const settingsTree = await mount(React.createElement(SettingsTab, { state: { ...baseState(), settings: { gubenToken: '', minimaxToken: '', minimaxModel: 'MiniMax-H3', minimaxResolution: '768P' } }, run, busy: false }));
check('设置页出现 MiniMax H3 一节', textOf(settingsTree).includes('MiniMax H3（视频生成）'));
const pwInputs = findAll(settingsTree, (n) => n.tag === 'input' && n.props?.type === 'password');
check('有 MiniMax Token 输入框（密码型）', pwInputs.length === 3, pwInputs.length); // 账号密码 + 顾本 Token + MiniMax Token
const modelSelect = find(settingsTree, (n) => n.tag === 'select' && n.props?.value === 'MiniMax-H3');
check('模型下拉默认 H3', Boolean(modelSelect));
const resSelect = find(settingsTree, (n) => n.tag === 'select' && n.props?.value === '768P');
check('分辨率下拉默认 768P', Boolean(resSelect));

// 保存 Token 时不能把打码值写回去。
// 注意：这一块必须在 mount(maxTree) 之前做完——mount 会重置 hook store 和当前根元素。
calls.length = 0;
const tokenInput = findInput(
  settingsTree,
  (n) => n.props?.type === 'password' && String(n.props?.placeholder ?? '').includes('MiniMax')
);
check('能定位到 MiniMax 的 Token 输入框（不是顾本那个）', tokenInput !== null);
// 拿重渲染后的新树：旧树上的按钮闭包还抓着没输入的旧 state
const typedTree = await act(() => tokenInput.props.onChange({ target: { value: 'sk-abc' } }));
const saveBtn = findDeep(typedTree, (n) => n.tag === 'button' && labelOf(n).includes('保存 Token'));
check('填了 Token 后保存按钮可用', saveBtn?.props?.disabled === false, saveBtn?.props?.disabled);
await act(() => saveBtn.props.onClick());
const saveCall = calls.find((c) => c.path === '/settings');
check('保存 MiniMax Token 打到 /settings', saveCall?.body?.settings?.minimaxToken === 'sk-abc', saveCall?.body);

// 选中 H3-Max 时分辨率选项不能出现 2K（文档：Max 不支持 2K）
const maxTree = await mount(React.createElement(SettingsTab, { state: { ...baseState(), settings: { minimaxToken: '', minimaxModel: 'MiniMax-H3-Max', minimaxResolution: '768P' } }, run, busy: false }));
const maxResOptions = findAll(maxTree, (n) => n.tag === 'option').map(labelOf);
check('H3-Max 不提供 2K 选项', !maxResOptions.includes('2K'), maxResOptions);

console.log('\n[设置页：顾本 CLI 路径覆盖]');
// 用户不用再单独装 guben-material：默认用插件内联的那份，想用自己更新的可以覆盖
const gubenTree = await mount(React.createElement(SettingsTab, { state: { ...baseState(), settings: { gubenToken: '', gubenScript: '' }, gubenScriptResolved: '/pkg/vendor/guben.mjs' }, run, busy: false }));
check('设置页有 CLI 路径覆盖项', textOf(gubenTree).includes('CLI 路径'));
check('显示当前生效的是内联副本', textOf(gubenTree).includes('/pkg/vendor/guben.mjs'), textOf(gubenTree).slice(0, 160));
check('没覆盖时「恢复内联副本」不可点', findDeep(gubenTree, (n) => n.tag === 'button' && labelOf(n).includes('恢复内联副本'))?.props?.disabled === true);
calls.length = 0;
const cliInput = findInput(gubenTree, (n) => /guben\.mjs|内联副本/.test(String(n.props?.placeholder ?? '')));
check('能定位到 CLI 路径输入框', cliInput !== null, cliInput?.props?.placeholder);
const cliTyped = await act(() => cliInput.props.onChange({ target: { value: '/opt/my/guben.mjs' } }));
await act(() => findDeep(cliTyped, (n) => n.tag === 'button' && labelOf(n).includes('保存 CLI 路径')).props.onClick());
const cliCall = calls.find((c) => c.path === '/settings');
check('保存 CLI 路径打到 /settings', cliCall?.body?.settings?.gubenScript === '/opt/my/guben.mjs', cliCall?.body);
// 已配置覆盖时按钮才可用，并且要能一键回到内联副本
const overridden = await mount(React.createElement(SettingsTab, { state: { ...baseState(), settings: { gubenToken: '', gubenScript: '/opt/my/guben.mjs' }, gubenScriptResolved: '/pkg/vendor/guben.mjs' }, run, busy: false }));
const restoreBtn = findDeep(overridden, (n) => n.tag === 'button' && labelOf(n).includes('恢复内联副本'));
check('配了覆盖后「恢复内联副本」可点', restoreBtn?.props?.disabled === false);
calls.length = 0;
await act(() => restoreBtn.props.onClick());
check('恢复内联副本会清空覆盖', calls.find((c) => c.path === '/settings')?.body?.settings?.gubenScript === '', calls.find((c) => c.path === '/settings')?.body);

console.log('\n[设置页：平台域名与连接自检]');
// mount 会重置 hook store，所以这里重新挂一个干净的实例再交互
const probeTree = await mount(React.createElement(SettingsTab, { state: { ...baseState(), settings: { gubenToken: '', minimaxToken: '***', minimaxModel: 'MiniMax-H3', minimaxResolution: '768P', minimaxBase: 'https://api.minimax.cn' } }, run, busy: false }));
// 国内 / 国际两套平台的 Key 不通用，域名必须能在界面上切
check('设置页能切 MiniMax 平台域名', Boolean(find(probeTree, (n) => n.tag === 'select' && n.props?.value === 'https://api.minimax.cn')));
const baseOptions = findAll(probeTree, (n) => n.tag === 'option').map(labelOf);
check('两个平台的域名都在选项里', baseOptions.some((o) => o.includes('api.minimax.cn')) && baseOptions.some((o) => o.includes('api.minimax.io')), baseOptions);

// 点「测试连接」应当打到 /minimax/test（走只读查询接口，不建任务、不花钱）
calls.length = 0;
routes['/minimax/test'] = () => ({ ok: true, probe: { ok: false, httpStatus: 401, message: 'login fail (1004)', hint: '域名可能选错了' } });
const testBtn = findDeep(probeTree, (n) => n.tag === 'button' && labelOf(n).includes('测试连接'));
check('有「测试连接」按钮', Boolean(testBtn));
const testedTree = await act(() => testBtn.props.onClick());
check('测试连接打到 /minimax/test', calls.some((c) => c.path === '/minimax/test'), calls.map((c) => c.path));
check('失败时把原因与提示显示出来', textOf(testedTree).includes('login fail') && textOf(testedTree).includes('域名可能选错了'), textOf(testedTree).slice(0, 140));
delete routes['/minimax/test'];

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
