/**
 * Core Text Utilities
 *
 * Platform-agnostic text processing functions.
 * Used by orchestrator and core pipeline.
 */

export {
  normalizeText,
  normalizeWhitespace,
  normalizeLineBreaks,
  removeInvisibleCharacters,
} from "./normalize";

export {
  mapOffset,
  mapRange,
  computeDiffSummary,
  type OffsetMapping,
  type RangeMapping,
  type DiffSummary,
} from "./diff";
