import { SectionLabel } from "@/components/ui/panel";
import { Pending } from "@/components/ui/pending";

export default function LeaguesPage() {
  return (
    <div>
      <SectionLabel>MINI-LEAGUES</SectionLabel>
      <Pending phase="configuration and phase 5">
        Rival squads and differential analysis. Needs FPL_LEAGUE_IDS set and a
        synced player reference table.
      </Pending>
    </div>
  );
}
