import { loadPreviewContext, previewPicks, PREVIEW_GW } from "@/lib/preview/context";
import { getDb, isDbConfigured } from "@/lib/db/client";
import { getAllPlayers, getFixturesFrom, getTeams } from "@/lib/db/queries";
import { buildSquadView } from "@/lib/squad/view";
import { DEFAULT_HORIZON } from "@/lib/engine/constants";
import { ep as formatEp, money } from "@/lib/format";
import { Panel, SectionLabel, StatRow } from "@/components/ui/panel";
import { FixtureDifficultyKey } from "@/components/ui/fixture-strip";
import { Bench, Pitch } from "@/components/squad/pitch";
import { PreviewUnavailable } from "../_shared";

/**
 * The pitch view against the preview squad.
 *
 * `buildSquadView` takes rows rather than a context, so this route re-reads
 * players, teams and fixtures rather than reshaping the preview context into
 * something it does not accept. Slightly more work at render time, and it keeps
 * the preview from needing a second code path through the view builder.
 */
export default async function PreviewSquadPage() {
  const preview = await loadPreviewContext(DEFAULT_HORIZON);
  if (preview.state !== "ready") {
    return <PreviewUnavailable context={preview} />;
  }
  if (!isDbConfigured()) return <PreviewUnavailable context={{ state: "no-db" }} />;

  const db = getDb();
  const [players, teams, fixtures] = await Promise.all([
    getAllPlayers(db),
    getTeams(db),
    getFixturesFrom(db, PREVIEW_GW, PREVIEW_GW + 6),
  ]);

  const picks = previewPicks(preview.context.squad);
  const view = buildSquadView({
    gw: PREVIEW_GW,
    picks,
    players,
    teams,
    fixtures,
    // The same synthetic history the projections were built from, handed back
    // by the loader so the pitch and the transfer board cannot disagree.
    stats: preview.stats,
  });

  return (
    <div className="grid grid-cols-1 items-start gap-4 sm:gap-6 lg:grid-cols-[1fr_300px]">
      <div className="flex flex-col gap-4 sm:gap-6">
        <div>
          <SectionLabel
            meta={`FIXTURE DIFFICULTY GW${view.gw}–${view.gw + 4} · LEFT TO RIGHT`}
          >
            SQUAD · {view.formation} · GW{view.gw}
          </SectionLabel>
          <Pitch squad={view} />
        </div>
        <div>
          <SectionLabel meta="AUTO-SUB ORDER">BENCH</SectionLabel>
          <Bench players={view.bench} />
        </div>
      </div>

      <div className="flex flex-col gap-4 sm:gap-6">
        <div>
          <SectionLabel>SQUAD TOTALS</SectionLabel>
          <Panel>
            <StatRow
              label="Starting XI EP"
              value={formatEp(view.totals.startingEp)}
            />
            <StatRow
              label="Captain bonus"
              value={`+${formatEp(view.totals.captainBonus)}`}
              tone="accent"
            />
            <StatRow
              label="Projected total"
              value={formatEp(view.totals.projectedTotal)}
              tone="accent"
            />
            <StatRow
              label="Bench EP"
              value={formatEp(view.totals.benchEp)}
              tone="muted"
            />
            <StatRow label="Squad value" value={money(view.totals.squadValue)} />
            <StatRow
              label="In the bank"
              value={money(preview.context.bank)}
              tone="muted"
            />
            <StatRow
              label="Flagged players"
              value={String(view.totals.flaggedCount)}
              tone={view.totals.flaggedCount > 0 ? "warn" : "primary"}
            />
          </Panel>
        </div>

        <div>
          <SectionLabel>DIFFICULTY KEY</SectionLabel>
          <Panel>
            <FixtureDifficultyKey />
          </Panel>
        </div>
      </div>
    </div>
  );
}
