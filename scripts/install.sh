#!/bin/sh
# 把 dsh-tiktok-ops 安装到指定 profile（默认 web）。
#
#   1) 在 profile 的 node_modules 里建软链，让宿主能按包名解析到本目录
#   2) 在 profile 的「用户 patch 层」补一行 insert（已存在则跳过，不清空其它行）
#
# 走用户 patch 层而不是 dsh plugin add：本机 profile 的 pnpm 被一个既有的
# minimumReleaseAge 策略卡住装不了，而且 patch 层会被运行中的 dsh web 热挂载。
#
# 用法：scripts/install.sh [profile名] [--uninstall]
set -e

WS="$(cd "$(dirname "$0")/.." && pwd)"
PKG="dsh-tiktok-ops"
PROFILE_NAME="${1:-web}"
case "$PROFILE_NAME" in
  --uninstall) PROFILE_NAME=web; MODE=uninstall ;;
  *) MODE=install ;;
esac
[ "$2" = "--uninstall" ] && MODE=uninstall

DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PROFILE="$DSH_HOME_DIR/profiles/$PROFILE_NAME"
PATCH="$PROFILE/cordis.patch.yml"
NM="$PROFILE/node_modules"

if [ ! -d "$PROFILE" ]; then
  echo "找不到 profile：$PROFILE" >&2
  exit 1
fi

if [ "$MODE" = "uninstall" ]; then
  rm -f "$NM/$PKG"
  if [ -f "$PATCH" ]; then
    # 按块删除：从 "- " 开头到下一个 "- " 之前为一块，块内含本插件包名才整块删掉。
    # 这样既不会留下孤立的 insert 键，也不会碰到其它插件的行。
    awk -v pkg="$PKG" '
      { line[NR] = $0 }
      END {
        n = NR; i = 1
        while (i <= n) {
          if (line[i] ~ /^- /) {
            j = i + 1
            while (j <= n && line[j] !~ /^- /) j++
            block = ""
            for (k = i; k < j; k++) block = block line[k] "\n"
            if (index(block, pkg) > 0) { i = j; continue }
            for (k = i; k < j; k++) print line[k]
            i = j
            continue
          }
          print line[i]; i++
        }
      }' "$PATCH" > "$PATCH.tmp"
    # 已经没有任何补丁项就还原成合法的空数组
    if ! grep -qE '^- ' "$PATCH.tmp"; then
      printf '[]\n' > "$PATCH.tmp"
    fi
    mv "$PATCH.tmp" "$PATCH"
  fi
  echo "已卸载（重启 dsh web 后生效）"
  exit 0
fi

# 1) 软链
ln -sfn "$WS" "$NM/$PKG"
echo "软链：$NM/$PKG -> $WS"

# 2) 补丁行（幂等）
if [ ! -f "$PATCH" ]; then
  printf '[]\n' > "$PATCH"
fi

if grep -q "name: '$PKG'" "$PATCH"; then
  echo "补丁行已存在，跳过"
else
  # 空的 [] 直接替换，否则追加
  if grep -qE '^\s*\[\s*\]\s*$' "$PATCH"; then
    cat > "$PATCH" <<YAML
# 本机叠加层。$PKG 挂在这里（用户层），
# 而不是走 bundle 列表，这样 web profile 的 patch 监听能直接生效。
- insert:
    - id: tiktok-ops
      name: '$PKG'
YAML
  else
    {
      echo ""
      echo "- insert:"
      echo "    - id: tiktok-ops"
      echo "      name: '$PKG'"
    } >> "$PATCH"
  fi
  echo "补丁行已写入：$PATCH"
fi

echo
echo "完成。重启 dsh web 后，打开 GUI →「设置 → TikTok 全流程」。"
echo "首次使用请在「设置」页签填顾本 CLI 路径与 API Token。"
