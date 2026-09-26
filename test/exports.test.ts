import { describe, expect, it } from "vitest";
import {
  DEFAULT_ABBREVIATIONS,
  DEFAULT_MARKER_PATTERN,
  DEFAULT_PLACEHOLDER_PATTERN,
  defaultSupports,
  extractAllCitedIds,
  extractCitedIds,
  splitSentences,
  stripCitationMarkers,
} from "../src/index.js";

describe("DEFAULT_ABBREVIATIONS", () => {
  it("documents its exact contents", () => {
    expect(DEFAULT_ABBREVIATIONS.alwaysFuse).toEqual([
      "mr", "mrs", "ms", "dr", "prof", "hon", "st", "v", "vs",
    ]);
    expect(DEFAULT_ABBREVIATIONS.contextFuse).toEqual([
      "no", "inc", "co", "corp", "ltd", "llc", "dept", "vol", "ed",
      "al", "etc", "eg", "ie", "approx", "fig", "p", "pp", "jr", "sr",
    ]);
  });

  it("is frozen: a consumer cannot mutate the shared default and affect other callers", () => {
    expect(Object.isFrozen(DEFAULT_ABBREVIATIONS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_ABBREVIATIONS.alwaysFuse)).toBe(true);
    expect(Object.isFrozen(DEFAULT_ABBREVIATIONS.contextFuse)).toBe(true);
    // Cast away `readonly` deliberately: the type system already forbids
    // this at compile time, so proving the freeze actually enforces it at
    // runtime (not just the types) requires calling the mutator directly.
    const mutable = DEFAULT_ABBREVIATIONS.alwaysFuse as string[];
    expect(() => {
      mutable.push("zz");
    }).toThrow(TypeError);
  });
});

describe("DEFAULT_MARKER_PATTERN", () => {
  it("matches the documented [[cite:id]] convention and captures the id, tolerating inner spaces", () => {
    const fresh = new RegExp(DEFAULT_MARKER_PATTERN.source, DEFAULT_MARKER_PATTERN.flags);
    const m = fresh.exec("claim [[cite: e1-x_9 ]]");
    expect(m?.[1]).toBe("e1-x_9");
  });

  it("does not match a bare single-bracket marker (that's a different convention)", () => {
    const fresh = new RegExp(DEFAULT_MARKER_PATTERN.source, DEFAULT_MARKER_PATTERN.flags);
    expect(fresh.test("claim [1]")).toBe(false);
  });

  it("is never mutated (lastIndex included) by passing it into the library's own functions", () => {
    // The JSDoc promises a fresh copy is always taken internally, so a
    // caller who also holds onto DEFAULT_MARKER_PATTERN for their own
    // direct .test()/.exec()/matchAll use won't find its lastIndex left in
    // a surprising state after handing it to splitSentences() as config.
    // (This is distinct from — and doesn't change — the ordinary JS rule
    // that calling .test() twice in a row on any /g regex you hold
    // yourself advances lastIndex each time; that's just how a global
    // RegExp object always behaves, in any library.)
    expect(DEFAULT_MARKER_PATTERN.lastIndex).toBe(0);
    splitSentences("claim [[cite:e1]]. another [[cite:e2]] claim.", {
      markerPattern: DEFAULT_MARKER_PATTERN,
    });
    expect(DEFAULT_MARKER_PATTERN.lastIndex).toBe(0);
    // And the object still works correctly for the caller's own first use
    // afterward.
    expect(DEFAULT_MARKER_PATTERN.test("[[cite:e1]]")).toBe(true);
  });
});

describe("DEFAULT_PLACEHOLDER_PATTERN", () => {
  it("matches the documented placeholder conventions", () => {
    expect(DEFAULT_PLACEHOLDER_PATTERN.test("[citation needed]")).toBe(true);
    expect(DEFAULT_PLACEHOLDER_PATTERN.test("[more research needed: refund window]")).toBe(true);
    expect(DEFAULT_PLACEHOLDER_PATTERN.test("[TK exact date]")).toBe(true);
    expect(DEFAULT_PLACEHOLDER_PATTERN.test("just a claim with no gap marker")).toBe(false);
  });
});

describe("defaultSupports", () => {
  it("passes on normalized substring containment in either direction", () => {
    expect(defaultSupports("battery life", "the battery life reached 14 hours")).toBe(true);
    expect(
      defaultSupports("the battery life reached 14 hours in testing", "battery life"),
    ).toBe(true);
  });

  it("word-overlap ratio: fails just below the 0.6 threshold (2/5 = 0.4)", () => {
    const claim = "alpha bravo charlie delta echo";
    expect(defaultSupports(claim, "alpha bravo only mentioned here")).toBe(false);
  });

  it("word-overlap ratio: passes exactly at the 0.6 threshold (3/5)", () => {
    const claim = "alpha bravo charlie delta echo";
    expect(defaultSupports(claim, "alpha bravo charlie only mentioned")).toBe(true);
  });

  it("word-overlap ratio: passes above the threshold (4/5 = 0.8)", () => {
    const claim = "alpha bravo charlie delta echo";
    expect(defaultSupports(claim, "alpha bravo charlie delta only")).toBe(true);
  });

  it("returns false for an empty claim, empty evidence, or both", () => {
    expect(defaultSupports("", "some evidence text here")).toBe(false);
    expect(defaultSupports("some claim text here", "")).toBe(false);
    expect(defaultSupports("", "")).toBe(false);
  });

  it("is case-insensitive and ignores punctuation", () => {
    expect(defaultSupports("BATTERY, life!", "the battery life reached 14 hours")).toBe(true);
  });
});

describe("extractCitedIds", () => {
  it("returns marker ids in appearance order, keeping duplicates", () => {
    expect(extractCitedIds("claim [[cite:e1]] and [[cite:e2]] and again [[cite:e1]].")).toEqual([
      "e1", "e2", "e1",
    ]);
  });

  it("returns an empty array when there are no markers", () => {
    expect(extractCitedIds("no citations here.")).toEqual([]);
  });

  it("honors a custom markerPattern", () => {
    expect(extractCitedIds("claim [1] and [2].", /\[(\d+)\]/g)).toEqual(["1", "2"]);
  });
});

describe("extractAllCitedIds", () => {
  it("returns distinct ids in first-appearance order", () => {
    expect(
      extractAllCitedIds("[[cite:e2]] then [[cite:e1]] then [[cite:e2]] again."),
    ).toEqual(["e2", "e1"]);
  });

  it("returns an empty array when there are no markers", () => {
    expect(extractAllCitedIds("no citations here.")).toEqual([]);
  });
});

describe("stripCitationMarkers", () => {
  it("removes markers and collapses the space left behind before punctuation", () => {
    expect(stripCitationMarkers("Battery life reached 14 hours [[cite:e1]].")).toBe(
      "Battery life reached 14 hours.",
    );
  });

  it("collapses a double space left by removing a mid-sentence marker", () => {
    expect(stripCitationMarkers("It works [[cite:e1]] well.")).toBe("It works well.");
  });

  it("returns the text unchanged when there are no markers", () => {
    expect(stripCitationMarkers("No citations here.")).toBe("No citations here.");
  });

  it("honors a custom markerPattern", () => {
    expect(stripCitationMarkers("claim [1].", /\[(\d+)\]/g)).toBe("claim.");
  });
});
