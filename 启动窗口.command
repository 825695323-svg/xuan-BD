#!/bin/zsh
# 通过本机启动定位与资源绑定打开独立应用窗口。
set -e
APP_DIR="$(cd -- "$(dirname -- "$0")" && pwd -P)"
cd -- "$APP_DIR"
exec "$APP_DIR/resources/bundled/darwin-arm64/node/bin/node" --import tsx "$APP_DIR/scripts/window.ts" "$@"
