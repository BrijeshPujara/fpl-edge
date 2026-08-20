import { notFound } from "next/navigation";
import { isPreviewEnabled, PREVIEW_GW } from "@/lib/preview/context";

/**
 * The fence around the preview.
 *
 * One gate for the whole subtree, and it is a 404 rather than a redirect or a
 * hidden flag: in production these routes do not exist. The real screens never
 * import anything from `lib/preview`, so there is no switch to leave on.
 */
export default function PreviewLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (!isPreviewEnabled()) notFound();

  return (
    <div>
      <div className="mb-4 border border-warn-dim bg-[color-mix(in_oklch,var(--warn)_8%,var(--surface-panel))] px-3.5 py-2.5 sm:mb-6">
        <div className="font-mono text-tiny tracking-[0.14em] text-warn">
          PREVIEW · NOT YOUR SQUAD · NOT THIS SEASON
        </div>
        <div className="mt-1.5 max-w-prose text-small leading-relaxed text-muted text-pretty">
          A development harness. The squad is invented and the form data is real
          but from <span className="text-tertiary">2025/26</span>, replayed as
          though it were gameweek {PREVIEW_GW}. Fixtures and prices are this
          season&apos;s. Nothing here is written to the database, and these
          routes return 404 in production.
        </div>
      </div>
      {children}
    </div>
  );
}
