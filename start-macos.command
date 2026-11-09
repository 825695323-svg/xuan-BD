#!/bin/zsh
set -e
APP_DIR="$(cd -- "$(dirname -- "$0")" && pwd -P)"
cd -- "$APP_DIR"
# 原随包入口保持严格核验；native 必须先显式选 Node，并只用显式新 locator。
if [[ "${1:-}" == --node=* ]]; then
  NODE="${1#--node=}"
  shift
  [[ "$NODE" == /* && -f "$NODE" && -x "$NODE" ]] || { print -u2 '需要明确可执行的 Node 绝对路径；不会搜索 PATH。'; exit 1; }
  exec "$NODE" "$APP_DIR/scripts/local-web.mjs" start "$@"
fi
exec "$APP_DIR/resources/bundled/darwin-arm64/node/bin/node" --import tsx "$APP_DIR/scripts/web.ts" "$@"
