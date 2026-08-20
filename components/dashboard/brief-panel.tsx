import { getBrief } from "@/lib/llm/brief";
import { Panel, SectionLabel } from "@/components/ui/panel";

/**
 * The written brief, when one exists.
 *
 * Renders nothing when there is no brief. That is the architectural rule the
 * whole project rests on: the engine works with no LLM present, and a screen
 * full of real numbers should not carry an apology about a missing one.
 *
 * Note what it does NOT check: whether THIS process has an API key.
 *
 * Briefs are written by the sync job and read by the app, and those are
 * different processes on different machines — the job runs in CI with a key,
 * the app renders on Vercel without needing one. Gating the read on a key
 * would hide a brief that had already been written and paid for, and would
 * make the app appear to need a credential it has no use for.
 */
export async function BriefPanel({
  entryId,
  gw,
}: {
  entryId: number;
  gw: number;
}) {
  const brief = await getBrief(entryId, gw);
  if (!brief) return null;

  return (
    <div>
      <SectionLabel meta={brief.model.toUpperCase()}>THE BRIEF</SectionLabel>
      <Panel padded>
        <div className="flex max-w-prose flex-col gap-2.5 text-small leading-relaxed text-secondary text-pretty">
          {brief.body
            .split(/\n{2,}/)
            .filter((p) => p.trim().length > 0)
            .map((paragraph, i) => (
              <p key={i}>{paragraph.trim()}</p>
            ))}
        </div>
      </Panel>
      <div className="mt-2 max-w-prose text-small leading-relaxed text-dim text-pretty">
        Written from the numbers above, never instead of them. Every figure it
        uses was computed by the engine; the model is not permitted to invent
        one or to disagree with the recommendation.
      </div>
    </div>
  );
}
