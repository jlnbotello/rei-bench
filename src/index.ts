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

async function runTask(taskFile: string, agentModelReq: any, judgeModelReq: any, outputDir: string = ".", timeoutMin: number = 30) {
  const taskContent = await readFile(taskFile, "utf-8");
  const task = JSON.parse(taskContent);

  console.log(`\n======================================================`);
  console.log(`[INFO] Starting benchmark for task file: ${taskFile}`);
  console.log(`======================================================\n`);
  
  const tmpDir = await mkdtemp(join(tmpdir(), "pi-bench-"));
  console.log(`[INFO] Working directory: ${tmpDir}`);

  try {
    console.log(`[INFO] Cloning ${task.repo} at commit ${task.commit}...`);
    await execAsync(`git init`, { cwd: tmpDir });
    await execAsync(`git remote add origin https://github.com/${task.repo}.git`, { cwd: tmpDir });
    await execAsync(`git fetch --depth 1 origin ${task.commit}`, { cwd: tmpDir });
    await execAsync(`git checkout --detach FETCH_HEAD`, { cwd: tmpDir });
    await execAsync(`git reset --hard FETCH_HEAD`, { cwd: tmpDir });

    console.log(`[INFO] Initializing agent session...`);
    const authStorage = AuthStorage.create();
    
    const localModelsPath = join(process.cwd(), "models.json");
    let modelRegistry;
    if (existsSync(localModelsPath)) {
      console.log(`[INFO] Using local models.json configuration`);
      modelRegistry = ModelRegistry.create(authStorage, localModelsPath);
    } else {
      modelRegistry = ModelRegistry.create(authStorage);
    }
    
    let resolvedAgentModel;
    if (agentModelReq) {
      resolvedAgentModel = modelRegistry.find(agentModelReq.provider, agentModelReq.id);
      if (!resolvedAgentModel) {
        throw new Error(`Could not find model ${agentModelReq.provider}/${agentModelReq.id} in registry`);
      }
    } else {
      const llamaModels = modelRegistry.getAll().filter(m => m.provider === "llama.cpp");
      if (llamaModels.length > 0) {
        resolvedAgentModel = llamaModels[0];
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
          if (argsStr.length > 200) argsStr = argsStr.substring(0, 200) + "...";
        } catch (e) {}
        console.log(`\n[AGENT] Started using tool: ${event.toolName} with args: ${argsStr}`);
      } else if (event.type === "tool_execution_end") {
        console.log(`[AGENT] Finished tool: ${event.toolName}`);
      } else if (event.type === "auto_retry_start") {
        console.warn(`\n[WARN] Agent retrying (${event.attempt}/${event.maxAttempts}): ${event.errorMessage}`);
      }
    });

    console.log(`\n--- Agent output ---`);
    const start = Date.now();
    const agentPrompt = `You are a benchmark agent. The target repository has ALREADY been cloned into your CURRENT WORKING DIRECTORY. 

CRITICAL INSTRUCTIONS:
1. Do NOT use \`git clone\` or download any repositories. The code is already here.
2. ALL your work (fixes and tests) must be done STRICTLY within your current working directory.
3. Do NOT explore, read, or modify files outside of your current working directory.
4. Focus only on fixing the issue described below and verifying your fix with tests.

Issue Description:
${task.prompt}`;
    const timeoutMs = timeoutMin * 60 * 1000;
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("AGENT_TIMEOUT")), timeoutMs);
    });

    try {
      await Promise.race([
        session.prompt(agentPrompt),
        timeoutPromise
      ]);
    } catch (err: any) {
      if (err.message === "AGENT_TIMEOUT") {
        console.error(`\n[ERROR] Agent execution timed out after ${timeoutMin} minutes. Aborting...`);
        await session.abort();
      } else {
        throw err;
      }
    }

    const lastAssistant = [...session.messages].reverse().find(m => m.role === "assistant") as any;
    if (lastAssistant && lastAssistant.stopReason === "error") {
      const errorMsg = lastAssistant.errorMessage || "Unknown error";
      const isConnectionError = /connection|fetch failed|socket|refused|lost|connect|timeout|timed out|500|502|503|504/i.test(errorMsg);
      if (isConnectionError) {
        throw new Error(`Inference backend is unreachable or crashed: ${errorMsg}`);
      }
    }

    const duration = Date.now() - start;
    console.log(`\n--- Agent finished in ${duration}ms ---\n`);

    console.log(`[INFO] Extracting diff...`);
    await execAsync(`git add .`, { cwd: tmpDir });
    let diff = "";
    try {
      const { stdout } = await execAsync(`git diff --cached`, { cwd: tmpDir });
      diff = stdout;
    } catch (e) {
      diff = "";
    }

    console.log(`[INFO] Generated diff length: ${diff.length} characters`);

    let testOutput = "";
    let testExitCode: number | null = null;
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
Your job is to determine if the diff successfully accomplishes the task. If tests were run, verify that the exit code is 0 (or indicates success).
Respond ONLY with a JSON object in this exact format, with no markdown wrapping:
{
  "score": 1,
  "rationale": "Explanation for the score"
}`;

    let truncatedTestOutput = testOutput;
    if (truncatedTestOutput.length > 15000) {
      truncatedTestOutput = truncatedTestOutput.substring(0, 5000) + "\n\n...[TRUNCATED]...\n\n" + truncatedTestOutput.substring(truncatedTestOutput.length - 10000);
    }

    const judgePrompt = `Task Prompt:
