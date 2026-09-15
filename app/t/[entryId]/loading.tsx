import { Panel, Row, SectionLabel } from "@/components/ui/panel";

/**
 * What fills the content area while the next tab loads.
 *
 * These pages render on the server against a remote database, so a navigation
 * on a phone has a real gap in it. Without this the previous page simply sits
 * there, which reads as a tap that did not register.
 *
 * Deliberately structural rather than a spinner: it holds roughly the shape of
 * what is arriving, so the layout does not jump when the real content lands,
 * and a few hundred milliseconds of skeleton reads as speed where a spinner
 * reads as trouble.
 */
export default function Loading() {
  return (
    <div className="grid grid-cols-1 items-start gap-4 sm:gap-6 lg:grid-cols-[1fr_340px]">
      <div className="flex flex-col gap-4 sm:gap-6">
        <div>
          <SectionLabel>LOADING</SectionLabel>
          <Panel>
            {Array.from({ length: 6 }, (_, i) => (
              <Row key={i} height="table" className="flex items-center">
                <div
                  className="h-2 animate-pulse bg-track"
                  style={{ width: `${58 - i * 6}%`, animationDelay: `${i * 60}ms` }}
                />
              </Row>
            ))}
          </Panel>
        </div>
      </div>

      <div>
        <SectionLabel>&nbsp;</SectionLabel>
        <Panel padded>
          <div className="flex flex-col gap-3">
            {Array.from({ length: 3 }, (_, i) => (
              <div
                key={i}
                className="h-2 animate-pulse bg-track"
                style={{ width: `${70 - i * 12}%`, animationDelay: `${i * 60}ms` }}
              />
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}
