#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/oracle"

if [[ -f .oracle-key ]]; then
  export ORACLE_PRIVATE_KEY="$(<.oracle-key)"
fi
export WATCH_INTERVAL_MIN="${WATCH_INTERVAL_MIN:-5}"
export PAGES_PUBLISH="${PAGES_PUBLISH:-1}"

exec node src/run.js watch