${task.prompt}

Expected Behavior:
${task.expectedBehavior || "Not specified."}

${expectedDiff ? `Known Correct Solution Diff:\n${expectedDiff}\n` : ""}
Agent Diff:
${diff ? diff : "(No changes made)"}

${task.testCommand ? `Automated Test Execution:\nCommand: ${task.testCommand}\nExit Code: ${testExitCode}\nOutput:\n${truncatedTestOutput}\n` : ""}
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

    // The judge has evaluated the test output and determined the final score.
    // We trust the judge's assessment of whether test failures are related to the task.
    const result = {
      task: task.id,
      durationMs: duration,
      diff,
      testExitCode,
      testOutput,
      judgeScore: score,
      judgeRationale: rationale
    };

    const resultPath = join(outputDir, `results-${task.id}.json`);
    await writeFile(resultPath, JSON.stringify(result, null, 2));
    console.log(`\n[INFO] Task Complete! Result saved to ${resultPath}`);
    console.log(`[INFO] Score: ${result.judgeScore}`);
    console.log(`[INFO] Rationale: ${result.judgeRationale}`);

    return result;

  } finally {
    await rm(tmpDir, { recursive: true, force: true });
    console.log(`[INFO] Cleaned up ${tmpDir}`);
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
    },
    allowPositionals: true,
  });

  const targetPath = positionals[0];
  if (!targetPath) {
    console.error("Usage: bun run src/index.ts <task-file-or-dir> [--model provider/model-id] [--judge-model provider/model-id] [--model-tag tag] [--platform platform-id]");
    process.exit(1);
  }

  let agentModelReq;
  if (values.model) {
    const parts = values.model.split("/");
    agentModelReq = parts.length > 1 ? { provider: parts[0] as any, id: parts.slice(1).join("/") } : undefined;
  }

  let judgeModelReq;
  if (values["judge-model"]) {
    const parts = values["judge-model"].split("/");
    judgeModelReq = parts.length > 1 ? getModel(parts[0], parts[1]) : undefined;
    if (!judgeModelReq) console.warn(`[WARN] Could not resolve judge model ${values["judge-model"]}. Using default.`);
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
  
  const modelTag = values["model-tag"] as string | undefined;
  let outputDir = "results";
  if (!agentModelReq || agentModelReq.provider === "llama.cpp") {
    try {
      const res = await fetch("http://localhost:8080/v1/models");
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

  await mkdir(outputDir, { recursive: true });
  if (modelTag) {
    await writeFile(join(outputDir, "run-meta.json"), JSON.stringify({ modelTag }, null, 2));
  }
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
    } catch(e) {
      console.warn(`[WARN] Could not pre-parse task file ${f} for resume check.`);
    }

    const res = await runTask(f, agentModelReq, judgeModelReq, outputDir, timeoutMin);
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

main().catch(console.error);
