import { Panel } from "./panel";

/**
 * Honest empty state for a screen whose engine has nothing to show yet.
 *
 * The design mocks every screen with plausible numbers. Those numbers must
 * never reach the running app — a decision tool that displays an invented
 * 6.4 EP is worse than one that displays nothing. This component is what
 * stands in until the real computation exists.
 */
export function Pending({
  phase,
  children,
}: {
  /** What the screen is waiting for, e.g. "the first deadline". */
  phase: string;
  children: React.ReactNode;
}) {
  return (
    <Panel padded>
      <div className="text-xs font-semibold tracking-wide text-warn uppercase">
        Waiting for {phase}
      </div>
      <div className="mt-1.5 max-w-prose text-sm leading-relaxed text-muted text-pretty">
        {children}
      </div>
    </Panel>
  );
}

/**
 * No entry id configured.
 *
 * Its own component because three screens hit it and the copy has to point at
 * the same fix. Deliberately distinct from "no squad synced yet": that one
 * resolves itself when a deadline passes, this one never resolves until someone
 * sets a variable, and conflating them sends people to wait for a deadline that
 * will not help.
 */
export function NoEntry() {
  return (
    <Pending phase="configuration">
      No FPL team is configured, so there is no squad to work from. Set{" "}
      <code className="font-mono text-tertiary">FPL_TEAM_ID</code> to your entry
      id — the number in the URL when you open{" "}
      <span className="font-medium text-tertiary">My Team</span> on the FPL site,
      as in <code className="font-mono text-tertiary">/entry/4278347/</code>.
      <br />
      <br />
      League-wide screens work without it. Only the ones about{" "}
      <span className="font-medium text-tertiary">your</span> squad need it.
    </Pending>
  );
}

/**
 * A caveat, not a refusal.
 *
 * Shown above a screen that IS ranking things, when the ranking rests on last
 * season alone. The numbers are real; what is missing is any knowledge of what
 * changed over the summer, and a ranking that quietly hid that would be worse
 * than one that says it.
 *
 * This text used to claim every player carried the same flat starting
 * probability. That was true when it was written and stopped being true in
 * 996fa39, which gave the minutes model last season's workload — so for two
 * days the screen told people their nailed starter and their fourth-choice
 * striker were indistinguishable when the model had in fact told them apart.
 * A caveat that overstates the uncertainty is as wrong as one that hides it.
 *
 * No outer margin: every caller places it inside a gapped column, and a margin
 * here doubled that gap.
 */
export function PriorSeasonBasis() {
  return (
    <div className="border border-warn-dim bg-[color-mix(in_oklch,var(--warn)_8%,var(--surface-panel))] px-4 py-3">
      <div className="text-sm font-semibold text-warn">Ranked on last season</div>
      <div className="mt-1 max-w-prose text-sm leading-relaxed text-secondary text-pretty">
        No gameweek has been played, so every number here comes from{" "}
        <span className="font-medium">last season</span> — scoring rates, how
        often each player started, and how strong each club was. All of it is
        real. None of it knows about a summer transfer, a new manager or a lost
        place, so a player who was nailed last season is ranked as nailed
        whether or not he still is.
      </div>
    </div>
  );
}
