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
