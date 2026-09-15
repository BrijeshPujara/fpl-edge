"use client";

import { useActionState } from "react";
import { useTeam } from "@/app/actions";
import type { UseTeamState } from "@/lib/entry-cookie";
import { Panel } from "@/components/ui/panel";

const INITIAL: UseTeamState = { error: null };

/**
 * The team id form.
 *
 * A client component only because it needs the pending state — the work all
 * happens in the server action. `inputMode="numeric"` puts a phone on the digit
 * keypad, which matters more than it sounds for a seven-digit number.
 */
export function TeamForm() {
  const [state, formAction, pending] = useActionState(useTeam, INITIAL);

  return (
    <Panel padded>
      <form action={formAction} className="flex flex-col gap-3.5">
        <div>
          <label htmlFor="entryId" className="text-sm font-semibold text-primary">
            Your FPL team ID
          </label>
          <p className="mt-1 text-sm leading-relaxed text-muted text-pretty">
            Open <span className="font-medium text-tertiary">My Team</span> on the
            FPL site and take the number from the URL — in{" "}
            <code className="font-mono text-tertiary">/entry/4278347/event/1</code>{" "}
            it is <code className="font-mono text-tertiary">4278347</code>.
          </p>
        </div>

        <input
          id="entryId"
          name="entryId"
          inputMode="numeric"
          autoComplete="off"
          placeholder="4278347"
          aria-describedby={state.error ? "entryId-error" : undefined}
          aria-invalid={state.error ? true : undefined}
          className="h-12 border border-edge-strong bg-panel px-3 font-display text-xl font-bold tracking-wide text-primary placeholder:text-ghost focus:border-primary focus:outline-2 focus:outline-offset-0 focus:outline-signal"
        />

        {state.error ? (
          <p
            id="entryId-error"
            role="alert"
            className="text-sm leading-relaxed font-medium text-danger text-pretty"
          >
            {state.error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={pending}
          className="h-12 bg-signal font-display text-lg font-bold tracking-wide text-signal-ink uppercase hover:bg-[color-mix(in_oklch,var(--signal)_88%,black)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? "Looking it up…" : "Open my team"}
        </button>

        <p className="text-sm leading-relaxed text-muted text-pretty">
          A team ID is public — anyone can read any squad through the FPL API,
          which is how mini-league tables work. Nothing private is stored, and
          there is no account to create.
        </p>
      </form>
    </Panel>
  );
}
