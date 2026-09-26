// Deterministic, dependency-free sentence splitter hardened against the ways a
// citation marker can get laundered onto the wrong sentence: abbreviation
// periods that don't end a sentence, a marker sitting right after a period
// (so it looks like it grounds the NEXT sentence instead of the one it
// actually terminates), clause-internal fabrications hiding behind a real
// citation elsewhere in the same sentence, non-ASCII sentence terminators, and
// malformed brackets that a naive matcher would silently accept.
//
// Nothing here is specific to any one product's citation convention beyond
// the two configurable regexes below (`markerPattern`, `placeholderPattern`)
// and the abbreviation-fusion list. Ship your own of each for your domain;
// the defaults are deliberately generic.

/** Controls which trailing periods do NOT end a sentence. */
export interface AbbreviationConfig {
  /**
   * Abbreviations that ALWAYS attach to the token that follows them, so a
   * period after one of these can never end a sentence (e.g. honorifics:
   * "Dr. Vance" must not split into "Dr." + "Vance").
   */
  alwaysFuse: readonly string[];
  /**
   * Abbreviations that CAN legitimately end a sentence (list-enders, unit
   * suffixes). They only fuse with what follows when the next fragment
   * continues in lower-case or a digit ("Corp. filed the report" ends the
   * sentence; "Corp. reserves the right" does not, but "no. 2 on the list"
   * does not end at "no.").
   */
  contextFuse: readonly string[];
}

/**
 * Small, generic English defaults. These are NOT tuned for any one domain —
 * override `alwaysFuse`/`contextFuse` entirely for other languages, other
 * abbreviation conventions, or to add domain-specific ones (they replace,
 * not merge, so you always know exactly what's active).
 */
export const DEFAULT_ABBREVIATIONS: AbbreviationConfig = Object.freeze({
  alwaysFuse: Object.freeze([
    "mr", "mrs", "ms", "dr", "prof", "hon", "st", "v", "vs",
  ]),
  contextFuse: Object.freeze([
    "no", "inc", "co", "corp", "ltd", "llc", "dept", "vol", "ed",
    "al", "etc", "eg", "ie", "approx", "fig", "p", "pp", "jr", "sr",
  ]),
});

/**
 * Regex matching one citation marker. Must contain exactly one capture group
 * holding the marker id. Any flags are fine — a fresh copy is always taken
 * internally, so a caller can safely reuse the same RegExp object elsewhere
 * (including with `.test()`) without lastIndex corruption.
 *
 * Default convention: `[[cite:id]]`. Bring your own for e.g. `[1]`,
 * `{{ref:id}}`, or whatever your generator already emits.
 */
export const DEFAULT_MARKER_PATTERN = /\[\[cite:\s*([a-zA-Z0-9_-]+)\s*\]\]/g;

/**
 * Regex matching an explicit "I don't have a source for this" placeholder —
 * the honest alternative to inventing a citation. Default recognizes a few
 * common bracketed conventions ("[citation needed]", "[TK]"). Bring your own
 * to match whatever gap-marker your prompt asks the model to emit.
 */
export const DEFAULT_PLACEHOLDER_PATTERN =
  /\[(?:citation needed|more research needed|TK)[^\]]*\]/i;

export interface SplitterConfig {
  abbreviations?: AbbreviationConfig;
  markerPattern?: RegExp;
  placeholderPattern?: RegExp;
}

const TERMINATOR_CLASS = /[.!?。．！？]/;

// --- regex hygiene -----------------------------------------------------
// Every call site below builds a FRESH RegExp from `.source`/`.flags` rather
// than reusing the caller's object. Global regexes carry mutable lastIndex
// state; sharing one instance across matchAll/test/exec calls (including the
// caller's own later use of the same object) is a classic source of
// "works on the first document, silently breaks on the second" bugs. It's a
// little more allocation, never a correctness footgun.

function freshGlobal(re: RegExp): RegExp {
  const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
  return new RegExp(re.source, flags);
}

