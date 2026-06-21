// Judge stays on pi-ai/Gemini: AuthStorage + ModelRegistry are kept ONLY to
// resolve the judge model's API key/headers. The AGENT is now `rei`.
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";
// `rei` is not published; it ships a compiled dist/ (no .d.ts) and lives as a
// sibling repo. Deep-import its Agent directly — rei's own node_modules resolves
// its internals at runtime. @ts-ignore: dist has no type declarations.
// @ts-ignore
import { Agent } from "../../rei/dist/core/agent.js";
// @ts-ignore
import { createModelProvider } from "../../rei/dist/providers/provider-factory.js";
// @ts-ignore
import type { ChatSession } from "../../rei/dist/chat/types.js";
// rei's spans are created unconditionally, so Laminar must be initialized before
// any Agent runs (mirrors rei/src/main.ts). Idempotent + self-disables when
// LMNR_PROJECT_API_KEY is unset. shutdown flushes spans on exit.
// @ts-ignore
import { initTelemetry, shutdownTelemetry } from "../../rei/dist/telemetry/init.js";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import * as net from "node:net";

const execAsync = promisify(exec);

// SWE-bench container test command builder
function buildSweTestCommand(task: any): string {
  const python = "/opt/miniconda3/envs/testbed/bin/python";

  if (task.repo === "django/django") {
    // Extract test modules from FAIL_TO_PASS entries like
    // "test_foo (auth_tests.test_forms.AuthTest)" → "auth_tests.test_forms"
    const modules = [...new Set(task.failToPass.map((t: string) => {
      const match = t.match(/\(([^)]+)\)/);
      if (match) {
        const parts = match[1].split(".");
        return parts.slice(0, -1).join(".");
      }
      return t;
    }))];
    // Django's runtests.py returns exit 0 even on failures, so we wrap
    // the command to parse the output and return a proper exit code.
    return `${python} /testbed/tests/runtests.py ${modules.join(" ")} --verbosity 2 2>&1 | tee /tmp/test_output.txt; grep -q "^OK" /tmp/test_output.txt`;
  }

  if (task.repo === "sphinx-doc/sphinx") {
    // Sphinx uses pytest; FAIL_TO_PASS entries are pytest node IDs
    const testPaths = task.failToPass.map((t: string) => `"${t}"`).join(" ");
    return `cd /testbed && ${python} -m pytest ${testPaths} -xvs`;
  }

  // Generic fallback: run pytest
  return `cd /testbed && ${python} -m pytest --tb=short`;
}

