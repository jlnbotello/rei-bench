#!/bin/bash
set -e

# Run rei-bench tasks inside official SWE-bench evaluation containers.
# Each task runs in its own container with the correct Python version and dependencies.
#
# Usage:
#   ./run-swe-bench.sh tasks/verified-mini/ --provider openrouter --judge-provider openrouter --judge-model google/gemini-3.1-pro-preview --platform strix-halo
#   ./run-swe-bench.sh tasks/verified-mini/django__django-12209.json --provider openrouter --model deepseek/deepseek-v4-flash
#   ./run-swe-bench.sh tasks/verified-mini/ --provider openrouter --pass 2   # retry failed tasks (pass@2)
#
# The script:
#   1. Iterates over task files in the given directory (or runs a single task file)
#   2. For each task, launches the corresponding SWE-bench container
#   3. Installs bun + rei-bench deps inside the container (cached via Docker volume)
#   4. Runs the benchmark: agent works in /testbed, then FAIL_TO_PASS tests are executed
#   5. Results are written back to the host via the bind-mounted rei-bench directory

TARGET="${1:?Usage: ./run-swe-bench.sh <task-file-or-dir> [extra-args...]}"
shift

PASS_COUNT=1
EXTRA_ARGS=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --pass)
      PASS_COUNT="$2"
      shift 2
      ;;
    *)
      EXTRA_ARGS="$EXTRA_ARGS $1"
      shift
      ;;
  esac
done
# These containers are published for linux/amd64 only (no arm64 manifest exists), so
# --platform is passed explicitly below. On x86_64 hosts it's a no-op; on Apple Silicon
# (or arm64 Linux) Docker runs them emulated (QEMU, or Rosetta if enabled in Docker
# Desktop's settings for much better performance) instead of erroring on a platform
# mismatch.
REGISTRY="ghcr.io/epoch-research/swe-bench.eval.x86_64"
REI_BENCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Containers run as root; results written through the bind mount must be handed
# back to the invoking user so host-side post-processing can write to them.
HOST_UID="$(id -u)"
HOST_GID="$(id -g)"

# rei-bench deep-imports the rei agent from ../rei/dist (+ rei's node_modules).
# That sibling repo lives outside /rei-bench, so it must be bind-mounted into the
# container at /rei for `../../rei/...` (resolved from /rei-bench/src) to exist.
# Override REI_DIR to point elsewhere if rei is not a sibling of rei-bench.
REI_DIR="${REI_DIR:-$(cd "$REI_BENCH_DIR/../rei" 2>/dev/null && pwd)}"
if [ -z "$REI_DIR" ] || [ ! -f "$REI_DIR/dist/core/agent.js" ]; then
  echo "[ERROR] rei build not found. Expected $REI_BENCH_DIR/../rei/dist (run 'npm run build' in rei),"
  echo "        or set REI_DIR to the rei repo path."
  exit 1
fi

# Create persistent bun cache volume (shared across all container runs)
docker volume create rei-bench-bun-cache 2>/dev/null || true

# Collect env file args
ENV_ARGS=""
if [ -f "$REI_BENCH_DIR/.env" ]; then
  ENV_ARGS="--env-file $REI_BENCH_DIR/.env"
fi

