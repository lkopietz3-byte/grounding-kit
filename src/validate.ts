// Internal runtime guards for top-level arguments. TypeScript callers
// already get these from the types; the guards exist for JavaScript callers
// and for values that arrived over JSON (an API request body, a stored
// document) with no static type at all.

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

/** Throws a TypeError naming `label` unless `value` is a string. */
export function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string (got ${describe(value)}).`);
  }
}

/**
 * Throws a TypeError naming `label` unless `value` is a non-null, non-array
 * object (the shape an EvidenceMap needs). Checked up front so a caller
 * passing `null`, `undefined`, or a primitive gets this kit's own clear
 * TypeError instead of a raw "Cannot convert undefined or null to object"
 * from the first `Object.hasOwn` call deep inside classification — which,
 * before this check existed, only happened for a sentence that had a
 * citation marker, so the same bad call could throw or silently succeed
 * depending on the input text.
 */
export function assertEvidenceMap(value: unknown, label: string): asserts value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object (got ${describe(value)}).`);
  }
}
