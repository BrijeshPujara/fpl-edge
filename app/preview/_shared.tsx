import { Pending } from "@/components/ui/pending";
import type { PreviewContext } from "@/lib/preview/context";

/**
 * The two ways a preview can fail to load, both of which are ordinary local
 * conditions rather than errors.
 */
export function PreviewUnavailable({
  context,
}: {
  context: Exclude<PreviewContext, { state: "ready" }>;
}) {
  if (context.state === "no-db") {
    return (
      <Pending phase="configuration">
        Supabase is not configured, so there are no players, teams or fixtures
        to build a preview from. The preview invents a squad and a form guide,
        never the league itself.
      </Pending>
    );
  }

  return (
    <Pending phase="the backtest cache">
      The preview replays real 2025/26 results, which live in the cache the
      backtest downloads. Run{" "}
      <code className="font-mono text-tertiary">npm run backtest</code> once to
      populate <code className="font-mono text-tertiary">.backtest-cache/</code>
      , then reload.
    </Pending>
  );
}
