/**
 * The runner.
 *
 * Three modes, and the split between them is about cost rather than thoroughness:
 *
 *   npm run eval:brief                 grade what is recorded. Free. The CI gate.
 *   npm run eval:brief -- --live       write fresh briefs, record them, grade.
 *   npm run eval:brief -- --live --judge   ...and measure groundedness with a model.
 *
 * Recording the generations is what makes the free mode possible. The
 * deterministic graders are pure functions of (brief, context), so once a brief
 * exists on disk every future change to a grader can be re-run against the whole
 * corpus for nothing — which means grader development is fast and does not cost
 * a call per iteration.
 *
 * A recording is bound to the fixture it came from by a hash. Edit the fixture
 * and the recording is stale, and stale is a failure rather than a shrug:
 * grading last week's brief against this week's context measures nothing and
 * would report a clean pass while doing it.
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildPrompt, composeBrief, SYSTEM } from "@/lib/llm/brief";
import { BRIEF_MODEL, isLlmConfigured } from "@/lib/llm/client";
import { CASES, type EvalCase } from "./fixtures";
import { gradeDeterministic, type Finding } from "./graders";
import { judge, type JudgeResult } from "./judge";

const RECORDED = join("evals", "brief", "recorded");

/**
 * Where a run's briefs live.
 *
 * The production model writes to `recorded/`, which is what CI grades and what
 * gets committed. A candidate model writes somewhere else, so an experiment can
 * never quietly replace the baseline it is being compared against.
 */
function recordingDir(model: string): string {
  if (model === BRIEF_MODEL) return RECORDED;
  return join("evals", "brief", "compare", model.replace(/[^a-z0-9.-]/gi, "-"));
}
/** Enough to keep the run quick; low enough not to trip rate limits. */
const CONCURRENCY = 4;

interface Recording {
  id: string;
  promptHash: string;
  model: string;
  generatedAt: string;
  /** One entry per sample. Temperature makes a single generation an anecdote. */
  texts: string[];
}

/**
 * What a recording is bound to.
 *
 * The fixture AND the instructions. Binding to the context alone was not
 * enough: editing the system prompt changes what the model is asked to do
 * while leaving every context byte-identical, so the recordings stayed
 * "fresh" and the corpus went on grading output from a prompt that no longer
 * existed. Hashing the rendered prompt catches both in one value.
 */
function hashOf(evalCase: EvalCase): string {
  return createHash("sha256")
    .update(SYSTEM)
    .update("\u0000")
    .update(buildPrompt(evalCase.context))
    .digest("hex")
    .slice(0, 16);
}

function pathOf(id: string, dir: string): string {
  return join(dir, `${id}.json`);
}

function readRecording(id: string, dir: string): Recording | null {
  try {
    return JSON.parse(readFileSync(pathOf(id, dir), "utf8")) as Recording;
  } catch {
    return null;
  }
}

/** Run tasks with a bounded number in flight. */
async function pooled<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await worker(items[index]!);
      }
    }),
  );
  return results;
}

// --- Reporting -----------------------------------------------------------

const RESET = "\x1b[0m";
const paint = (code: string, text: string) =>
  process.stdout.isTTY ? `${code}${text}${RESET}` : text;
const red = (t: string) => paint("\x1b[31m", t);
const yellow = (t: string) => paint("\x1b[33m", t);
const green = (t: string) => paint("\x1b[32m", t);
const dim = (t: string) => paint("\x1b[2m", t);

interface CaseReport {
  id: string;
  findings: Finding[];
  failures: number;
  warnings: number;
  judged: JudgeResult | null;
  /** How many of the case's samples came back with no failure. */
  cleanSamples: number;
  samples: number;
  status: "graded" | "stale" | "missing";
}

