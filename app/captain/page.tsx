import { SectionLabel } from "@/components/ui/panel";
import { Pending } from "@/components/ui/pending";

export default function CaptainPage() {
  return (
    <div>
      <SectionLabel>CAPTAIN CANDIDATES</SectionLabel>
      <Pending phase="phase 3 — optimiser">
        Captaincy is ranked on the EP distribution rather than the mean —
        ceiling matters more than expectation when the return is doubled. Needs
        the EP model to emit a distribution, not just a point estimate.
      </Pending>
    </div>
  );
}
