/**
 * Core Highlight Anchors
 *
 * Platform-agnostic anchor model for tracking highlights across text changes.
 * Anchors persist across snapshots and are remapped when text changes.
 *
 * RULES:
 * - No DOM imports (must work in Node.js/test environments)
 * - Pure functions only
 * - Anchors track highlights by ID to enable stable rendering
 */

import { Issue } from "../contracts";
import { mapRange } from "../text/diff";

/**
 * Highlight anchor - tracks a highlight's position and content across snapshots
 */
export interface HighlightAnchor {
  /** Unique identifier matching the Issue.id */
  id: string;

  /** The exact text substring that was highlighted */
  originalText: string;

  /** Start offset in the snapshot where this anchor was created */
  start: number;

  /** End offset in the snapshot where this anchor was created */
  end: number;

  /** Left context (characters before the anchor) for relocation */
  leftContext: string;

  /** Right context (characters after the anchor) for relocation */
  rightContext: string;

  /** Snapshot version when this anchor was created */
  createdVersion: number;

  /** Current start offset (updated after remapping) */
  currentStart: number;

  /** Current end offset (updated after remapping) */
  currentEnd: number;

  /** The issue data associated with this anchor */
  issue: Issue;
}

/**
 * Result of remapping anchors
 */
export interface RemapResult {
  /** Anchors that were kept (exact match after remap) */
  kept: HighlightAnchor[];

  /** Anchors that were updated (remapped to new positions) */
  updated: HighlightAnchor[];

  /** Anchors that were removed (invalid or not found) */
  removed: HighlightAnchor[];

  /** Count of anchors relocated using context search */
  contextRelocated: number;
}

/**
 * Configuration for anchor creation
 */
export interface AnchorConfig {
  /** Number of characters to include in left context (default: 20) */
  leftContextLength?: number;

  /** Number of characters to include in right context (default: 20) */
  rightContextLength?: number;

  /** Search window size for context-based relocation (default: 100) */
  contextSearchWindow?: number;
}

const DEFAULT_CONFIG: Required<AnchorConfig> = {
  leftContextLength: 20,
  rightContextLength: 20,
  contextSearchWindow: 100,
};

/**
 * Create anchors from issues
 *
 * @param issues - Issues to create anchors for
 * @param snapshotText - Text content of the snapshot
 * @param snapshotVersion - Version of the snapshot
 * @param config - Configuration for anchor creation
 * @returns Map of anchor ID to anchor
 */
export function createAnchors(
  issues: Issue[],
  snapshotText: string,
  snapshotVersion: number,
  config: AnchorConfig = {}
): Map<string, HighlightAnchor> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const anchors = new Map<string, HighlightAnchor>();

  for (const issue of issues) {
    // Extract original text
    const originalText = snapshotText.substring(issue.start, issue.end);

    // Extract context
    const leftContextStart = Math.max(0, issue.start - cfg.leftContextLength);
    const leftContext = snapshotText.substring(leftContextStart, issue.start);

    const rightContextEnd = Math.min(
      snapshotText.length,
      issue.end + cfg.rightContextLength
    );
    const rightContext = snapshotText.substring(issue.end, rightContextEnd);

    const anchor: HighlightAnchor = {
      id: issue.id,
      originalText,
      start: issue.start,
      end: issue.end,
      leftContext,
      rightContext,
      createdVersion: snapshotVersion,
      currentStart: issue.start,
      currentEnd: issue.end,
      issue,
    };

    anchors.set(anchor.id, anchor);
  }

  return anchors;
}

/**
 * Attempt to relocate an anchor using context search
 *
 * @param anchor - Anchor to relocate
 * @param newText - New text to search in
 * @param predictedStart - Predicted start position from diff mapping
 * @param config - Configuration
 * @returns New position if found, null otherwise
 */
function relocateWithContext(
  anchor: HighlightAnchor,
  newText: string,
  predictedStart: number,
  config: Required<AnchorConfig>
): { start: number; end: number } | null {
  // Search window around predicted position
  const searchStart = Math.max(0, predictedStart - config.contextSearchWindow);
  const searchEnd = Math.min(
    newText.length,
    predictedStart + config.contextSearchWindow
  );

  const searchText = newText.substring(searchStart, searchEnd);

  // Try to find originalText in the search window
  const textIndex = searchText.indexOf(anchor.originalText);
  if (textIndex !== -1) {
    // Found the text, verify context if possible
    const foundStart = searchStart + textIndex;
    const foundEnd = foundStart + anchor.originalText.length;

    // Optional: verify left/right context matches (fuzzy match)
    // For now, if we found the exact text, we trust it
    return { start: foundStart, end: foundEnd };
  }

  return null;
}

