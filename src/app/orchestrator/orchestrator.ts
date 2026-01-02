/**
 * Orchestrator
 *
 * Coordinates platform adapters and core pipeline
 *
 * Responsibilities:
 * - Wires adapter.observeChanges to debounced pipeline
 * - Calls adapter.getSnapshot()
 * - Calls core pipeline to produce issues (stub for now)
 * - Calls adapter.renderIssues()
 * - Emits DebugEvents into ring buffer
 *
 * RULES:
 * - No DOM operations here (delegated to adapters)
 * - No business logic here (delegated to core)
 * - Pure orchestration and coordination
 */

import {
  PlatformAdapter,
  Unsubscribe,
} from "../../platform/base/PlatformAdapter";
import { DocumentSnapshot, Issue, DebugEvent } from "../../core/contracts";
import { globalEventBuffer } from "../debug/eventBuffer";
import { removeInvisibleCharacters } from "../../core/text";
import {
  HighlightAnchor,
  remapAnchors,
  mergeAnchorsWithIssues,
  anchorsToIssues,
} from "../../core/highlights/anchors";

/**
 * Options for creating an orchestrator
 */
export interface OrchestratorOptions {
  /** Debounce delay in milliseconds for change detection */
  debounceMs?: number;

  /** Minimum text length to trigger grammar check */
  minTextLength?: number;

  /** Grammar check function (stub for now, will be replaced with core pipeline) */
  checkGrammar?: (snapshot: DocumentSnapshot) => Promise<Issue[]>;
}

/**
 * Orchestrator class
 * Coordinates adapter and core pipeline
 */
export class Orchestrator {
  private adapter: PlatformAdapter;
  private unsubscribe: Unsubscribe | null = null;
  private debounceTimeout: number | null = null;
  private lastSnapshotVersion: number = -1;
  private isProcessing: boolean = false;
  private staleDiscardCount: number = 0; // Track how many stale results were discarded

  // Anchor state for highlight stability
  private lastSnapshotText: string = "";
  private currentAnchors: Map<string, HighlightAnchor> = new Map();

  private readonly debounceMs: number;
  private readonly minTextLength: number;
  private readonly checkGrammar: (
    snapshot: DocumentSnapshot
  ) => Promise<Issue[]>;

  constructor(adapter: PlatformAdapter, options: OrchestratorOptions = {}) {
    this.adapter = adapter;
    this.debounceMs = options.debounceMs ?? 300;
    this.minTextLength = options.minTextLength ?? 3;

    // Stub grammar check function - will be replaced with core pipeline
    this.checkGrammar = options.checkGrammar ?? this.defaultGrammarCheck;
  }

