#!/bin/bash
set -e

# Pre-pull all SWE-bench evaluation containers for the verified-mini dataset.
# This is optional — run-swe-bench.sh will pull lazily if needed.
# Total download: ~2.4 GB compressed, ~6 GB on disk.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TASK_DIR="${SCRIPT_DIR}/../tasks/verified-mini"
# These containers are published for linux/amd64 only (no arm64 manifest exists), so
# --platform is passed explicitly to `docker pull` below. No-op on x86_64 hosts; on
# Apple Silicon (or arm64 Linux) it pulls the amd64 image for emulated execution,
# matching what run-swe-bench.sh runs.
REGISTRY="ghcr.io/epoch-research/swe-bench.eval.x86_64"

if [ ! -d "$TASK_DIR" ]; then
  echo "[ERROR] Task directory not found: $TASK_DIR"
  echo "[INFO]  Run ./scripts/download-swe-mini.sh first to create task files."
  exit 1
fi

TOTAL=$(ls "$TASK_DIR"/*.json 2>/dev/null | wc -l)
COUNT=0

for task_file in "$TASK_DIR"/*.json; do
  COUNT=$((COUNT + 1))
  TASK_ID=$(python3 -c "import json; print(json.load(open('$task_file'))['id'])")
  IMAGE="${REGISTRY}.${TASK_ID}:latest"

  echo "[$COUNT/$TOTAL] Pulling $IMAGE ..."
  docker pull --platform linux/amd64 "$IMAGE" 2>&1 | tail -1
done

echo ""
echo "=== All $TOTAL images pulled ==="
echo "Disk usage:"
docker images | grep "swe-bench.eval" | awk '{print "  " $1 ":" $2 " — " $NF}'
