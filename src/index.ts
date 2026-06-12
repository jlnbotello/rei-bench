import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { existsSync } from "node:fs";

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

async function runTask(taskFile: string, agentModelReq: any, judgeModelReq: any, outputDir: string = ".", timeoutMin: number = 30, provider: string = "llama.cpp", port?: string) {
  const taskContent = await readFile(taskFile, "utf-8");
  const task = JSON.parse(taskContent);

  console.log(`\n======================================================`);
  console.log(`[INFO] Starting benchmark for task file: ${taskFile}`);
  console.log(`======================================================\n`);

  const sweTestbed = "/testbed";
  const isSweContainer = existsSync(sweTestbed);
  const tmpDir = isSweContainer ? sweTestbed : await mkdtemp(join(tmpdir(), "pi-bench-"));
  console.log(`[INFO] Working directory: ${tmpDir} (SWE container: ${isSweContainer})`);

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
    const authStorage = AuthStorage.create();

    const localModelsPath = join(process.cwd(), "models.json");
    let modelRegistry;
    if (existsSync(localModelsPath)) {
      console.log(`[INFO] Using local models.json configuration`);
      if (port) {
        const modelsContent = await readFile(localModelsPath, "utf-8");
        const modelsData = JSON.parse(modelsContent);
        if (modelsData.providers && modelsData.providers[provider] && modelsData.providers[provider].baseUrl) {
          modelsData.providers[provider].baseUrl = modelsData.providers[provider].baseUrl.replace(/:\d+/, `:${port}`);
        }
        const tmpModelsPath = tmpDir + "-models.json";
        await writeFile(tmpModelsPath, JSON.stringify(modelsData));
        modelRegistry = ModelRegistry.create(authStorage, tmpModelsPath);
      } else {
        modelRegistry = ModelRegistry.create(authStorage, localModelsPath);
      }
    } else {
      if (port) {
        const modelsData = {
          providers: {
            [provider]: {
              baseUrl: `http://localhost:${port}/v1`,
              api: "openai-completions",
              apiKey: "none",
              models: [{ id: "local-model", contextWindow: 128000, maxTokens: 65536 }]
            }
          }
        };
        const tmpModelsPath = tmpDir + "-models.json";
        await writeFile(tmpModelsPath, JSON.stringify(modelsData));
        modelRegistry = ModelRegistry.create(authStorage, tmpModelsPath);
      } else {
        modelRegistry = ModelRegistry.create(authStorage);
      }
    }

    let resolvedAgentModel;
    if (agentModelReq) {
      resolvedAgentModel = modelRegistry.find(agentModelReq.provider, agentModelReq.id);
      if (!resolvedAgentModel) {
        throw new Error(`Could not find model ${agentModelReq.provider}/${agentModelReq.id} in registry`);
      }
    } else {
      const providerModels = modelRegistry.getAll().filter(m => m.provider === provider);
      if (providerModels.length > 0) {
        resolvedAgentModel = providerModels[0];
        console.log(`[INFO] No agent model specified, defaulting to ${resolvedAgentModel.provider}/${resolvedAgentModel.id}`);
      }
    }

    const { session } = await createAgentSession({
      cwd: tmpDir,
      sessionManager: SessionManager.inMemory(tmpDir),
      authStorage,
      modelRegistry,
      model: resolvedAgentModel,
    });

    console.log(`[INFO] Agent resolved to model: ${session.model?.provider}/${session.model?.id}`);

    let lastToolName = "";
    let lastToolArgs = "";
    let repeatedToolCount = 0;
    let loopDetected = false;

    session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent) {
        if (event.assistantMessageEvent.type === "text_delta") {
          process.stdout.write(event.assistantMessageEvent.delta);
        } else if (event.assistantMessageEvent.type === "error") {
          console.error(`\n[ERROR] Agent LLM Error:`, event.assistantMessageEvent.error);
        }
      } else if (event.type === "tool_execution_start") {
        let argsStr = "";
        try {
          argsStr = JSON.stringify(event.args);

          if (argsStr === lastToolArgs && event.toolName === lastToolName) {
            repeatedToolCount++;
          } else {
            repeatedToolCount = 1;
            lastToolName = event.toolName;
            lastToolArgs = argsStr;
          }

          if (repeatedToolCount >= 3) {
            console.warn(`\n[WARN] Loop detected! Tool ${event.toolName} called ${repeatedToolCount} times with same arguments.`);
            loopDetected = true;
            session.abort();
          }

          if (argsStr.length > 200) argsStr = argsStr.substring(0, 200) + "...";
        } catch (e) { }
        console.log(`\n[AGENT] Started using tool: ${event.toolName} with args: ${argsStr}`);
      } else if (event.type === "tool_execution_end") {
        console.log(`[AGENT] Finished tool: ${event.toolName}`);
        if (event.result) {
          try {
            let resStr = typeof event.result === 'string' ? event.result : JSON.stringify(event.result);
            if (resStr.length > 500) resStr = resStr.substring(0, 500) + "... [TRUNCATED]";
            console.log(`[AGENT] Tool result: ${resStr}`);
          } catch (e) { }
        }
      } else if (event.type === "auto_retry_start") {
        console.warn(`\n[WARN] Agent retrying (${event.attempt}/${event.maxAttempts}): ${event.errorMessage}`);
      }
    });

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
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("AGENT_TIMEOUT")), timeoutMs);
    });

    let timedOut = false;

    const runPromptWithLoopDetection = async (promptText: string) => {
      let currentPrompt = promptText;
      let maxLoops = 3;

      while (!timedOut && maxLoops > 0) {
        try {
          await Promise.race([
            session.prompt(currentPrompt),
            timeoutPromise
          ]);
          if (loopDetected) throw new Error("LOOP_DETECTED");
          break; // Finished successfully
        } catch (err: any) {
          if (err.message === "AGENT_TIMEOUT") {
            console.error(`\n[ERROR] Agent execution timed out after ${timeoutMin} minutes. Aborting...`);
            await session.abort();
            timedOut = true;
          } else if (loopDetected || err.message === "LOOP_DETECTED" || err.name === "AbortError" || err.message?.includes("abort")) {
            console.log(`\n[INFO] Recovering from tool loop... Prompting agent to try something else.`);
            currentPrompt = `SYSTEM WARNING: You are repeatedly calling the tool \`${lastToolName}\` with the exact same arguments: \`${lastToolArgs}\`. This is an infinite loop. The last execution was aborted. You MUST try a completely different approach, use different arguments, or implement the fix now.\n\n[Tool results are returned. If the result is sufficient, answer now.]`;
            loopDetected = false;
            repeatedToolCount = 0;
            lastToolName = "";
            lastToolArgs = "";
            maxLoops--;
          } else {
            throw err;
          }
        }
      }
    };

    await runPromptWithLoopDetection(agentPrompt);

    let lastAssistant = [...session.messages].reverse().find(m => m.role === "assistant") as any;
    if (lastAssistant && lastAssistant.stopReason === "error") {
      const errorMsg = lastAssistant.errorMessage || "Unknown error";
      const isConnectionError = /connection|fetch failed|socket|refused|lost|connect|timeout|timed out|500|502|503|504/i.test(errorMsg);
      if (isConnectionError) {
        throw new Error(`Inference backend is unreachable or crashed: ${errorMsg}`);
      }
    }

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

    if (!diff.trim() && !timedOut && (!lastAssistant || lastAssistant.stopReason !== "error")) {
      console.log(`\n[INFO] Agent finished with no changes. Prompting to continue...`);
      const reminderPrompt = `You are running as part of an automated pipeline, as such you MUST complete the task you have been assigned and fully implement it now by editing all the required files in the workspace, autonomously and without any further interaction.\n\nReminder of your task:\n${task.prompt}\n\n[Tool results are returned. If the result is sufficient, answer now.]`;

      try {
        await runPromptWithLoopDetection(reminderPrompt);
      } catch (err: any) {
        if (err.message === "AGENT_TIMEOUT") {
          // Already handled in runPromptWithLoopDetection, but just in case
        } else {
          throw err;
        }
      }

      lastAssistant = [...session.messages].reverse().find(m => m.role === "assistant") as any;
      if (lastAssistant && lastAssistant.stopReason === "error") {
        const errorMsg = lastAssistant.errorMessage || "Unknown error";
        const isConnectionError = /connection|fetch failed|socket|refused|lost|connect|timeout|timed out|500|502|503|504/i.test(errorMsg);
        if (isConnectionError) {
          throw new Error(`Inference backend is unreachable or crashed: ${errorMsg}`);
        }
      }

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

    if (
      diffHasOnlyConfigFiles(diff) &&
      !timedOut &&
      (!lastAssistant || lastAssistant.stopReason !== "error")
    ) {
      console.log(
        `\n[INFO] Agent only modified config/build files (no source code edits). Prompting to make actual changes...`
      );
      const configOnlyPrompt = `IMPORTANT: You have only modified build/configuration files (such as setup.py, tox.ini, pyproject.toml) but have NOT made any actual source code changes. These config file changes are likely environment artifacts and do NOT address the issue.\n\nYou MUST edit the actual source code files to fix the bug described in the task. Go back to investigating the issue and implement the fix in the relevant Python source files.\n\nReminder of your task:\n${task.prompt}`;

      try {
        await runPromptWithLoopDetection(configOnlyPrompt);
      } catch (err: any) {
        if (err.message === "AGENT_TIMEOUT") {
          // handled
        } else {
          throw err;
        }
      }

      lastAssistant = [...session.messages]
        .reverse()
        .find((m) => m.role === "assistant") as any;
      if (lastAssistant && lastAssistant.stopReason === "error") {
        const errorMsg = lastAssistant.errorMessage || "Unknown error";
        const isConnectionError =
          /connection|fetch failed|socket|refused|lost|connect|timeout|timed out|500|502|503|504/i.test(
            errorMsg
          );
        if (isConnectionError) {
          throw new Error(
            `Inference backend is unreachable or crashed: ${errorMsg}`
          );
        }
      }

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
    const judgeModel = judgeModelReq || session.state.model;
    if (!judgeModel) throw new Error("Judge model not found");
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
    }, { apiKey: auth.apiKey, headers: auth.headers });

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
    if (!isSweContainer) {
      await rm(tmpDir, { recursive: true, force: true });
      console.log(`[INFO] Cleaned up ${tmpDir}`);
    } else {
      console.log(`[INFO] SWE-bench container — skipping /testbed cleanup.`);
    }
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      model: { type: "string" },
      "judge-model": { type: "string" },
      "model-tag": { type: "string" },
      timeout: { type: "string", default: "30" },
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

  // --provider takes precedence, --engine is a backward-compat alias
  const provider = (values.provider || values.engine || "llama.cpp") as string;

  const targetPath = positionals[0];
  if (!targetPath && !values["print-output-dir"]) {
    console.error("Usage: bun run src/index.ts <task-file-or-dir> [--provider llama.cpp|ds4|openrouter] [--model model-id] [--judge-model provider/model-id] [--model-tag tag] [--platform platform-id] [--rocm-version 7.2.4] [--port 8080] [--inference-profile params]");
    process.exit(1);
  }

  let agentModelReq;
  if (values.model) {
    const modelVal = values.model;
    // If --model contains a slash AND --provider is set, treat --model as just the model ID
    // Otherwise, parse provider/model from --model (backward compat: --model openrouter/deepseek/deepseek-v4-flash)
    if (modelVal.includes("/") && !values.provider) {
      const parts = modelVal.split("/");
      agentModelReq = { provider: parts[0] as any, id: parts.slice(1).join("/") };
    } else {
      // --model is just the model ID, use --provider for the provider
      agentModelReq = { provider: provider as any, id: modelVal };
    }
  }

  let judgeModelReq;
  if (values["judge-model"]) {
    const parts = values["judge-model"].split("/");
    judgeModelReq = parts.length > 1 ? getModel(parts[0] as any, parts[1]) : undefined;
    if (!judgeModelReq && !values["print-output-dir"]) console.warn(`[WARN] Could not resolve judge model ${values["judge-model"]}. Using default.`);
  }

  const modelTag = values["model-tag"] as string | undefined;
  const isLocalProvider = provider === "llama.cpp" || provider === "ds4";
  let outputDir = "results";
  if (isLocalProvider) {
    try {
      const fetchPort = values.port || (provider === "ds4" ? "8000" : "8080");
      const res = await fetch(`http://localhost:${fetchPort}/v1/models`);
      const data = await res.json();
      if (data && data.data && data.data.length > 0) {
        const quantName = data.data[0].id.replace(/[^a-zA-Z0-9_-]/g, "_");
        outputDir = `${quantName}_results`;
      } else if (agentModelReq) {
        outputDir = `${agentModelReq.id.replace(/\\\//g, "_")}_results`;
      }
    } catch (e) {
      if (agentModelReq) {
        outputDir = `${agentModelReq.id.replace(/\\\//g, "_")}_results`;
      }
    }
  } else if (agentModelReq) {
    outputDir = `${agentModelReq.id.replace(/\//g, "_")}_results`;
  }

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

  await mkdir(outputDir, { recursive: true });
  const runMeta: any = {
    modelTag,
    backend: provider,
    rocm: values["rocm-version"]
  };
  if (values["inference-profile"]) {
    runMeta.inferenceProfile = values["inference-profile"];
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

    const res = await runTask(f, agentModelReq, judgeModelReq, outputDir, timeoutMin, provider, values.port as string);
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

main().catch((e) => { console.error(e); process.exit(1); }).then(() => process.exit(0));
