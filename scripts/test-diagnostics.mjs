/**
 * 诊断留证测试：DOM 采集失败时，必须留下一张现场截图，并把路径写进错误信息。
 *
 * 用一个未登录的会话去跑「回复评论」——它一定会失败（找不到评论入口），
 * 正好用来验证失败路径不会变成黑盒。
 *
 * 用法：node scripts/test-diagnostics.mjs
 */
import { fileURLToPath } from 'node:url';
import { existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const HOME = fileURLToPath(new URL('../.diag-home/', import.meta.url));
process.env.DSH_HOME = HOME;
rmSync(HOME, { recursive: true, force: true });

const impl = await import('../lib/impl.js');
const { tiktokReply, readState } = impl.internals;

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

const settings = readState().settings;
// 未登录的账号：走一遍真实浏览器流程，必然失败
const account = { id: 'diagtest', username: 'nobody', password: '' };

console.log('\n[失败路径留证]');
let error = null;
try {
  await tiktokReply(settings, account, { commentText: '一条根本不存在的评论', replyText: '测试回复' });
} catch (e) {
  error = e;
}

check('确实失败了（未登录会话找不到评论入口）', error !== null, error ? null : '居然成功了');
const message = error instanceof Error ? error.message : String(error);
check('错误信息说明了卡在哪一步', /无法定位|找不到|no-|not-found/.test(message), message);
check('错误信息里带上了截图路径', /现场截图：/.test(message), message);

const match = message.match(/现场截图：(.+?)[）)]?\s*$/);
const shot = match ? match[1].trim() : null;
check('截图路径可解析', shot !== null && shot.endsWith('.png'), shot);

const dir = join(HOME, 'tiktok-ops', 'diagnostics');
check('diagnostics 目录已创建', existsSync(dir), dir);
if (shot) {
  check('截图文件真的落盘了', existsSync(shot), shot);
  check('截图不是空文件', existsSync(shot) && statSync(shot).size > 1000, existsSync(shot) ? statSync(shot).size : 0);
}

const files = existsSync(dir) ? (await import('node:fs')).readdirSync(dir) : [];
console.log(`    → 诊断目录现有 ${files.length} 个文件：${files.join(', ')}`);

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
rmSync(HOME, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
