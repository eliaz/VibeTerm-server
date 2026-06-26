#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

load_env_file() {
  local file="$1"
  if [[ -f "$file" ]]; then
    set -a
    # shellcheck source=/dev/null
    source "$file"
    set +a
  fi
}

load_env_file "$ROOT_DIR/.env"
load_env_file "$ROOT_DIR/.env.local"

cd "$ROOT_DIR"
mkdir -p "${VIBETERM_LOG_DIR:-.logs}"

exec node scripts/vibeterm-config-server.mjs \
  --host "${VIBETERM_UI_HOST:-0.0.0.0}" \
  --port "${VIBETERM_UI_PORT:-3457}" \
  --file "${VIBETERM_UI_FILE:-server/vibeterm-ui.json}"
