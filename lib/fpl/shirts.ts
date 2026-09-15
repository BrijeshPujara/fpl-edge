/**
 * A club's shirt, as FPL's own pitch view draws it.
 *
 * Shirts replaced player headshots on the pitch. The Premier League's photo
 * library is out of date for anyone who has moved clubs — Tzolis appeared in a
 * Norwich kit while playing for Arsenal — and nothing in the FPL payload says
 * which photos are stale, so a wrong one cannot be caught, only avoided. A
 * shirt is keyed on the club the player is at NOW, and cannot be wrong that
 * way. Players new to the league also had no photo at all; every club has a
 * shirt.
 *
 * Keyed on the club's `code`, not its `id`, which FPL renumbers. Goalkeepers
 * wear the `_1` kit, as on FPL. The 110px size so a 52px render stays sharp on
 * a high-density screen.
 */
export const SHIRT_HOST = "fantasy.premierleague.com";

export function shirtUrl(teamCode: number, goalkeeper: boolean): string {
  return `https://${SHIRT_HOST}/dist/img/shirts/standard/shirt_${teamCode}${goalkeeper ? "_1" : ""}-110.png`;
}
