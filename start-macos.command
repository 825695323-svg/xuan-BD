#!/bin/zsh
set -e
APP_DIR="$(cd -- "$(dirname -- "$0")" && pwd -P)"
cd -- "$APP_DIR"
exec "$APP_DIR/resources/bundled/darwin-arm64/node/bin/node" --import tsx "$APP_DIR/scripts/web.ts" "$@"
