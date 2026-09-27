// Strict NodeNext type probe: uses grounding-kit's public types the way a
// TypeScript consumer would, imported by package name from the installed
// tarball. Compiled with `tsc --noEmit --strict` by verify-package.mjs; not
// executed, so this deliberately avoids node:assert (this kit has no
// @types/node dev dependency, and adding one just for this file isn't worth
// a new dependency — see the standard's known baseline defect note).
import {
  classifyDocument,
  classifySentence,
  splitSentences,
  stripCitationMarkers,
  defaultSupports,
  DEFAULT_ABBREVIATIONS,
  type ClassifyConfig,
  type DocumentClassification,
  type EvidenceMap,
  type SentenceClassification,
  type SentenceStatus,
  type SplitterConfig,
  type SupportsFn,
} from "grounding-kit";

const evidence: EvidenceMap = {
  e1: "independent lab testing measured 14 hours of battery life",
};

const sentences: string[] = splitSentences(
  "Battery life reached 14 hours [[cite:e1]]. It shipped the next day.",
);

const splitterConfig: SplitterConfig = {
  markerPattern: /\[(\d+)\]/g,
  placeholderPattern: /\[tbd\]/i,
  abbreviations: { alwaysFuse: ["dr"], contextFuse: ["etc"] },
};
const customSplit: string[] = splitSentences("Dr. Vance retested it [1].", splitterConfig);

const classification: SentenceClassification = classifySentence(sentences[0], evidence);
const status: SentenceStatus = classification.status;
const citedIds: string[] = classification.citedIds;
const validIds: string[] = classification.validIds;

const customSupports: SupportsFn = (claim, evidenceText) =>
  claim.length > 0 && evidenceText.length > 0;
const classifyConfig: ClassifyConfig = { supports: customSupports };
const withCustomSupports: SentenceClassification = classifySentence(
  sentences[0],
  evidence,
  classifyConfig,
);

const doc: DocumentClassification = classifyDocument(sentences.join(" "), evidence);
const counts: Record<SentenceStatus, number> = doc.counts;
const isClean: boolean = doc.isClean;
const citedEvidenceIds: string[] = doc.citedEvidenceIds;

const stripped: string = stripCitationMarkers(sentences[0]);
const supported: boolean = defaultSupports("battery life", "battery life reached 14 hours");
const alwaysFuse: readonly string[] = DEFAULT_ABBREVIATIONS.alwaysFuse;

// Reference every binding so `noUnusedLocals` (inherited via the probe's own
// strict compile) has nothing to flag.
if (
  customSplit.length === -1 ||
  citedIds.length === -1 ||
  validIds.length === -1 ||
  counts.grounded === -1 ||
  citedEvidenceIds.length === -1 ||
  alwaysFuse.length === -1 ||
  status === ("__unreachable__" as SentenceStatus) ||
  stripped === "__unreachable__" ||
  supported === undefined ||
  isClean === undefined ||
  withCustomSupports.sentence === "__unreachable__"
) {
  throw new Error("unreachable: type probe sanity check");
}
