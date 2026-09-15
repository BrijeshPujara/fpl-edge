import Link from "next/link";
import { cookies } from "next/headers";
import { ArrowRight } from "lucide-react";
import { ENTRY_COOKIE } from "@/lib/entry-cookie";
import { parseEntryId, resolveEntryId } from "@/lib/fpl/entry";
import { getDb, isDbConfigured } from "@/lib/db/client";
import { getEntryRow } from "@/lib/db/entries";
import { TeamForm } from "@/components/chrome/team-form";
import { Panel, SectionLabel } from "@/components/ui/panel";

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
    <div className="mx-auto flex max-w-3xl flex-col gap-10 pb-8 sm:gap-12">
      <section className="flex flex-col gap-4 pt-4 sm:pt-10">
        <div className="text-xs font-semibold tracking-wide text-muted uppercase">
          FPL Edge · a decision tool, not a tip sheet
        </div>
        <h1 className="max-w-2xl font-display text-4xl leading-[1.02] font-bold tracking-wide text-primary uppercase text-balance sm:text-6xl">
          Every recommendation shows the number behind it.
        </h1>
        <p className="max-w-prose text-base leading-relaxed text-secondary text-pretty">
          Fantasy football is a shopping problem wearing a football shirt. You
          have £100m, you buy fifteen players, eleven of them score. This
          forecasts what each player is worth, then solves for the best squad you
          can actually afford — and tells you when the answer is to do nothing.
        </p>

        <div className="mt-2">
          {known !== null ? (
            <div className="flex flex-col items-start gap-3">
              <Link
                href={`/t/${known}`}
                className="inline-flex h-12 items-center gap-2 bg-signal px-6 font-display text-lg font-bold tracking-wide text-signal-ink uppercase hover:bg-[color-mix(in_oklch,var(--signal)_88%,black)] hover:text-signal-ink"
              >
                Open {entry?.name ?? `team ${known}`}
                <ArrowRight aria-hidden className="size-5" />
              </Link>
              <Link
                href="/?switch=1"
                className="text-sm font-medium text-muted underline underline-offset-4 hover:text-primary"
              >
                Use a different team
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
        label="How it works"
        meta="Two questions"
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
        label="The data"
        meta="All of it public"
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
        label="The calculations"
        meta="Four that matter"
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
        label="What it will not do"
        meta="The honest part"
        lead="A tool that hides its limits is a tool you cannot calibrate against."
      >
        <Panel>
          <DataRow
            what="Invent a number it has not earned"
            detail="Before a gameweek is played every projection is the same positional prior, so the screens explain that instead of ranking noise. Dashes, not decimals."
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
        <SectionLabel meta="Open source">The long version</SectionLabel>
        <Panel padded>
          <p className="max-w-prose text-sm leading-relaxed text-muted text-pretty">
            <a
              href="https://github.com/BrijeshPujara/fpl-edge"
              className="font-semibold text-primary underline underline-offset-4 hover:text-accent"
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
      <p className="mb-3 max-w-prose text-sm leading-relaxed text-muted text-pretty">
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
    <div className="grid grid-cols-[3rem_minmax(0,1fr)] gap-3 border-b border-edge-subtle px-4 py-3.5 last:border-b-0">
      <div>
        <span className="inline-block bg-sidebar px-1.5 py-0.5 font-display text-sm font-bold text-signal">
          {index}
        </span>
      </div>
      <div>
        <div className="text-base font-semibold text-primary">{title}</div>
        <div className="mt-1 max-w-prose text-sm leading-relaxed text-muted text-pretty">
          {body}
        </div>
      </div>
    </div>
  );
}

function DataRow({ what, detail }: { what: string; detail: string }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-edge-subtle px-4 py-3 last:border-b-0">
      <div className="text-sm font-semibold text-primary">{what}</div>
      <div className="max-w-prose text-sm leading-relaxed text-muted text-pretty">
        {detail}
      </div>
    </div>
  );
}
