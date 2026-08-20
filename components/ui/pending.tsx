import { Panel } from "./panel";

/**
 * Honest empty state for a screen whose engine has not been built yet.
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
  /** Which build phase delivers this screen, per PLAN.md. */
  phase: string;
  children: React.ReactNode;
}) {
  return (
    <Panel padded>
      <div className="font-mono text-tiny tracking-[0.14em] text-label">
        AWAITING {phase.toUpperCase()}
      </div>
      <div className="mt-2 max-w-prose text-small leading-relaxed text-muted text-pretty">
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
      <span className="text-tertiary">My Team</span> on the FPL site, as in{" "}
      <code className="font-mono text-tertiary">/entry/4278347/</code>.
      <br />
      <br />
      League-wide screens work without it. Only the ones about{" "}
      <span className="text-tertiary">your</span> squad need it.
    </Pending>
  );
}
