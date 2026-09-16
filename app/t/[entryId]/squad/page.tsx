import { notFound } from "next/navigation";
import { getSeasonContext } from "@/lib/fpl/season";
import { parseEntryId } from "@/lib/fpl/entry";
import { loadSquadView } from "@/lib/squad/squad-view";
import { ep as formatEp, money } from "@/lib/format";
import { PageHeader, Panel, SectionLabel, StatRow } from "@/components/ui/panel";
import { Pending } from "@/components/ui/pending";
import { Bench, Pitch, PitchKey } from "@/components/squad/pitch";

/**
 * My team: the pitch, and the handful of numbers that go with it.
 *
 * Rendered from the database rather than the live API. Note the pre-deadline
 * case, which is not an error: picks do not exist publicly until a gameweek's
 * deadline has passed, so before the first deadline there is genuinely nothing
 * to render.
 */
export default async function SquadPage({
  params,
}: {
  params: Promise<{ entryId: string }>;
}) {
  const entryId = parseEntryId((await params).entryId);
  if (entryId === null) notFound();

  const season = await getSeasonContext();

  if (!season.available) {
    return (
      <Pending phase="upstream recovery">
        The FPL API is unreachable, so the gameweek cannot be resolved.
      </Pending>
    );
  }

  const loaded = await loadSquadView(entryId, season);

  if (loaded.state === "no-db") {
    return (
      <Pending phase="configuration">
        Supabase is not configured. Set{" "}
        <code className="font-mono text-tertiary">NEXT_PUBLIC_SUPABASE_URL</code>{" "}
        and{" "}
        <code className="font-mono text-tertiary">
          SUPABASE_SERVICE_ROLE_KEY
        </code>
        .
      </Pending>
    );
  }

  if (loaded.state === "no-squad") {
    return (
      <Pending phase="the first deadline">
        No squad has been synced yet. The FPL API only publishes a manager&apos;s
        picks once a gameweek&apos;s deadline has passed, so there is nothing to
        render until{" "}
        <span className="font-medium text-tertiary">{season.gameweek.target.name}</span>{" "}
        locks. Once it has, use{" "}
        <span className="font-medium text-tertiary">refresh squad</span> above to
        pull it straight away — the scheduled sync would not otherwise reach it
        until the following morning.
      </Pending>
    );
  }

  const { view, live } = loaded;

  return (
    <div className="grid grid-cols-1 items-start gap-5 sm:gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="flex flex-col gap-4">
        <PageHeader
          title="My team"
          subtitle={`GW${view.picksGw} picks · ${view.formation} · projected for GW${view.gw}`}
        />

        {view.picksAreStale ? (
          <div className="border border-warn-dim bg-[color-mix(in_oklch,var(--warn)_8%,var(--surface-panel))] px-4 py-3 text-sm text-secondary">
            <span className="font-semibold text-warn">
              Showing your GW{view.picksGw} team.
            </span>{" "}
            FPL publishes GW{view.gw} picks when the deadline passes, so
            transfers or a captain change made since won&apos;t show until then.
          </div>
        ) : null}

        <Pitch squad={view} live={live} />
        <Bench players={view.bench} live={live} />
      </div>

      <div className="flex flex-col gap-4 lg:pt-[3.25rem]">
        <section>
          <SectionLabel>GW{view.gw} projection</SectionLabel>
          <Panel>
            {view.preSeason ? (
              <StatRow label="Projections" value="After GW1" tone="warn" />
            ) : (
              <>
                <StatRow
                  label="Projected total"
                  value={formatEp(view.totals.projectedTotal)}
                  tone="accent"
                />
                <StatRow
                  label="Starting eleven"
                  value={formatEp(view.totals.startingEp)}
                />
                <StatRow
                  label="Captain bonus"
                  value={`+${formatEp(view.totals.captainBonus)}`}
                />
                <StatRow
                  label="Bench"
                  value={formatEp(view.totals.benchEp)}
                  tone="muted"
                />
              </>
            )}
          </Panel>
        </section>

        <section>
          <SectionLabel>Squad</SectionLabel>
          <Panel>
            <StatRow label="Squad value" value={money(view.totals.squadValue)} />
            <StatRow
              label="Flagged players"
              value={String(view.totals.flaggedCount)}
              tone={view.totals.flaggedCount > 0 ? "warn" : "primary"}
            />
          </Panel>
        </section>

        {view.preSeason ? (
          <Pending phase="gameweek 1">
            Expected points need appearance history to mean anything. Until a
            gameweek has been played the model cannot tell these players apart,
            so cards show a dash rather than a number it has not earned.
          </Pending>
        ) : null}

        <section>
          <SectionLabel>Key</SectionLabel>
          <Panel padded>
            <PitchKey />
          </Panel>
        </section>
      </div>
    </div>
  );
}
