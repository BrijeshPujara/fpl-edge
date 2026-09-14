import { notFound } from "next/navigation";
import { getDb, isDbConfigured } from "@/lib/db/client";
import { getPlayersByIds } from "@/lib/db/queries";
import { getShadowWeeks, type ShadowWeek } from "@/lib/db/shadow";
import { getEntryHistory } from "@/lib/fpl/client";
import { parseEntryId } from "@/lib/fpl/entry";
import { getSeasonContext } from "@/lib/fpl/season";
import {
  pairWeeks,
  shadowVerdict,
  type ShadowVerdict,
} from "@/lib/shadow/verdict";
import { CHIP_LABEL, type ChipName } from "@/lib/rules";
import { ep as formatEp, money } from "@/lib/format";
import { cn } from "@/lib/cn";
import { Panel, Readout, Row, SectionLabel, StatRow } from "@/components/ui/panel";
import { Pending } from "@/components/ui/pending";
import { GapChart } from "@/components/shadow/gap-chart";

/**
 * The shadow manager: your squad against one that only follows the engine.
 *
 * The journal scores single decisions, each on the assumption that the rest of
 * the squad was yours. The shadow drops the assumption — it owns its own
 * fifteen, pays its own hits and plays its own chips — so the gap here is the
 * whole case for or against the engine, and the page is built around not
 * overstating it: the band on the chart is what luck alone produces, and the
 * reading is withheld until the gap clears it.
 */
