import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb, isDbConfigured } from "@/lib/db/client";
import { getEntryRow } from "@/lib/db/entries";
import { parseEntryId } from "@/lib/fpl/entry";
import { RefreshSquad } from "@/components/chrome/refresh-squad";
import { EntryReadouts } from "@/components/chrome/entry-readouts";
import { buttonClass } from "@/components/ui/button";

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
    <div className="flex flex-col gap-5 sm:gap-6">
      {/*
        Which team you are looking at, always visible. The moment the URL
        decides whose squad is on screen, this is the most important line on
        the page.
      */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-display text-xl font-bold tracking-wide text-primary uppercase">
            {entry?.name ?? `Team ${entryId}`}
          </div>
          <div className="text-sm text-muted">
            {entry ? `${entry.manager_name} · ` : ""}ID {entryId}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <RefreshSquad entryId={entryId} />
          <Link href="/?switch=1" className={buttonClass("secondary")}>
            Switch team
          </Link>
        </div>
      </div>

      <EntryReadouts entryId={entryId} />

      {children}
    </div>
  );
}
