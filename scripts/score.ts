/**
 * Read-only scoring of benchmark_results on the SWE-bench ground truth.
 *
 *   bun run scripts/score.ts                  # all runs, one line each
 *   bun run scripts/score.ts --run w131k      # per-task detail for matching runs
 *   bun run scripts/score.ts --gap            # only tasks where judge and tests disagree
 *
 * Writes nothing. `generate-report.ts` and `summary.json` both count `judgeScore`,
 * which its system prompt explicitly licenses to override a failing test ("strict
 * framework type assertions like expecting an integer instead of a string"). That
 * makes it a plausibility rating, not a result. SWE-bench's contract is the
 * FAIL_TO_PASS tests, so `sweTestExitCode` is what this reports.
 *
 * The two agree while an agent produces empty diffs (nothing to be generous about)
 * and diverge as it starts producing plausible-but-wrong ones — so the GAP column
 * is itself a signal, not just bookkeeping.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

type Result = {
  task: string;
  sweTestExitCode?: number | null;
  judgeScore?: number;
  diff?: string;
  durationMs?: number;
};

type Run = { dir: string; label: string; results: Result[] };

const ROOT = join(import.meta.dir, "..");
const args = process.argv.slice(2);
const runFilter = args.includes("--run") ? args[args.indexOf("--run") + 1] : undefined;
const gapOnly = args.includes("--gap");

/** Every directory holding results-*.json, at any depth under benchmark_results/. */
async function findRunDirs(dir: string, out: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  if (entries.some((e) => e.isFile() && e.name.startsWith("results-"))) out.push(dir);
  for (const e of entries) if (e.isDirectory()) await findRunDirs(join(dir, e.name), out);
  return out;
}

async function loadRun(dir: string): Promise<Run> {
  const files = (await readdir(dir)).filter(
    // `-attemptN` files are retries; the unsuffixed file is the run's final answer.
    (f) => f.startsWith("results-") && f.endsWith(".json") && !f.includes("-attempt"),
  );
  const results: Result[] = [];
  for (const f of files) {
    try {
      results.push(JSON.parse(await readFile(join(dir, f), "utf-8")));
    } catch {
      /* a run killed mid-write leaves a truncated file — skip it, don't abort */
    }
  }
  results.sort((a, b) => (a.task ?? "").localeCompare(b.task ?? ""));
  return { dir, label: dir.substring(dir.indexOf("benchmark_results") + 18), results };
}

const scored = (r: Result) => r.sweTestExitCode !== undefined && r.sweTestExitCode !== null;
const testPass = (r: Result) => r.sweTestExitCode === 0;
const judgePass = (r: Result) => (r.judgeScore ?? 0) >= 1;

const dirs = await findRunDirs(join(ROOT, "benchmark_results"));
const runs = (await Promise.all(dirs.map(loadRun)))
  .filter((r) => r.results.length > 0)
  .filter((r) => !runFilter || r.label.includes(runFilter))
  .sort((a, b) => a.label.localeCompare(b.label));

if (runs.length === 0) {
  console.log(runFilter ? `No runs matching "${runFilter}".` : "No results found.");
  process.exit(0);
}

const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);
console.log(
  `\n${pad("run", 56)}${"n".padStart(5)}${"scored".padStart(8)}${"TEST".padStart(13)}${"judge".padStart(9)}${"gap".padStart(6)}`,
);
console.log("-".repeat(97));

for (const run of runs) {
  const n = run.results.length;
  const s = run.results.filter(scored).length;
  const t = run.results.filter(testPass).length;
  const j = run.results.filter(judgePass).length;
  const rate = s > 0 ? `${t}/${s} (${Math.round((t / s) * 100)}%)` : "—";
  console.log(
    pad(run.label, 56) +
      String(n).padStart(5) +
      String(s).padStart(8) +
      rate.padStart(13) +
      `${j}/${n}`.padStart(9) +
      String(j - t).padStart(6),
  );
}

if (runs.some((r) => r.results.some((x) => !scored(x)))) {
  console.log(
    `\nNOTE: unscored tasks ran outside the SWE container (bun run src/index.ts).\n` +
      `      Only ./run-swe-bench.sh executes FAIL_TO_PASS and sets sweTestExitCode.`,
  );
}

// Per-task detail: only when a run is named, or when asking for the disagreements.
if (runFilter || gapOnly) {
  for (const run of runs) {
    const rows = run.results.filter((r) => !gapOnly || (scored(r) && testPass(r) !== judgePass(r)));
    if (rows.length === 0) continue;
    console.log(`\n=== ${run.label}`);
    for (const r of rows) {
      const verdict = !scored(r) ? "UNSCORED" : testPass(r) ? "PASS" : "FAIL";
      const flag = scored(r) && testPass(r) !== judgePass(r) ? "  <-- judge disagrees" : "";
      console.log(
        `  ${pad(r.task ?? "?", 26)}${pad(verdict, 10)}judge=${String(r.judgeScore ?? "-").padEnd(5)}` +
          `${String((r.diff ?? "").length).padStart(7)}ch${String(Math.round((r.durationMs ?? 0) / 1000)).padStart(6)}s${flag}`,
      );
    }
  }
}
console.log();
