import { describe, expect, it } from "vitest";
import {
  DEFAULT_MARKER_PATTERN,
  DEFAULT_PLACEHOLDER_PATTERN,
  GroundingConfigError,
  classifyDocument,
  classifySentence,
  extractAllCitedIds,
  extractCitedIds,
  splitSentences,
  stripCitationMarkers,
} from "../src/index.js";
import { withWatchdog } from "./helpers/watchdog.js";

const evidence = { e1: "the claimant lost money occasionally" };

describe("GK-F02: a zero-length marker match is a configuration error, never a loop", () => {
  const zeroWidth = /()/g;
  const lookahead = /(?=(a))/g;

  const entryPoints: Array<[string, (re: RegExp, text: string) => unknown]> = [
    ["splitSentences", (re, text) => splitSentences(text, { markerPattern: re })],
    ["classifyDocument", (re, text) => classifyDocument(text, {}, { markerPattern: re })],
    ["classifySentence", (re, text) => classifySentence(text, {}, { markerPattern: re })],
    ["extractCitedIds", (re, text) => extractCitedIds(text, re)],
    ["extractAllCitedIds", (re, text) => extractAllCitedIds(text, re)],
    ["stripCitationMarkers", (re, text) => stripCitationMarkers(text, re)],
  ];

  for (const [name, call] of entryPoints) {
    it(`${name} throws GroundingConfigError for /()/g on 'abc'`, () => {
      const run = () => withWatchdog(() => call(zeroWidth, "abc"), 1000);
      expect(run).toThrow(GroundingConfigError);
      expect(run).toThrow(/markerPattern matched zero characters at index 0/);
    });

    it(`${name} throws GroundingConfigError for a lookahead that matches nothing on 'xxa'`, () => {
      expect(() => withWatchdog(() => call(lookahead, "xxa"), 1000)).toThrow(
        /markerPattern matched zero characters at index 2/,
      );
    });
  }

  it("throws even for empty text, where /()/g matches at index 0", () => {
    expect(() => withWatchdog(() => splitSentences("", { markerPattern: zeroWidth }))).toThrow(
      GroundingConfigError,
    );
  });

  it("only throws when a zero-length match is actually found (it is data dependent)", () => {
    expect(withWatchdog(() => splitSentences("xyz", { markerPattern: lookahead }))).toEqual(["xyz"]);
    expect(extractCitedIds("xyz", lookahead)).toEqual([]);
  });

  it("catches a zero-length match that only appears at the start of a later clause (peel path)", () => {
    // `^` sees the whole sentence "Foo; Zed baz." first, where nothing matches;
    // the peel step then sees the clause "Zed baz." on its own.
    const markerPattern = /^(?=Zed)()/g;
    const run = () => withWatchdog(() => splitSentences("Foo; Zed baz.", { markerPattern }), 1000);
    expect(run).toThrow(GroundingConfigError);
    expect(run).toThrow(/at index 0/);
  });

  it("is a TypeError with the name GroundingConfigError", () => {
    let caught: unknown;
    try {
      extractCitedIds("abc", zeroWidth);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TypeError);
    expect(caught).toBeInstanceOf(GroundingConfigError);
    expect((caught as Error).name).toBe("GroundingConfigError");
  });

  it("leaves working custom delimiters alone", () => {
    expect(extractCitedIds("a [1] b {{ref:x}}", /\[(\d+)\]|\{\{ref:(\w+)\}\}/g)).toEqual(["1"]);
    expect(extractCitedIds("a <c id=7/> b", /<c id=(\d+)\/>/g)).toEqual(["7"]);
    expect(
      splitSentences("Claim <c id=7/>. Next claim.", { markerPattern: /<c id=(\d+)\/>/ }),
    ).toEqual(["Claim <c id=7/>.", "Next claim."]);
  });

  it("does not touch the caller's regex when it throws", () => {
    const re = /()/g;
    re.lastIndex = 2;
    expect(() => extractCitedIds("abc", re)).toThrow(GroundingConfigError);
    expect(re.lastIndex).toBe(2);
  });
});

