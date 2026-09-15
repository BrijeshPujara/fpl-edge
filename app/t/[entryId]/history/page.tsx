import { notFound } from "next/navigation";
import { getDb, isDbConfigured } from "@/lib/db/client";
import { getJournal, movesOf, type JournalEntry } from "@/lib/db/decisions";
import { getPlayersByIds } from "@/lib/db/queries";
import { parseEntryId } from "@/lib/fpl/entry";
import { ep as formatEp, epDelta } from "@/lib/format";
import { cn } from "@/lib/cn";
import { PageHeader, Panel, SectionLabel, StatRow } from "@/components/ui/panel";
import { Pending } from "@/components/ui/pending";

/**
 * The decision journal.
 *
 * PLAN.md calls this the differentiator and it is the only screen here that
 * can embarrass the engine. Every tool gives advice; this one keeps a record of
 * what it advised, before the deadline, and what that advice was worth.
 *
 * The number that matters is not points scored — that is mostly a function of
 * who you own. It is the DELTA against the best alternative the engine passed
 * over. A captain who scores two is a bad week; a captain who scores two when
 * every alternative also scored two is not a bad decision.
 */
export default async function HistoryPage({
  params,
}: {
  params: Promise<{ entryId: string }>;
}) {
  const entryId = parseEntryId((await params).entryId);
  if (entryId === null) notFound();

  if (!isDbConfigured()) {
    return (
      <Pending phase="configuration">
        Supabase is not configured, so there is nowhere to keep a journal.
      </Pending>
    );
  }

  const db = getDb();
  const journal = await getJournal(db, entryId);

  const header = (
    <PageHeader
      title="History"
      subtitle="What the engine advised before each deadline, and what it was worth"
    />
  );

  if (journal.length === 0) {
    return (
      <div className="flex flex-col gap-5">
        {header}
        <Pending phase="the first recommendation">
          Nothing recorded yet. The engine writes down what it advises for each
          gameweek while that gameweek is still open — never afterwards, since a
          recommendation written after a deadline is hindsight and would make
          the whole record worthless.
          <br />
          <br />
          The first entry appears once there is a squad to advise on and a
          gameweek still to play.
        </Pending>
      </div>
    );
  }

  const playerIds = [
    ...new Set(
      journal.flatMap((entry) =>
        [
          entry.decision.player_in,
          entry.decision.player_out,
          ...(movesOf(entry.decision) ?? []).flatMap((m) => [m.in, m.out]),
        ].filter((id): id is number => id !== null),
      ),
    ),
  ];
  const players = await getPlayersByIds(db, playerIds);
  const nameOf = new Map(players.map((p) => [p.id, p.web_name]));

  const scored = journal.filter((entry) => entry.outcome !== null);
  const record = summarise(scored);

  return (
    <div className="flex flex-col gap-5">
      {header}

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
        <section>
          <SectionLabel meta={`${journal.length} recorded`}>Decision journal</SectionLabel>
          <Panel>
            {journal.map((entry) => (
              <JournalRow key={entry.decision.id} entry={entry} nameOf={nameOf} />
            ))}
          </Panel>
        </section>

        <div className="flex flex-col gap-3">
          <section>
            <SectionLabel meta="Against the alternative">The record</SectionLabel>
            <Panel>
              <StatRow label="Decisions scored" value={String(scored.length)} />
              <StatRow
                label="Better than the alternative"
                value={String(record.better)}
                tone={record.better > 0 ? "accent" : "muted"}
              />
              <StatRow
                label="Worse"
                value={String(record.worse)}
                tone={record.worse > 0 ? "warn" : "muted"}
              />
              <StatRow label="No difference" value={String(record.level)} tone="muted" />
              <StatRow
                label="Net points"
                value={scored.length === 0 ? "—" : epDelta(record.net)}
                tone={record.net >= 0 ? "accent" : "warn"}
              />
            </Panel>
          </section>

          <p className="max-w-prose text-sm leading-relaxed text-muted text-pretty">
            Scored against the best option the engine passed over, not against the
            highest score in the game. The question is whether it chose well from
            what it offered — being beaten by a player nobody was considering is
            not a mistake it made.
            {scored.length > 0 && scored.length < 10 ? (
              <>
                {" "}
                <span className="font-semibold text-primary">
                  Too few decisions to mean anything yet.
                </span>{" "}
                A handful of captaincy calls is noise; a season of them is a
                record.
              </>
            ) : null}
          </p>
        </div>
      </div>
    </div>
  );
}

function summarise(scored: JournalEntry[]) {
  let better = 0;
  let worse = 0;
  let level = 0;
  let net = 0;

  for (const { outcome } of scored) {
    if (!outcome) continue;
    net += outcome.delta;
    if (outcome.delta > 0) better += 1;
    else if (outcome.delta < 0) worse += 1;
    else level += 1;
  }
  return { better, worse, level, net };
}

const KIND_LABEL: Record<string, string> = {
  captain: "Captain",
  transfer: "Transfer",
  hold: "Hold",
  chip: "Chip",
};

function JournalRow({
  entry,
  nameOf,
}: {
  entry: JournalEntry;
  nameOf: Map<number, string>;
}) {
  const { decision, outcome } = entry;
  const name = (id: number | null) =>
    id === null ? null : (nameOf.get(id) ?? `#${id}`);

  const moves = decision.kind === "transfer" ? movesOf(decision) : [];

  const headline =
    decision.kind === "transfer"
      ? moves === null
        ? // Recorded before the whole plan was stored. The rationale was
          // always written from the full plan, so it still names everyone.
          (decision.rationale?.split(":")[0] ?? "—")
        : moves.length === 0
          ? "— → —"
          : `${moves.map((m) => name(m.out)).join(", ")} → ${moves.map((m) => name(m.in)).join(", ")}`
      : decision.kind === "hold"
        ? "Rolled the transfer"
        : (name(decision.player_in) ?? "—");

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-edge-subtle px-4 py-3 last:border-b-0">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-display text-base font-bold text-primary">
            GW{decision.gw}
          </span>
          <span className="bg-sunken px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-tertiary uppercase">
            {KIND_LABEL[decision.kind] ?? decision.kind}
          </span>
        </div>
        <div className="truncate text-sm font-semibold text-primary">{headline}</div>
        {decision.rationale ? (
          <div className="max-w-prose text-sm leading-relaxed text-muted text-pretty">
            {decision.rationale}
          </div>
        ) : null}
      </div>

      <div className="text-right">
        {outcome === null ? (
          <>
            <div className="text-xs font-medium text-muted">Predicted</div>
            <div className="font-display text-xl font-bold text-muted">
              {decision.predicted_ep === null
                ? "—"
                : formatEp(Number(decision.predicted_ep))}
            </div>
            <div className="text-xs text-fainter">Awaiting results</div>
          </>
        ) : (
          <>
            <div className="text-xs font-medium text-muted">vs alternative</div>
            <div
              className={cn(
                "font-display text-xl font-bold",
                outcome.delta > 0
                  ? "text-accent"
                  : outcome.delta < 0
                    ? "text-danger"
                    : "text-muted",
              )}
            >
              {epDelta(outcome.delta)}
            </div>
            <div className="text-xs text-muted">
              {outcome.actual_points} v {outcome.best_alternative_points}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