// Insert a space wherever a citation marker is glued directly to adjacent
// prose with no whitespace — glued to a following word ("]]The"), glued to a
// following word via a terminator ("]].The"), or glued to a PRECEDING
// terminator ("occasionally.[[cite:e1]]"). Left alone, any of these fuses two
// sentences into one and lets the second ride the first's citation — the core
// laundering vector this library exists to close. Normal spacing
// ("sentence. [[cite:e1]] Next sentence.") is left untouched.
function normalizeMarkerAdjacency(text: string, markerPattern: RegExp): string {
  const re = freshGlobal(markerPattern);
  let result = "";
  let last = 0;
  for (const m of text.matchAll(re)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    result += text.slice(last, start);
    if (result.length > 0 && TERMINATOR_CLASS.test(result[result.length - 1])) {
      result += " ";
    }
    result += m[0];
    let cursor = end;
    const afterMarker = text[cursor] ?? "";
    if (TERMINATOR_CLASS.test(afterMarker)) {
      // A terminator immediately follows the marker (e.g. "]]."): keep it
      // attached, then check whether THAT is glued to the next word.
      result += afterMarker;
      cursor += 1;
    }
    // \p{L}\p{N} (any script's letters/digits), not the ASCII-only
    // [A-Za-z0-9]: a marker glued directly to non-Latin prose ("[[cite:e1]]
    // こんにちは") needs the same normalizing space as one glued to English.
    if (/[\p{L}\p{N}]/u.test(text[cursor] ?? "")) {
      result += " ";
    }
    last = cursor;
  }
  result += text.slice(last);
  return result;
}

// Whether a fragment's trailing period is a FALSE boundary (does not end the
// sentence). `next` is the fragment that would follow; it decides the
// context-sensitive abbreviations.
function endsOnFalseBoundary(
  fragment: string,
  next: string | undefined,
  alwaysFuse: Set<string>,
  contextFuse: Set<string>,
): boolean {
  const trimmed = fragment.trimEnd();
  // A single letter is a name initial ("Dana M. Whitfield") only when it
  // stands alone. A letter glued to a number/currency ("$9M.") is a unit that
  // really ends the sentence.
  if (/(?:^|\s)[A-Za-z]\.$/.test(trimmed)) return true;
  const m = /([A-Za-z][A-Za-z.]*)\.$/.exec(trimmed);
  if (!m) return false;
  const word = m[1].replace(/\./g, "").toLowerCase();
  if (alwaysFuse.has(word)) return true;
  if (contextFuse.has(word)) {
    // No following fragment -> a real sentence end. A capitalized next
    // fragment starts a new sentence; lower-case or a digit continues this one.
    return next != null && !/^[A-Z]/.test(next.trimStart());
  }
  return false;
}

// A fragment is "citation only" when stripping its markers leaves no prose —
// the model (or an editor) emitted the marker AFTER the terminal period on
// its own. Such a fragment must reattach to the preceding sentence, or that
// sentence reads as ungrounded even though it was cited.
function isCitationOnly(fragment: string, markerPattern: RegExp): boolean {
  const re = freshGlobal(markerPattern);
  const withoutMarkers = fragment.replace(re, "");
  // \p{L}\p{N} (any script), not [A-Za-z0-9]: prose in Japanese, Arabic,
  // Cyrillic, etc. must count as "real content" here too, or a non-Latin
  // sentence sitting next to a citation marker gets misread as pure
  // leftover punctuation and silently absorbed into the previous sentence.
  return withoutMarkers !== fragment && !/[\p{L}\p{N}]/u.test(withoutMarkers);
}

// A fragment can BEGIN with citation markers that actually terminate the
// PREVIOUS sentence ("...occasionally. [[cite:e1]] The claimant lost
// $500,000."). The split orphans those markers onto the FOLLOWING fragment,
// where they would falsely ground it — the laundering vector that lets a
// fabricated, uncited claim ride an earlier citation. Peel any leading
// markers off so the caller can reattach them to the sentence they actually
// terminate. A citation can only ground prose that precedes or surrounds it
// within the SAME sentence.
function peelLeadingMarkers(
  fragment: string,
  markerPattern: RegExp,
): { markers: string; rest: string } {
  let rest = fragment.trimStart();
  const collected: string[] = [];
  const re = freshGlobal(markerPattern);
  for (;;) {
    re.lastIndex = 0;
    const m = re.exec(rest);
    if (!m || m.index !== 0) break;
    collected.push(m[0]);
    rest = rest.slice(m[0].length).trimStart();
  }
  return { markers: collected.join(" "), rest };
}

