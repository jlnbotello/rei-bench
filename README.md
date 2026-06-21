# rei-bench

A lightweight, customizable benchmark runner for the `rei` coding agent.

> **Credits:** `rei-bench` is a fork of **[pi-bench](https://github.com/kyuz0/pi-bench)**
> by **Donato Capitella** ([@kyuz0](https://github.com/kyuz0)) — thank you for the original
> harness. This fork adapts it to benchmark the `rei` agent instead of `pi-coding-agent`;
> the task format, SWE-bench integration, Docker sandbox, LLM judge, and dashboard are all
> inherited from pi-bench.

## Overview
`rei-bench` automates the process of testing an AI coding agent against real-world tasks. It does this by:
1. Cloning a target repository to a temporary workspace (or using a pre-configured SWE-bench container).
2. Checking out a specific baseline commit.
3. Driving the `rei` agent (in **agent mode**) in the workspace with a predefined task prompt.
4. Letting the agent use its tools (`read_files`, `run_command`, `edit_file`, `create_file`) to complete the task.
5. Capturing the generated patch (`git diff`).
6. **Running the test suite** — either from a `testCommand` (curated tasks) or SWE-bench `FAIL_TO_PASS` tests (inside the container).
7. Using a secondary LLM **Judge** (via `pi-ai`, e.g. Gemini or OpenRouter) to evaluate the patch and provide a rationale for the score.

## Setup

First, install the required dependencies (using `bun` or `npm`):
```bash
bun install
```

`rei-bench` deep-imports the agent from `rei`'s compiled output (`../rei/dist/**`),
assuming the two repos are siblings. Build `rei` first, and rebuild it whenever its
source changes:
```bash
cd ../rei && npm install && npm run build && cd -
```

## Defining Tasks

Benchmark tasks are defined as simple JSON files. See `tasks/curated/easy.json` for a reference:
```json
{
  "id": "curated-easy",
  "repo": "chalk/chalk",
  "commit": "v5.3.0",
  "prompt": "There is a typo in the README.md file in the `chalk` repository. Please find the typo 'colos' and fix it to 'colors'.",
  "expectedDiff": "diff --git a/README.md b/README.md\n...",
  "testCommand": "npm install && npm test"
}
```

*Note: `solutionCommit`, `expectedDiff`, and `testCommand` are optional. If `testCommand` is provided, the runner will execute it in the workspace after the agent completes. A `0` exit code automatically grants a perfect score, bypassing the subjective LLM judge.*

## Included Datasets

`pi-bench` supports multiple datasets to evaluate the agent's performance.

### SWE-bench Verified Mini (Recommended)
A highly curated subset of 50 verified tasks from the SWE-bench dataset. This is the recommended dataset for rapid, high-quality evaluation as it tests a broad set of capabilities without taking days to run.

To download and import this dataset directly from HuggingFace, simply run:
```bash
./scripts/download-swe-mini.sh
```
This will automatically generate the 50 task files inside the `tasks/verified-mini/` directory.



---

## Running Benchmarks

### SWE-bench Tasks (Recommended)

SWE-bench tasks run inside **official SWE-bench Docker containers** from `ghcr.io/epoch-research/swe-bench.eval.x86_64.*`. Each task gets its own container with:
- The correct Python version (e.g. Python 3.6 for Django 3.1, Python 3.8+ for Sphinx)
- All dependencies pre-installed
- The repository checked out at the right commit in `/testbed`

This eliminates the environment mismatch problems that plague host-side execution.

#### Pre-pull containers (optional)
Download all 49 container images upfront (~2.4 GB download, ~6 GB on disk due to heavy layer sharing):
```bash
./scripts/pull-swe-containers.sh
```

#### Provider Setup & Execution

`rei` selects its provider and model from **environment variables**; `rei-bench`
translates the `--provider` / `--model` flags into those vars at startup. Supported
providers: `llmstudio` (default), `ollama`, `openrouter`, `groq`, `gemini`, `huggingface`.
Put API keys / endpoints in `.env` (see [Configuring Models](#configuring-models)).
Unlike pi-bench, there is no `models.json` and no `/v1/models` auto-detection — pass
`--model` explicitly.

> **Note:** the SWE-bench Docker runner below still provisions `bun` + `pi` deps inside
> the container; running `rei` in-container requires building `rei` there too, which is
> **not yet wired in this fork**. Host-side curated runs (see *Local Execution*) are the
> supported path today.

**Example: local LM Studio**
```bash
./run-swe-bench.sh tasks/verified-mini/ \
  --provider llmstudio \
  --model qwen/qwen3.6-35b-a3b \
  --judge-model openrouter/google/gemini-2.5-flash \
  --platform strix-halo \
  --timeout 45
```

**Example: local Ollama**
```bash
./run-swe-bench.sh tasks/verified-mini/ \
  --provider ollama \
  --model qwen2.5-coder:14b \
  --judge-model openrouter/google/gemini-2.5-flash \
  --platform strix-halo \
  --timeout 45
```

##### Cloud Providers (`openrouter`)
For cloud providers like OpenRouter, you **must** specify which model to run via `--model`,
and set `OPENROUTER_API_KEY` in `.env`.

**Example: Running with OpenRouter**
```bash
./run-swe-bench.sh tasks/verified-mini/django__django-11790.json \
  --provider openrouter \
  --model deepseek/deepseek-v4-flash \
  --judge-model openrouter/google/gemini-2.5-flash \
  --platform openrouter \
  --timeout 30
```

#### How SWE-bench evaluation works
After the agent finishes editing code, the runner:
1. **Applies the test patch** from the SWE-bench dataset (adds the regression tests)
2. **Runs the `FAIL_TO_PASS` tests** inside the container using the correct Python and test runner
3. **Score is ground truth** — if the tests pass, `score = 1`; if they fail, `score = 0`
4. **The LLM Judge** (Gemini) receives both the diff and the test results, and provides a human-readable rationale explaining *why* the fix worked or didn't

This combines the objectivity of SWE-bench's test-based evaluation with the explainability of an LLM judge.

### Curated Tasks (Docker sandbox)

For non-SWE-bench tasks (curated, custom), use the Docker runner:
```bash
./run-docker.sh tasks/curated/ \
  --provider llmstudio --model qwen/qwen3.6-35b-a3b \
  --judge-model openrouter/google/gemini-2.5-flash \
  --platform strix-halo \
  --timeout 30
```

### Local Execution (Use with Caution)
Running the benchmark locally executes the agent on your host machine. This is the
supported path for `rei` today. `--judge-model` is required.
```bash
bun run src/index.ts tasks/curated/easy.json \
  --provider llmstudio --model qwen/qwen3.6-35b-a3b \
  --judge-model openrouter/google/gemini-2.5-flash \
  --timeout 30
```

---

## CLI Reference

### Provider & Model Flags

| Flag | Description | Default |
|---|---|---|
| `--provider <name>` | rei provider: `llmstudio`, `ollama`, `openrouter`, `groq`, `gemini`, `huggingface` | `llmstudio` |
| `--model <model-id>` | Agent model ID for that provider (e.g. `qwen/qwen3.6-35b-a3b`) | — |
| `--judge-model <provider/id>` | Judge model, resolved via pi-ai (e.g. `openrouter/google/gemini-2.5-flash`). **Required.** | — |
| `--engine <name>` | Backward-compatible alias for `--provider` | — |

`rei-bench` translates `--provider` / `--model` into the env vars `rei` reads:
`--provider` sets `MODEL_PROVIDER` + `AGENT_MODEL_PROVIDER`, and `--model` sets the
provider's `<PROVIDER>_MODEL_AGENT` (e.g. `LLM_STUDIO_MODEL_AGENT`, `OPENROUTER_MODEL_AGENT`).
The judge call enables `reasoning: "low"`, so reasoning-mandatory judge models
(e.g. `google/gemini-3.1-pro-preview` on OpenRouter) work without 400 errors.

### Other Flags

| Flag | Description | Default |
|---|---|---|
| `--platform <id>` | Save results to `benchmark_results/<platform>/` | — |
| `--model-tag <tag>` | Append a suffix to the results directory (e.g. `mtp`) | — |
| `--rocm-version <ver>`| ROCm version running the backend | `7.2.4` |
| `--context <tokens>` | Override rei's context window (`REI_CONTEXT_WINDOW`) | rei default |
| `--timeout <minutes>` | Agent timeout per task | `30` |

### Examples

```bash
# Local LM Studio
./run-swe-bench.sh tasks/verified-mini/ \
  --provider llmstudio --model qwen/qwen3.6-35b-a3b \
  --judge-model openrouter/google/gemini-2.5-flash \
  --platform strix-halo \
  --rocm-version 7.2.4 \
  --timeout 45

# Local Ollama
./run-swe-bench.sh tasks/verified-mini/ \
  --provider ollama --model qwen2.5-coder:14b \
  --judge-model openrouter/google/gemini-2.5-flash \
  --platform strix-halo \
  --rocm-version 7.2.4 \
  --timeout 45

# OpenRouter cloud (agent + judge)
./run-swe-bench.sh tasks/verified-mini/ \
  --provider openrouter --model deepseek/deepseek-v4-flash \
  --judge-model openrouter/google/gemini-2.5-flash \
  --platform openrouter \
  --timeout 30

# Single task
./run-swe-bench.sh tasks/verified-mini/django__django-11790.json \
  --provider openrouter --model deepseek/deepseek-v4-flash \
  --judge-model openrouter/google/gemini-2.5-flash \
  --platform openrouter \
  --timeout 30

# Override context window for a run (e.g. limit to 90k tokens)
./run-swe-bench.sh tasks/verified-mini/ \
  --provider llmstudio --model qwen/qwen3.6-35b-a3b \
  --judge-model openrouter/google/gemini-2.5-flash \
  --platform strix-halo \
  --context 90000 \
  --timeout 45
```

---

## Configuring Models

`rei` is configured through environment variables (provider, model, endpoints, context
window) — there is no `models.json`. `rei-bench` sets the provider/model vars from the
CLI flags; everything else goes in `.env`.

### API Keys & endpoints
Create a `.env` file in the root `rei-bench/` directory:
```
# Judge (pick per --judge-model)
GEMINI_API_KEY=...
OPENROUTER_API_KEY=...

# Agent provider credentials/endpoints, as needed by rei. e.g. LM Studio runs
# locally and usually needs no key; OPENROUTER_API_KEY also covers an OpenRouter agent.

# Optional: Laminar tracing (see below)
LMNR_PROJECT_API_KEY=...
LMNR_BASE_URL=http://localhost
LMNR_GRPC_PORT=8001
```
Both `run-docker.sh` and `run-swe-bench.sh` automatically pass this file into the container.

### Telemetry (Laminar)
`rei` emits Laminar/OpenTelemetry spans. Since `rei-bench` deep-imports the agent
(bypassing rei's CLI entry point), the harness initializes telemetry itself — but only
when `LMNR_PROJECT_API_KEY` is set **and** the Laminar collector is reachable. Otherwise
it prints a single warning and disables tracing (the server is optional; rei's span
helpers no-op when telemetry is off). When enabled, each task yields a
`rei.turn → step → tool/llm-call` trace.

---

## Results & Multi-Platform Dashboard

When a single run completes, it outputs a JSON artifact to the current directory (e.g. `results-curated-easy.json`).

When running a **batch** (providing a directory like `tasks/verified-mini/`), `pi-bench` automatically generates a uniquely named directory for the results based on the model (e.g., `Qwen3_6-35B-A3B-UD-Q8_K_XL_gguf_results/`).

### Populating the Dashboard
`pi-bench` includes a dynamic HTML dashboard that can track results across multiple hardware platforms. To get your results onto the dashboard:

1. **Create your platform metadata**: If it's a new platform, create a folder for it inside `benchmark_results/` and add a `platform.json` describing your hardware:
   ```bash
   mkdir -p benchmark_results/r9700
   ```
   *benchmark_results/r9700/platform.json*:
   ```json
   {
     "id": "r9700",
     "name": "Radeon 9700",
     "gpu": "Radeon 9700 16GB",
     "ram": "32GB DDR5"
   }
   ```
2. **Run your benchmark with the `--platform` flag**:
   ```bash
   ./run-swe-bench.sh tasks/verified-mini/ \
     --judge-model google/gemini-3.1-pro-preview \
     --platform r9700
   ```
   *This automatically routes the results folder (e.g. `Qwen3_6..._results`) right into `benchmark_results/r9700/`.*
   
3. **Generate the report**:
   This script parses all new results in `benchmark_results/` and compiles them into a single `docs/data.json` file. The frontend dashboard (`app.js`) requires this JSON file to display data.
   ```bash
   bun run scripts/generate-report.ts
   ```

4. **Serve the dashboard**:
   The dashboard is a static website. Serve the `docs/` folder, open your browser (e.g., `http://localhost:8082`), and the Vue frontend (`app.js`) will automatically load the updated `data.json`.
   ```bash
   python3 -m http.server 8082 -d docs/
   ```
