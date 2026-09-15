"use client";

import { useFormStatus } from "react-dom";
import { RefreshCw } from "lucide-react";
import { refreshSquad } from "@/app/actions";
import { buttonClass } from "@/components/ui/button";
import { cn } from "@/lib/cn";

/**
 * Pull this manager's squad from FPL now.
 *
 * The one control on the screen that exists because of a clock: picks appear
 * the instant a deadline passes, and the scheduled sync runs the next morning.
 */
export function RefreshSquad({ entryId }: { entryId: number }) {
  return (
    <form action={refreshSquad}>
      <input type="hidden" name="entryId" value={entryId} />
      <Button />
    </form>
  );
}

function Button() {
  // useFormStatus has to be read from inside the form, hence the split.
  const { pending } = useFormStatus();

  return (
    <button type="submit" disabled={pending} className={buttonClass("secondary")}>
      <RefreshCw aria-hidden className={cn("size-4", pending && "animate-spin")} />
      {pending ? "Syncing…" : "Refresh squad"}
    </button>
  );
}
