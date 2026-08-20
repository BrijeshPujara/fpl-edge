import Link from "next/link";
import { PREVIEW_GW } from "@/lib/preview/context";
import { Panel, Row, SectionLabel } from "@/components/ui/panel";

const SCREENS = [
  {
    href: "/preview/dashboard",
    name: "Dashboard",
    note: "This week's ranked actions and the squad's EP distribution",
  },
  {
    href: "/preview/squad",
    name: "Squad",
    note: "Pitch view, per-player EP, fixture difficulty strips",
  },
  {
    href: "/preview/transfers",
    name: "Transfers",
    note: "Ranked options, hits, the roll, and the budget shadow price",
  },
  {
    href: "/preview/chips",
    name: "Chips",
    note: "Which gameweek to play each chip, and the margin over the alternative",
  },
];

export default function PreviewIndex() {
  return (
    <div>
      <SectionLabel meta={`REPLAYING GW${PREVIEW_GW}`}>
        PREVIEW SCREENS
      </SectionLabel>
      <Panel>
        {SCREENS.map((screen) => (
          <Row key={screen.href} height="tall" hover>
            <Link href={screen.href} className="block">
              <div className="text-body text-primary">{screen.name}</div>
              <div className="text-small text-muted">{screen.note}</div>
            </Link>
          </Row>
        ))}
      </Panel>
    </div>
  );
}
