/**
 * Core Contracts
 * Single source of truth for types between platform adapters and core
 *
 * These types define the strict boundary between platform-specific code
 * and platform-agnostic business logic.
 *
 * RULES:
 * - Core must NOT import DOM APIs (document/window/HTMLElement/Selection)
 * - Platform adapters communicate with core ONLY through these types
 * - All offsets are relative to snapshot text, not DOM positions
 */

/**
 * Text block metadata (optional, for rich text editors)
 */
export interface Block {
  id: string;
  type: string;
  startOffset: number;
  endOffset: number;
  metadata?: Record<string, unknown>;
}

/**
 * Document snapshot - platform-agnostic representation of document state
 * This is the primary contract between adapters and core
 */
export interface DocumentSnapshot {
  /** Full text content of the document */
  text: string;

  /** Optional block structure for rich text editors */
  blocks?: Block[];

  /** Version number - increments on each change to enable change detection */
  version: number;

  /** Optional metadata (e.g., element ID, platform-specific info) */
  meta?: {
    elementId?: string;
    platform?: string;
    [key: string]: unknown;
  };
}

/**
 * Platform-agnostic range reference
 * DO NOT use DOM Range - this is a pure data structure
 */
export interface RangeRef {
  /** Start offset in snapshot text */
  start: number;

  /** End offset in snapshot text */
  end: number;

  /** Optional block ID if this range spans a block boundary */
  blockId?: string;

  /** Optional metadata for platform-specific range tracking */
  meta?: Record<string, unknown>;
}

/**
 * Grammar/spelling issue
 * All offsets are relative to the snapshot text at snapshot.version
 */
export interface Issue {
  /** Unique identifier for this issue instance */
  id: string;

  /** Start offset in snapshot text */
  start: number;

  /** End offset in snapshot text */
  end: number;

  /** The problematic text */
  word: string;

  /** Suggested replacements */
  suggestions: string[];

  /** Issue type */
  type: "grammar" | "spelling";

  /** Optional severity level */
  severity?: "error" | "warning" | "info";

  /** Optional message explaining the issue */
  message?: string;

  /** Snapshot version this issue was detected at */
  snapshotVersion: number;
}

/**
 * Suggestion for applying a fix
 */
export interface Suggestion {
  /** Issue ID this suggestion applies to */
  issueId: string;

  /** Replacement text */
  replacement: string;

  /** Optional confidence score (0-1) */
  confidence?: number;
}

/**
 * Change operation to apply to document
 */
export type Change =
  | {
      type: "replace";
      range: RangeRef;
      text: string;
    }
  | {
      type: "insert";
      position: number;
      text: string;
    }
  | {
      type: "delete";
      range: RangeRef;
    };

/**
 * Result of applying a change
 */
export interface ApplyChangeResult {
  /** Success flag */
  success: boolean;

  /** New snapshot version after change */
  newVersion: number;

  /** Error message if failed */
  error?: string;

  /** Updated snapshot after change */
  snapshot?: DocumentSnapshot;
}

/**
 * Debug event for pipeline observability
 */
export interface DebugEvent {
  /** Event timestamp */
  timestamp: number;

  /** Event stage/phase */
  stage:
    | "snapshot_created"
    | "change_detected"
    | "pipeline_triggered"
    | "text_normalized"
    | "grammar_check_started"
    | "grammar_check_finished"
    | "request_sent"
    | "response_received"
    | "issues_computed"
    | "render_issues"
    | "stale_issues_discarded"
    | "highlights_rendered"
    | "change_applied"
    | "error";

  /** Event data */
  data: {
    snapshotVersion?: number;
    textLength?: number;
    issueCount?: number;
    timeSpent?: number;
    error?: string;
    [key: string]: unknown;
  };

  /** Optional element ID for context */
  elementId?: string;
}

/**
 * Viewport information (optional, for scroll-aware features)
 */
export interface Viewport {
  scrollX: number;
  scrollY: number;
  width: number;
  height: number;
}