/**
 * Validate that an anchor's current position matches the original text
 *
 * @param anchor - Anchor to validate
 * @param newText - New text to check against
 * @returns True if the text at current position matches original
 */
function validateAnchorText(anchor: HighlightAnchor, newText: string): boolean {
  if (
    anchor.currentStart < 0 ||
    anchor.currentEnd > newText.length ||
    anchor.currentStart >= anchor.currentEnd
  ) {
    return false;
  }

  const currentText = newText.substring(anchor.currentStart, anchor.currentEnd);
  return currentText === anchor.originalText;
}

/**
 * Remap anchors from old text to new text
 *
 * @param prevText - Previous text
 * @param nextText - New text
 * @param anchors - Map of anchors to remap
 * @param config - Configuration
 * @returns Remapping result
 */
export function remapAnchors(
  prevText: string,
  nextText: string,
  anchors: Map<string, HighlightAnchor>,
  config: AnchorConfig = {}
): RemapResult {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const kept: HighlightAnchor[] = [];
  const updated: HighlightAnchor[] = [];
  const removed: HighlightAnchor[] = [];
  let contextRelocated = 0;

  for (const anchor of anchors.values()) {
    // Map the range using diff
    const rangeMapping = mapRange(
      prevText,
      nextText,
      anchor.currentStart,
      anchor.currentEnd
    );

    // Update current position
    anchor.currentStart = rangeMapping.start;
    anchor.currentEnd = rangeMapping.end;

    // Check if exact match at remapped position
    if (validateAnchorText(anchor, nextText)) {
      // Exact match - keep as-is
      kept.push(anchor);
      continue;
    }

    // No exact match - try context-based relocation
    const relocated = relocateWithContext(
      anchor,
      nextText,
      rangeMapping.start,
      cfg
    );

    if (relocated) {
      // Found via context search
      anchor.currentStart = relocated.start;
      anchor.currentEnd = relocated.end;

      // Verify the relocated position
      if (validateAnchorText(anchor, nextText)) {
        updated.push(anchor);
        contextRelocated++;
        continue;
      }
    }

    // Could not relocate - remove anchor
    removed.push(anchor);
  }

  return {
    kept,
    updated,
    removed,
    contextRelocated,
  };
}

/**
 * Merge new issues into existing anchors
 * Updates existing anchors and creates new ones
 *
 * @param existingAnchors - Current anchors map
 * @param newIssues - New issues from grammar check
 * @param snapshotText - Current snapshot text
 * @param snapshotVersion - Current snapshot version
 * @param config - Configuration
 * @returns Updated anchors map
 */
export function mergeAnchorsWithIssues(
  existingAnchors: Map<string, HighlightAnchor>,
  newIssues: Issue[],
  snapshotText: string,
  snapshotVersion: number,
  config: AnchorConfig = {}
): Map<string, HighlightAnchor> {
  const newAnchors = createAnchors(
    newIssues,
    snapshotText,
    snapshotVersion,
    config
  );

  // Update or create anchors
  for (const [id, newAnchor] of newAnchors.entries()) {
    const existing = existingAnchors.get(id);

    if (existing) {
      // Update existing anchor with new issue data
      existing.issue = newAnchor.issue;
      existing.originalText = newAnchor.originalText;
      existing.start = newAnchor.start;
      existing.end = newAnchor.end;
      existing.currentStart = newAnchor.start;
      existing.currentEnd = newAnchor.end;
      existing.leftContext = newAnchor.leftContext;
      existing.rightContext = newAnchor.rightContext;
      existing.createdVersion = snapshotVersion;
    } else {
      // Create new anchor
      existingAnchors.set(id, newAnchor);
    }
  }

  // Remove anchors that are no longer in new issues
  const newIssueIds = new Set(newIssues.map((issue) => issue.id));
  for (const [id] of existingAnchors.entries()) {
    if (!newIssueIds.has(id)) {
      existingAnchors.delete(id);
    }
  }

  return existingAnchors;
}

/**
 * Convert anchors back to issues for rendering
 *
 * @param anchors - Anchors to convert
 * @param snapshotVersion - Current snapshot version
 * @returns Issues array
 */
export function anchorsToIssues(
  anchors: Map<string, HighlightAnchor>,
  snapshotVersion: number
): Issue[] {
  const issues: Issue[] = [];

  for (const anchor of anchors.values()) {
    // Create issue with current position
    const issue: Issue = {
      ...anchor.issue,
      start: anchor.currentStart,
      end: anchor.currentEnd,
      snapshotVersion,
    };

    issues.push(issue);
  }

  return issues;
}