// Split ONE sentence into clause-level grounding units on ';', an em-dash, or
// a colon that introduces a new clause. Bracket-aware via MATCHED-pair
// tracking: a separator inside a real `[ ... ]` span (or inside whatever the
// marker/placeholder patterns match, even if they don't use square brackets)
// is never a split point — but an UNbalanced '[' cannot suppress later
// splits, so bracket handling fails CLOSED rather than silently swallowing
// the rest of the sentence.
function splitGroundingUnits(
  sentence: string,
  markerPattern: RegExp,
  placeholderPattern: RegExp,
): string[] {
  const inside = new Array<boolean>(sentence.length).fill(false);
  const openStack: number[] = [];
  for (let i = 0; i < sentence.length; i++) {
    if (sentence[i] === "[") {
      openStack.push(i);
    } else if (sentence[i] === "]" && openStack.length > 0) {
      const open = openStack.pop()!;
      for (let j = open; j <= i; j++) inside[j] = true;
    }
  }
  // Belt-and-suspenders: also shield whatever the marker/placeholder regexes
  // match directly, in case a caller's marker syntax doesn't use brackets at
  // all (e.g. "{{ref:id}}"). While scanning marker matches, also record each
  // match's END offset into a prefix-count array: the colon-boundary check
  // below needs to know "does the pending clause contain a marker?" at every
  // ':', and re-slicing + re-testing the (growing) pending clause from
  // scratch each time is O(n) per query — O(n^2) overall on a long,
  // marker-free, colon-heavy input. A prefix count answers the same question
  // in O(1) per query.
  const markerEndCounts = new Uint32Array(sentence.length + 1);
  for (const m of sentence.matchAll(freshGlobal(markerPattern))) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    for (let j = start; j < end; j++) inside[j] = true;
    if (end <= sentence.length) markerEndCounts[end] += 1;
  }
  for (const m of sentence.matchAll(freshGlobal(placeholderPattern))) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    for (let j = start; j < end; j++) inside[j] = true;
  }
  for (let i = 1; i <= sentence.length; i++) markerEndCounts[i] += markerEndCounts[i - 1];

  const isDigit = (c: string | undefined) => c != null && c >= "0" && c <= "9";
  const units: string[] = [];
  let start = 0;
  for (let i = 0; i < sentence.length; i++) {
    if (inside[i]) continue;
    const ch = sentence[i];
    // Split a colon ONLY when the clause BEFORE it already carries a
    // citation. The laundering vector is a cite reaching FORWARD across the
    // colon to ground an uncited clause; requiring a marker in the pending
    // clause catches exactly that. A leading uncited label ("Results: ...
    // [[cite:e1]]") is left intact, behaving like an accepted comma-join.
    // Numeric colons (time "9:30", ratio "3:1") are never boundaries.
    // markerEndCounts[i] - markerEndCounts[start] is the number of marker
    // matches whose end offset falls in (start, i] — i.e. a marker fully
    // inside the pending clause. Markers can't straddle an accepted split
    // point (a split point is never `inside` a marker match), so this is
    // exactly equivalent to "the pending clause contains a marker."
    const isColonBoundary =
      ch === ":" &&
      !(isDigit(sentence[i - 1]) && isDigit(sentence[i + 1])) &&
      markerEndCounts[i] - markerEndCounts[start] > 0;
    if (ch === ";" || ch === "—" || isColonBoundary) {
      const unit = sentence.slice(start, i).trim();
      if (unit) units.push(unit);
      start = i + 1;
    }
  }
  const last = sentence.slice(start).trim();
  if (last) units.push(last);
  return units;
}

/**
 * Split `text` into sentence-ish grounding units, keeping citation markers
 * attached to the unit they actually ground (never a following clause or
 * sentence). Hardened against:
 *  - abbreviation periods that don't end a sentence (configurable list)
 *  - a citation marker glued to punctuation/prose with no whitespace
 *  - non-ASCII sentence terminators (。．！？)
 *  - a marker sitting right after a period, which would otherwise be read as
 *    grounding the sentence that follows it (leading-marker peeling)
 *  - clause-internal fabrications riding a citation elsewhere in the sentence
 *    (semicolon/em-dash/cited-colon clause splitting)
 *  - malformed/unbalanced brackets (fails closed: never suppresses a split)
 */
