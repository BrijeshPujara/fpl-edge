import { loadPreviewContext } from "@/lib/preview/context";
import { CaptainBoard } from "@/components/captain/captain-board";
import { PreviewUnavailable } from "../_shared";

export default async function PreviewCaptainPage() {
  // One gameweek: captaincy is a one-week decision.
  const preview = await loadPreviewContext(1);
  if (preview.state !== "ready") {
    return <PreviewUnavailable context={preview} />;
  }
  return <CaptainBoard context={preview.context} />;
}
