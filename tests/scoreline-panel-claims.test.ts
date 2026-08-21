import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { basisLabel } from "@/components/dashboard/scoreline-panel";

/**
 * The panel must not assert facts it has not been given.
 *
 * Three captions on this panel went stale in a single feature — a header
 * naming a column that no longer existed, a footnote claiming "last season
 * only" after the prior became three seasons, and a description of the mode
 * after the statistic became the mean. Each was a sentence that ASSUMED
 * something rather than reading it, so nothing could detect the divergence.
 *
 * The structural fix is that every claim now derives from a value. These tests
 * guard that: the derivations behave, and the source is checked for the
 * hardcoded phrasings that went wrong before.
 */

describe("the ratings caption follows the ratings", () => {
  it("names the number of seasons rather than assuming one", () => {
    expect(basisLabel("prior-season", 1)).toBe("last season");
    expect(basisLabel("prior-season", 3)).toContain("three");
    expect(basisLabel("prior-season", 4)).toContain("four");
  });

  it("changes when the season count changes", () => {
    // The exact failure that shipped: the prior went from one season to three
    // and the caption did not move, because it was keyed only on `basis`.
    expect(basisLabel("prior-season", 1)).not.toBe(
      basisLabel("prior-season", 3),
    );
  });

  it("says this season once it is fitted on this season", () => {
    expect(basisLabel("this-season", 3)).toBe("this season");
  });

  it("says both while it is blending", () => {
    const label = basisLabel("blended", 3);
    expect(label).toContain("three");
    expect(label).toContain("this one");
  });

  it("degrades to something honest for a basis it does not know", () => {
    expect(basisLabel("from-the-future", 3)).toBe("from-the-future");
    expect(basisLabel(null, 3).length).toBeGreaterThan(0);
  });
});

describe("no claim is hardcoded back into the panel", () => {
  const source = readFileSync(
    "components/dashboard/scoreline-panel.tsx",
    "utf8",
  );
  // Strip comments: they discuss these phrases deliberately.
  const rendered = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it.each([
    ["last season only", "the season count is stored — read it"],
    ["three seasons", "derive the number from priorSeasons"],
    ["most often takes", "that described the mode; read captionFor instead"],
    ["most likely scoreline", "read captionFor instead"],
    ["clubs they replaced", "the promoted prior is measured, not inherited"],
  ])("does not state %s (%s)", (phrase) => {
    expect(rendered.toLowerCase()).not.toContain(phrase);
  });
});
