import { describe, expect, it } from "vitest";
import { parseEntryId } from "@/lib/fpl/entry";

describe("parseEntryId", () => {
  it("accepts a plain entry id", () => {
    expect(parseEntryId("4278347")).toBe(4278347);
    expect(parseEntryId(4278347)).toBe(4278347);
    expect(parseEntryId(" 4278347 ")).toBe(4278347);
  });

  it("rejects what Number() would have silently accepted", () => {
    // Every one of these becomes a number under coercion, and every one would
    // reach the FPL API as a request for a team that does not exist.
    // Number("") is 0; Number("1e5") is 100000; Number("0x10") is 16.
    for (const value of ["", "   ", "12abc", "1e5", "0x10", "1.5", "-4", "1 2"]) {
      expect(parseEntryId(value)).toBeNull();
    }
  });

  it("rejects NaN and Infinity rather than passing them on", () => {
    expect(parseEntryId(Number.NaN)).toBeNull();
    expect(parseEntryId(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("rejects absent values", () => {
    expect(parseEntryId(null)).toBeNull();
    expect(parseEntryId(undefined)).toBeNull();
  });

  it("rejects zero, which is not a valid entry id", () => {
    // The preview harness relies on this: it labels its invented squad with
    // entry 0 precisely so no real lookup can ever match it.
    expect(parseEntryId(0)).toBeNull();
    expect(parseEntryId("0")).toBeNull();
  });

  it("rejects an id far beyond any plausible season", () => {
    expect(parseEntryId("999999999999")).toBeNull();
  });
});
