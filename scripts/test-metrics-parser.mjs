/**
 * 创作中心「内容」列表解析测试。
 *
 * 关键点：下面 fixtures 里的字符串不是编的，是我在本机把两个作品发布到 TikTok 后，
 * 从 https://www.tiktok.com/tiktokstudio/content 真实抓下来的 innerText。
 * 解析器就是照着这些真实形状写的。
 *
 * 用法：node scripts/test-metrics-parser.mjs
 */
import { fileURLToPath } from 'node:url';

process.env.DSH_HOME = fileURLToPath(new URL('../.parser-home/', import.meta.url));
const impl = await import('../lib/impl.js');
const { parseCompactNumber, parseStudioRow, parseStudioRows, matchMetricsToTasks } = impl.internals;

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 300)}`}`);
  }
};

// ---- 真实抓取到的行（两个已发布作品） --------------------------------------
const REAL_ROWS = [
  '00:15 From raw metal to a set stone — grinding, polishing and hand-setting every detail. 💎 #jewelry #handmade #jewelrymaking #diamond #fyp 9月21日 12:27 所有人 0 0 0',
  '00:21 Timeless pieces for every day. ✨ #jewelry #gold #necklace #fyp 9月21日 12:03 所有人 0 0 0',
];

// 审查期间抓到的那一行（状态位是「内容审查中」，可见范围是「仅自己」）
const REVIEW_ROW =
  '00:15 From raw metal to a set stone — grinding, polishing and hand-setting every detail. 💎 #jewelry #handmade #jewelrymaking #diamond #fyp 内容审查中 仅自己 0 0 0';

console.log('\n[紧凑数字]');
check('纯数字', parseCompactNumber('0') === 0, parseCompactNumber('0'));
check('千分位', parseCompactNumber('1,234') === 1234, parseCompactNumber('1,234'));
check('万', parseCompactNumber('1.2万') === 12000, parseCompactNumber('1.2万'));
check('亿', parseCompactNumber('1.5亿') === 1.5e8, parseCompactNumber('1.5亿'));
check('K/M', parseCompactNumber('12.3K') === 12300 && parseCompactNumber('2M') === 2e6, [
  parseCompactNumber('12.3K'),
  parseCompactNumber('2M'),
]);
check('空值返回 null', parseCompactNumber('') === null && parseCompactNumber(null) === null, parseCompactNumber(''));
check('垃圾输入返回 null', parseCompactNumber('abc') === null, parseCompactNumber('abc'));

console.log('\n[单行解析 — 真实数据]');
const first = parseStudioRow(REAL_ROWS[0]);
check('解析成功', first !== null, first);
check('时长', first?.duration === '00:15', first?.duration);
check('描述完整', first?.caption === 'From raw metal to a set stone — grinding, polishing and hand-setting every detail. 💎 #jewelry #handmade #jewelrymaking #diamond #fyp', first?.caption);
check('发布时间', first?.publishedAt === '9月21日 12:27', first?.publishedAt);
check('状态为已发布', first?.status === 'published', first?.status);
check('可见范围', first?.privacy === '所有人', first?.privacy);
check('指标为 0', first?.views === 0 && first?.likes === 0 && first?.comments === 0, first);

const second = parseStudioRow(REAL_ROWS[1]);
check('第二条也能解析', second?.duration === '00:21' && second?.privacy === '所有人', second);
check('第二条描述正确', second?.caption === 'Timeless pieces for every day. ✨ #jewelry #gold #necklace #fyp', second?.caption);

console.log('\n[单行解析 — 审查中]');
const review = parseStudioRow(REVIEW_ROW);
check('审查中的行可解析', review !== null, review);
check('状态是审查中而不是时间', review?.status === '内容审查中' && review?.publishedAt === null, review);
check('此时可见范围是仅自己', review?.privacy === '仅自己', review?.privacy);

console.log('\n[分享列：开了才有，没开不能瞎猜]');
const threeCols = parseStudioRow('00:15 描述文字 9月21日 12:27 所有人 1,234 88 12');
check('只有三列时 shares 为 null', threeCols?.shares === null, threeCols);
check('三列时列数为 3', threeCols?.columnCount === 3, threeCols?.columnCount);
check('三列时前三项仍正确', threeCols?.views === 1234 && threeCols?.likes === 88 && threeCols?.comments === 12, threeCols);

const fourCols = parseStudioRow('00:15 描述文字 9月21日 12:27 所有人 1,234 88 12 7');
check('四列时能解析出分享', fourCols?.shares === 7, fourCols);
check('四列时列数为 4', fourCols?.columnCount === 4, fourCols?.columnCount);

// 分享数带单位
const shareUnit = parseStudioRow('00:15 描述文字 9月21日 12:27 所有人 12万 3000 210 1.5万');
check('分享支持万单位', shareUnit?.shares === 15000 && shareUnit?.views === 120000, shareUnit);

console.log('\n[批量解析与兜底]');
const batch = parseStudioRows([...REAL_ROWS, '这一行是表头或分隔符', '']);
check('解析出 2 条', batch.parsed.length === 2, batch.parsed.length);
check('无法解析的进 unparsed', batch.unparsed.length === 2, batch.unparsed);
check('空数组安全', parseStudioRows(undefined).parsed.length === 0, parseStudioRows(undefined));
check('非数组安全', parseStudioRows('nope').parsed.length === 0, parseStudioRows('nope'));

console.log('\n[指标挂到作品]');
const posts = [
  { id: 'p1', caption: 'Timeless pieces for every day. ✨ #jewelry #gold #necklace #fyp' },
  { id: 'p2', caption: 'From raw metal to a set stone — grinding, polishing and hand-setting every detail. 💎 #jewelry #handmade #jewelrymaking #diamond #fyp' },
];
const matched = matchMetricsToTasks(posts, batch.parsed);
check('按描述而非顺序匹配 p1', matched.get('p1')?.duration === '00:21', matched.get('p1'));
check('按描述而非顺序匹配 p2', matched.get('p2')?.duration === '00:15', matched.get('p2'));

const partial = matchMetricsToTasks(
  [{ id: 'x1', caption: '完全对不上的描述' }, { id: 'x2', caption: 'Timeless pieces for every day. ✨ #jewelry #gold #necklace #fyp' }],
  batch.parsed
);
check('对不上时退化为按序对位，不会丢', partial.get('x1') !== null && partial.get('x2') !== null, [...partial.entries()]);
check('没有作品时返回空表', matchMetricsToTasks([], batch.parsed).size === 0);

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