describe("GK-F03: the marker scan ignores the sticky flag and never touches the caller's regex", () => {
  const text = "Claim [[cite:missing]] [citation needed].";
  const source = /\[\[cite:([\w-]+)\]\]/;
  const variants: Array<[string, RegExp]> = [
    ["no flags", new RegExp(source.source)],
    ["g", new RegExp(source.source, "g")],
    ["y", new RegExp(source.source, "y")],
    ["gy", new RegExp(source.source, "gy")],
    ["giy", new RegExp(source.source, "giy")],
  ];

  for (const [name, markerPattern] of variants) {
    it(`a missing citation outranks the placeholder (${name})`, () => {
      const doc = classifyDocument(text, {}, { markerPattern });
      expect(doc.counts).toEqual({ grounded: 0, placeholder: 0, ungrounded: 0, invalid: 1 });
      expect(doc.isClean).toBe(false);
      expect(doc.sentences[0].citedIds).toEqual(["missing"]);
    });

    it(`finds a marker in the middle of the text (${name})`, () => {
      expect(extractCitedIds("start [[cite:a]] then [[cite:b]]", markerPattern)).toEqual(["a", "b"]);
      expect(stripCitationMarkers("start [[cite:a]] then [[cite:b]].", markerPattern)).toBe(
        "start then.",
      );
      expect(splitSentences("One claim. [[cite:a]] Two claim.", { markerPattern })).toEqual([
        "One claim. [[cite:a]]",
        "Two claim.",
      ]);
    });
  }

  it("never changes the caller's lastIndex, flags or source, on any entry point", () => {
    const re = /\[\[cite:([\w-]+)\]\]/gy;
    re.lastIndex = 7;
    const placeholder = /\[citation needed\]/gy;
    placeholder.lastIndex = 5;
    classifyDocument(text, evidence, { markerPattern: re, placeholderPattern: placeholder });
    classifySentence(text, evidence, { markerPattern: re, placeholderPattern: placeholder });
    splitSentences(text, { markerPattern: re, placeholderPattern: placeholder });
    extractCitedIds(text, re);
    extractAllCitedIds(text, re);
    stripCitationMarkers(text, re);
    expect(re.lastIndex).toBe(7);
    expect(re.flags).toBe("gy");
    expect(re.source).toBe("\\[\\[cite:([\\w-]+)\\]\\]");
    expect(placeholder.lastIndex).toBe(5);
    expect(placeholder.flags).toBe("gy");
  });

  it("leaves the exported default patterns untouched", () => {
    DEFAULT_MARKER_PATTERN.lastIndex = 3;
    DEFAULT_PLACEHOLDER_PATTERN.lastIndex = 4;
    classifyDocument("A claim [[cite:e1]]. B [citation needed].", evidence);
    expect(DEFAULT_MARKER_PATTERN.lastIndex).toBe(3);
    expect(DEFAULT_PLACEHOLDER_PATTERN.lastIndex).toBe(4);
    DEFAULT_MARKER_PATTERN.lastIndex = 0;
    DEFAULT_PLACEHOLDER_PATTERN.lastIndex = 0;
  });

  it("shields a non-bracket placeholder even when it is sticky", () => {
    const placeholderPattern = /\{\{gap[^}]*\}\}/y;
    expect(splitSentences("Claim. Filler {{gap; see notes}} more.", { placeholderPattern })).toEqual([
      "Claim.",
      "Filler {{gap; see notes}} more.",
    ]);
  });

  it("keeps a global placeholder from carrying lastIndex from one sentence to the next", () => {
    const doc = classifyDocument("First [tbd]. Second [tbd]. Third [tbd].", {}, {
      placeholderPattern: /\[tbd\]/g,
    });
    expect(doc.counts.placeholder).toBe(3);
  });

  it("keeps the placeholder's other flags, so a case-insensitive pattern still matches", () => {
    expect(
      classifySentence("Missing [CITATION NEEDED].", {}, { placeholderPattern: /\[citation needed\]/i })
        .status,
    ).toBe("placeholder");
    expect(
      classifySentence("Missing [CITATION NEEDED].", {}, { placeholderPattern: /\[citation needed\]/ })
        .status,
    ).toBe("ungrounded");
  });

  it("uses a custom marker pattern in classifySentence itself", () => {
    expect(
      classifySentence("Claim about lasting [1].", { "1": "claim about lasting" }, {
        markerPattern: /\[(\d+)\]/g,
      }),
    ).toEqual({
      sentence: "Claim about lasting [1].",
      status: "grounded",
      citedIds: ["1"],
      validIds: ["1"],
    });
  });
});

