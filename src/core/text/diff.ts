/**
 * Core Text Diff and Offset Mapping
 *
 * Platform-agnostic text diffing and offset remapping utilities.
 * Used to track how text changes affect highlight positions.
 *
 * RULES:
 * - No DOM imports (must work in Node.js/test environments)
 * - Pure functions only
 * - Optimized for small edits (single char insert/delete common)
 * - O(n) or near-O(n) performance for typical edits
 */

/**
 * Result of mapping an offset from old text to new text
 */
export interface OffsetMapping {
  /** Mapped offset in new text, or null if offset is invalid */
  offset: number | null;

  /** Whether the offset was affected by the diff */
  changed: boolean;
}

/**
 * Result of mapping a range from old text to new text
 */
export interface RangeMapping {
  /** Mapped start offset in new text */
  start: number;

  /** Mapped end offset in new text */
  end: number;

  /** Whether the range was affected by the diff */
  changed: boolean;
}

/**
 * Efficiently compute offset mapping between two texts
 * Uses prefix/suffix matching + middle diff for optimal performance
 *
 * @param oldText - Previous text
 * @param newText - Current text
 * @param oldOffset - Offset in old text
 * @returns Mapped offset in new text
 */
export function mapOffset(
  oldText: string,
  newText: string,
  oldOffset: number
): OffsetMapping {
  // Handle edge cases
  if (oldOffset < 0) {
    return { offset: null, changed: true };
  }

  if (oldText === newText) {
    // No change, offset unchanged
    return { offset: oldOffset, changed: false };
  }

  // Find common prefix
  let prefixLength = 0;
  const minLength = Math.min(oldText.length, newText.length);
  while (
    prefixLength < minLength &&
    oldText[prefixLength] === newText[prefixLength]
  ) {
    prefixLength++;
  }

  // If offset is in common prefix, it's unchanged
  if (oldOffset <= prefixLength) {
    return { offset: oldOffset, changed: false };
  }

  // Find common suffix (after prefix)
  let suffixLength = 0;
  //   const oldSuffixStart = oldText.length - suffixLength;
  //   const newSuffixStart = newText.length - suffixLength;

  while (
    suffixLength < oldText.length - prefixLength &&
    suffixLength < newText.length - prefixLength &&
    oldText[oldText.length - 1 - suffixLength] ===
      newText[newText.length - 1 - suffixLength]
  ) {
    suffixLength++;
  }

  // Calculate the changed middle region
  const oldMiddleStart = prefixLength;
  const oldMiddleEnd = oldText.length - suffixLength;
  const newMiddleStart = prefixLength;
  const newMiddleEnd = newText.length - suffixLength;

  const oldMiddleLength = oldMiddleEnd - oldMiddleStart;
  const newMiddleLength = newMiddleEnd - newMiddleStart;
  const delta = newMiddleLength - oldMiddleLength;

  // If offset is in the unchanged suffix region
  if (oldOffset >= oldMiddleEnd) {
    // Offset is in suffix, adjust by delta
    const newOffset = oldOffset + delta;
    return {
      offset: newOffset <= newText.length ? newOffset : newText.length,
      changed: delta !== 0,
    };
  }

  // Offset is in the changed middle region
  // For simplicity, map proportionally within the middle region
  // This is a heuristic - exact mapping would require full diff
  if (oldMiddleLength === 0) {
    // Old middle is empty (insertion), map to start of new middle
    return { offset: newMiddleStart, changed: true };
  }

  if (newMiddleLength === 0) {
    // New middle is empty (deletion), map to start
    return { offset: newMiddleStart, changed: true };
  }

  // Proportional mapping within middle region
  const positionInOldMiddle = oldOffset - oldMiddleStart;
  const ratio = positionInOldMiddle / oldMiddleLength;
  const positionInNewMiddle = Math.floor(ratio * newMiddleLength);
  const newOffset = newMiddleStart + positionInNewMiddle;

  return { offset: newOffset, changed: true };
}

/**
 * Map a range (start, end) from old text to new text
 *
 * @param oldText - Previous text
 * @param newText - Current text
 * @param oldStart - Start offset in old text
 * @param oldEnd - End offset in old text
 * @returns Mapped range in new text
 */
export function mapRange(
  oldText: string,
  newText: string,
  oldStart: number,
  oldEnd: number
): RangeMapping {
  // Validate input
  if (oldStart < 0 || oldEnd < oldStart) {
    // Invalid range, try to map end only
    const endMapping = mapOffset(oldText, newText, oldEnd);
    return {
      start: endMapping.offset ?? 0,
      end: endMapping.offset ?? 0,
      changed: true,
    };
  }

  // Map both endpoints
  const startMapping = mapOffset(oldText, newText, oldStart);
  const endMapping = mapOffset(oldText, newText, oldEnd);

  // Handle null offsets
  const start = startMapping.offset ?? 0;
  let end = endMapping.offset ?? start;

  // Ensure end >= start
  if (end < start) {
    end = start;
  }

  // Ensure end doesn't exceed new text length
  if (end > newText.length) {
    end = newText.length;
  }

  return {
    start,
    end,
    changed: startMapping.changed || endMapping.changed,
  };
}

/**
 * Compute a simple diff summary between two texts
 * Returns information about what changed for debugging
 *
 * @param oldText - Previous text
 * @param newText - Current text
 * @returns Diff summary
 */
export interface DiffSummary {
  /** Length of common prefix */
  prefixLength: number;

  /** Length of common suffix */
  suffixLength: number;

  /** Length of changed middle in old text */
  oldMiddleLength: number;

  /** Length of changed middle in new text */
  newMiddleLength: number;

  /** Net change in length (positive = insertion, negative = deletion) */
  delta: number;
}

export function computeDiffSummary(
  oldText: string,
  newText: string
): DiffSummary {
  // Find common prefix
  let prefixLength = 0;
  const minLength = Math.min(oldText.length, newText.length);
  while (
    prefixLength < minLength &&
    oldText[prefixLength] === newText[prefixLength]
  ) {
    prefixLength++;
  }

  // Find common suffix (after prefix)
  let suffixLength = 0;
  while (
    suffixLength < oldText.length - prefixLength &&
    suffixLength < newText.length - prefixLength &&
    oldText[oldText.length - 1 - suffixLength] ===
      newText[newText.length - 1 - suffixLength]
  ) {
    suffixLength++;
  }

  const oldMiddleLength = oldText.length - prefixLength - suffixLength;
  const newMiddleLength = newText.length - prefixLength - suffixLength;
  const delta = newMiddleLength - oldMiddleLength;

  return {
    prefixLength,
    suffixLength,
    oldMiddleLength,
    newMiddleLength,
    delta,
  };
}
