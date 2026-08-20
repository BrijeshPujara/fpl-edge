import { loadPreviewContext } from "@/lib/preview/context";
import { DEFAULT_HORIZON } from "@/lib/engine/constants";
import { TransferBoard } from "@/components/transfers/transfer-board";
import { PreviewUnavailable } from "../_shared";

export default async function PreviewTransfersPage() {
  const preview = await loadPreviewContext(DEFAULT_HORIZON);
  if (preview.state !== "ready") {
    return <PreviewUnavailable context={preview} />;
  }
  return <TransferBoard context={preview.context} />;
}
