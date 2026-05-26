#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ACTION="${1:-prepare}"
SLOT="${2:-07:00}"
ARTICLES="${3:-1}"
CONFIG="${CONFIG_PATH:-$ROOT/config.json}"

mkdir -p "$ROOT/logs" "$ROOT/queue/pending" "$ROOT/queue/published" "$ROOT/queue/failed"

if [[ "$ACTION" != "prepare" ]]; then
  echo "Usage: $0 prepare <slot> <articles>" >&2
  exit 1
fi

# Never allow direct publish from cron wrapper.
export XHS_CRON_MODE=1

python3 -m xhs_hotspot_poster --config "$CONFIG" --prepare-slot "$SLOT" --articles "$ARTICLES"
