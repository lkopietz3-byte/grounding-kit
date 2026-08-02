export {
  DEFAULT_ABBREVIATIONS,
  DEFAULT_MARKER_PATTERN,
  DEFAULT_PLACEHOLDER_PATTERN,
  splitSentences,
  extractCitedIds,
  extractAllCitedIds,
  stripCitationMarkers,
  type AbbreviationConfig,
  type SplitterConfig,
} from "./sentenceSplitter.js";

export {
  classifySentence,
  classifyDocument,
  defaultSupports,
  type SentenceStatus,
  type EvidenceMap,
  type SupportsFn,
  type ClassifyConfig,
  type SentenceClassification,
  type DocumentClassification,
} from "./classify.js";
