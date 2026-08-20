import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ENTRY_COOKIE } from "@/lib/entry-cookie";
import { parseEntryId, resolveEntryId } from "@/lib/fpl/entry";
import { TeamForm } from "@/components/chrome/team-form";
import { SectionLabel } from "@/components/ui/panel";

/**
 * The way in.
 *
 * Whoever has been here before goes straight through — a remembered cookie
 * first, then the deployment's own `FPL_TEAM_ID`, which is what keeps a
 * personal install feeling like a personal install rather than a public tool
 * that happens to know your name.
 *
 * There is no sign-in here and there is not going to be one. An FPL team id is
 * public: `entry/{id}/` is unauthenticated, and the FPL site itself reads it
 * for every mini-league table. A password would protect nothing and imply the
 * opposite.
 */
export default async function LandingPage({
  searchParams,
}: {
  searchParams: Promise<{ switch?: string }>;
}) {
  // `?switch=1` is what makes "switch team" work at all. Without it the
  // redirects below fire unconditionally, so on a deployment with FPL_TEAM_ID
  // set — every personal install — the link would bounce straight back to the
  // same team and look broken.
  const wantsSwitch = (await searchParams).switch !== undefined;

  if (!wantsSwitch) {
    // The cookie outranks the environment on purpose. A configured
    // FPL_TEAM_ID is this deployment's default, not a lock: someone who has
    // deliberately chosen another team should keep landing on it.
    const store = await cookies();
    const remembered = parseEntryId(store.get(ENTRY_COOKIE)?.value);
    if (remembered !== null) redirect(`/t/${remembered}`);

    const configured = resolveEntryId();
    if (configured !== null) redirect(`/t/${configured}`);
  }

  return (
    <div className="mx-auto max-w-lg pt-8 sm:pt-16">
      <SectionLabel meta="NO SIGN-IN REQUIRED">
        {wantsSwitch ? "SWITCH TEAM" : "GET STARTED"}
      </SectionLabel>
      <TeamForm />
    </div>
  );
}
