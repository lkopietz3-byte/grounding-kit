import { describe, expect, it } from "vitest";
import {
  classifyDocument,
  classifySentence,
  defaultSupports,
  extractAllCitedIds,
  extractCitedIds,
  splitSentences,
  stripCitationMarkers,
} from "../src/index.js";

describe("labels in validation messages name the right option", () => {
  it("names config for a bad config on every entry point", () => {
    const message = "config must be an object (got null).";
    expect(() => splitSentences("x.", null as never)).toThrow(new TypeError(message));
    expect(() => classifySentence("x.", {}, null as never)).toThrow(new TypeError(message));
    expect(() => classifyDocument("x.", {}, null as never)).toThrow(new TypeError(message));
  });

  it("names markerPattern for a bad pattern in each helper", () => {
    expect(() => extractCitedIds("a", "x" as never)).toThrow(/^markerPattern must be a RegExp \(got string\)\.$/);
    expect(() => extractAllCitedIds("a", "x" as never)).toThrow(/^markerPattern must be a RegExp/);
    expect(() => stripCitationMarkers("a", "x" as never)).toThrow(/^markerPattern must be a RegExp/);
  });

  it("names contextFuse and alwaysFuse separately", () => {
    expect(() =>
      splitSentences("x.", { abbreviations: { alwaysFuse: [], contextFuse: "etc" as never } }),
    ).toThrow(/^abbreviations\.contextFuse must be an array of strings/);
    expect(() =>
      splitSentences("x.", { abbreviations: { alwaysFuse: "dr" as never, contextFuse: [] } }),
    ).toThrow(/^abbreviations\.alwaysFuse must be an array of strings/);
  });
});

describe("evidence values", () => {
  it("treats a non-string evidence value as a missing one and never calls supports", () => {
    let calls = 0;
    const supports = () => {
      calls++;
      return true;
    };
    for (const value of [42, null, undefined, {}, ["text"], true]) {
      const result = classifySentence("Claim [[cite:e1]].", { e1: value as never }, { supports });
      expect(result).toEqual({ sentence: "Claim [[cite:e1]].", status: "invalid", citedIds: ["e1"], validIds: [] });
    }
    expect(calls).toBe(0);
  });
});

describe("marker helpers", () => {
  it("strips trailing whitespace left where a final marker was", () => {
    expect(stripCitationMarkers("Claim [[cite:e1]]  ")).toBe("Claim");
    expect(stripCitationMarkers("Claim [[cite:e1]]\t")).toBe("Claim");
  });

  it("returns text with no markers unchanged apart from tidying", () => {
    expect(stripCitationMarkers("No markers here.")).toBe("No markers here.");
    expect(stripCitationMarkers("")).toBe("");
  });

  it("puts a space between a marker that ends in a terminator and the marker after it", () => {
    const markerPattern = /#(\d+)\./g;
    expect(splitSentences("A #1.#2. B", { markerPattern })).toEqual(["A #1. #2.", "B"]);
  });
});

describe("trailing-word scan boundaries", () => {
  const fuse = (word: string) => ({ abbreviations: { alwaysFuse: [word], contextFuse: [] } });

  it("recognizes an abbreviation that ends in the letter z, and in Z", () => {
    expect(splitSentences("See xyz. Then more.", fuse("xyz"))).toEqual(["See xyz. Then more."]);
    expect(splitSentences("See XYZ. Then more.", fuse("xyz"))).toEqual(["See XYZ. Then more."]);
    expect(splitSentences("See zz. Then more.", fuse("zz"))).toEqual(["See zz. Then more."]);
    expect(splitSentences("See ZZ. Then more.", fuse("zz"))).toEqual(["See ZZ. Then more."]);
    expect(splitSentences("See aa. Then more.", fuse("aa"))).toEqual(["See aa. Then more."]);
    expect(splitSentences("See AA. Then more.", fuse("aa"))).toEqual(["See AA. Then more."]);
  });

  it("finds the word through dots: 'e.g.' is the word 'eg'", () => {
    expect(splitSentences("Use e.g. Then more.", fuse("eg"))).toEqual(["Use e.g. Then more."]);
    expect(splitSentences("Use e.g. Then more.", fuse("e"))).toEqual(["Use e.g.", "Then more."]);
  });

  it("does not treat a number before the period as an abbreviation, even with an empty entry configured", () => {
    // A fragment that is only "5." has no word. An empty configured entry
    // must not turn it into an abbreviation that swallows the next sentence.
    expect(splitSentences("Wait. 5. Then go.", fuse(""))).toEqual(["Wait.", "5.", "Then go."]);
    expect(splitSentences("Wait. .. Then go.", fuse(""))).toEqual(["Wait.", "..", "Then go."]);
  });
});

describe("defaultSupports normalization", () => {
  it("trims the normalized text before comparing", () => {
    // "up to 9!" becomes "up to 9 " with a trailing space until trimmed.
    expect(defaultSupports("up to 9!", "up to 9items")).toBe(true);
    expect(defaultSupports("!up to 9", "xup to 9")).toBe(true);
  });
});
