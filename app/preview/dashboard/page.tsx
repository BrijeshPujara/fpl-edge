import { loadPreviewContext } from "@/lib/preview/context";
import { DEFAULT_HORIZON } from "@/lib/engine/constants";
import { FlagPanel, WeekPanels } from "@/components/dashboard/week-panels";
import { SectionLabel } from "@/components/ui/panel";
import { PreviewUnavailable } from "../_shared";

export default async function PreviewDashboardPage() {
  const preview = await loadPreviewContext(DEFAULT_HORIZON);
  if (preview.state !== "ready") {
    return <PreviewUnavailable context={preview} />;
  }

  return (
    <div className="grid grid-cols-1 items-start gap-4 sm:gap-6 lg:grid-cols-[1fr_340px]">
      <WeekPanels context={preview.context} />
      <div>
        <SectionLabel>FLAGS</SectionLabel>
        <FlagPanel squad={preview.context.squad} />
      </div>
    </div>
  );
}
