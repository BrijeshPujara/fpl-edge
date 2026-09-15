import { describe, expect, it } from "vitest";
import { chipShort, managerWeek } from "@/lib/leagues/chips";
import { mapWithConcurrency } from "@/lib/concurrency";
import { shirtUrl } from "@/lib/fpl/shirts";

describe("managerWeek", () => {
  const history = {
    current: [
      { event: 3, event_transfers_cost: 4 },
      { event: 4, event_transfers_cost: 0 },
    ],
    chips: [{ name: "wildcard", event: 4 }],
  };

  it("reads the chip played that gameweek", () => {
    expect(managerWeek(history, 4).chip).toBe("wildcard");
  });

  it("reports no chip for a week without one", () => {
    expect(managerWeek(history, 3).chip).toBeNull();
  });

  it("reads the hit for that gameweek", () => {
    expect(managerWeek(history, 3).hits).toBe(4);
  });

  it("treats a gameweek not yet in the history as no hit", () => {
    expect(managerWeek(history, 5)).toEqual({ chip: null, hits: 0 });
  });
});

describe("chipShort", () => {
  it("labels the four chips", () => {
    expect(["wildcard", "freehit", "bboost", "3xc"].map(chipShort)).toEqual([
      "WC",
      "FH",
      "BB",
      "TC",
    ]);
  });

  it("labels a chip it has never heard of instead of hiding it", () => {
    expect(chipShort("manager")).toBe("MA");
  });
});

describe("mapWithConcurrency", () => {
  it("keeps the input order", async () => {
    const out = await mapWithConcurrency([30, 10, 20], 2, async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return ms;
    });
    expect(out).toEqual([30, 10, 20]);
  });

  it("never runs more than the limit at once", async () => {
    let running = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 2));
      running -= 1;
    });
    expect(peak).toBe(3);
  });

  it("handles an empty list", async () => {
    expect(await mapWithConcurrency([], 4, async (x) => x)).toEqual([]);
  });
});

describe("shirtUrl", () => {
  it("is keyed on the club code", () => {
    expect(shirtUrl(3, false)).toBe(
      "https://fantasy.premierleague.com/dist/img/shirts/standard/shirt_3-110.png",
    );
  });

  it("dresses goalkeepers in the keeper kit", () => {
    expect(shirtUrl(3, true)).toBe(
      "https://fantasy.premierleague.com/dist/img/shirts/standard/shirt_3_1-110.png",
    );
  });
});
