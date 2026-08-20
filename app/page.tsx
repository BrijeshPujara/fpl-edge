import Link from "next/link";
import { cookies } from "next/headers";
import { ENTRY_COOKIE } from "@/lib/entry-cookie";
import { parseEntryId, resolveEntryId } from "@/lib/fpl/entry";
import { getDb, isDbConfigured } from "@/lib/db/client";
import { getEntryRow } from "@/lib/db/entries";
import { TeamForm } from "@/components/chrome/team-form";
import { Panel, Row, SectionLabel } from "@/components/ui/panel";

/**
 * The front door.
 *
 * It used to redirect straight to a known team, which made this page
 * effectively invisible — nobody arriving for the first time ever saw what the
 * thing was. The fast path is now a button rather than a redirect: one click
 * instead of zero, in exchange for the page existing at all.
 */
export default async function LandingPage({
  searchParams,
}: {
  searchParams: Promise<{ switch?: string }>;
}) {
  // `?switch=1` forces the form even when a team is remembered. Without it the
  // "use a different team" link lands back on a page offering the same team,
  // which is the same dead end the old redirect created.
  const wantsSwitch = (await searchParams).switch !== undefined;

  const store = await cookies();
  const remembered =
    parseEntryId(store.get(ENTRY_COOKIE)?.value) ?? resolveEntryId();
  const known = wantsSwitch ? null : remembered;

  const entry =
    known !== null && isDbConfigured()
      ? await getEntryRow(getDb(), known)
      : null;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8 pb-8 sm:gap-12">
      <section className="pt-6 sm:pt-12">
        <div className="font-mono text-tiny tracking-[0.16em] text-label">
          FPL EDGE · A DECISION TOOL, NOT A TIP SHEET
        </div>
        <h1 className="mt-4 max-w-2xl text-hero leading-[1.1] font-semibold tracking-[-0.02em] text-primary text-balance sm:text-display">
          Every recommendation shows the number behind it.
        </h1>
        <p className="mt-4 max-w-prose text-body leading-relaxed text-muted text-pretty">
          Fantasy football is a shopping problem wearing a football shirt. You
          have £100m, you buy fifteen players, eleven of them score. This
          forecasts what each player is worth, then solves for the best squad you
          can actually afford — and tells you when the answer is to do nothing.
        </p>

        <div className="mt-7">
          {known !== null ? (
            <div className="flex flex-col gap-3">
              <Link
                href={`/t/${known}`}
                className="inline-flex h-11 w-full max-w-sm items-center justify-center border border-accent-dim bg-[color-mix(in_oklch,var(--accent)_10%,var(--surface-panel))] px-5 font-mono text-tiny tracking-[0.14em] text-accent transition-colors hover:bg-[color-mix(in_oklch,var(--accent)_16%,var(--surface-panel))]"
              >
                OPEN {(entry?.name ?? `TEAM ${known}`).toUpperCase()} →
              </Link>
              <Link
                href="/?switch=1"
                className="font-mono text-micro tracking-[0.12em] text-dim underline-offset-4 hover:text-primary hover:underline"
              >
                USE A DIFFERENT TEAM
              </Link>
            </div>
          ) : (
            <div className="max-w-md">
              <TeamForm />
            </div>
          )}
        </div>
      </section>

      <Section
        label="HOW IT WORKS"
        meta="TWO QUESTIONS"
        lead="Only two questions exist, and keeping them apart is the whole design. Most people mash them together and end up buying whoever did well last Saturday."
      >
        <Panel>
          <Step
            index="01"
            title="Forecast — what is each player worth?"
            body="Never a prediction that someone will score. An average across every way the match could go, the same idea as a 70% chance of rain. The number that comes out already contains the blanks, which is what makes it fair to compare two players with."
          />
          <Step
            index="02"
            title="Choose — which fifteen should I own?"
            body="Not the fifteen highest scorers; you would run out of money in four signings. The best combination inside the budget and the squad rules — a suitcase problem, and there are about 2.8 × 10²⁷ legal squads, so it is solved rather than searched."
          />
        </Panel>
      </Section>

      <Section
        label="THE DATA"
        meta="ALL OF IT PUBLIC"
        lead="Everything comes from the official FPL API. No scraping, no paid feed, no account beyond your own public team id."
      >
        <Panel>
          <DataRow
            what="Expected goals and assists"
            detail="Opta xG and xA per player per gameweek — the same underlying data the analytics sites use. Shot quality, not whether the shot went in."
          />
          <DataRow
            what="Minutes and starts"
            detail="Six gameweeks of appearance history. The single most consequential input in the model."
          />
          <DataRow
            what="Fitness and team news"
            detail="Status, the club's own percentage, and the news string — which says whether it is a knock or a lack of match fitness, and those mean different things at the same 75%."
          />
          <DataRow
            what="Set-piece duty"
            detail="Who takes the penalties and the corners, as a per-club ordering."
          />
          <DataRow
            what="Fixtures, difficulty, blanks and doubles"
            detail="Counted from the fixture list rather than trusted from a rating."
          />
          <DataRow
            what="Prices and net transfers"
            detail="Sampled daily, because FPL moves prices daily and the counters reset."
          />
        </Panel>
      </Section>

      <Section
        label="THE CALCULATIONS"
        meta="FOUR THAT MATTER"
        lead="Each one is a pure function with tests against it, and each is measured against a full replay of last season rather than against intuition."
      >
        <Panel>
          <Step
            index="EP"
            title="Expected points"
            body="Appearance points, plus xG and xA adjusted for the opponent, plus a Poisson clean-sheet probability, plus defensive contributions, bonus and set-piece duty — every term after the first scaled by the chance of actually being on the pitch."
          />
          <Step
            index="MIP"
            title="The squad solve"
            body="A mixed-integer programme over the whole player pool. It returns the provably best fifteen for a given forecast, not a good one — then solves a second time, relaxed, purely to read what one more £0.1m would buy."
          />
          <Step
            index="FT"
            title="Transfers, after the hit"
            body="Each transfer count is solved as its own scenario with a retention floor, then compared after the four-point charge. Rolling is always one of the options, and frequently the winner."
          />
          <Step
            index="CHIP"
            title="Chip timing"
            body="An assignment problem across every chip and every remaining week, so the answer to 'is this week good enough' accounts for the better week that might be coming before the window shuts."
          />
        </Panel>
      </Section>

      <Section
        label="WHAT IT WILL NOT DO"
        meta="THE HONEST PART"
        lead="A tool that hides its limits is a tool you cannot calibrate against."
      >
        <Panel>
          <DataRow
            what="Invent a number it has not earned"
            detail="Before a gameweek is played every projection is the same positional prior, so the screens explain that instead of ranking noise. Em dashes, not decimals."
          />
          <DataRow
            what="Watch football"
            detail="It has never seen a press conference and cannot tell that a player looked exhausted on Saturday."
          />
          <DataRow
            what="Decide anything"
            detail="It beats a naive baseline by 2.6% across last season and loses to it on forwards. That is a real edge and a thin one. The call stays yours."
          />
        </Panel>
      </Section>

      <section>
        <SectionLabel meta="OPEN SOURCE">THE LONG VERSION</SectionLabel>
        <Panel padded>
          <p className="max-w-prose text-small leading-relaxed text-muted text-pretty">
            <a
              href="https://github.com/BrijeshPujara/fpl-edge"
              className="text-accent underline-offset-4 hover:underline"
            >
              The repository
            </a>{" "}
            carries the specification, the backtest, and a working document of
            everything currently known to be wrong with it. Every constant in
            the model has a comment explaining where the number came from.
          </p>
        </Panel>
      </section>
    </div>
  );
}