function report(reports: CaseReport[], judged: boolean, model: string): number {
  console.log();
  for (const item of reports) {
    if (item.status === "missing") {
      console.log(`${yellow("○")} ${item.id} ${dim("— nothing recorded")}`);
      continue;
    }
    if (item.status === "stale") {
      console.log(
        `${red("✗")} ${item.id} ${red("— recording is stale")} ${dim("(fixture changed; re-run with --live)")}`,
      );
      continue;
    }

    const mark =
      item.failures > 0 ? red("✗") : item.warnings > 0 ? yellow("!") : green("✓");

    const score =
      item.judged === null
        ? ""
        : dim(
            ` ${(item.judged.groundedness * 100).toFixed(0)}% grounded ` +
              `(${item.judged.claims.length} claims)`,
          );

    const spread =
      item.samples > 1
        ? dim(` ${item.cleanSamples}/${item.samples} samples clean`)
        : "";
    console.log(`${mark} ${item.id}${spread}${score}`);

    for (const finding of item.findings) {
      const tag = finding.severity === "fail" ? red("fail") : yellow("warn");
      console.log(`    ${tag} ${dim(finding.grader)}  ${finding.message}`);
    }
    for (const claim of item.judged?.ungrounded ?? []) {
      console.log(`    ${red("fail")} ${dim("judge")}  “${claim.claim}” — ${claim.reason}`);
    }
  }

  const graded = reports.filter((r) => r.status === "graded");
  const stale = reports.filter((r) => r.status === "stale").length;
  const missing = reports.filter((r) => r.status === "missing").length;
  const failures = graded.reduce((sum, r) => sum + r.failures, 0);
  const warnings = graded.reduce((sum, r) => sum + r.warnings, 0);
  const clean = graded.filter((r) => r.failures === 0).length;

  console.log();
  const totalSamples = graded.reduce((sum, r) => sum + r.samples, 0);
  const cleanSample = graded.reduce((sum, r) => sum + r.cleanSamples, 0);
  console.log(dim(`model: ${model}`));
  if (totalSamples > graded.length) {
    console.log(`${cleanSample}/${totalSamples} samples clean`);
  }
  console.log(
    `${clean}/${graded.length} cases clean · ${failures} failures · ${warnings} warnings` +
      (stale > 0 ? ` · ${red(`${stale} stale`)}` : "") +
      (missing > 0 ? ` · ${yellow(`${missing} unrecorded`)}` : ""),
  );

  if (judged) {
    const scored = graded.filter((r) => r.judged !== null);
    if (scored.length > 0) {
      const claims = scored.flatMap((r) => r.judged!.claims);
      const ungrounded = scored.flatMap((r) => r.judged!.ungrounded);
      const tokens = scored.reduce(
        (sum, r) => sum + r.judged!.cost.inputTokens + r.judged!.cost.outputTokens,
        0,
      );
      const rate = ((claims.length - ungrounded.length) / claims.length) * 100;
      console.log(
        `groundedness ${rate.toFixed(1)}% over ${claims.length} claims ` +
          `(${ungrounded.length} ungrounded) · ${dim(`${tokens} judge tokens`)}`,
      );
    } else {
      console.log(yellow("groundedness not measured — the judge returned nothing"));
    }
  }

  // Stale recordings fail. Missing ones do not: a fresh checkout with no
  // recordings has not failed the corpus, it simply has not run it, and a gate
  // that cannot tell those apart teaches people to ignore it.
  const ungroundedTotal = graded.reduce(
    (sum, r) => sum + (r.judged?.ungrounded.length ?? 0),
    0,
  );
  return failures + stale + ungroundedTotal > 0 ? 1 : 0;
}