# --network host (Linux) puts the container directly on the host's network namespace, so
# 127.0.0.1-bound local model servers (LM Studio, Ollama both default to loopback-only —
# verified against real servers: `ss -tln` showed 127.0.0.1:1234 / 127.0.0.1:11434, not
# 0.0.0.0) are reachable as-is, with zero config. It's Linux-only (unsupported/beta on
# Docker Desktop for Mac), so macOS instead uses --add-host=host.docker.internal:host-gateway.
# Unlike Linux's host-gateway (a real route to the bridge IP, which can't reach
# loopback-only ports), Docker Desktop proxies host.docker.internal through to the Mac's
# own 127.0.0.1, so loopback-bound local servers stay reachable there without
# reconfiguring them either. Only macOS needs the base URL pointed at that hostname —
# and only when the user hasn't already set a custom value, so an explicit remote
# endpoint is never clobbered.
DOCKER_NETWORK_ARGS="--network host"
LOCAL_PROVIDER_ENV_ARGS=""
if [ "$(uname -s)" = "Darwin" ]; then
  DOCKER_NETWORK_ARGS="--add-host=host.docker.internal:host-gateway"
  default_local_provider_env() {
    local var="$1" default="$2"
    if [ -n "${!var:-}" ]; then return; fi
    if [ -f "$REI_BENCH_DIR/.env" ] && grep -qE "^${var}=.+" "$REI_BENCH_DIR/.env"; then return; fi
    echo "-e ${var}=${default}"
  }
  LOCAL_PROVIDER_ENV_ARGS="$(default_local_provider_env LLM_STUDIO_BASE_URL 'http://host.docker.internal:1234/v1') $(default_local_provider_env OLLAMA_BASE_URL 'http://host.docker.internal:11434')"
fi

