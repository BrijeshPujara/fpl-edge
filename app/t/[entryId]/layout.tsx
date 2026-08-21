import { notFound } from "next/navigation";
import { getDb, isDbConfigured } from "@/lib/db/client";
import { getEntryRow } from "@/lib/db/entries";
import { parseEntryId } from "@/lib/fpl/entry";
import { RefreshSquad } from "@/components/chrome/refresh-squad";
import { SwitchTeam } from "@/components/chrome/switch-team";
import { EntryReadouts } from "@/components/chrome/entry-readouts";

/**
 * Everything under `/t/{entryId}` belongs to one manager.
 *
 * The id is validated here rather than in each page, so a malformed segment
 * cannot reach a query. `notFound()` and not a redirect: `/t/banana` is not a
 * page that moved, it is a page that never existed, and a 404 says so.
 */
export default async function EntryLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ entryId: string }>;
}) {
  const { entryId: raw } = await params;
  const entryId = parseEntryId(raw);
  if (entryId === null) notFound();

  const entry = isDbConfigured() ? await getEntryRow(getDb(), entryId) : null;

  return (
    <div>
      {/*
        Which team you are looking at, always visible. In a single-manager app
        this would be clutter; the moment the URL decides whose squad is on
        screen it is the most important line on the page.
      */}
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-edge pb-3 sm:mb-6">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
          <div className="truncate text-body text-primary">
            {entry?.name ?? `Team ${entryId}`}
          </div>
          {entry ? (
            <div className="font-mono text-micro tracking-[0.1em] text-fainter">
              {entry.manager_name.toUpperCase()}
            </div>
          ) : null}
          <div className="font-mono text-micro tracking-[0.1em] text-label">
            #{entryId}
          </div>
        </div>
        <div className="flex shrink-0 items-baseline gap-4">
          <RefreshSquad entryId={entryId} />
          <SwitchTeam />
        </div>
      </div>

      {/*
        This manager's numbers, in the one layout that knows which manager that
        is. They were in the masthead and permanently blank; see EntryReadouts.
      */}
      <div className="mb-4 border-b border-edge pb-3 sm:mb-6">
        <EntryReadouts entryId={entryId} />
      </div>
      {children}
    </div>
  );
}
