import { getBrief } from "@/lib/llm/brief";
import { isLlmConfigured } from "@/lib/llm/client";
import { Panel, SectionLabel } from "@/components/ui/panel";

/**
 * The written brief, when one exists.
 *
 * Renders nothing at all without a key. That is deliberate and it is the
 * architectural rule the whole project is built on: the engine works with no
 * LLM present, and a screen full of real numbers should not carry an apology
 * about a missing one.
 */
export async function BriefPanel({
  entryId,
  gw,
}: {
  entryId: number;
  gw: number;
}) {
  if (!isLlmConfigured()) return null;

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