# Collect task files
TASK_FILES=()
if [ -d "$TARGET" ]; then
  for f in "$TARGET"/*.json; do
    [ -f "$f" ] && TASK_FILES+=("$f")
  done
else
  TASK_FILES+=("$TARGET")
fi

if [ ${#TASK_FILES[@]} -eq 0 ]; then
  echo "[ERROR] No task JSON files found in $TARGET"
  exit 1
fi

TOTAL=${#TASK_FILES[@]}
COUNT=0
PASSED=0
FAILED=0

# Determine results directory on the host to check for cached results.
# --print-output-dir emits the path last, but banners (e.g. the telemetry notice)
# may precede it on stdout, so keep only the final line.
RESULTS_DIR=$(bun run src/index.ts --print-output-dir "$TARGET" $EXTRA_ARGS 2>/dev/null | tail -1 | tr -d '\r' || true)

echo "========================================================"
echo "[INFO] SWE-bench Runner — $TOTAL tasks queued"
if [ -n "$RESULTS_DIR" ]; then
  echo "[INFO] Results directory: $RESULTS_DIR"
fi
echo "========================================================"

for task_file in "${TASK_FILES[@]}"; do
  COUNT=$((COUNT + 1))
  TASK_ID=$(python3 -c "import json; print(json.load(open('$task_file'))['id'])")

  # Skip if result already exists (check on host to avoid docker startup overhead)
  if [ -n "$RESULTS_DIR" ] && [ -f "$RESULTS_DIR/results-${TASK_ID}.json" ]; then
    echo ""
    echo "========================================================"
    echo "[$COUNT/$TOTAL] Task: $TASK_ID"
    echo "[INFO] Skipping $TASK_ID, result already exists."
    echo "========================================================"
    PASSED=$((PASSED + 1))
    continue
  fi

  IMAGE="${REGISTRY}.${TASK_ID}:latest"

  echo ""
  echo "========================================================"
  echo "[$COUNT/$TOTAL] Task: $TASK_ID"
  echo "         Image: $IMAGE"
  echo "========================================================"

  REL_TASK_FILE=$(python3 -c "import os; print(os.path.relpath('$(realpath "$task_file")', '$(realpath "$REI_BENCH_DIR")'))")

  for ATTEMPT in $(seq 1 $PASS_COUNT); do
    if [ $PASS_COUNT -gt 1 ]; then
      echo "[INFO] Starting attempt $ATTEMPT of $PASS_COUNT for $TASK_ID"
    fi

    # Run container and tee output to a temp file so we can extract the results dir
    LOGFILE=$(mktemp /tmp/rei-bench-log.XXXXXX)
    docker run --init -it --rm --platform linux/amd64 $DOCKER_NETWORK_ARGS \
      $ENV_ARGS $LOCAL_PROVIDER_ENV_ARGS \
      -v "$REI_BENCH_DIR:/rei-bench:z" \
      -v "$REI_DIR:/rei:z" \
      -v "rei-bench-bun-cache:/root/.bun" \
      "$IMAGE" \
      bash -c "
        set -e

        # Install unzip + bun (cached after first run via volume)
        if [ ! -f /root/.bun/bin/bun ]; then
          echo '[SETUP] Installing bun...'
          apt-get update -qq && apt-get install -y -qq unzip >/dev/null 2>&1
          curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1
          echo '[SETUP] bun installed.'
        fi
        export PATH=/root/.bun/bin:\$PATH

        # Ensure unzip is available (bun cache might exist from a previous run but unzip might not be in this container)
        which unzip >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq unzip >/dev/null 2>&1; }

        # Install rei-bench dependencies (fast if node_modules exists from bind mount)
        cd /rei-bench && bun install --frozen-lockfile 2>/dev/null || bun install 2>/dev/null

        # Activate the SWE-bench testbed conda environment so 'python' resolves
        # to the correct version (e.g. Python 3.6 for Django, 3.8+ for Sphinx)
        source /opt/miniconda3/etc/profile.d/conda.sh
        conda activate testbed

        # Run the benchmark
        RC=0
        bun run src/index.ts $REL_TASK_FILE $EXTRA_ARGS || RC=\$?

        # The container runs as root, so everything it writes into the bind-mounted
        # results dir lands root-owned and the host-side steps below (attempt renames,
        # combine, aggregate summary) cannot touch it. Hand ownership back.
        if [ -n '$RESULTS_DIR' ] && [ -d '/rei-bench/$RESULTS_DIR' ]; then
          chown -R $HOST_UID:$HOST_GID '/rei-bench/$RESULTS_DIR' 2>/dev/null || true
        fi

        exit \$RC
      " 2>&1 | tee "$LOGFILE"

    EXIT_CODE=${PIPESTATUS[0]}

    # Capture the results directory from container output (first occurrence only)
    if [ -z "$RESULTS_DIR" ]; then
      RESULTS_DIR=$(grep -m1 'Saving results to directory:' "$LOGFILE" | sed 's/.*Saving results to directory: //' | tr -d '\r' || true)
    fi
    rm -f "$LOGFILE"

    if [ $EXIT_CODE -eq 2 ]; then
      echo "[FATAL] Inference backend is unreachable or crashed. Aborting entire benchmark run."
      exit 2
    fi

    # Rename the outputs for this attempt
    if [ -n "$RESULTS_DIR" ]; then
      mv "$RESULTS_DIR/results-${TASK_ID}.json" "$RESULTS_DIR/results-${TASK_ID}-attempt${ATTEMPT}.json" 2>/dev/null || true
      mv "$RESULTS_DIR/transcript-${TASK_ID}.json" "$RESULTS_DIR/transcript-${TASK_ID}-attempt${ATTEMPT}.json" 2>/dev/null || true

      # Check if this attempt succeeded
      JUDGE_SCORE=$(python3 -c "import json, sys; r=json.load(open(sys.argv[1], 'r')); print(r.get('judgeScore', 0))" "$RESULTS_DIR/results-${TASK_ID}-attempt${ATTEMPT}.json" 2>/dev/null || echo "0")
      if [ "$JUDGE_SCORE" = "1" ]; then
        break
      fi
    fi
  done

  # Combine attempts and determine pass/fail
  python3 -c "
import json, sys, os, shutil
results_dir = sys.argv[1]
task_id = sys.argv[2]
pass_count = int(sys.argv[3])

attempts = []
best_attempt = None
succeeded_at = None

for a in range(1, pass_count + 1):
    res_path = os.path.join(results_dir, f'results-{task_id}-attempt{a}.json')
    if os.path.exists(res_path):
        with open(res_path, 'r') as f:
            data = json.load(f)
            attempts.append(data)
            best_attempt = a
            if data.get('judgeScore') == 1:
                succeeded_at = a
                break

if attempts:
    final_data = attempts[-1].copy() # use the last run as base
    final_data['attempts'] = attempts
    final_data['succeededAtAttempt'] = succeeded_at

    with open(os.path.join(results_dir, f'results-{task_id}.json'), 'w') as f:
        json.dump(final_data, f, indent=2)

    # Copy the best transcript to standard name for legacy support
    best_trans = os.path.join(results_dir, f'transcript-{task_id}-attempt{best_attempt}.json')
    final_trans = os.path.join(results_dir, f'transcript-{task_id}.json')
    if os.path.exists(best_trans):
        shutil.copy2(best_trans, final_trans)
" "$RESULTS_DIR" "$TASK_ID" "$PASS_COUNT"

  # Count passes/fails based on the final combined file. Exit code 0 only means the
  # harness completed, not that the judge scored it a pass, so if the results file
  # can't be read (e.g. the results dir could not be determined), fail closed rather
  # than trusting the exit code.
  if [ -n "$RESULTS_DIR" ] && [ -f "$RESULTS_DIR/results-${TASK_ID}.json" ]; then
    FINAL_SCORE=$(python3 -c "import json, sys; r=json.load(open(sys.argv[1], 'r')); print(r.get('judgeScore', 0))" "$RESULTS_DIR/results-${TASK_ID}.json" 2>/dev/null || echo "0")
  else
    echo "[WARN] No results file for $TASK_ID under '${RESULTS_DIR:-<unknown>}'; counting as failed."
    FINAL_SCORE=0
  fi

  if [ "$FINAL_SCORE" = "1" ]; then
    PASSED=$((PASSED + 1))
  else
    FAILED=$((FAILED + 1))
    echo "[WARN] Task $TASK_ID failed after $ATTEMPT attempts"
  fi
done

echo ""
echo "========================================================"
echo "[INFO] SWE-bench Runner Complete!"
echo "[INFO] Tasks: $TOTAL | Succeeded: $PASSED | Failed: $FAILED"
echo "========================================================"

# Generate aggregate summary.json from all individual result files.
# Each container writes its own summary.json with only 1 task, overwriting the previous.
# This step reads all results-*.json and builds the real aggregate.
if [ -n "$RESULTS_DIR" ] && [ -d "$RESULTS_DIR" ]; then
  echo "[INFO] Generating aggregate summary from $RESULTS_DIR ..."
  python3 -c "
import json, glob, os, sys

results_dir = sys.argv[1]
# Per-attempt files (results-<task>-attemptN.json) are folded into the canonical
# results-<task>.json by the combine step, so exclude them from the aggregate.
result_files = sorted(
    f for f in glob.glob(os.path.join(results_dir, 'results-*.json'))
    if '-attempt' not in os.path.basename(f)
)

if not result_files:
    print('[WARN] No result files found, skipping summary generation.')
    sys.exit(0)

results = []
passed = 0
total_duration = 0

for f in result_files:
    with open(f) as fh:
        r = json.load(fh)
        results.append(r)
        if r.get('judgeScore') == 1:
            passed += 1
        total_duration += r.get('durationMs', 0)

summary = {
    'totalTasks': len(results),
    'passedTasks': passed,
    'passRate': passed / len(results) if results else 0,
    'totalDurationMs': total_duration,
    'averageDurationMs': total_duration / len(results) if results else 0,
    'results': results
}

summary_path = os.path.join(results_dir, 'summary.json')
try:
    with open(summary_path, 'w') as fh:
        json.dump(summary, fh, indent=2)
except OSError as e:
    print(f'[WARN] Could not write {summary_path}: {e}')
    sys.exit(0)

print(f'[INFO] Aggregate summary: {passed}/{len(results)} passed ({summary[\"passRate\"]*100:.1f}%)')
print(f'[INFO] Summary saved to {summary_path}')
" "$RESULTS_DIR" || echo "[WARN] Aggregate summary generation failed; individual results are unaffected."
else
  echo "[WARN] Could not determine results directory for aggregate summary."
fi
