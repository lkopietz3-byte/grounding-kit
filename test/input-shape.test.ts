import { describe, expect, it } from "vitest";
import { classifyDocument, classifySentence, splitSentences } from "../src/index.js";

// Bug classes 1, 3 and 6: caller input is read once and never as a getter
// that can answer differently the second time; error messages are built from
// the kind of a value, never from calling into it; and a Map/Set/Date/class
// instance is refused where a plain record is expected instead of being read
// as empty.

describe("class 1: each caller-supplied option is read once", () => {
  it("reads every config option exactly once for a whole document", () => {
    const reads: Record<string, number> = {};
    const config = new Proxy(
      {},
      {
        get(_target, key) {
          const name = String(key);
          reads[name] = (reads[name] ?? 0) + 1;
          return undefined;
        },
      },
    );
    classifyDocument("One claim. Two claim. Three claim.", {}, config);
    expect(reads).toEqual({ supports: 1, abbreviations: 1, markerPattern: 1, placeholderPattern: 1 });
  });

  it("uses the first-read marker pattern for every sentence, even if a getter changes its answer", () => {
    let reads = 0;
    const config = {
      get markerPattern(): RegExp {
        reads++;
        // The first read is the real pattern; any later read would be a different one.
        return reads === 1 ? /\[(\d+)\]/g : /\[\[cite:(\w+)\]\]/g;
      },
    };
    const doc = classifyDocument("First [1]. Second [2]. Third [3].", { "1": "first", "2": "second" }, {
      ...config,
      supports: () => true,
    });
    // The spread above reads the getter once; the kit then holds that one pattern.
    expect(reads).toBe(1);
    expect(doc.sentences.map((s) => s.citedIds)).toEqual([["1"], ["2"], ["3"]]);
    expect(doc.counts).toEqual({ grounded: 2, placeholder: 0, ungrounded: 0, invalid: 1 });
  });

  it("reads an evidence value once per id, however many sentences cite it", () => {
    let reads = 0;
    const evidence: Record<string, string> = {};
    Object.defineProperty(evidence, "e1", {
      enumerable: true,
      get() {
        reads++;
        return reads === 1 ? "supporting text" : 12345; // a later read would be invalid
      },
    });
    const doc = classifyDocument("A [[cite:e1]]. B [[cite:e1]]. C [[cite:e1]] [[cite:e1]].", evidence, {
      supports: () => true,
    });
    expect(reads).toBe(1);
    expect(doc.counts.grounded).toBe(3);
  });

  it("reads an evidence value once per call for a repeated id in one sentence", () => {
    let reads = 0;
    const evidence: Record<string, string> = {};
    Object.defineProperty(evidence, "e1", {
      enumerable: true,
      get() {
        reads++;
        return "supporting text";
      },
    });
    classifySentence("A [[cite:e1]] and B [[cite:e1]].", evidence, { supports: () => true });
    expect(reads).toBe(1);
  });

  it("reads an abbreviation list once and copies it", () => {
    let reads = 0;
    const abbreviations = {
      get alwaysFuse(): string[] {
        reads++;
        return ["prof"];
      },
      contextFuse: [],
    };
    expect(splitSentences("Prof. Ito spoke. Then left. Prof. Ito again.", { abbreviations })).toEqual([
      "Prof. Ito spoke.",
      "Then left.",
      "Prof. Ito again.",
    ]);
    expect(reads).toBe(1);
  });
});

describe("class 6: only plain or null-prototype objects are records", () => {
  const nonPlain: Array<[string, unknown]> = [
    ["a Map", new Map([["e1", "text"]])],
    ["a Set", new Set(["e1"])],
    ["a Date", new Date(0)],
    ["a RegExp", /e1/],
    ["a class instance", new (class Evidence { e1 = "text"; })()],
    ["an array", ["text"]],
    ["a boxed string", new String("text")],
  ];

  for (const [name, value] of nonPlain) {
    it(`refuses ${name} as the evidence map, cited or not`, () => {
      expect(() => classifySentence("Claim [[cite:e1]].", value as never)).toThrow(TypeError);
      expect(() => classifySentence("Nothing cited.", value as never)).toThrow(TypeError);
      expect(() => classifyDocument("Claim [[cite:e1]].", value as never)).toThrow(TypeError);
      expect(() => classifyDocument("", value as never)).toThrow(TypeError);
    });
  }

  it("names the problem when a Map is passed", () => {
    expect(() => classifySentence("x.", new Map() as never)).toThrow(
      new TypeError("evidenceMap must be an object (got a non-plain object)."),
    );
  });

  it("accepts a plain object, a null-prototype object and one made in another realm", async () => {
    const claim = "Battery lasted fourteen hours [[cite:e1]].";
    const text = "battery lasted fourteen hours";
    expect(classifySentence(claim, { e1: text }).status).toBe("grounded");
    expect(classifySentence(claim, Object.assign(Object.create(null) as object, { e1: text })).status).toBe(
      "grounded",
    );
    const vm = await import("node:vm");
    const foreign = vm.runInContext(`({ e1: ${JSON.stringify(text)} })`, vm.createContext({})) as Record<
      string,
      string
    >;
    expect(classifySentence(claim, foreign).status).toBe("grounded");
  });
});

describe("class 3: error messages never call into the offending value", () => {
  it("describes a value with a throwing toString, toJSON and Symbol.toPrimitive", () => {
    const hostile = {
      toString() {
        throw new Error("toString called");
      },
      toJSON() {
        throw new Error("toJSON called");
      },
      [Symbol.toPrimitive]() {
        throw new Error("toPrimitive called");
      },
    };
    const call = () => splitSentences(hostile as never);
    expect(call).toThrow(new TypeError("text must be a string (got object)."));
  });

  it("describes a bigint, a symbol, a function and a revoked Proxy without throwing something else", () => {
    expect(() => splitSentences(1n as never)).toThrow(new TypeError("text must be a string (got bigint)."));
    expect(() => splitSentences(Symbol("s") as never)).toThrow(new TypeError("text must be a string (got symbol)."));
    expect(() => splitSentences((() => 1) as never)).toThrow(
      new TypeError("text must be a string (got function)."),
    );
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(() => splitSentences(proxy as never)).toThrow(new TypeError("text must be a string (got an object)."));
    expect(() => classifySentence("x.", proxy as never)).toThrow(
      new TypeError("evidenceMap must be an object (got an object)."),
    );
    expect(() => splitSentences("x.", proxy as never)).toThrow(TypeError);
  });
});
