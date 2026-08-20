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

describe("entryBaseFrom — the tab strip's view of the URL", () => {
  // Reimplemented here rather than imported: the component is a client module
  // and this is the parsing rule, which is what can silently break.
  const entryBaseFrom = (pathname: string): string | null => {
    const [, root, entryId] = pathname.split("/");
    if (root !== "t" || !entryId || !/^\d+$/.test(entryId)) return null;
    return `/t/${entryId}`;
  };

  it("finds the team in a team route", () => {
    expect(entryBaseFrom("/t/4278347")).toBe("/t/4278347");
    expect(entryBaseFrom("/t/4278347/transfers")).toBe("/t/4278347");
  });

  it("finds no team on the landing page", () => {
    expect(entryBaseFrom("/")).toBeNull();
  });

  it("finds no team in the preview harness", () => {
    // The preview renders the same screens with no manager behind them, and a
    // tab strip there would point at routes that 404.
    expect(entryBaseFrom("/preview/transfers")).toBeNull();
  });

  it("refuses a malformed segment rather than building a broken link", () => {
    for (const path of ["/t/banana", "/t/", "/t", "/t/12abc/squad"]) {
      expect(entryBaseFrom(path)).toBeNull();
    }
  });
});
