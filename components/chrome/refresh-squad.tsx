"use client";

import { useFormStatus } from "react-dom";
import { refreshSquad } from "@/app/actions";

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
    <button
      type="submit"
      disabled={pending}
      className="shrink-0 font-mono text-micro tracking-[0.12em] text-dim underline-offset-4 hover:text-primary hover:underline disabled:cursor-not-allowed disabled:no-underline disabled:opacity-60"
    >
      {pending ? "SYNCING…" : "REFRESH SQUAD"}
    </button>
  );
}
