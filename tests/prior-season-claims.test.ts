import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The "ranked on last season" caveat must describe the model that exists.
 *
 * This is the scoreline-panel failure again, in two places that test did not
 * cover. Both the on-screen banner and the brief's prompt claimed that every
 * player carried the same flat starting probability — true when written, and
 * false from 996fa39 onward, which gave the minutes model last season's
 * workload. For two days the app told people a nailed starter and a squad
 * player were indistinguishable while the engine was in fact telling them
 * apart, and the brief was instructed to repeat it.
 *
 * A caveat that OVERSTATES uncertainty is as wrong as one that hides it, and
 * neither is detectable by a type or a unit test: both are prose asserting
 * something about code somewhere else. So the source is scanned, the same way
 * the scoreline captions are.
 */

/**
 * Comments are not claims.
 *
 * The first version of this test failed on the comment that EXPLAINS why the
 * phrasing was retired — which would have left the choice between a guard that
 * works and a file that records why it exists. Stripping comments keeps both:
 * the check reads only what ships to a reader, which is the thing that can be
 * wrong.
 */
function shippedText(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .toLowerCase();
}

const SOURCES = [
  "components/ui/pending.tsx",
  "lib/llm/brief.ts",
  "evals/brief/graders.ts",
];

/** Phrasings that assert minutes are unmodelled. They no longer are. */
const RETIRED = [
  "flat starting probability",
  "minutes are not",
  "minutes aren't",
  "same flat",
  "indistinguishable",
];

describe("the prior-season caveat", () => {
  for (const path of SOURCES) {
    it(`does not claim unmodelled minutes in ${path}`, () => {
      const shipped = shippedText(path);
      for (const phrase of RETIRED) {
        expect(shipped).not.toContain(phrase);
      }
    });
  }

  it("still says the ranking rests on last season", () => {
    // Removing the false half must not remove the warning entirely. The
    // caveat exists because last season's role is not this season's.
    const banner = readFileSync("components/ui/pending.tsx", "utf8");
    expect(banner).toContain("last season");
    expect(banner).toContain("summer transfer");
  });

  it("keeps the brief's instruction aligned with the banner", () => {
    // Two descriptions of the same limitation, and they drifted apart once.
    const brief = readFileSync("lib/llm/brief.ts", "utf8");
    expect(brief).toContain("rests entirely on last season");
    expect(brief).toContain("summer transfer");
  });
});
