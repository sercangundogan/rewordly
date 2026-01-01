/**
 * Google Docs Platform Adapter (TODO: Migrate)
 *
 * This adapter is NOT yet migrated to the new architecture.
 *
 * MIGRATION STEPS:
 * 1. Implement PlatformAdapter interface
 * 2. Use RedditPlatformAdapter as a template
 * 3. Wrap existing GoogleDocs-specific helper logic initially
 * 4. Gradually migrate helper logic into this adapter
 * 5. Test with orchestrator
 * 6. Remove old adapter code from src/adapters/
 *
 * REFERENCE:
 * - See src/platform/reddit/index.ts for implementation example
 * - See ARCHITECTURE.md for migration guide
 */

import {
  PlatformAdapter,
  ChangeCallback,
  Unsubscribe,
} from "../base/PlatformAdapter";
import {
  DocumentSnapshot,
  Issue,
  Change,
  ApplyChangeResult,
} from "../../core/contracts";

/**
 * Google Docs Platform Adapter
 * TODO: Implement PlatformAdapter interface
 */
export class GoogleDocsPlatformAdapter implements PlatformAdapter {
  readonly platform = "google-docs";

  /**
   * Check if adapter is enabled for current page
   */
  isEnabled(): boolean {
    // TODO: Implement Google Docs detection
    return window.location.hostname.toLowerCase().includes("docs.google.com");
  }

  /**
   * Initialize the adapter
   */
  initialize(): void {
    // TODO: Implement initialization
    // - Set up mutation observers
    // - Find and attach to editable elements (document body)
    // - Set up input listeners
    throw new Error("GoogleDocs adapter not yet implemented");
  }

  /**
   * Cleanup resources
   */
  cleanup(): void {
    // TODO: Implement cleanup
    throw new Error("GoogleDocs adapter not yet implemented");
  }

  /**
   * Get current document snapshot
   */
  getSnapshot(): DocumentSnapshot {
    // TODO: Implement snapshot extraction
    // - Extract text from Google Docs editor
    // - Track version per element
    // - Return DocumentSnapshot
    throw new Error("GoogleDocs adapter not yet implemented");
  }

  /**
   * Observe document changes
   */
  observeChanges(_callback: ChangeCallback): Unsubscribe {
    // TODO: Implement change observation
    // - Set up input/focus listeners
    // - Call callback on changes
    // - Return unsubscribe function
    throw new Error("GoogleDocs adapter not yet implemented");
  }

  /**
   * Render issues on the document
   */
  renderIssues(_issues: Issue[], _snapshotVersion: number): void {
    // TODO: Implement issue rendering
    // - Map Issue[] to DOM highlights
    // - Use existing helper functions initially
    // - Mark with // TODO: migrate
    throw new Error("GoogleDocs adapter not yet implemented");
  }

  /**
   * Apply a change to the document
   */
  applyChange(_change: Change): ApplyChangeResult {
    // TODO: Implement change application
    // - Map Change to DOM operations
    // - Increment version
    // - Return ApplyChangeResult
    throw new Error("GoogleDocs adapter not yet implemented");
  }
}
