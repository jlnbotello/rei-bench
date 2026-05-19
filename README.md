# Pi-Bench

A lightweight, customizable benchmark runner for `pi-coding-agent`, inspired by `opencode-bench`.

## Overview
`pi-bench` automates the process of testing an AI coding agent against real-world tasks. It does this by:
1. Cloning a target repository to a temporary workspace.
2. Checking out a specific baseline commit.
3. Spinning up `pi-coding-agent` in the temporary workspace with a predefined task prompt.
4. Letting the agent use its tools (`read`, `bash`, `edit`, `write`) to complete the task.
5. Capturing the generated patch (`git diff`).
6. **(New) Running the test suite**, if a `testCommand` is provided, verifying success or failure based on standard exit codes.
7. Using a secondary LLM "Judge" to evaluate the patch against expected behavior and outputting a structured JSON score (if no hard test command determines the outcome).

## Setup

First, install the required dependencies (using `bun` or `npm`):
```bash
bun install
```

Make sure your API keys are configured exactly as they would be for the standard `pi` CLI (e.g. `ANTHROPIC_API_KEY`, or via `pi /login`).

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

### SWE-bench Lite
`pi-bench` natively supports importing the standard SWE-bench Lite dataset (300 tasks):
```bash
bun run scripts/import-swe-bench.ts path/to/swe_bench_lite.json
```
This generates individual task files in `tasks/synthetic/` mapped directly from SWE-bench instances, including the extraction of `test_patch` (which `pi-bench` will attempt to apply before running tests).

## Usage

You can run `pi-bench` against a **single file** or a **batch directory** of tasks.

### Local Execution (Use with Caution)
Running the benchmark locally executes the agent on your host machine.

```bash
# Run a single task
bun run src/index.ts tasks/synthetic/dummy-1.json

# Run a full directory batch
bun run src/index.ts tasks/curated/
```

### Docker Execution (Recommended Sandbox)
To ensure the coding agent can safely run `npm install`, arbitrary tests, or code without modifying your host system, we provide a Docker runner:

```bash
# Builds the image and runs the benchmark inside a container
./run-docker.sh tasks/curated/
```
*Note: To guarantee reproducibility and isolation, the Docker container runs completely decoupled from your host's `~/.pi` configuration. To provide API keys (like `GEMINI_API_KEY` for the judge), simply create a `.env` file in the root `pi-bench/` directory. `run-docker.sh` automatically maps this `.env` into the container.*

### Configuring Models

By default, the script resolves models securely using standard environment variables (e.g., `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`) loaded from your `.env` file. Since the container runs with `--network host`, local models served at `localhost:8080` (e.g., `llama.cpp`) are discovered automatically without any configuration.

If you need to configure custom API endpoints (e.g., an OpenAI-compatible server on a non-standard port), you can place a standard `models.json` file inside the `pi-bench/` root directory. The script will automatically detect and load it.

You can explicitly override the model for the agent and the judge using CLI flags. Additionally, you can provide a `--platform` flag to automatically save the results directly into the `benchmark_results/<platform>/` folder. If you want to append a suffix to the auto-detected model name (e.g., to distinguish MTP runs), use `--model-tag`:

```bash
./run-docker.sh tasks/verified-mini/ \
  --judge-model google/gemini-3.1-pro-preview \
  --platform strix-halo \
  --model-tag mtp \
  --timeout 45
```
*This would produce a results directory like `Qwen3_6-35B-A3B-UD-Q8_K_XL_gguf-mtp_results/` instead of `Qwen3_6-35B-A3B-UD-Q8_K_XL_gguf_results/`.*

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
     "ram": "32GB DDR5",
     "backend": "llama.cpp",
     "rocm": "7.2.2"
   }
   ```
2. **Run your benchmark with the `--platform` flag**:
   ```bash
   ./run-docker.sh tasks/verified-mini/ \
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
