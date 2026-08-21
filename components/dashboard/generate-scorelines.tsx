"use client";

import { useFormStatus } from "react-dom";
import { generateScorelines } from "@/app/actions";

/**
 * The button that makes the prediction.
 *
 * Labelled REGENERATE once predictions exist, because pressing it again
 * replaces them — and someone who thinks they are adding a second opinion
 * should be told they are overwriting the first.
 */
export function GenerateScorelines({
  entryId,
  gw,
  existing,
}: {
  entryId: number;
  gw: number;
  existing: boolean;
}) {
  return (
    <form action={generateScorelines}>
      <input type="hidden" name="entryId" value={entryId} />
      <input type="hidden" name="gw" value={gw} />
      <Button existing={existing} />
    </form>
  );
}

function Button({ existing }: { existing: boolean }) {
  // useFormStatus has to be read from inside the form, hence the split.
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      className="shrink-0 font-mono text-micro tracking-[0.12em] text-dim underline-offset-4 hover:text-primary hover:underline disabled:cursor-not-allowed disabled:no-underline disabled:opacity-60"
    >
      {pending ? "GENERATING…" : existing ? "REGENERATE" : "GENERATE"}
    </button>
  );
}
