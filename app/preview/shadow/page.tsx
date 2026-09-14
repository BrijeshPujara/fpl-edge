import { shadowVerdict } from "@/lib/shadow/verdict";
import { Panel, SectionLabel } from "@/components/ui/panel";
import { GapChart } from "@/components/shadow/gap-chart";

/**
 * The shadow chart with invented weeks.
 *
 * The real screen has nothing to draw until a shadow week is scored, which is
 * the Monday after its deadline at the earliest. This renders the same
 * component through the same verdict code, so the band, the end label and the
 * hover layer can be looked at before then.
 */

// Engine minus manager, per week: a small edge buried in ordinary noise — the
// shape a real season would most likely have.
const GAPS = [4, -6, 9, -3, 2, 11, -8, 5, 7, -2, 6, 3];

export default function ShadowPreview() {
  const verdict = shadowVerdict(
    GAPS.map((gap, i) => ({ gw: 5 + i, shadow: 55 + gap, manager: 55 })),
  );

  return (
    <div>
      <SectionLabel meta="SHADED BAND = WHAT LUCK ALONE PRODUCES">
        CUMULATIVE GAP, ENGINE MINUS YOU
      </SectionLabel>
      <Panel padded>
        <GapChart points={verdict.weeks} />
      </Panel>
      <div className="mt-3 max-w-prose font-mono text-tiny text-muted">
        gap {verdict.gap} · t {verdict.t?.toFixed(2)} · reading {verdict.reading}
      </div>
    </div>
  );
}
