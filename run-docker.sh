#!/bin/bash
set -e

REI_BENCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# rei-bench deep-imports the rei agent from ../rei/dist (+ rei's node_modules).
# That sibling repo lives outside /rei-bench, so it must be bind-mounted into the
# container at /rei for `../../rei/...` (resolved from /rei-bench/src) to exist.
# Override REI_DIR to point elsewhere if rei is not a sibling of rei-bench.
REI_DIR="${REI_DIR:-$(cd "$REI_BENCH_DIR/../rei" 2>/dev/null && pwd)}"
if [ -z "$REI_DIR" ] || [ ! -d "$REI_DIR" ]; then
  echo "[ERROR] rei repo not found. Expected $REI_BENCH_DIR/../rei,"
  echo "        or set REI_DIR to the rei repo path."
  exit 1
fi

# Always rebuild rei so the bench tests the CURRENT source, not a stale dist/
# (rei-bench deep-imports rei/dist). Skip with REI_SKIP_BUILD=1 for fast iteration.
if [ "${REI_SKIP_BUILD:-0}" != "1" ]; then
  echo "[INFO] Building rei ($REI_DIR) so the bench tests current code..."
  ( cd "$REI_DIR" && npm run build ) || { echo "[ERROR] rei build failed."; exit 1; }
fi

if [ ! -f "$REI_DIR/dist/core/agent.js" ]; then
  echo "[ERROR] rei build not found at $REI_DIR/dist (build may have failed)."
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
if [ -f "$REI_DIR/.env" ]; then
  ENV_ARGS="--env-file $REI_DIR/.env"
fi
if [ -f "$REI_BENCH_DIR/.env" ]; then
  ENV_ARGS="$ENV_ARGS --env-file $REI_BENCH_DIR/.env"
fi
# Skip RAG embedding indexing for faster benchmark runs.
# REI still generates the flat repo map (file list + function signatures)
# in the system prompt — only the vector store chunking/embedding is skipped.
ENV_ARGS="$ENV_ARGS -e REI_SKIP_RAG=true"

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

    # Laminar (telemetry) runs on the Mac host, but LMNR_BASE_URL is typically set to
    # localhost/127.0.0.1 — which inside the container resolves to the container itself,
    # so rei's canConnect() check fails and it silently disables tracing. Unlike the
    # local providers above (where a user-set value is left untouched), a loopback LMNR
    # host is *always* wrong in the container, so rewrite it to host.docker.internal.
    # A genuinely remote endpoint (non-loopback) is left as-is.
    lmnr_host_override() {
        local url=""
        [ -n "${LMNR_BASE_URL:-}" ] && url="$LMNR_BASE_URL"
        # env-file order is rei then rei-bench, so rei-bench wins (checked last).
        for f in "$REI_DIR/.env" "$REI_BENCH_DIR/.env"; do
            if [ -z "${LMNR_BASE_URL:-}" ] && [ -f "$f" ] && grep -qE '^LMNR_BASE_URL=.+' "$f"; then
                url="$(grep -E '^LMNR_BASE_URL=' "$f" | tail -1 | cut -d= -f2-)"
            fi
        done
        case "$url" in
            *localhost*|*127.0.0.1*) echo "-e LMNR_BASE_URL=http://host.docker.internal" ;;
        esac
    }
    LOCAL_PROVIDER_ENV_ARGS="$LOCAL_PROVIDER_ENV_ARGS $(lmnr_host_override)"
fi

# Create persistent volume for a linux-native rei/node_modules (see comment below).
docker volume create rei-node-modules-linux 2>/dev/null || true

docker run --init --rm -it $DOCKER_NETWORK_ARGS \
    $ENV_ARGS $LOCAL_PROVIDER_ENV_ARGS \
    -v "$REI_BENCH_DIR:/rei-bench:z" \
    -v "$REI_DIR:/rei:z" \
    -v "rei-node-modules-linux:/rei/node_modules" \
    -w /rei-bench \
    rei-bench-runner \
    bash -c '
        # rei/node_modules is bind-mounted from the host, but native addons in it (e.g.
        # sharp, pulled in by rei'"'"'s RAG embedder) are platform-specific binaries fixed at
        # install time. If rei was built on a Mac host, those are Darwin binaries that
        # cannot load in this Linux container. The rei-node-modules-linux volume above
        # shadows /rei/node_modules inside the container only (the host directory under
        # REI_DIR is never touched), so install into it here with a real linux install.
        # Cheap no-op after the first run since the volume persists.
        cd /rei && bun install 2>&1 | tail -5
        cd /rei-bench && bun run src/index.ts "$@"
    ' bash "$@"
