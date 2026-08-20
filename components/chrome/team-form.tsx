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
          <label
            htmlFor="entryId"
            className="font-mono text-tiny tracking-[0.14em] text-label"
          >
            FPL TEAM ID
          </label>
          <p className="mt-1.5 text-small leading-relaxed text-muted text-pretty">
            Open <span className="text-tertiary">My Team</span> on the FPL site
            and take the number from the URL — in{" "}
            <code className="font-mono text-tertiary">
              /entry/4278347/event/1
            </code>{" "}
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
          className="h-11 border border-edge-strong bg-sunken px-3 font-mono text-value text-primary placeholder:text-ghost focus:border-accent-dim focus:outline-none"
        />

        {state.error ? (
          <p
            id="entryId-error"
            role="alert"
            className="text-small leading-relaxed text-warn text-pretty"
          >
            {state.error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={pending}
          className="h-11 border border-accent-dim bg-[color-mix(in_oklch,var(--accent)_10%,var(--surface-panel))] font-mono text-tiny tracking-[0.14em] text-accent transition-colors hover:bg-[color-mix(in_oklch,var(--accent)_16%,var(--surface-panel))] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? "LOOKING IT UP…" : "OPEN MY TEAM"}
        </button>

        <p className="text-small leading-relaxed text-dim text-pretty">
          A team id is public — anyone can read any squad through the FPL API,
          which is how mini-league tables work. Nothing private is stored, and
          there is no account to create.
        </p>
      </form>
    </Panel>
  );
}
