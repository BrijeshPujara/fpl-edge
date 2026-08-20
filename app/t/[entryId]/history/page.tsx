import { SectionLabel } from "@/components/ui/panel";
import { Pending } from "@/components/ui/pending";

export default function HistoryPage() {
  return (
    <div>
      <SectionLabel>DECISION JOURNAL</SectionLabel>
      <Pending phase="phase 5 — decision journal">
        Every recommendation, what was actually done, and what it returned
        against the best alternative. This is the screen that answers whether
        the engine has been right — it needs the decisions and outcomes tables
        and at least one resolved gameweek.
      </Pending>
    </div>
  );
}