function Section({
  label,
  meta,
  lead,
  children,
}: {
  label: string;
  meta: string;
  lead: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <SectionLabel meta={meta}>{label}</SectionLabel>
      <p className="mb-3.5 max-w-prose text-small leading-relaxed text-muted text-pretty">
        {lead}
      </p>
      {children}
    </section>
  );
}

function Step({
  index,
  title,
  body,
}: {
  index: string;
  title: string;
  body: string;
}) {
  return (
    <Row height="auto" className="grid grid-cols-[2.25rem_1fr] gap-3">
      <div className="pt-0.5 font-mono text-micro tracking-[0.12em] text-accent-dim">
        {index}
      </div>
      <div>
        <div className="text-body text-primary">{title}</div>
        <div className="mt-1 max-w-prose text-small leading-relaxed text-muted text-pretty">
          {body}
        </div>
      </div>
    </Row>
  );
}

/**
 * items-start is load-bearing: the Row primitive sets items-center for its
 * usual single-line case, which centres a column of text horizontally.
 */
function DataRow({ what, detail }: { what: string; detail: string }) {
  return (
    <Row height="auto" className="flex flex-col items-start gap-0.5">
      <div className="text-small text-secondary">{what}</div>
      <div className="max-w-prose text-small leading-relaxed text-dim text-pretty">
        {detail}
      </div>
    </Row>
  );
}
