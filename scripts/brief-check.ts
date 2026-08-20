/**
 * Exercise the weekly brief end to end against real players.
 *
 * The brief cannot otherwise be tested until a squad exists, which needs a
 * deadline to have passed. This runs it against the preview harness instead —
 * real players, real fixtures, last season's form replayed as gameweek eight —
 * so the call, the prompt and the output can all be checked the moment a key
 * is configured.
 *
 * Writes nothing. No brief row, no usage row, no squad.
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { loadPreviewContext, PREVIEW_GW } from "@/lib/preview/context";
import { isLlmConfigured } from "@/lib/llm/client";
import { buildPrompt, composeBrief, type BriefContext } from "@/lib/llm/brief";
import { bestXi } from "@/lib/engine/best-xi";
import { rankCaptains } from "@/lib/engine/captain";
import { suggestTransfers } from "@/lib/engine/transfers";
import { toPlayerCandidate } from "@/lib/squad/candidates";
import { createGlpkSolver } from "@/lib/solver/glpk";

async function main() {
  const dryRun = process.argv.includes("--prompt-only");

  if (!isLlmConfigured() && !dryRun) {
    console.error(
      "ANTHROPIC_API_KEY is not set in .env.local.\n" +
        "Add it, or run with --prompt-only to see what would be sent.",
    );
    process.exit(1);
  }

  const preview = await loadPreviewContext(1);
  if (preview.state !== "ready") {
    console.error(
      preview.state === "no-cache"
        ? "Run `npm run backtest` once to populate .backtest-cache/."
        : `Preview unavailable: ${preview.state}`,
    );
    process.exit(1);
  }

  const context = preview.context;
  const byId = new Map(context.squad.map((c) => [c.id, c]));
  const epOf = (id: number) =>
    byId.get(id)?.perGameweek.find((g) => g.gw === PREVIEW_GW)?.ep ?? 0;

  const describe = (p: { id: number }) => {
    const c = byId.get(p.id);
    return {
      name: c?.name ?? `#${p.id}`,
      position: c?.positionShort ?? "",
      club: c?.club ?? "",
      ep: epOf(p.id),
      flag: c?.flag?.note,
    };
  };

  const xi = bestXi(
    context.squad.map((c) => ({ id: c.id, position: c.position, ep: epOf(c.id) })),
  );

  const captains = rankCaptains(
    context.squad.map((c) => ({
      playerId: c.id,
      input: c.modelInput,
      fixtures: c.thisGameweek,
    })),
  );
  const [pick, ...rest] = captains;

  const solver = await createGlpkSolver();
  const suggestion = suggestTransfers(
    {
      currentSquad: context.squad.map((c) => toPlayerCandidate(c)),
      candidates: context.pool.map((c) => toPlayerCandidate(c)),
      freeTransfers: context.freeTransfers,
      bank: context.bank,
    },
    solver,
    { priceWeight: "auto" },
  );
  const move = suggestion.recommended;

  const brief: BriefContext = {
    gw: PREVIEW_GW,
    teamName: "Preview XI",
    starting: xi.starting.map(describe),
    bench: xi.bench.map(describe),
    captain: pick
      ? {
          name: byId.get(pick.playerId)?.name ?? "",
          ep: pick.ep,
          pHaul: pick.pHaul,
          pBlank: pick.pBlank,
          runnerUp: rest[0] ? (byId.get(rest[0].playerId)?.name ?? null) : null,
          runnerUpEp: rest[0]?.ep ?? null,
        }
      : null,
    transfer:
      move.transfers === 0 || move.netGain <= 0
        ? { kind: "hold", out: null, in: null, epGain: 0, hitCost: 0, netGain: 0 }
        : {
            kind: "transfer",
            out: byId.get(move.playersOut[0]?.id ?? -1)?.name ?? null,
            in:
              context.pool.find((c) => c.id === move.playersIn[0]?.id)?.name ??
              null,
            epGain: move.epGain,
            hitCost: move.hitCost,
            netGain: move.netGain,
          },
    chip: null,
    freeTransfers: context.freeTransfers,
    bank: context.bank,
    flagged: context.squad.filter((c) => c.flag !== null).map(describe),
    record: null,
    priorSeasonOnly: context.basis === "prior-season",
  };

  const prompt = buildPrompt(brief);

  if (dryRun) {
    console.log("=== PROMPT (nothing sent) ===\n");
    console.log(prompt);
    return;
  }

  console.log(`prompt: ${prompt.length} characters\n`);
  const started = Date.now();
  const result = await composeBrief(brief);

  if (result === null) {
    console.error("No brief returned. The key may be invalid or the call failed.");
    process.exit(1);
  }

  console.log("=== BRIEF ===\n");
  console.log(result.text);
  console.log("\n=== COST ===");
  console.log(
    `model ${result.model} · ${result.inputTokens} in · ` +
      `${result.outputTokens} out · ${result.cachedTokens} cached · ` +
      `${Date.now() - started}ms`,
  );
}

main();