async function runTask(taskFile: string, judgeModelReq: any, outputDir: string = ".", timeoutMin: number = 30) {
  const taskContent = await readFile(taskFile, "utf-8");
  const task = JSON.parse(taskContent);

  console.log(`\n======================================================`);
  console.log(`[INFO] Starting benchmark for task file: ${taskFile}`);
  console.log(`======================================================\n`);

  const sweTestbed = "/testbed";
  const isSweContainer = existsSync(sweTestbed);
  const tmpDir = isSweContainer ? sweTestbed : await mkdtemp(join(tmpdir(), "pi-bench-"));
  console.log(`[INFO] Working directory: ${tmpDir} (SWE container: ${isSweContainer})`);

  // Hoisted so the `finally` block can tear down MCP regardless of where we fail.
  let agent: Agent | undefined;

  try {
    if (isSweContainer) {
      console.log(`[INFO] Using pre-configured SWE-bench testbed at ${sweTestbed}`);
      // Ensure git is initialized in /testbed for diff extraction
      try { await execAsync(`git status`, { cwd: tmpDir }); } catch {
        await execAsync(`git init && git add -A && git commit -m "baseline" --allow-empty`, { cwd: tmpDir });
      }
    } else {
      console.log(`[INFO] Cloning ${task.repo} at commit ${task.commit}...`);
      await execAsync(`git init`, { cwd: tmpDir });
      await execAsync(`git remote add origin https://github.com/${task.repo}.git`, { cwd: tmpDir });
      await execAsync(`git fetch --depth 1 origin ${task.commit}`, { cwd: tmpDir });
      await execAsync(`git checkout --detach FETCH_HEAD`, { cwd: tmpDir });
      await execAsync(`git reset --hard FETCH_HEAD`, { cwd: tmpDir });
    }

    console.log(`[INFO] Initializing agent session...`);

    // Judge auth only: pi's ModelRegistry resolves the Gemini judge's API key.
    // The agent itself no longer uses this registry.
    const authStorage = AuthStorage.create();
    const localModelsPath = join(process.cwd(), "models.json");
    const modelRegistry = existsSync(localModelsPath)
      ? ModelRegistry.create(authStorage, localModelsPath)
      : ModelRegistry.create(authStorage);

    // The `rei` agent. Provider + model are selected via env vars
    // (MODEL_PROVIDER / AGENT_MODEL_PROVIDER / *_MODEL_AGENT), which main()
    // populates by translating the CLI flags. `tmpDir` is the workspace; rei
    // applies its edits directly to disk there, so the later `git diff` captures them.
    agent = new Agent(createModelProvider(), tmpDir);
    try {
      await agent.connectMcp();
    } catch (e) {
      console.warn(`[WARN] MCP startup failed (continuing):`, e);
    }
    // Agent mode is REQUIRED — only that mode runs the autonomous tool-calling
    // loop that edits files. `ask`/`planning` would never touch the workspace.
    const session: ChatSession = { messages: [], mode: "agent" };
    console.log(`[INFO] Agent provider: ${process.env.AGENT_MODEL_PROVIDER || process.env.MODEL_PROVIDER}`);

    console.log(`\n--- Agent output ---`);
    const start = Date.now();
    const sweEnvInstruction = isSweContainer
      ? `7. The development environment is already fully configured with the correct Python version and all dependencies pre-installed. Do NOT install packages, create virtual environments, or modify the Python installation. Just focus on understanding and fixing the bug.\n8. If necessary you can write tests or modify existing tests to verify your fix. Avoid running the entire test suite though, if you can only focus on tests that are relevant to the code you're changing to ensure you're not introducing regressions.\n9. Make the MINIMAL changes necessary to fix the issue. Do not refactor unrelated code.\n10. TIME EFFICIENCY - Do NOT waste time on:\n    - Unnecessary git archaeology (git log, git show). Focus on the CURRENT code, not its history, unless you deem it essential to fix the issue.\n    - Re-running the same test with different pipe/grep/tail flags. Capture the full output ONCE and read it.\n    - Guessing test class/function names. If unsure, grep for the class name first BEFORE running.\n11. INFINITE LOOP PREVENTION - When running test suites or scripts that execute code you have modified, wrap the command with \`timeout\` to guard against inadvertent infinite loops (e.g., \`timeout 300 python -m pytest tests/test_xxx.py -xvs\`). No single test run should need more than 5 minutes.`
      : "";
    const agentPrompt = `You are an expert AI coding assistant. The target repository has ALREADY been cloned into your CURRENT WORKING DIRECTORY (\`${tmpDir}\`). 

CRITICAL INSTRUCTIONS:
1. Do NOT use \`git clone\` or download any repositories. The code is already here.
2. ALL your work (fixes and tests) must be done STRICTLY within your current working directory. Use relative paths (e.g., \`.\`) instead of absolute paths.
3. Do NOT explore, read, or modify files outside of your current working directory.
4. Focus only on fixing the issue described below and verifying your fix with tests.
5. You are running completely autonomously. There is NO human interaction. You must independently investigate, write the fix, verify it, and then STOP calling tools when you are done.
6. You are to complete the task and produce changes editing the files in this project. Do not stop without editing the files required to complete the task!
${sweEnvInstruction}

Issue Description:
${task.prompt}`;
    const timeoutMs = timeoutMin * 60 * 1000;
    let timedOut = false;

    // rei has no event bus and no external abort handle: one runTurn() IS the
    // full autonomous run — its tool loop, loop-guards and self-verify are all
    // internal. We only race it against a wall-clock timeout. Provider/connection
    // failures throw out of runTurn; surface them as the same fatal error pi used.
    const runPrompt = async (promptText: string): Promise<void> => {
      if (timedOut) return;
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("AGENT_TIMEOUT")), timeoutMs);
      });
      try {
        const response = await Promise.race([
          agent.runTurn(session, promptText),
          timeoutPromise,
        ]);
        process.stdout.write((response as string) + "\n");
      } catch (err: any) {
        if (err?.message === "AGENT_TIMEOUT") {
          console.error(`\n[ERROR] Agent execution timed out after ${timeoutMin} minutes.`);
          timedOut = true;
          return;
        }
        const msg = err?.message || String(err);
        if (/connection|fetch failed|socket|refused|lost|connect|timeout|timed out|500|502|503|504/i.test(msg)) {
          throw new Error(`Inference backend is unreachable or crashed: ${msg}`);
        }
        throw err;
      }
    };

    await runPrompt(agentPrompt);

    const getDiff = async () => {
      await execAsync(`git add .`, { cwd: tmpDir });
      try {
        const { stdout } = await execAsync(`git diff --cached`, { cwd: tmpDir });
        return stdout;
      } catch (e) {
        return "";
      }
    };

    console.log(`[INFO] Extracting diff...`);
    let diff = await getDiff();

    if (!diff.trim() && !timedOut) {
      console.log(`\n[INFO] Agent finished with no changes. Prompting to continue...`);
      const reminderPrompt = `You are running as part of an automated pipeline, as such you MUST complete the task you have been assigned and fully implement it now by editing all the required files in the workspace, autonomously and without any further interaction.\n\nReminder of your task:\n${task.prompt}\n\n[Tool results are returned. If the result is sufficient, answer now.]`;

      await runPrompt(reminderPrompt);

      console.log(`[INFO] Re-extracting diff...`);
      diff = await getDiff();
    }

    // Check if diff only contains config/environment files (no actual source code edits).
    // This catches a common failure pattern where the agent modifies setup.py/tox.ini
    // (environment artifacts) but never edits real source code.
    const CONFIG_ONLY_FILES = new Set([
      "setup.py", "setup.cfg", "tox.ini", "pyproject.toml",
      "requirements.txt", ".pre-commit-config.yaml", "Makefile",
      "MANIFEST.in", "pytest.ini", ".flake8", ".pylintrc",
    ]);

    const diffHasOnlyConfigFiles = (diffText: string): boolean => {
      if (!diffText.trim()) return false; // empty diff is handled separately
      const files: string[] = [];
      for (const line of diffText.split("\n")) {
        if (line.startsWith("diff --git")) {
          const parts = line.split(" ");
          if (parts.length >= 4) {
            const filePath = parts[3].replace(/^b\//, "");
            files.push(filePath.split("/").pop() || filePath);
          }
        }
      }
      if (files.length === 0) return false;
      return files.every((f) => CONFIG_ONLY_FILES.has(f));
    };

    if (diffHasOnlyConfigFiles(diff) && !timedOut) {
      console.log(
        `\n[INFO] Agent only modified config/build files (no source code edits). Prompting to make actual changes...`
      );
      const configOnlyPrompt = `IMPORTANT: You have only modified build/configuration files (such as setup.py, tox.ini, pyproject.toml) but have NOT made any actual source code changes. These config file changes are likely environment artifacts and do NOT address the issue.\n\nYou MUST edit the actual source code files to fix the bug described in the task. Go back to investigating the issue and implement the fix in the relevant Python source files.\n\nReminder of your task:\n${task.prompt}`;

      await runPrompt(configOnlyPrompt);

      console.log(`[INFO] Re-extracting diff after config-only re-prompt...`);
      diff = await getDiff();
    }

    const duration = Date.now() - start;
    console.log(`\n--- Agent finished in ${duration}ms ---\n`);

    console.log(`[INFO] Generated diff length: ${diff.length} characters`);

    let testOutput = "";
    let testExitCode: number | null = null;

    // SWE-bench container test evaluation: apply test patch and run FAIL_TO_PASS tests
    if (isSweContainer && task.failToPass && task.failToPass.length > 0) {
      console.log(`[INFO] Running SWE-bench FAIL_TO_PASS tests (${task.failToPass.length} tests)...`);

      // Apply the test patch
      if (task.testPatch) {
        console.log(`[INFO] Applying SWE-bench test patch...`);
        try {
          const patchPath = join(tmpDir, "swe_test.patch");
          await writeFile(patchPath, task.testPatch);

          // Revert any changes the agent made to standard test directories
          // to prevent patch conflicts with the SWE-bench evaluation testPatch.
          // IMPORTANT: Each directory MUST be reverted in its own command.
          // Passing multiple paths (e.g. `git checkout -- tests/ test/ testing/`)
          // causes git to abort the ENTIRE operation if ANY pathspec doesn't match,
          // silently leaving all test files un-reverted.
          console.log(`[INFO] Reverting agent test modifications to avoid conflicts...`);
          for (const testDir of ['tests/', 'test/', 'testing/']) {
            try {
              // Single atomic operation: restores both index and working tree to HEAD
              await execAsync(`git checkout HEAD -- ${testDir}`, { cwd: tmpDir });
              console.log(`[INFO] Reverted ${testDir} to HEAD.`);
            } catch {
              // Directory doesn't exist in this repo — expected, not an error
            }
          }
          // Clean any untracked files the agent may have added in test directories
          await execAsync(`git clean -fd tests/ test/ testing/ 2>/dev/null || true`, { cwd: tmpDir });

          try {
            await execAsync(`git apply swe_test.patch`, { cwd: tmpDir });
          } catch {
            console.log(`[INFO] Standard git apply failed, trying 3-way merge...`);
            await execAsync(`git apply --3way swe_test.patch`, { cwd: tmpDir });
          }
          console.log(`[INFO] Test patch applied successfully.`);
        } catch (e) {
          console.warn(`[WARN] Failed to apply test patch:`, e);
        }
      }

      // Run the test command appropriate for this repo
      const sweTestCmd = buildSweTestCommand(task);
      console.log(`[INFO] SWE test command: ${sweTestCmd}`);
      try {
        const { stdout, stderr } = await execAsync(sweTestCmd, {
          cwd: tmpDir, maxBuffer: 10 * 1024 * 1024, timeout: 300_000
        });
        testExitCode = 0;
        testOutput = `STDOUT:\n${stdout}\nSTDERR:\n${stderr}`;
      } catch (error: any) {
        testExitCode = error.code ?? 1;
        testOutput = `STDOUT:\n${error.stdout || ""}\nSTDERR:\n${error.stderr || ""}\nERROR: ${error.message}`;
      }
      console.log(`[INFO] SWE-bench test exit code: ${testExitCode}`);
    } else {
      // Original flow for non-SWE tasks
      if (task.testPatch) {
        console.log(`[INFO] Applying test patch...`);
        try {
          const patchPath = join(tmpDir, "test.patch");
          await writeFile(patchPath, task.testPatch);
          await execAsync(`git apply test.patch`, { cwd: tmpDir });
        } catch (e) {
          console.warn(`[WARN] Failed to apply test patch:`, e);
        }
      }

      if (task.testCommand) {
        console.log(`[INFO] Running test command: ${task.testCommand}...`);
        try {
          const { stdout, stderr } = await execAsync(task.testCommand, { cwd: tmpDir, maxBuffer: 10 * 1024 * 1024 });
          testExitCode = 0;
          testOutput = `STDOUT:\n${stdout}\nSTDERR:\n${stderr}`;
        } catch (error: any) {
          testExitCode = error.code ?? 1;
          testOutput = `STDOUT:\n${error.stdout}\nSTDERR:\n${error.stderr}\nERROR: ${error.message}`;
        }
        console.log(`[INFO] Test command finished with exit code ${testExitCode}`);
      }
    }

    console.log(`[INFO] Running LLM judge...`);
    // The judge is independent of the rei agent (Gemini via pi-ai). There is no
    // agent-side fallback model anymore, so --judge-model is required.
    const judgeModel = judgeModelReq;
    if (!judgeModel) throw new Error("Judge model not found — pass --judge-model <provider/id>");
    const auth = await modelRegistry.getApiKeyAndHeaders(judgeModel);
    if (!auth.ok) throw new Error("Judge auth failed: " + auth.error);

    let expectedDiff = task.expectedDiff || "";
    if (task.solutionCommit) {
      console.log(`[INFO] Fetching solution commit ${task.solutionCommit} to generate expected diff...`);
      await execAsync(`git fetch --depth 1 origin ${task.solutionCommit}`, { cwd: tmpDir });
      try {
        const { stdout } = await execAsync(`git diff ${task.commit} ${task.solutionCommit}`, { cwd: tmpDir });
        expectedDiff = stdout;
      } catch (e) {
        console.warn(`[WARN] Failed to generate diff for solution commit:`, e);
      }
    }

    const judgeSystemPrompt = `You are an expert software engineer judging the output of an AI coding agent.
You will be provided with the task prompt, the expected behavior, the git diff generated by the agent, and optionally a known correct "solution diff" and automated test output.
Your job is to determine if the diff successfully accomplishes the task. If automated tests were run, consider them a strong signal, but NOT the absolute ground truth. 
If a test fails (e.g., due to strict framework type assertions like expecting an integer instead of a string), but you determine the agent's code practically solves the user's issue in a valid way, you MAY still score it a 1. Provide a detailed rationale explaining why you bypassed the test failure.
Respond ONLY with a JSON object in this exact format, with no markdown wrapping:
{
  "score": 1,
  "rationale": "Explanation for the score"
}`;

    let truncatedTestOutput = testOutput;
    if (truncatedTestOutput.length > 15000) {
      truncatedTestOutput = truncatedTestOutput.substring(0, 5000) + "\n\n...[TRUNCATED]...\n\n" + truncatedTestOutput.substring(truncatedTestOutput.length - 10000);
    }

    // Build the test results section for the judge
    let testResultsSection = "";
    if (testExitCode !== null) {
      const testSource = isSweContainer ? "SWE-bench Container" : "Local";
      testResultsSection = `Automated Test Execution (${testSource}):\nExit Code: ${testExitCode}\nTests: ${isSweContainer && task.failToPass ? task.failToPass.join(", ") : (task.testCommand || "N/A")}\nOutput:\n${truncatedTestOutput}\n`;
    }

    const judgePrompt = `Task Prompt:
${task.prompt}

Expected Behavior:
${task.expectedBehavior || "Not specified."}

${expectedDiff ? `Known Correct Solution Diff:\n${expectedDiff}\n` : ""}
Agent Diff:
${diff ? diff : "(No changes made)"}

${testResultsSection}
`;

    let judgeOutput = "";
    const { streamSimple } = await import("@mariozechner/pi-ai");
    const stream = streamSimple(judgeModel, {
      systemPrompt: judgeSystemPrompt,
      messages: [{ role: "user", content: judgePrompt, timestamp: Date.now() }]
    }, {
      apiKey: auth.apiKey,
      headers: auth.headers,
      // Some judge models (e.g. gemini-3.1-pro-preview on OpenRouter) MANDATE
      // reasoning and 400 if it's disabled. Enable it; thinking arrives on its
      // own chunk type, so `judgeOutput` (text_delta only) stays clean JSON.
      // Harmlessly clamped for non-reasoning models.
      reasoning: "low",
    });

    for await (const chunk of stream) {
      if (chunk.type === "text_delta") {
        judgeOutput += chunk.delta;
      }
      if (chunk.type === "error") {
        console.error("[DEBUG] streamSimple error:", chunk.error);
      }
    }
    console.log("[DEBUG] Raw judge output:", judgeOutput);

    let score = 0;
    let rationale = "Failed to parse judge output";
    try {
      const jsonStr = judgeOutput.match(/\{[\s\S]*\}/)?.[0] || judgeOutput;
      const parsed = JSON.parse(jsonStr);
      score = parsed.score;
      rationale = parsed.rationale;
    } catch (e) {
      console.error("[ERROR] Failed to parse judge JSON", e);
      rationale = judgeOutput;
    }

    // The judge now provides the final score, taking test results into account but allowed to override them.
    const finalScore = score;
    const result: any = {
      task: task.id,
      durationMs: duration,
      diff,
      testExitCode,
      testOutput,
      judgeScore: finalScore,
      judgeRationale: rationale,
    };
    if (isSweContainer) {
      result.sweContainerTest = true;
      result.sweTestExitCode = testExitCode;
    }

    const resultPath = join(outputDir, `results-${task.id}.json`);
    await writeFile(resultPath, JSON.stringify(result, null, 2));
    console.log(`\n[INFO] Task Complete! Result saved to ${resultPath}`);

    const transcriptPath = join(outputDir, `transcript-${task.id}.json`);
    try {
      await writeFile(transcriptPath, JSON.stringify([...session.messages], null, 2));
      console.log(`[INFO] Agent transcript saved to ${transcriptPath}`);
    } catch (e) {
      console.warn(`[WARN] Could not save transcript to ${transcriptPath}`, e);
    }
    console.log(`[INFO] Score: ${result.judgeScore}`);
    console.log(`[INFO] Rationale: ${result.judgeRationale}`);

    return result;

  } finally {
    try {
      await agent?.disposeMcp();
    } catch { /* best-effort MCP teardown */ }
    if (!isSweContainer) {
      await rm(tmpDir, { recursive: true, force: true });
      console.log(`[INFO] Cleaned up ${tmpDir}`);
    } else {
      console.log(`[INFO] SWE-bench container — skipping /testbed cleanup.`);
    }
  }
}

