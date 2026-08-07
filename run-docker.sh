#!/bin/bash
set -e

REI_BENCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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

# Build the docker image
echo "[INFO] Building rei-bench docker image..."
docker build -t rei-bench-runner "$REI_BENCH_DIR"

# Run the benchmark
# -v $REI_BENCH_DIR:/rei-bench:z mounts the rei-bench directory
# -v $REI_DIR:/rei:z mounts the sibling rei build
# -w /rei-bench sets the working directory to rei-bench
echo "[INFO] Running rei-bench inside docker..."
ENV_ARGS=""
if [ -f "$REI_BENCH_DIR/.env" ]; then
    ENV_ARGS="--env-file $REI_BENCH_DIR/.env"
fi

# Local providers (llmstudio, ollama) default to http://localhost:<port>, which from
# inside a container never reaches the host. We don't rely on --network host (Linux-only;
# unsupported/beta on Docker Desktop for Mac) — instead the container gets
# --add-host=host.docker.internal:host-gateway below, and here we point the local
# providers' base URL at that hostname. Only injected when the user hasn't already set
# a custom value (shell env or .env), so an explicit remote endpoint is never clobbered.
default_local_provider_env() {
    local var="$1" default="$2"
    if [ -n "${!var:-}" ]; then return; fi
    if [ -f "$REI_BENCH_DIR/.env" ] && grep -qE "^${var}=.+" "$REI_BENCH_DIR/.env"; then return; fi
    echo "-e ${var}=${default}"
}
LOCAL_PROVIDER_ENV_ARGS="$(default_local_provider_env LLM_STUDIO_BASE_URL 'http://host.docker.internal:1234/v1') $(default_local_provider_env OLLAMA_BASE_URL 'http://host.docker.internal:11434')"

docker run --init --rm -it \
    --add-host=host.docker.internal:host-gateway \
    $ENV_ARGS $LOCAL_PROVIDER_ENV_ARGS \
    -v "$REI_BENCH_DIR:/rei-bench:z" \
    -v "$REI_DIR:/rei:z" \
    -w /rei-bench \
    rei-bench-runner \
    bun run src/index.ts "$@"