// --- Main ----------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const live = args.includes("--live");
  const withJudge = args.includes("--judge");
  const only = args.find((a) => a.startsWith("--case="))?.split("=")[1];
  const samples = Math.max(
    1,
    Number(args.find((a) => a.startsWith("--samples="))?.split("=")[1] ?? 1),
  );
  const model = args.find((a) => a.startsWith("--model="))?.split("=")[1] ?? BRIEF_MODEL;
  const dir = recordingDir(model);

  const cases = only ? CASES.filter((c) => c.id === only) : CASES;
  if (cases.length === 0) {
    console.error(`No case named "${only}".`);
    process.exit(1);
  }

  if ((live || withJudge) && !isLlmConfigured()) {
    console.error(
      "ANTHROPIC_API_KEY is not set in .env.local.\n" +
        "Run without --live to grade the recordings already on disk.",
    );
    process.exit(1);
  }

  if (live) {
    mkdirSync(dir, { recursive: true });
    // Deduplicated: sixteen cases failing for one exhausted credit balance is
    // one fact, not forty-eight.
    const failures = new Set<string>();
    process.stdout.write(`generating ${cases.length} briefs with ${model}`);

    const written = await pooled(cases, CONCURRENCY, async (evalCase) => {
      const texts: string[] = [];
      for (let i = 0; i < samples; i++) {
        const result = await composeBrief(evalCase.context, model, (reason) =>
          failures.add(reason),
        );
        process.stdout.write(result === null ? "x" : ".");
        if (result !== null) texts.push(result.text);
      }
      if (texts.length === 0) return false;

      const recording: Recording = {
        id: evalCase.id,
        promptHash: hashOf(evalCase),
        model,
        generatedAt: new Date().toISOString(),
        texts,
      };
      writeFileSync(pathOf(evalCase.id, dir), `${JSON.stringify(recording, null, 2)}\n`);
      return true;
    });

    const failed = written.filter((ok) => !ok).length;
    console.log(failed > 0 ? ` (${failed} cases produced nothing)` : "");
    for (const reason of failures) console.log(`  ${red("api")} ${reason}`);
    // A partial corpus is not a result. Reporting 15/15 clean while the one
    // case the model actually struggles with never generated is worse than
    // reporting nothing, because it looks like an answer.
    if (failures.size > 0) {
      console.log(
        yellow(
          "\nGeneration failed for at least one case; any score below is measured\n" +
            "on a partial corpus and must not be compared against a complete one.",
        ),
      );
    }
  }

  const reports = await pooled(cases, CONCURRENCY, async (evalCase) => {
    const recording = readRecording(evalCase.id, dir);

    if (recording === null) {
      return {
        id: evalCase.id,
        findings: [],
        failures: 0,
        warnings: 0,
        judged: null,
        cleanSamples: 0,
        samples: 0,
        status: "missing" as const,
      };
    }
    if (recording.promptHash !== hashOf(evalCase)) {
      return {
        id: evalCase.id,
        findings: [],
        failures: 0,
        warnings: 0,
        judged: null,
        cleanSamples: 0,
        samples: 0,
        status: "stale" as const,
      };
    }

    // Every sample is graded. A finding is reported once however many samples
    // produced it, with the count when it was not all of them — an error that
    // shows up in one generation of three is a different fact about the model
    // from one that shows up in every generation, and collapsing them loses
    // exactly the variance this mode exists to expose.
    const perSample = recording.texts.map((text) =>
      gradeDeterministic(text, evalCase),
    );
    const findings: Finding[] = [];
    const counts = new Map<string, { finding: Finding; times: number }>();
    for (const graded of perSample) {
      for (const finding of graded.findings) {
        const key = `${finding.grader}:${finding.message}`;
        const seen = counts.get(key);
        if (seen) seen.times += 1;
        else counts.set(key, { finding, times: 1 });
      }
    }
    for (const { finding, times } of counts.values()) {
      findings.push(
        times === perSample.length
          ? finding
          : { ...finding, message: `${finding.message} [${times}/${perSample.length}]` },
      );
    }

    // The judge reads the first sample only. It is the expensive half, and a
    // groundedness rate over one generation per case is already 250+ claims.
    const judged =
      withJudge && recording.texts[0]
        ? await judge(recording.texts[0], evalCase.context)
        : null;

    return {
      id: evalCase.id,
      findings,
      failures: findings.filter((f) => f.severity === "fail").length,
      warnings: findings.filter((f) => f.severity === "warn").length,
      judged,
      cleanSamples: perSample.filter((g) => g.failures === 0).length,
      samples: perSample.length,
      status: "graded" as const,
    };
  });

  process.exit(report(reports, withJudge, model));
}

main();
