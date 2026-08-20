import Link from "next/link";

/** Back to the landing page to enter a different team id. */
export function SwitchTeam() {
  return (
    <Link
      href="/?switch=1"
      className="shrink-0 font-mono text-micro tracking-[0.12em] text-dim underline-offset-4 hover:text-primary hover:underline"
    >
      SWITCH TEAM
    </Link>
  );
}
