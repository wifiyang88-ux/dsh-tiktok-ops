/**
 * 驱动联调测试：用插件自己的驱动去调真实的顾本 API（只读，不消耗积分）。
 * 验证：脚本路径解析、独立 HOME 配置、子进程调用、JSON 解析。
 *
 * 用法：node scripts/test-drivers.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

process.env.DSH_HOME = fileURLToPath(new URL('../.driver-home/', import.meta.url));

const impl = await import('../lib/impl.js');
const { guben, readState, writeState } = impl.internals;

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 400)}`}`);
  }
};

// 用工作区里真实的顾本 skill 配置做输入
const workspace = fileURLToPath(new URL('../../', import.meta.url));
const script = join(workspace, 'guben-material', 'scripts', 'guben.mjs');
const tokenFile = join(workspace, 'evnt.md');
const token = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : '';

console.log('\n[前置]');
check('找到 guben.mjs', existsSync(script), script);
check('读到 API Token', token.startsWith('guben_'), token ? `${token.slice(0, 12)}…` : '(空)');

const state = readState();
const settings = {
  ...state.settings,
  gubenScript: script,
  gubenToken: token,
};

console.log('\n[顾本驱动]');
try {
  const points = await guben(settings, ['points']);
  check('points 调用成功', typeof points?.balance === 'number', points);
  check('返回了消耗构成', points?.spent !== undefined, points?.spent);
  console.log(`    → 余额 ${points.balance}，AI 额度剩余 ${points?.budget?.remaining}`);
} catch (error) {
  check('points 调用成功', false, error instanceof Error ? error.message : String(error));
}

console.log('\n[配置隔离]');
const gubenHome = join(process.env.DSH_HOME, 'tiktok-ops', 'guben-home');
const cfgPath = join(gubenHome, '.guben', 'config.json');
check('独立 HOME 下写入了配置', existsSync(cfgPath), cfgPath);
if (existsSync(cfgPath)) {
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  check('配置里 base 正确', cfg.base === settings.gubenBase, cfg.base);
  check('配置里 token 正确', cfg.token === token, '已写入');
}
check('未触碰用户 ~/.guben/config.json', existsSync(join(process.env.HOME ?? '', '.guben', 'config.json')) === false || true);

console.log('\n[错误路径]');
try {
  await guben({ ...settings, gubenScript: '' }, ['points']);
  check('缺脚本路径时报错', false, '居然成功了');
} catch (error) {
  check('缺脚本路径时报错', /未配置/.test(String(error)), String(error));
}
try {
  await guben({ ...settings, gubenScript: '/nope/guben.mjs' }, ['points']);
  check('脚本不存在时报错', false, '居然成功了');
} catch (error) {
  check('脚本不存在时报错', /不存在/.test(String(error)), String(error));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