describe("GK-F04: supports() must return a real boolean", () => {
  const sentence = "The claimant lost money occasionally [[cite:e1]].";
  const notBooleans: Array<[string, () => unknown]> = [
    ["a resolved Promise<false>", () => Promise.resolve(false)],
    ["an async function's Promise", () => (async () => false)()],
    ["the string 'false'", () => "false"],
    ["the string 'true'", () => "true"],
    ["an object", () => ({})],
    ["0", () => 0],
    ["1", () => 1],
    ["undefined", () => undefined],
    ["null", () => null],
    ["a Boolean object", () => new Boolean(false)],
  ];

  for (const [name, supports] of notBooleans) {
    it(`throws GroundingConfigError for ${name}`, () => {
      const config = { supports: supports as unknown as () => boolean };
      expect(() => classifySentence(sentence, evidence, config)).toThrow(GroundingConfigError);
      expect(() => classifyDocument(sentence, evidence, config)).toThrow(TypeError);
      expect(() => classifySentence(sentence, evidence, config)).toThrow(/supports\(\) must return a boolean/);
    });
  }

  it("does not await a Promise: it names it and stays synchronous", () => {
    const config = { supports: (() => Promise.resolve(true)) as unknown as () => boolean };
    expect(() => classifySentence(sentence, evidence, config)).toThrow(/got a Promise/);
  });

  it("does not leave a rejected Promise unhandled", async () => {
    const config = { supports: (() => Promise.reject(new Error("nope"))) as unknown as () => boolean };
    expect(() => classifySentence(sentence, evidence, config)).toThrow(GroundingConfigError);
    // vitest fails the run on an unhandled rejection; give one a chance to surface.
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it("keeps a real true and a real false meaning what they meant", () => {
    expect(classifySentence(sentence, evidence, { supports: () => true }).status).toBe("grounded");
    expect(classifySentence(sentence, evidence, { supports: () => false }).status).toBe("invalid");
  });

  it("passes the marker-free claim and the evidence text to the callback", () => {
    const calls: Array<[string, string]> = [];
    classifySentence(sentence, evidence, {
      supports: (claim, text) => {
        calls.push([claim, text]);
        return true;
      },
    });
    expect(calls).toEqual([["The claimant lost money occasionally.", evidence.e1]]);
  });

  it("does not call supports for an uncited or unknown citation", () => {
    let calls = 0;
    const supports = () => {
      calls++;
      return true;
    };
    classifySentence("Nothing cited.", evidence, { supports });
    classifySentence("Unknown id [[cite:zzz]].", evidence, { supports });
    expect(calls).toBe(0);
  });

  it("lets an exception from the callback propagate unchanged, never as a clean result", () => {
    const boom = new Error("callback failed");
    expect(() =>
      classifySentence(sentence, evidence, {
        supports: () => {
          throw boom;
        },
      }),
    ).toThrow(boom);
  });

  it("rejects a non-function supports up front, even for a sentence that cites nothing", () => {
    for (const supports of ["yes", 1, {}, true]) {
      expect(() =>
        classifySentence("Nothing cited.", evidence, { supports: supports as unknown as () => boolean }),
      ).toThrow(/config\.supports must be a function/);
    }
  });
});

describe("option validation", () => {
  it("rejects a config that is not a plain object", () => {
    for (const config of [null, 5, "cfg", [], new Map(), new Set(), new Date(), /re/]) {
      expect(() => splitSentences("a.", config as never)).toThrow(TypeError);
      expect(() => classifySentence("a.", {}, config as never)).toThrow(TypeError);
      expect(() => classifyDocument("a.", {}, config as never)).toThrow(TypeError);
    }
    expect(() => splitSentences("a.", null as never)).toThrow(
      new TypeError("config must be an object (got null)."),
    );
    expect(() => splitSentences("a.", new Map() as never)).toThrow(
      new TypeError("config must be an object (got a non-plain object)."),
    );
  });

  it("accepts a null-prototype config and an explicit undefined", () => {
    const config = Object.assign(Object.create(null) as object, { markerPattern: /\[(\d)\]/g });
    expect(splitSentences("A claim [1]. B claim.", config as never)).toEqual(["A claim [1].", "B claim."]);
    expect(classifySentence("A claim [1].", { "1": "a claim" }, config as never).status).toBe("grounded");
    expect(splitSentences("One. Two.", undefined)).toEqual(["One.", "Two."]);
    expect(splitSentences("One. Two.", { markerPattern: undefined })).toEqual(["One.", "Two."]);
  });

  it("rejects a pattern that is not a RegExp", () => {
    for (const bad of ["\\[(\\d)\\]", { source: "x", flags: "g" }, 5, null]) {
      if (bad !== null) {
        expect(() => splitSentences("a.", { markerPattern: bad as never })).toThrow(
          /markerPattern must be a RegExp/,
        );
        expect(() => splitSentences("a.", { placeholderPattern: bad as never })).toThrow(
          /placeholderPattern must be a RegExp/,
        );
      }
      expect(() => extractCitedIds("a", bad as never)).toThrow(TypeError);
    }
    expect(() => splitSentences("a.", { markerPattern: new Proxy(/x/, {}) })).toThrow(
      /must be a RegExp/,
    );
  });

  it("accepts a RegExp from another realm", async () => {
    const vm = await import("node:vm");
    const foreign = vm.runInContext("/\\[(\\d)\\]/g", vm.createContext({})) as RegExp;
    expect(foreign instanceof RegExp).toBe(false);
    expect(extractCitedIds("a [4] b [5]", foreign)).toEqual(["4", "5"]);
  });

  it("requires the string inputs of the extract and strip helpers to be strings", () => {
    expect(() => extractCitedIds(5 as never)).toThrow(new TypeError("sentence must be a string (got number)."));
    expect(() => extractAllCitedIds(null as never)).toThrow(new TypeError("text must be a string (got null)."));
    expect(() => stripCitationMarkers(undefined as never)).toThrow(
      new TypeError("text must be a string (got undefined)."),
    );
  });

  it("requires abbreviation lists to be dense arrays of strings", () => {
    const ok = ["dr"];
    // eslint-disable-next-line no-sparse-arrays
    const sparse = ["dr", , "mr"] as string[];
    for (const abbreviations of [
      { alwaysFuse: sparse, contextFuse: ok },
      { alwaysFuse: ok, contextFuse: sparse },
      { alwaysFuse: ["dr", 5], contextFuse: ok },
      { alwaysFuse: ok, contextFuse: "etc" },
      { alwaysFuse: ok },
      { contextFuse: ok },
      { alwaysFuse: new Set(["dr"]), contextFuse: ok },
    ]) {
      expect(() => splitSentences("Dr. A. Next.", { abbreviations: abbreviations as never })).toThrow(
        TypeError,
      );
    }
    expect(() => splitSentences("a.", { abbreviations: { alwaysFuse: sparse, contextFuse: ok } })).toThrow(
      /abbreviations\.alwaysFuse\[1\] must be a string \(got undefined\)/,
    );
    expect(() => splitSentences("a.", { abbreviations: [] as never })).toThrow(
      /abbreviations must be an object \(got an array\)/,
    );
    expect(() => splitSentences("a.", { abbreviations: { alwaysFuse: "x", contextFuse: [] } as never })).toThrow(
      /abbreviations\.alwaysFuse must be an array of strings \(got string\)/,
    );
  });

  it("lower-cases abbreviations, so 'Dr' and 'dr' both fuse", () => {
    expect(
      splitSentences("Prof. Ito spoke. Then left.", {
        abbreviations: { alwaysFuse: ["PROF"], contextFuse: [] },
      }),
    ).toEqual(["Prof. Ito spoke.", "Then left."]);
  });
});

describe("supports() runs once per distinct cited id within a sentence", () => {
  const map: Record<string, string> = { a: "alpha text", b: "beta text", c: "gamma text" };

  it("a repeated id in one sentence costs one callback call, not one per citation", () => {
    const calls: string[] = [];
    const supports = (_claim: string, text: string): boolean => {
      calls.push(text);
      return true;
    };
    const result = classifySentence("Claim [[cite:a]] more [[cite:b]] more [[cite:a]] and [[cite:a]] [[cite:b]].", map, { supports });
    expect(calls).toEqual(["alpha text", "beta text"]);
    // citedIds and validIds still list every citation, repeats included.
    expect(result.citedIds).toEqual(["a", "b", "a", "a", "b"]);
    expect(result.validIds).toEqual(["a", "b", "a", "a", "b"]);
    expect(result.status).toBe("grounded");
  });

  it("the same id in two different sentences is judged once per sentence, because the claim text differs", () => {
    const claims: string[] = [];
    const supports = (claim: string): boolean => {
      claims.push(claim);
      return true;
    };
    classifyDocument("First claim [[cite:a]] [[cite:a]]. Second claim [[cite:a]] [[cite:a]].", map, { supports });
    expect(claims).toEqual(["First claim.", "Second claim."]);
  });

  it("a rejected id stays rejected for every repeat, and later ids are still judged", () => {
    const calls: string[] = [];
    const supports = (_claim: string, text: string): boolean => {
      calls.push(text);
      return text !== "alpha text";
    };
    const result = classifySentence("X [[cite:a]] [[cite:b]] [[cite:a]].", map, { supports });
    expect(calls).toEqual(["alpha text", "beta text"]);
    expect(result.status).toBe("invalid");
    expect(result.validIds).toEqual(["b"]);
  });

  it("matches a per-citation evaluation for a pure callback, over seeded random sentences", () => {
    let seed = 20260930;
    const rand = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const ids = ["a", "b", "c", "zzz"]; // zzz is not in the map
    const pure = (claim: string, text: string): boolean => (claim.length + text.length) % 3 !== 0;
    for (let trial = 0; trial < 200; trial++) {
      const cites = Array.from({ length: 1 + Math.floor(rand() * 6) }, () => ids[Math.floor(rand() * ids.length)]);
      const sentence = `Claim${"x".repeat(Math.floor(rand() * 5))} ${cites.map((id) => `[[cite:${id}]]`).join(" and ")}.`;
      const result = classifySentence(sentence, map, { supports: pure });
      const claim = stripCitationMarkers(sentence);
      const expectedValid = cites.filter((id) => Object.hasOwn(map, id) && pure(claim, map[id]));
      expect(result.citedIds).toEqual(cites);
      expect(result.validIds).toEqual(expectedValid);
      expect(result.status).toBe(expectedValid.length === cites.length ? "grounded" : "invalid");
    }
  });
});