export default async function ShadowPage({
  params,
}: {
  params: Promise<{ entryId: string }>;
}) {
  const entryId = parseEntryId((await params).entryId);
  if (entryId === null) notFound();

  if (!isDbConfigured()) {
    return (
      <Pending phase="configuration">
        Supabase is not configured, so there is nowhere to keep a shadow squad.
      </Pending>
    );
  }

  const db = getDb();
  const weeks = await getShadowWeeks(db, entryId);

  if (weeks.length === 0) {
    return (
      <div>
        <SectionLabel>SHADOW MANAGER</SectionLabel>
        <Pending phase="the next journal sync">
          No shadow squad yet. The next sync copies your latest squad — same
          players, bank and chips — and from then on the shadow does only what
          the engine advises. Nothing is filled in for gameweeks already played:
          a plan made after a deadline would be picked with the results in.
        </Pending>
      </div>
    );
  }

  // Read live. A failure is carried with its reason rather than collapsed into
  // "nothing to compare": a schema throw read as an outage once already.
  const [history, season] = await Promise.all([
    getEntryHistory(entryId).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({
        ok: false as const,
        reason: error instanceof Error ? error.message : String(error),
      }),
    ),
    getSeasonContext(),
  ]);

  const ids = weeks.flatMap((w) => [
    ...w.picks.map((p) => p.playerId),
    ...w.moves.flatMap((m) => [m.in, m.out]),
  ]);
  const players = await getPlayersByIds(db, [...new Set(ids)]);
  const nameOf = new Map(players.map((p) => [p.id, p.web_name]));
  const name = (id: number) => nameOf.get(id) ?? `#${id}`;

  const seed = weeks.find((w) => w.row.origin === "seed");
  const engineWeeks = weeks.filter((w) => w.row.origin === "engine");
  const latest = engineWeeks[engineWeeks.length - 1] ?? null;
  // `next` is by definition the gameweek whose deadline is still ahead — the
  // same test sync-shadow records against, so the page cannot call a week open
  // that the sync would refuse to write.
  const openGw = season.available ? (season.gameweek.next?.id ?? null) : null;

  const verdict = history.ok
    ? shadowVerdict(
        pairWeeks(
          engineWeeks.map((w) => ({
            gw: w.row.gw,
            origin: w.row.origin,
            points: w.row.points,
            hitCost: w.row.hit_cost,
          })),
          history.value.current,
        ),
      )
    : null;
  const pairedByGw = new Map((verdict?.weeks ?? []).map((w) => [w.gw, w]));

  return (
    <div className="flex flex-col gap-4 sm:gap-6">
      <div>
        <SectionLabel meta={seed ? `STARTED FROM YOUR GW${seed.row.gw} SQUAD` : undefined}>
          SHADOW MANAGER
        </SectionLabel>
        <Panel padded>
          {verdict ? (
            <div className="grid grid-cols-2 gap-x-6 sm:grid-cols-4">
              <Readout label="ENGINE" value={String(verdict.shadowTotal)} />
              <Readout label="YOU" value={String(verdict.managerTotal)} />
              <Readout
                label="GAP"
                value={signed(verdict.gap)}
                tone={verdict.gap > 0 ? "accent" : verdict.gap < 0 ? "warn" : "primary"}
              />
              <Readout label="WEEKS SCORED" value={String(verdict.weeks.length)} />
            </div>
          ) : (
            <div className="font-mono text-tiny tracking-[0.14em] text-warn">
              YOUR FPL HISTORY COULD NOT BE READ
            </div>
          )}
          <div className="mt-3 max-w-prose text-small leading-relaxed text-muted text-pretty">
            {verdict ? reading(verdict) : `Nothing to compare against: ${history.ok ? "" : history.reason}`}{" "}
            <span className="text-dim">
              The shadow began with your squad, bank and chips, and since then
              has done only what the engine advises — its transfers, its hits,
              its chips and its captain. Each week is written while the
              gameweek is open and never afterwards. Points are net of hits on
              both sides.
            </span>
          </div>
        </Panel>
      </div>

      {verdict && verdict.weeks.length > 0 ? (
        <div>
          <SectionLabel meta="SHADED BAND = WHAT LUCK ALONE PRODUCES">
            CUMULATIVE GAP, ENGINE MINUS YOU
          </SectionLabel>
          <Panel padded>
            <GapChart points={verdict.weeks} />
          </Panel>
        </div>
      ) : null}

      <div className="grid grid-cols-1 items-start gap-4 sm:gap-6 lg:grid-cols-[1fr_300px]">
        <div>
          <SectionLabel meta={`${engineWeeks.length} PLANNED`}>WEEK BY WEEK</SectionLabel>
          <Panel>
            <Row
              height="dense"
              className="grid grid-cols-[48px_1fr_52px_52px_52px] gap-2 font-mono text-micro tracking-[0.12em] text-label"
            >
              <div>GW</div>
              <div>ENGINE DID</div>
              <div className="text-right">YOU</div>
              <div className="text-right">ENGINE</div>
              <div className="text-right">GAP</div>
            </Row>
            {[...engineWeeks].reverse().map((week) => (
              <WeekRow
                key={week.row.id}
                week={week}
                paired={pairedByGw.get(week.row.gw) ?? null}
                open={week.row.gw === openGw}
                name={name}
              />
            ))}
            {engineWeeks.length === 0 ? (
              <Row height="auto" className="text-small text-muted">
                The first plan is written on the next sync.
              </Row>
            ) : null}
          </Panel>
        </div>

        {latest ? (
          <div>
            <SectionLabel
              meta={
                // Short: this sits in a 300px column, and anything longer
                // pushes the title onto two lines.
                latest.row.gw === openGw
                  ? "OPEN TILL DEADLINE"
                  : latest.row.points === null
                    ? "AWAITING RESULTS"
                    : "SCORED"
              }
            >
              GW{latest.row.gw} PLAN
            </SectionLabel>
            <Panel>
              <StatRow
                label="Chip"
                value={latest.row.chip_played ? chipLabel(latest.row.chip_played) : "None"}
                tone={latest.row.chip_played ? "accent" : "muted"}
              />
              <StatRow label="Transfers" value={String(latest.moves.length)} />
              <StatRow
                label="Hit"
                value={latest.row.hit_cost > 0 ? `−${latest.row.hit_cost}` : "0"}
                tone={latest.row.hit_cost > 0 ? "warn" : "muted"}
              />
              <StatRow
                label="Captain"
                value={captainOf(latest, name)}
              />
              <StatRow
                label="Projected"
                value={latest.row.projected_ep === null ? "—" : formatEp(latest.row.projected_ep)}
              />
              <StatRow label="Bank" value={money(latest.row.bank)} tone="muted" />
              <StatRow
                label="Recorded"
                value={stamp(latest.row.updated_at)}
                tone="muted"
              />
              {latest.moves.length > 0 ? (
                <Row height="auto" className="text-small text-primary">
                  {latest.moves.map((m) => (
                    <div key={`${m.out}-${m.in}`}>
                      <span className="text-muted">{name(m.out)}</span> → {name(m.in)}
                    </div>
                  ))}
                </Row>
              ) : null}
            </Panel>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function WeekRow({
  week,
  paired,
  open,
  name,
}: {
  week: ShadowWeek;
  paired: ShadowVerdict["weeks"][number] | null;
  open: boolean;
  name: (id: number) => string;
}) {
  const { row, moves } = week;
  const did = [
    row.chip_played ? chipLabel(row.chip_played) : null,
    moves.length === 0
      ? "Rolled"
      : `${moves.map((m) => name(m.out)).join(", ")} → ${moves.map((m) => name(m.in)).join(", ")}`,
    row.hit_cost > 0 ? `−${row.hit_cost} hit` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Row
      height="auto"
      className="grid grid-cols-[48px_1fr_52px_52px_52px] items-baseline gap-2"
    >
      <div className="font-mono text-cell text-label">GW{row.gw}</div>
      <div className="min-w-0 text-small text-primary text-pretty">{did}</div>
      <div className="text-right font-mono text-cell text-muted">
        {paired ? paired.manager : "—"}
      </div>
      <div className="text-right font-mono text-cell text-primary">
        {paired ? paired.shadow : open ? "open" : "—"}
      </div>
      <div
        className={cn(
          "text-right font-mono text-cell",
          !paired && "text-fainter",
          paired && paired.gap > 0 && "text-accent",
          paired && paired.gap < 0 && "text-warn",
          paired && paired.gap === 0 && "text-muted",
        )}
      >
        {paired ? signed(paired.gap) : "—"}
      </div>
    </Row>
  );
}

function reading(verdict: ShadowVerdict): string {
  const t = verdict.t === null ? "" : ` (t = ${verdict.t.toFixed(2)})`;
  switch (verdict.reading) {
    case "no-data":
      return "No gameweek has been scored yet. The first comparison lands once that week's results are checked.";
    case "too-few":
      return "One week scored. One week is a coin toss, not a verdict.";
    case "noise":
      return `Inside the noise${t}. Not yet evidence either way — the line has to leave the band, and stay out, before it means anything.`;
    case "engine-ahead":
      return `The engine is ahead by more than luck explains${t}.`;
    case "manager-ahead":
      return `You are ahead of the engine by more than luck explains${t}.`;
  }
}

function captainOf(week: ShadowWeek, name: (id: number) => string): string {
  const captain = week.picks.find((p) => p.isCaptain);
  const vice = week.picks.find((p) => p.isVice);
  if (!captain) return "—";
  return vice ? `${name(captain.playerId)} (${name(vice.playerId)})` : name(captain.playerId);
}

function chipLabel(chip: string): string {
  return CHIP_LABEL[chip as ChipName] ?? chip;
}

/** 14 Sep 16:40 UTC. The deadline is the reference, so the zone is stated. */
function stamp(iso: string): string {
  const d = new Date(iso);
  const month = d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" });
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${month} ${hh}:${mm} UTC`;
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : "0";
}