/** TCP-probe an endpoint so we only init Laminar when its collector is actually up. */
function canConnect(host: string, port: number, timeoutMs = 600): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const finish = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

/**
 * Init Laminar ONLY when a key is set AND the collector is reachable. Otherwise the
 * OTLP exporter would flood ECONNREFUSED on every span. The Laminar server is optional
 * for benchmarking, so a missing collector is a one-line warning, not a failure. When
 * we skip init, rei's span helpers no-op (see isTelemetryEnabled in rei).
 */
async function setupTelemetry(): Promise<void> {
  if (!process.env.LMNR_PROJECT_API_KEY) {
    initTelemetry(); // logs "telemetry disabled" and no-ops
    return;
  }
  const host = (process.env.LMNR_BASE_URL ?? "http://localhost")
    .replace(/^https?:\/\//, "")
    .replace(/[/:].*$/, "");
  const port = Number(process.env.LMNR_GRPC_PORT ?? 8001);
  if (await canConnect(host, port)) {
    initTelemetry();
    console.log(`[telemetry] Laminar tracing enabled (${host}:${port}).`);
  } else {
    console.warn(`[telemetry] Laminar not reachable at ${host}:${port} — tracing disabled for this run.`);
  }
}

async function main() {
  // Bootstrap Laminar before any Agent/span is created — only if its collector is up.
  await setupTelemetry();

  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      model: { type: "string" },
      "judge-model": { type: "string" },
      "model-tag": { type: "string" },
      timeout: { type: "string", default: "30" },
      context: { type: "string" },
      platform: { type: "string" },
      provider: { type: "string" },
      engine: { type: "string" }, // backward compat alias for --provider
      "rocm-version": { type: "string", default: "7.2.4" },
      port: { type: "string" },
      "inference-profile": { type: "string" },
      "print-output-dir": { type: "boolean" },
    },
    allowPositionals: true,
  });

  // rei picks provider/model from env vars; translate the CLI flags into them
  // up-front, before any Agent is built. --provider wins, --engine is a legacy
  // alias. Default: llmstudio (local, supports tool-calling).
  const provider = (values.provider || values.engine || "llmstudio") as string;
  process.env.MODEL_PROVIDER = provider;
  process.env.AGENT_MODEL_PROVIDER = provider;

  const targetPath = positionals[0];
  if (!targetPath && !values["print-output-dir"]) {
    console.error("Usage: bun run src/index.ts <task-file-or-dir> [--provider llama.cpp|ds4|openrouter] [--model model-id] [--judge-model provider/model-id] [--model-tag tag] [--platform platform-id] [--rocm-version 7.2.4] [--port 8080] [--context tokens] [--inference-profile params]");
    process.exit(1);
  }

  // Map --model to the provider-specific *_MODEL_AGENT env var rei reads for
  // agent mode (see resolveModelForMode in rei's provider-factory).
  const AGENT_MODEL_ENV: Record<string, string> = {
    openrouter: "OPENROUTER_MODEL_AGENT",
    ollama: "OLLAMA_MODEL_AGENT",
    groq: "GROQ_MODEL_AGENT",
    gemini: "GEMINI_MODEL_AGENT",
    huggingface: "HF_MODEL_AGENT",
    llmstudio: "LLM_STUDIO_MODEL_AGENT",
  };
  if (values.model) {
    const envVar = AGENT_MODEL_ENV[provider];
    if (envVar) process.env[envVar] = values.model as string;
    else console.warn(`[WARN] Unknown provider "${provider}" — cannot map --model to an env var.`);
  }

  // Judge model is independent of the agent (resolved via pi-ai). Format is
  // <provider>/<model-id>; the model-id itself may contain slashes (e.g.
  // OpenRouter's "openrouter/deepseek/deepseek-chat"), so keep everything after
  // the first segment as the id.
  let judgeModelReq;
  if (values["judge-model"]) {
    const parts = values["judge-model"].split("/");
    judgeModelReq = parts.length > 1 ? getModel(parts[0] as any, parts.slice(1).join("/")) : undefined;
    if (!judgeModelReq && !values["print-output-dir"]) console.warn(`[WARN] Could not resolve judge model ${values["judge-model"]}. Using default.`);
  }

  // Results-dir naming: prefer the explicit --model, then the provider's default
  // agent model from env, then a provider-tagged fallback.
  const modelTag = values["model-tag"] as string | undefined;
  const exactModelId =
    (values.model as string) ||
    process.env[AGENT_MODEL_ENV[provider] ?? ""] ||
    `rei-${provider}`;
  let outputDir = `${exactModelId.replace(/[^a-zA-Z0-9_-]/g, "_")}_results`;

  // Append model tag to directory name for filesystem uniqueness
  if (modelTag) {
    outputDir = outputDir.replace(/_results$/, `-${modelTag}_results`);
  }

  if (values.platform) {
    outputDir = join("benchmark_results", values.platform as string, outputDir);
  }

  if (values["print-output-dir"]) {
    console.log(outputDir);
    process.exit(0);
  }

  const s = await stat(targetPath);
  const taskFiles: string[] = [];
  if (s.isDirectory()) {
    const files = await readdir(targetPath);
    for (const f of files) {
      if (f.endsWith(".json")) {
        taskFiles.push(join(targetPath, f));
      }
    }
  } else {
    taskFiles.push(targetPath);
  }

  if (taskFiles.length === 0) {
    console.log(`[INFO] No task JSON files found in ${targetPath}`);
    return;
  }

  console.log(`[INFO] Found ${taskFiles.length} tasks to run.`);
  const timeoutMin = parseInt(values.timeout as string, 10) || 30;
  const contextWindowOverride = values.context ? parseInt(values.context as string, 10) : undefined;
  if (contextWindowOverride) {
    // rei reads REI_CONTEXT_WINDOW for its token budget (model-runtime.ts).
    process.env.REI_CONTEXT_WINDOW = String(contextWindowOverride);
    console.log(`[INFO] Context window override: ${contextWindowOverride} tokens`);
  }

  await mkdir(outputDir, { recursive: true });
  const runMeta: any = {
    modelTag,
    backend: provider,
    rocm: values["rocm-version"],
    exactModelId
  };
  if (values["inference-profile"]) {
    runMeta.inferenceProfile = values["inference-profile"];
  }
  if (contextWindowOverride) {
    runMeta.contextWindowOverride = contextWindowOverride;
  }
  await writeFile(join(outputDir, "run-meta.json"), JSON.stringify(runMeta, null, 2));
  console.log(`[INFO] Saving results to directory: ${outputDir}`);

  const results = [];
  let passed = 0;
  let totalDuration = 0;

  for (const f of taskFiles) {
    try {
      const content = await readFile(f, "utf-8");
      const task = JSON.parse(content);
      const resultFile = join(outputDir, `results-${task.id}.json`);

      try {
        const existing = await readFile(resultFile, "utf-8");
        const res = JSON.parse(existing);
        console.log(`[INFO] Skipping ${task.id}, result already exists.`);
        results.push(res);
        if (res.judgeScore === 1) passed++;
        totalDuration += res.durationMs;
        continue;
      } catch (e) {
        // file doesn't exist, proceed
      }
    } catch (e) {
      console.warn(`[WARN] Could not pre-parse task file ${f} for resume check.`);
    }

    const res = await runTask(f, judgeModelReq, outputDir, timeoutMin);
    results.push(res);
    if (res.judgeScore === 1) passed++;
    totalDuration += res.durationMs;
  }

  const summary = {
    totalTasks: results.length,
    passedTasks: passed,
    passRate: passed / results.length,
    totalDurationMs: totalDuration,
    averageDurationMs: totalDuration / results.length,
    results
  };

  const summaryPath = join(outputDir, "summary.json");
  await writeFile(summaryPath, JSON.stringify(summary, null, 2));
  console.log(`\n======================================================`);
  console.log(`[INFO] Benchmark Suite Complete!`);
  console.log(`[INFO] Pass Rate: ${(summary.passRate * 100).toFixed(2)}% (${passed}/${results.length})`);
  console.log(`[INFO] Summary saved to ${summaryPath}`);
  console.log(`======================================================\n`);
}

main()
  .then(async () => {
    await shutdownTelemetry(); // flush spans before exit
    process.exit(0);
  })
  .catch(async (e) => {
    console.error(e);
    await shutdownTelemetry();
    if (e instanceof Error && e.message.includes("Inference backend is unreachable")) {
      process.exit(2);
    }
    process.exit(1);
  });
