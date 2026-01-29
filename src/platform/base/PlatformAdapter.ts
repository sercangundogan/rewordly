/**
 * Platform Adapter Interface
 *
 * This interface defines the contract that all platform adapters must implement.
 * Platform adapters handle DOM-specific operations and communicate with core
 * through the contracts defined in core/contracts.ts.
 *
 * RULES:
 * - Adapters MUST NOT implement business logic (no NLP, grammar checking, etc.)
 * - Adapters handle DOM operations: selection, scrolling, event wiring
 * - All communication with core uses contracts.ts types
 * - Adapters are responsible for mapping between DOM and platform-agnostic types
 */

import {
  DocumentSnapshot,
  RangeRef,
  Issue,
  Change,
  ApplyChangeResult,
  Viewport,
} from "../../core/contracts";

/**
 * Change callback type
 * Called when the document changes (user input, programmatic changes, etc.)
 */
export type ChangeCallback = (snapshot: DocumentSnapshot) => void;

/**
 * Unsubscribe function returned by observeChanges
 */
export type Unsubscribe = () => void;

/**
 * Platform Adapter Interface
 *
 * Each platform (Reddit, Gmail, GoogleDocs, etc.) implements this interface
 * to provide platform-specific DOM operations while keeping business logic
 * in the core layer.
 */
export interface PlatformAdapter {
  /**
   * Platform identifier
   */
  readonly platform: string;

  /**
   * Check if this adapter is enabled for the current page
   */
  isEnabled(): boolean;

  /**
   * Initialize the adapter (set up observers, event listeners, etc.)
   */
  initialize(): void;

  /**
   * Cleanup resources (remove listeners, observers, etc.)
   */
  cleanup(): void;

  /**
   * Get current document snapshot
   * Returns a snapshot of the current document state
   */
  getSnapshot(): DocumentSnapshot | Promise<DocumentSnapshot>;

  /**
   * Observe document changes
   * Calls the callback whenever the document changes
   * Returns an unsubscribe function
   */
  observeChanges(callback: ChangeCallback): Unsubscribe;

  /**
   * Render issues on the document
   * Maps platform-agnostic issues to DOM highlights/overlays
   *
   * @param issues - Issues to render
   * @param snapshotVersion - Version of snapshot these issues are for
   */
  renderIssues(issues: Issue[], snapshotVersion: number): void;

  /**
   * Apply a change to the document
   * Maps platform-agnostic change operations to DOM modifications
   *
   * @param change - Change to apply
   * @returns Result of applying the change
   */
  applyChange(change: Change): ApplyChangeResult | Promise<ApplyChangeResult>;

  /**
   * Get current viewport information (optional)
   * Used for scroll-aware features
   */
  getViewport?(): Viewport;

  /**
   * Scroll to a specific range (optional)
   * Used for navigation features
   */
  scrollToRange?(range: RangeRef): void;

  /**
   * Clear all rendered issues (optional)
   * Used for cleanup or when disabling highlights
   */
  clearIssues?(): void;
}



