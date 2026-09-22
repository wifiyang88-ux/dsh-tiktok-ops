#!/usr/bin/env node
/**
 * 安装 + 运行时一键验证。
 *
 * 分三段：
 *   A. 静态安装状态（profile 软链、补丁行、依赖、配置、组合结果）
 *   B. 运行时状态（宿主的 /ping、/diag、客户端半是否登记）
 *   C. 可选：用 agent-browser 打开 GUI 并截图（需要带 token 的地址）
 *
 * 用法：
 *   node scripts/verify-install.mjs                 # A + B
 *   node scripts/verify-install.mjs --url "<带token的GUI地址>"   # A + B + C
 *
 * 退出码 0 表示全部通过。
 */
import { existsSync, readlinkSync, readFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_DIR = fileURLToPath(new URL('../', import.meta.url));
const WORKSPACE = join(PLUGIN_DIR, '..');
const PKG = 'dsh-tiktok-ops';
/** 去掉尾部路径分隔符，避免软链比较被 fileURLToPath 的尾斜杠误伤。 */
const trimSlash = (p) => String(p).replace(/[/\\]+$/, '');
const PROFILE_NAME = 'web';
const DSH_HOME_DIR = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const PROFILE = join(DSH_HOME_DIR, 'profiles', PROFILE_NAME);
const PATCH = join(PROFILE, 'cordis.patch.yml');
const NM = join(PROFILE, 'node_modules');
const PORT = Number(process.env.DSH_WEB_PORT ?? 3080);
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? `  ${detail}` : ''}`);
  }
};

// ---------------------------------------------------------------- A. 静态

console.log('\nA. 静态安装状态');
const link = join(NM, PKG);
check('profile 里有软链', existsSync(link), link);
if (existsSync(link)) {
  const target = readlinkSync(link);
  check('软链指向本插件', trimSlash(target) === trimSlash(PLUGIN_DIR), target);
}
check('插件入口存在', existsSync(join(PLUGIN_DIR, 'lib/index.js')));
check('客户端入口存在', existsSync(join(PLUGIN_DIR, 'lib/client.js')));
check('自带 agent-browser', existsSync(join(PLUGIN_DIR, 'node_modules/.bin/agent-browser')));
check('dsh-tools 依赖可解析', existsSync(join(PLUGIN_DIR, 'node_modules/@deepseek-ai/dsh-tools')));
check('配置已预置', existsSync(join(DSH_HOME_DIR, 'tiktok-ops/state.json')));

let patchText = '';
try {
  patchText = readFileSync(PATCH, 'utf8');
} catch {}
check('补丁行已写入', patchText.includes(`name: '${PKG}'`));

try {
  const dshBin = process.env.DSH_BIN ?? 'dsh';
  const dumped = execFileSync(dshBin, ['--profile', PROFILE_NAME, '--dump-config'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  check('profile 组合里含本插件', dumped.includes(PKG));
} catch (error) {
  check('profile 组合里含本插件', false, `dump-config 失败：${error.message.slice(0, 120)}`);
}

// ---------------------------------------------------------------- B. 运行时

console.log(`\nB. 运行时状态（${BASE}）`);
async function getJson(path) {
  const res = await fetch(BASE + path, { signal: AbortSignal.timeout(8000) });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { __raw: text.slice(0, 200), __status: res.status };
  }
}

let ping = null;
try {
  ping = await getJson('/api/tiktok-ops/ping');
} catch (error) {
  check('宿主接口可达', false, error.message);
}
if (ping) {
  check('宿主接口可达', ping.ok === true, JSON.stringify(ping).slice(0, 160));
  if (ping.pluginDir) {
    const decoded = !ping.pluginDir.includes('%');
    check('pluginDir 已正确解码（无百分号编码）', decoded, ping.pluginDir);
  }
}

if (ping) {
  try {
    const diag = await getJson('/api/tiktok-ops/diag');
    const clientModules = diag.clientModules ?? {};
    const isNewCode = 'mine' in clientModules;
    check('宿主跑的是最新代码', isNewCode, isNewCode ? '' : '「diag 结构是旧的」= 运行中的是陈旧/泄漏实例');
    if (isNewCode) {
      const mine = clientModules.mine ?? [];
      check('客户端半已登记', mine.length > 0, JSON.stringify(mine).slice(0, 160));
      // 宿主可能用单数 clientPath，也可能给一张 clientPaths 表，两种都认
      const bundlePath = clientModules.clientPath ?? clientModules.clientPaths?.[PKG] ?? null;
      check('客户端 bundle 路径可解析', Boolean(bundlePath) && existsSync(bundlePath), String(bundlePath ?? ''));
    }
  } catch (error) {
    check('诊断接口可用', false, error.message);
  }
}

// ---------------------------------------------------------------- C. 可选 UI

const urlFlag = process.argv.indexOf('--url');
if (urlFlag >= 0 && process.argv[urlFlag + 1]) {
  const url = process.argv[urlFlag + 1];
  console.log('\nC. 打开 GUI 截图');
  const ab = process.env.AGENT_BROWSER_BIN ?? join(PLUGIN_DIR, 'node_modules/.bin/agent-browser');
  const outDir = join(DSH_HOME_DIR, 'tiktok-ops', 'diagnostics');
  mkdirSync(outDir, { recursive: true });
  const shot = join(outDir, 'verify-gui.png');
  try {
    execFileSync(ab, ['--session', 'tkflow-verify', 'open', url], { stdio: 'ignore', timeout: 180000 });
    execFileSync(ab, ['--session', 'tkflow-verify', 'screenshot', shot], { stdio: 'ignore', timeout: 120000 });
    check('已截图（页面上手动点到「设置 → TikTok 全流程」确认落地页）', existsSync(shot), shot);
    execFileSync(ab, ['--session', 'tkflow-verify', 'close'], { stdio: 'ignore', timeout: 60000 });
  } catch (error) {
    check('GUI 截图', false, error.message.slice(0, 160));
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) {
  console.log('\n如果 B 段报「宿主跑的是最新代码」失败：说明运行中的 dsh web 还是重启前的进程，');
  console.log('需要在启动它的终端里 Ctrl+C 后重新启动（监督器不会自动拉起正常退出的进程）。\n');
}
process.exit(fail === 0 ? 0 : 1);
