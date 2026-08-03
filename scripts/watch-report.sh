#!/bin/bash
# Serve docs/ and regenerate the report whenever a benchmark result lands.
#
#   ./scripts/watch-report.sh [port]
#
# Run this in one terminal, then run benchmarks in another: every new
# results-*.json triggers a regeneration, so a browser refresh shows it.
# Polls instead of using inotify so it needs nothing installed.

set -e

PORT="${1:-8082}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Fingerprint of every result file: path + mtime + size. Changes when a run
# writes a new result OR rewrites an existing one (re-runs of the same task).
fingerprint() {
  find benchmark_results -name 'results-*.json' -printf '%p %T@ %s\n' 2>/dev/null | sort | md5sum
}

regenerate() {
  if bun run scripts/generate-report.ts >/tmp/rei-report.log 2>&1; then
    echo "[$(date +%H:%M:%S)] report updated ($(find benchmark_results -name 'results-*.json' 2>/dev/null | wc -l) results)"
  else
    echo "[$(date +%H:%M:%S)] generate-report FAILED — see /tmp/rei-report.log"
    tail -5 /tmp/rei-report.log
  fi
}

regenerate

python3 -m http.server "$PORT" -d docs/ >/dev/null 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null' EXIT INT TERM
echo "[INFO] Serving http://localhost:$PORT — watching benchmark_results/ (Ctrl-C to stop)"

LAST="$(fingerprint)"
while true; do
  sleep 3
  NOW="$(fingerprint)"
  if [ "$NOW" != "$LAST" ]; then
    LAST="$NOW"
    # A result file is written in one go, but the judge writes summary.json just
    # after; pause so a regeneration picks up the whole set rather than half.
    sleep 1
    regenerate
  fi
done
