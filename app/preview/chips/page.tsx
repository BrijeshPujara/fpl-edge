import { loadPreviewContext } from "@/lib/preview/context";
import { CHIP_SCAN_HORIZON } from "@/lib/engine/constants";
import { ChipPlanPanels } from "@/components/chips/advisories";
import { PreviewUnavailable } from "../_shared";

export default async function PreviewChipsPage() {
  const preview = await loadPreviewContext(CHIP_SCAN_HORIZON);
  if (preview.state !== "ready") {
    return <PreviewUnavailable context={preview} />;
  }
  return <ChipPlanPanels context={preview.context} />;
}
