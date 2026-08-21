import { getDb, isDbConfigured } from "@/lib/db/client";
import { getLatestSquad } from "@/lib/db/queries";
import { getEntry } from "@/lib/fpl/client";
import { getLiveGameweek } from "@/lib/fpl/live-context";
import { getSeasonContext } from "@/lib/fpl/season";
import { gameweekInPlay } from "@/lib/fpl/gameweek";
import { liveSquad } from "@/lib/squad/live";
import { Readout } from "@/components/ui/panel";
import { money, ep as formatEp } from "@/lib/format";
import { loadDecisionContext } from "@/lib/db/decision-context";
import { bestXi } from "@/lib/engine/best-xi";
import { DEFAULT_HORIZON } from "@/lib/engine/constants";
import { CAPTAIN_MULTIPLIER } from "@/lib/rules";

/**
 * The four readouts that belong to a manager rather than to the season.
 *
 * They used to sit in the masthead beside the deadline, hardcoded to an em
 * dash with a comment promising they would fill in "until the squad sync
 * lands". They could not: the masthead is rendered by the ROOT layout, which
 * has no entry id and cannot get one — every URL under `/t/{id}` names a
 * different manager and any team is viewable, so reading the cookie would show
 * your numbers over someone else's squad.
 *
 * So they live here, in the one layout that knows whose team is on screen. The
 * deadline stays in the masthead, because a deadline belongs to the gameweek
 * and is the same for everyone.
 */
export async function EntryReadouts({ entryId }: { entryId: number }) {
  const season = await getSeasonContext();
  const db = isDbConfigured() ? getDb() : null;

  // Overall rank comes from FPL rather than from our tables — we never store
  // it, and it moves every gameweek. Cached for an hour by the client, and
  // allowed to fail: a missing rank is a dash, not an error page.
  const [entry, squad] = await Promise.all([
    getEntry(entryId, { revalidate: 3600 }).catch(() => null),
    db && season.available
      ? getLatestSquad(db, entryId, season.gameweek.target.id).catch(() => null)
      : null,
  ]);

  /*
   * While the football is on, the live score is the number a manager wants
   * here — a projection for a match already being played is not.
   */
  const inPlay = season.available ? gameweekInPlay(season.gameweek) : null;
  const started = inPlay !== null && !inPlay.finished;

  let points: string | null = null;
  if (squad && inPlay && started) {
    const live = await getLiveGameweek(inPlay.id);
    if (live?.anyStarted) {
      points = String(
        liveSquad({
          picks: squad.picks.map((p) => ({
            playerId: p.player_id,
            position: p.position,
            isCaptain: p.is_captain,
            isVice: p.is_vice,
          })),
          elements: live.elements,
          startedFixtures: live.startedFixtures,
          chip: squad.squad.chip_played,
        }).total,
      );
    }
  }

  /*
   * With no football under way, the projection is the useful number. Loaded
   * only in that case — during a gameweek it would be a forecast for matches
   * already being played, and the work is wasted as well as misleading.
   */
  let projected: string | null = null;
  if (points === null) {
    const context = await loadDecisionContext(entryId, DEFAULT_HORIZON).catch(
      () => null,
    );
    if (context?.state === "ready" && context.projectable) {
      const epFor = (id: number) =>
        context.squad.find((c) => c.id === id)?.perGameweek.find(
          (g) => g.gw === context.gw,
        )?.ep ?? 0;
      const xi = bestXi(
        context.squad.map((c) => ({
          id: c.id,
          position: c.position,
          ep: epFor(c.id),
        })),
      );
      if (xi.starting.length > 0) {
        const captainBonus = xi.captain
          ? epFor(xi.captain.id) * (CAPTAIN_MULTIPLIER - 1)
          : 0;
        projected = formatEp(
          xi.starting.reduce((sum, p) => sum + epFor(p.id), 0) + captainBonus,
        );
      }
    }
  }

  const rank = entry?.summary_overall_rank ?? null;

  return (
    <div className="grid grid-cols-4 gap-x-4">
      {/*
        One slot, two different numbers, and the label says which. Showing a
        projection beside a live score would invite reading the wrong one; see
        the same reasoning on the squad tiles.
      */}
      <Readout
        label={points !== null ? "GW POINTS" : "PROJ. EP"}
        tone={points !== null ? "accent" : "primary"}
        value={points ?? projected ?? "—"}
      />
      <Readout
        label="BANK"
        value={squad ? money(squad.squad.bank) : "—"}
      />
      <Readout
        label="FT"
        value={squad ? String(squad.squad.free_transfers) : "—"}
      />
      <Readout
        label="OR"
        // Grouped, because a seven-digit rank is unreadable otherwise.
        value={rank === null ? "—" : rank.toLocaleString("en-GB")}
      />
    </div>
  );
}
