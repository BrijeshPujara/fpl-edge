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
