import {
  NEWS_CATEGORY_MULTIPLIER,
  NEWS_MULTIPLIER_BOUNDS,
} from "./constants";

/**
 * What team news says that the percentage does not.
 *
 * Pure, deterministic, free. This exists because of a measurement: FPL's
 * `news` field and `chance_of_playing_next_round` are nearly the same fact
 * written twice — "Hamstring injury - 75% chance of playing" sits beside a
 * chance of 75 — so most of the string is already in the model.
 *
 * What is NOT already in the model is the category. "Lack of match fitness" and
 * "Knock" both appear at 75%, and they mean different things: the first is a
 * player who will come off the bench, the second is a player who will start.
 * The percentage cannot distinguish them; the words can.
 *
 * That is a small, systematic mapping, which is exactly the shape of thing that
 * wants a calibrated lookup rather than a language model called once per player
 * per day. The `NewsSignal` interface below is the seam: anything that can read
 * text and justify a bounded multiplier can implement it, including an LLM
 * reading a source richer than this one.
 */

export type NewsCategory = keyof typeof NEWS_CATEGORY_MULTIPLIER;

export interface NewsSignal {
  /** Bounded multiplier on the minutes projection. */
  multiplier: number;
  category: NewsCategory;
  /**
   * The words the multiplier came from. An adjustment that cannot point at its
   * evidence is a guess with a decimal point, and this is what makes the
   * difference visible on screen and auditable afterwards.
   */
  citedText: string;
}

/** No news, or nothing in it worth acting on. */
export const NO_NEWS_SIGNAL: NewsSignal = {
  multiplier: 1,
  category: "other",
  citedText: "",
};

/**
 * Ordered most specific first. "Lack of match fitness" must be tested before
 * "fitness", and a hamstring must not fall through to the generic injury rule.
 */
const PATTERNS: { category: NewsCategory; match: RegExp }[] = [
  { category: "matchFitness", match: /lack of match fitness|match fitness|match sharpness/i },
  { category: "muscular", match: /hamstring|calf|groin|thigh|quad|adductor|muscle|muscular/i },
  { category: "illness", match: /\bill\b|illness|virus|sick/i },
  { category: "knock", match: /\bknock\b/i },
  {
    category: "injury",
    match: /ankle|knee|shoulder|hip|back|foot|toe|wrist|hand|arm|rib|head|concussion|achilles|\binjur/i,
  },
];

export function clampNewsMultiplier(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(
    NEWS_MULTIPLIER_BOUNDS.min,
    Math.min(NEWS_MULTIPLIER_BOUNDS.max, value),
  );
}

/**
 * Read an FPL news string into a bounded multiplier.
 *
 * Returns no adjustment for text it does not recognise. Silence is the correct
 * answer to an unfamiliar phrase — inventing a discount for "Suspended for one
 * match" or a transfer note would be worse than ignoring it.
 */
export function readNewsSignal(news: string): NewsSignal {
  const text = news.trim();
  if (text.length === 0) return NO_NEWS_SIGNAL;

  for (const { category, match } of PATTERNS) {
    const found = text.match(match);
    if (found) {
      return {
        multiplier: clampNewsMultiplier(NEWS_CATEGORY_MULTIPLIER[category]),
        category,
        citedText: found[0],
      };
    }
  }

  return NO_NEWS_SIGNAL;
}

/**
 * Accept an externally-supplied signal — from a language model, or anything
 * else — only if it can be trusted.
 *
 * Two checks, both of which exist to stop a confident sentence moving real
 * money:
 *
 *   1. The multiplier is clamped into range. An analyser that returns 5.0
 *      because it misread a sentence must not be able to sell your captain.
 *   2. The cited text must actually appear in the source. A citation the source
 *      does not contain is a fabrication, and the whole adjustment is dropped
 *      rather than partially believed.
 *
 * Returns null when the signal fails, which callers read as "no adjustment"
 * rather than as an error — an analyser being unavailable or wrong should leave
 * the numeric model exactly as it was.
 */
export function verifyNewsSignal(
  signal: { multiplier: number; category: NewsCategory; citedText: string },
  source: string,
): NewsSignal | null {
  const cited = signal.citedText.trim();
  if (cited.length === 0) return null;

  const normalise = (value: string) =>
    value.toLowerCase().replace(/\s+/g, " ").trim();

  if (!normalise(source).includes(normalise(cited))) return null;

  return {
    multiplier: clampNewsMultiplier(signal.multiplier),
    category: signal.category,
    citedText: cited,
  };
}