  /**
   * Start the orchestrator
   * Sets up change observation and initial check
   */
  async start(): Promise<void> {
    // Emit debug event
    this.emitDebugEvent("pipeline_triggered", {
      message: "Orchestrator started",
    });

    // Set up change observation
    this.unsubscribe = this.adapter.observeChanges((snapshot) => {
      this.handleChange(snapshot);
    });

    // Perform initial check
    try {
      const snapshot = await this.adapter.getSnapshot();
      await this.handleChange(snapshot);
    } catch (error) {
      this.emitDebugEvent("error", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Stop the orchestrator
   */
  stop(): void {
    if (this.debounceTimeout !== null) {
      clearTimeout(this.debounceTimeout);
      this.debounceTimeout = null;
    }

    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }

    this.emitDebugEvent("pipeline_triggered", {
      message: "Orchestrator stopped",
    });
  }

  /**
   * Handle document change
   * Debounced to avoid excessive grammar checks
   * STEP 3: Remap anchors immediately on change (before grammar check)
   */
  private handleChange(snapshot: DocumentSnapshot): void {
    // Skip if already processing
    if (this.isProcessing) {
      return;
    }

    // Skip if version hasn't changed
    if (snapshot.version === this.lastSnapshotVersion) {
      return;
    }

    // Clear previous debounce timeout
    if (this.debounceTimeout !== null) {
      clearTimeout(this.debounceTimeout);
    }

    // Emit change detected event
    this.emitDebugEvent("change_detected", {
      snapshotVersion: snapshot.version,
      textLength: snapshot.text.length,
    });

    // STEP 3: Remap anchors immediately if we have existing anchors and text changed
    if (
      this.currentAnchors.size > 0 &&
      this.lastSnapshotText !== snapshot.text
    ) {
      const cleanedText = removeInvisibleCharacters(snapshot.text);
      const cleanedLastText = removeInvisibleCharacters(this.lastSnapshotText);

      if (cleanedLastText !== cleanedText) {
        // Remap anchors to new text positions
        const remapResult = remapAnchors(
          cleanedLastText,
          cleanedText,
          this.currentAnchors
        );

        // Update last snapshot text
        this.lastSnapshotText = cleanedText;

        // Emit remapping debug event
        this.emitDebugEvent("anchors_remapped", {
          snapshotVersion: snapshot.version,
          kept: remapResult.kept.length,
          updated: remapResult.updated.length,
          removed: remapResult.removed.length,
          contextRelocated: remapResult.contextRelocated,
        });

        // Remove invalidated anchors
        for (const removed of remapResult.removed) {
          this.currentAnchors.delete(removed.id);
        }

        // If we have valid anchors after remapping, render them immediately
        // This provides instant feedback while grammar check is in progress
        if (this.currentAnchors.size > 0) {
          const remappedIssues = anchorsToIssues(
            this.currentAnchors,
            snapshot.version
          );

          if (remappedIssues.length > 0) {
            this.adapter.renderIssues(remappedIssues, snapshot.version);

            this.emitDebugEvent("highlights_rendered", {
              snapshotVersion: snapshot.version,
              issueCount: remappedIssues.length,
              source: "anchor_remap",
            });
          }
        } else {
          // All anchors were invalidated
          this.emitDebugEvent("anchors_invalidated", {
            snapshotVersion: snapshot.version,
            count: remapResult.removed.length,
          });
        }
      }
    } else if (this.lastSnapshotText === "") {
      // First snapshot - initialize
      this.lastSnapshotText = removeInvisibleCharacters(snapshot.text);
    }

    // Debounce the grammar check
    this.debounceTimeout = window.setTimeout(() => {
      this.processSnapshot(snapshot);
    }, this.debounceMs);
  }

  /**
   * Process a snapshot through the pipeline
   * STEP 2: Add stale result protection
   */
  private async processSnapshot(snapshot: DocumentSnapshot): Promise<void> {
    if (this.isProcessing) {
      return;
    }

    this.isProcessing = true;
    const startTime = performance.now();

    try {
      // Emit snapshot created event
      this.emitDebugEvent("snapshot_created", {
        snapshotVersion: snapshot.version,
        textLength: snapshot.text.length,
      });

      // Skip if text is too short
      if (snapshot.text.trim().length < this.minTextLength) {
        this.isProcessing = false;
        return;
      }

      // STEP 3: Minimal text cleaning (only invisible characters)
      // Keep newlines and whitespace as-is so positions match DOM text
      // LanguageTool API supports newlines, so we don't need to normalize them
      const cleanedText = removeInvisibleCharacters(snapshot.text);
      const cleanedSnapshot: DocumentSnapshot = {
        ...snapshot,
        text: cleanedText,
      };

      // Update last snapshot text if not already updated in handleChange
      if (this.lastSnapshotText !== cleanedText) {
        this.lastSnapshotText = cleanedText;
      }

      // Emit grammar check started event
      this.emitDebugEvent("grammar_check_started", {
        snapshotVersion: snapshot.version,
        textLength: cleanedText.length,
      });

      // Call grammar check with cleaned snapshot
      // All offsets in returned issues are relative to cleaned text (which matches DOM text)
      const issues = await this.checkGrammar(cleanedSnapshot);

      const timeSpent = performance.now() - startTime;

      // STALE RESULT PROTECTION: Check if snapshot version is still current
      const currentSnapshot = await this.adapter.getSnapshot();
      if (currentSnapshot.version !== snapshot.version) {
        // Snapshot has changed, discard stale results
        this.staleDiscardCount++;
        this.emitDebugEvent("stale_issues_discarded", {
          snapshotVersion: snapshot.version,
          currentVersion: currentSnapshot.version,
          issueCount: issues.length,
          timeSpent,
          totalDiscarded: this.staleDiscardCount,
        });
        this.isProcessing = false;
        return;
      }

      // Filter out issues that don't match current snapshot version
      const validIssues = issues.filter(
        (issue) => issue.snapshotVersion === snapshot.version
      );
      const staleIssues = issues.length - validIssues.length;

      if (staleIssues > 0) {
        this.staleDiscardCount += staleIssues;
        this.emitDebugEvent("stale_issues_discarded", {
          snapshotVersion: snapshot.version,
          issueCount: staleIssues,
          validIssueCount: validIssues.length,
          totalDiscarded: this.staleDiscardCount,
        });
      }

      // Emit grammar check finished event
      this.emitDebugEvent("grammar_check_finished", {
        snapshotVersion: snapshot.version,
        issueCount: validIssues.length,
        timeSpent,
      });

      // STEP 3: Merge new issues with existing anchors
      // This updates existing anchors and creates new ones
      mergeAnchorsWithIssues(
        this.currentAnchors,
        validIssues,
        cleanedText,
        snapshot.version
      );

      // Convert anchors to issues for rendering
      const finalIssues = anchorsToIssues(
        this.currentAnchors,
        snapshot.version
      );

      // Render final set of issues (includes remapped + new)
      if (finalIssues.length > 0) {
        this.adapter.renderIssues(finalIssues, snapshot.version);

        // Emit render issues event
        this.emitDebugEvent("render_issues", {
          snapshotVersion: snapshot.version,
          issueCount: finalIssues.length,
        });
      }

      this.lastSnapshotVersion = snapshot.version;
    } catch (error) {
      const timeSpent = performance.now() - startTime;
      this.emitDebugEvent("error", {
        error: error instanceof Error ? error.message : String(error),
        timeSpent,
        snapshotVersion: snapshot.version,
      });
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Default grammar check stub
   * Returns empty array - will be replaced with core pipeline
   */
  private async defaultGrammarCheck(
    _snapshot: DocumentSnapshot
  ): Promise<Issue[]> {
    // Stub implementation - returns empty array
    // This will be replaced with the actual core pipeline
    return [];
  }

  /**
   * Emit a debug event
   */
  private emitDebugEvent(
    stage: DebugEvent["stage"],
    data: DebugEvent["data"],
    elementId?: string
  ): void {
    const event: DebugEvent = {
      timestamp: Date.now(),
      stage,
      data,
      ...(elementId !== undefined && { elementId }),
    };

    globalEventBuffer.add(event);
  }

  /**
   * Manually trigger a grammar check
   * Useful for testing or manual triggers
   */
  async triggerCheck(): Promise<void> {
    try {
      const snapshot = await this.adapter.getSnapshot();
      await this.processSnapshot(snapshot);
    } catch (error) {
      this.emitDebugEvent("error", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
