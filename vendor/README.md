# vendor/ —— 内联的第三方 CLI

## guben.mjs

| | |
|---|---|
| 来源 | `guben-material/scripts/guben.mjs`（顾本素材网 Agent CLI） |
| 内联日期 | 2026-09-22 |
| sha256 | `4fb96f05cdfad524a2fba27129707e36717f274edc60b4ac8ba9fd33ef03d4bd` |
| 体积 | 21 KB，**零 npm 依赖**（只 import `node:fs` / `os` / `path` / `stream`） |

### 为什么内联

插件原本靠 `probeGubenScript()` 去**插件同级目录**找 `../guben-material/scripts/guben.mjs`。
开发机上同级目录存在所以能跑，但用户从 npm 装进 `node_modules/` 之后同级什么都没有，
而 `gubenScript` 又不能在设置里手填 —— 结果就是「顾本通道对新用户完全不可用」。

内联之后开箱可用；同时 `gubenScript` 已经开放成设置项，想用自己那份更新的 CLI 可以覆盖。

### ⚠️ 绝对不要内联 config.json

`guben-material/scripts/config.json` 里存着**真实 API Token**。CLI 的配置查找顺序是
`$HOME/.guben/config.json` → `__dirname/config.json`，所以只要 `vendor/config.json` 不存在，
它就只会读插件自己写的那份（`$DSH_HOME/tiktok-ops/guben-home/.guben/config.json`，0600）。

**更新这份内联副本时，只拷 `guben.mjs`，别用 `cp -r`。**

### 怎么更新

```sh
cp guben-material/scripts/guben.mjs dsh-tiktok-ops/vendor/guben.mjs
shasum -a 256 dsh-tiktok-ops/vendor/guben.mjs   # 更新下面表格里的 sha256
```

`npm run test:host` 里有一条断言会比对内联副本与同级源文件（同级不存在时自动跳过），
所以在这个 workspace 里改了源文件却忘了同步，测试会直接报出来。

### 授权

`guben.mjs` 是自有代码，版权归本项目所有，随仓库根目录的 `LICENSE`（MIT）一起分发。

> `guben-material/` 源目录本身仍然没有 LICENSE 文件。如果以后要单独分发那个 skill，
> 记得也给它补一份。本仓库只内联了 `guben.mjs` 这一个文件。

---

## sd25-pe/SKILL.md —— ⚠️ 第三方内容，授权未明确

| | |
|---|---|
| 来源 | 火山方舟官方 skill，`https://arkdocs.tos-cn-beijing.volces.com/skills/` |
| 安装方式（官方给） | `npx --yes skills@latest add "https://arkdocs.tos-cn-beijing.volces.com/skills/" --skill sd25-pe --yes` |
| frontmatter | `name: sd25-pe`、`skill_version: 0.1.1`、**`owner: seedance`** |
| 体积 | 69,727 字节（约 26,629 字符，996 行） |
| sha256 | `ee04557ba9a1c9f5517b574e24fc73d0022b22254373074db4c11f3d0635ea57` |
| 内联日期 | 2026-09-22 |

### 为什么内联

`sd25-pe` 原本是 **workspace 级** skill（`.agents/skills/sd25-pe/`）。开发机上有，
但从 git 装进来的插件在别人机器上根本没有它 —— 于是注入给 agent 的说明会要求
「先加载 sd25-pe」，而那个东西并不存在：agent 要么卡住、要么跳过，
「不要凭感觉写一句话就提交」这条约束也跟着落空。

内联之后由 `registerVendoredSkill()` 通过 `ctx.skills.register()` 注册为**运行时 skill**。
选它而不是塞进系统提示，是因为 skill 是**渐进披露**的：提示里只出现名字与描述，
26 K 字符的正文按需加载，不会撑爆上下文。

### ⚠️ 授权状态：未经授权再分发

**这份文件不是本项目的代码，全文没有任何 license 或 copyright 声明。**
`owner: seedance` 表明它属于火山方舟（字节跳动）的 Seedance 团队。

本仓库是**公开**仓库，因此内联它等于向公众再分发第三方内容。经项目所有者确认
**接受这一风险**后保留在此；法律上「没有 license」默认是保留所有权利，
所以：

- 对外分发本仓库前，或收到任何权利方异议时，**优先移除 `vendor/sd25-pe/` 并改用
  `docs/TEAM-INSTALL.md` 里记录的官方安装命令**（那才是官方分发渠道）。
- 移除后功能不会崩：`registerVendoredSkill()` 会因为文件不存在而跳过，
  说明文本会自动退回「不点名 sd25-pe」的自包含版本（`buildPromptGuidance(false)`），
  硬要求仍然全部保留。

### 怎么更新

```sh
npx --yes skills@latest add "https://arkdocs.tos-cn-beijing.volces.com/skills/" --skill sd25-pe --yes
cp .agents/skills/sd25-pe/SKILL.md dsh-tiktok-ops/vendor/sd25-pe/SKILL.md
shasum -a 256 dsh-tiktok-ops/vendor/sd25-pe/SKILL.md   # 更新上面表格里的 sha256
```
