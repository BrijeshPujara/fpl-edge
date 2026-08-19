import { SectionLabel } from "@/components/ui/panel";
import { Pending } from "@/components/ui/pending";

export default function TransfersPage() {
  return (
    <div>
      <SectionLabel meta="HORIZON 5 GW">TRANSFER CANDIDATES</SectionLabel>
      <Pending phase="phase 3 — optimiser">
        Ranked transfer moves with EP gain, cost after hits and price-change
        risk. Depends on the mixed-integer optimiser, which in turn depends on a
        calibrated expected-points model. Critically, this screen must be able
        to recommend rolling a transfer when nothing clears the four-point
        threshold — that is the phase-3 acceptance test.
      </Pending>
    </div>
  );
}
