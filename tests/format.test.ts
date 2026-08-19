import { describe, expect, it } from "vitest";
import {
  countdown,
  ep,
  epDelta,
  hit,
  money,
  moneyDelta,
  rank,
} from "@/lib/format";

describe("money", () => {
  it("renders tenths of a million as pounds", () => {
    expect(money(65)).toBe("£6.5");
    expect(money(151)).toBe("£15.1");
    expect(money(1000)).toBe("£100.0");
  });

  it("always shows one decimal place", () => {
    expect(money(50)).toBe("£5.0");
  });

  it("signs deltas with a real minus sign, not a hyphen", () => {
    expect(moneyDelta(-6)).toBe("−£0.6");
    expect(moneyDelta(26)).toBe("+£2.6");
    // U+2212, not U+002D. Hyphens are visibly short next to tabular figures.
    expect(moneyDelta(-6).charAt(0)).toBe("−");
  });
});

describe("expected points", () => {
  it("renders to one decimal place", () => {
    expect(ep(6.42)).toBe("6.4");
    expect(ep(9)).toBe("9.0");
  });

  it("signs deltas", () => {
    expect(epDelta(6.44)).toBe("+6.4");
    expect(epDelta(-1.2)).toBe("−1.2");
    expect(epDelta(0)).toBe("+0.0");
  });
});

describe("hit", () => {
  it("renders zero as a plain zero and a cost as negative", () => {
    expect(hit(0)).toBe("0");
    expect(hit(4)).toBe("−4");
    expect(hit(8)).toBe("−8");
  });
});

describe("rank", () => {
  it("groups thousands", () => {
    expect(rank(41208)).toBe("41,208");
  });

  it("renders an em dash when unranked", () => {
    expect(rank(null)).toBe("—");
  });
});

describe("countdown", () => {
  it("pads hours, minutes and seconds", () => {
    expect(
      countdown({
        days: 1,
        hours: 7,
        minutes: 2,
        seconds: 8,
        expired: false,
      }),
    ).toBe("1d 07:02:08");
  });

  it("says so once the deadline has passed", () => {
    expect(
      countdown({ days: 0, hours: 0, minutes: 0, seconds: 0, expired: true }),
    ).toBe("DEADLINE PASSED");
  });
});
