import { notFound } from "next/navigation";
import { getDb, isDbConfigured } from "@/lib/db/client";
import { getJournal, movesOf, type JournalEntry } from "@/lib/db/decisions";
import { getPlayersByIds } from "@/lib/db/queries";
import { parseEntryId } from "@/lib/fpl/entry";
import { ep as formatEp, epDelta } from "@/lib/format";
import { cn } from "@/lib/cn";
import { Panel, Row, SectionLabel, StatRow } from "@/components/ui/panel";
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

  if (journal.length === 0) {
    return (
      <div>
        <SectionLabel>DECISION JOURNAL</SectionLabel>
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
    <div className="grid grid-cols-1 items-start gap-4 sm:gap-6 lg:grid-cols-[1fr_280px]">
      <div>
        <SectionLabel meta={`${journal.length} RECORDED`}>
          DECISION JOURNAL
        </SectionLabel>
        <Panel>
          {journal.map((entry) => (
            <JournalRow key={entry.decision.id} entry={entry} nameOf={nameOf} />
          ))}
        </Panel>
      </div>

      <div className="flex flex-col gap-4 sm:gap-6">
        <div>
          <SectionLabel meta="AGAINST THE ALTERNATIVE">THE RECORD</SectionLabel>
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
        </div>

        <div className="max-w-prose text-small leading-relaxed text-dim text-pretty">
          Scored against the best option the engine passed over, not against the
          highest score in the game. The question is whether it chose well from
          what it offered — being beaten by a player nobody was considering is
          not a mistake it made.
          {scored.length > 0 && scored.length < 10 ? (
            <>
              {" "}
              <span className="text-tertiary">
                Too few decisions to mean anything yet.
              </span>{" "}
              A handful of captaincy calls is noise; a season of them is a
              record.
            </>
          ) : null}
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
  captain: "CAPTAIN",
  transfer: "TRANSFER",
  hold: "HOLD",
  chip: "CHIP",
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
    <Row height="auto" className="grid grid-cols-[1fr_auto] gap-3">
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <div className="font-mono text-micro tracking-[0.14em] text-label">
            GW{decision.gw}
          </div>
          <div className="font-mono text-micro tracking-[0.12em] text-accent-dim">
            {KIND_LABEL[decision.kind] ?? decision.kind.toUpperCase()}
          </div>
        </div>
        <div className="truncate text-body text-primary">{headline}</div>
        {decision.rationale ? (
          <div className="max-w-prose text-small leading-relaxed text-muted text-pretty">
            {decision.rationale}
          </div>
        ) : null}
      </div>

      <div className="flex flex-col justify-center text-right">
        {outcome === null ? (
          <>
            <div className="font-mono text-micro tracking-[0.12em] text-label">
              PREDICTED
            </div>
            <div className="font-mono text-cell text-muted">
              {decision.predicted_ep === null
                ? "—"
                : formatEp(Number(decision.predicted_ep))}
            </div>
            <div className="font-mono text-micro tracking-[0.1em] text-ghost">
              AWAITING RESULTS
            </div>
          </>
        ) : (
          <>
            <div className="font-mono text-micro tracking-[0.12em] text-label">
              VS ALTERNATIVE
            </div>
            <div
              className={cn(
                "font-mono text-cell",
                outcome.delta > 0
                  ? "text-accent"
                  : outcome.delta < 0
                    ? "text-warn"
                    : "text-muted",
              )}
            >
              {epDelta(outcome.delta)}
            </div>
            <div className="font-mono text-micro tracking-[0.1em] text-fainter">
              {outcome.actual_points} V {outcome.best_alternative_points}
            </div>
          </>
        )}
      </div>
    </Row>
  );
}
