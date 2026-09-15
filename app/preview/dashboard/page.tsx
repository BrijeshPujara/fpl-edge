import { loadPreviewContext } from "@/lib/preview/context";
import { CHIP_SCAN_HORIZON, DEFAULT_HORIZON } from "@/lib/engine/constants";
import { FlagsCard } from "@/components/dashboard/flags-card";
import { WeekPlan } from "@/components/dashboard/week-plan";
import { PreviewUnavailable } from "../_shared";

export default async function PreviewDashboardPage() {
  // Two horizons, as the real dashboard loads them.
  const [preview, chipPreview] = await Promise.all([
    loadPreviewContext(DEFAULT_HORIZON),
    loadPreviewContext(CHIP_SCAN_HORIZON),
  ]);
  if (preview.state !== "ready") {
    return <PreviewUnavailable context={preview} />;
  }
  if (chipPreview.state !== "ready") {
    return <PreviewUnavailable context={chipPreview} />;
  }

  return (
    <div className="grid grid-cols-1 items-start gap-5 sm:gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <WeekPlan
        context={preview.context}
        chipContext={chipPreview.context}
        played={[]}
        deadline={null}
        shape={null}
      />
      <FlagsCard squad={preview.context.squad} />
    </div>
  );
}