export function splitSentences(text: string, config: SplitterConfig = {}): string[] {
  const abbreviations = config.abbreviations ?? DEFAULT_ABBREVIATIONS;
  const markerPattern = config.markerPattern ?? DEFAULT_MARKER_PATTERN;
  const placeholderPattern = config.placeholderPattern ?? DEFAULT_PLACEHOLDER_PATTERN;

  const alwaysFuse = new Set(abbreviations.alwaysFuse.map((w) => w.toLowerCase()));
  const contextFuse = new Set(abbreviations.contextFuse.map((w) => w.toLowerCase()));

  const normalized = normalizeMarkerAdjacency(text, markerPattern);

  const sentences: string[] = [];
  for (const line of normalized.split("\n")) {
    // Split on ASCII terminators followed by whitespace, AND on non-ASCII
    // full stops (they may carry no trailing space, e.g. in CJK text).
    const parts = line.split(/(?<=[.!?。．！？])\s+|(?<=[。．！？])(?=\S)/);
    let buffer = "";
    for (let i = 0; i < parts.length; i++) {
      buffer = buffer ? `${buffer} ${parts[i]}` : parts[i];
      // endsOnFalseBoundary only inspects the trailing word of its `fragment`
      // argument ($-anchored regexes), which is fully contained in `parts[i]`
      // itself regardless of how much has already accumulated in `buffer`.
      // Passing the whole (potentially long-growing) `buffer` here instead of
      // just the newly-appended part is O(current buffer length) per
      // iteration purely from re-flattening and re-scanning it — O(n^2) over
      // a long run of fused fragments (e.g. many single-letter initials in a
      // row, which never hit a real sentence boundary). Passing `parts[i]`
      // keeps each check O(that part's length) and the whole loop O(n).
      if (!endsOnFalseBoundary(parts[i], parts[i + 1], alwaysFuse, contextFuse)) {
        const trimmed = buffer.trim();
        if (trimmed) sentences.push(trimmed);
        buffer = "";
      }
    }
    const trimmed = buffer.trim();
    if (trimmed) sentences.push(trimmed);
  }

  // Clause-level split so an uncited clause can't ride a cited one inside the
  // same sentence. Erring toward more units is safe: it fails closed (flags
  // for a citation), it never launders.
  const units = sentences.flatMap((s) =>
    splitGroundingUnits(s, markerPattern, placeholderPattern),
  );

  // Reattach orphaned citation markers to the unit they belong to.
  const merged: string[] = [];
  for (const unit of units) {
    const { markers, rest } = peelLeadingMarkers(unit, markerPattern);
    if (markers) {
      // Leading markers sat after the PREVIOUS unit's terminal period.
      // Attach them there so they can't ground the prose that follows. If
      // this is the FIRST unit, there is no prior unit for them to
      // terminate, so they ground nothing and are dropped.
      if (merged.length > 0) {
        merged[merged.length - 1] = `${merged[merged.length - 1]} ${markers}`;
      }
      // `rest` already went through peelLeadingMarkers' trimStart(), so if
      // it's non-empty it necessarily starts with (and therefore contains) a
      // non-whitespace character — no need to additionally require that
      // character be ASCII alnum. The old `[A-Za-z0-9]` guard here silently
      // discarded any surviving remainder written in a non-Latin script
      // (e.g. a whole CJK sentence right after a peeled marker) or made of
      // bare punctuation (e.g. a lone "!"), deleting real content from the
      // output instead of just an empty string.
      if (rest) merged.push(rest);
      continue;
    }
    // Trailing citation-only fragment (marker after the period, on its own).
    if (merged.length > 0 && isCitationOnly(unit, markerPattern)) {
      merged[merged.length - 1] = `${merged[merged.length - 1]} ${unit}`;
      continue;
    }
    merged.push(unit);
  }
  return merged;
}

/** Every citation marker id referenced in `sentence`, in appearance order (duplicates kept). */
export function extractCitedIds(
  sentence: string,
  markerPattern: RegExp = DEFAULT_MARKER_PATTERN,
): string[] {
  const re = freshGlobal(markerPattern);
  const ids: string[] = [];
  for (const m of sentence.matchAll(re)) {
    if (m[1] !== undefined) ids.push(m[1]);
  }
  return ids;
}

/** Every distinct citation marker id referenced anywhere in `text`, first-appearance order. */
export function extractAllCitedIds(
  text: string,
  markerPattern: RegExp = DEFAULT_MARKER_PATTERN,
): string[] {
  const seen = new Set<string>();
  for (const id of extractCitedIds(text, markerPattern)) seen.add(id);
  return [...seen];
}

/**
 * Remove citation markers for display/export while leaving prose intact.
 * Collapses any double space or space-before-punctuation left behind by the
 * removal (e.g. "reach [[cite:e1]]." -> "reach.", not "reach .").
 */
export function stripCitationMarkers(
  text: string,
  markerPattern: RegExp = DEFAULT_MARKER_PATTERN,
): string {
  const re = freshGlobal(markerPattern);
  return text
    .replace(re, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .trimEnd();
}
