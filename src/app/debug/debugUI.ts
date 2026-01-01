/**
 * Debug UI
 * Minimal debug interface for pipeline observability
 *
 * Press Ctrl+Shift+D (or Cmd+Shift+D on Mac) to toggle debug panel
 */

import { globalEventBuffer } from "./eventBuffer";
import { DebugEvent } from "../../core/contracts";

/**
 * Debug UI Panel
 */
export class DebugUI {
  private panel: HTMLElement | null = null;
  private isVisible: boolean = false;
  private updateInterval: number | null = null;

  /**
   * Initialize debug UI
   */
  init(): void {
    // Listen for keyboard shortcut
    document.addEventListener("keydown", (event) => {
      // Ctrl+Shift+D or Cmd+Shift+D
      if (
        (event.ctrlKey || event.metaKey) &&
        event.shiftKey &&
        event.key === "D"
      ) {
        event.preventDefault();
        this.toggle();
      }
    });

    console.log(
      "Rewordly Debug UI: Press Ctrl+Shift+D (or Cmd+Shift+D) to toggle debug panel"
    );
  }

  /**
   * Toggle debug panel visibility
   */
  toggle(): void {
    if (this.isVisible) {
      this.hide();
    } else {
      this.show();
    }
  }

  /**
   * Show debug panel
   */
  show(): void {
    if (this.panel) {
      this.panel.style.display = "block";
      this.isVisible = true;
      this.startAutoUpdate();
      return;
    }

    // Create panel
    this.panel = document.createElement("div");
    this.panel.id = "rewordly-debug-panel";
    this.panel.style.cssText = `
      position: fixed;
      top: 10px;
      right: 10px;
      width: 400px;
      max-height: 600px;
      background: #1e1e1e;
      color: #d4d4d4;
      font-family: 'Courier New', monospace;
      font-size: 12px;
      padding: 10px;
      border: 1px solid #3e3e3e;
      border-radius: 4px;
      z-index: 999999;
      overflow-y: auto;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.3);
    `;

    // Create header
    const header = document.createElement("div");
    header.style.cssText = `
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
      padding-bottom: 10px;
      border-bottom: 1px solid #3e3e3e;
    `;

    const title = document.createElement("div");
    title.textContent = "Rewordly Debug Panel";
    title.style.cssText = "font-weight: bold; font-size: 14px;";

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "×";
    closeBtn.style.cssText = `
      background: transparent;
      border: none;
      color: #d4d4d4;
      font-size: 20px;
      cursor: pointer;
      padding: 0 5px;
    `;
    closeBtn.onclick = () => this.hide();

    header.appendChild(title);
    header.appendChild(closeBtn);
    this.panel.appendChild(header);

    // Create content area
    const content = document.createElement("div");
    content.id = "rewordly-debug-content";
    this.panel.appendChild(content);

    document.body.appendChild(this.panel);
    this.isVisible = true;
    this.startAutoUpdate();
  }

  /**
   * Hide debug panel
   */
  hide(): void {
    if (this.panel) {
      this.panel.style.display = "none";
      this.isVisible = false;
      this.stopAutoUpdate();
    }
  }

  /**
   * Start auto-update
   */
  private startAutoUpdate(): void {
    this.update();
    this.updateInterval = window.setInterval(() => {
      this.update();
    }, 1000);
  }

  /**
   * Stop auto-update
   */
  private stopAutoUpdate(): void {
    if (this.updateInterval !== null) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }

  /**
   * Update panel content
   * STEP 5: Show snapshot.version, issue counts, stale discards
   */
  private update(): void {
    if (!this.panel || !this.isVisible) {
      return;
    }

    const content = this.panel.querySelector("#rewordly-debug-content");
    if (!content) {
      return;
    }

    const stats = globalEventBuffer.getStats();
    const recentEvents = globalEventBuffer.getLast(20); // Show more events

    // Get latest snapshot version and issue counts
    const latestSnapshot = this.getLatestSnapshotInfo(recentEvents);
    const staleCount = this.getStaleDiscardCount(recentEvents);
    const issueCounts = this.getIssueCountsByVersion(recentEvents);

    // Build HTML
    let html = "";

    // Current State (STEP 5: Show snapshot.version live)
    html +=
      '<div style="margin-bottom: 15px; padding: 10px; background: #2a2a2a; border-radius: 4px;">';
    html +=
      '<div style="font-weight: bold; margin-bottom: 8px; color: #4ec9b0;">Current State</div>';
    if (latestSnapshot) {
      html += `<div>Current Snapshot Version: <strong style="color: #569cd6;">${latestSnapshot.version}</strong></div>`;
      html += `<div>Text Length: ${latestSnapshot.textLength}</div>`;
      if (latestSnapshot.issueCount !== undefined) {
        html += `<div>Issues Found: <strong style="color: ${
          latestSnapshot.issueCount > 0 ? "#f48771" : "#4ec9b0"
        }">${latestSnapshot.issueCount}</strong></div>`;
      }
    } else {
      html += '<div style="color: #888;">No snapshot yet</div>';
    }
    if (staleCount > 0) {
      html += `<div style="color: #ce9178; margin-top: 5px;">Stale Results Discarded: <strong>${staleCount}</strong></div>`;
    }
    html += "</div>";

    // Statistics
    html += '<div style="margin-bottom: 15px;">';
    html +=
      '<div style="font-weight: bold; margin-bottom: 5px;">Statistics</div>';
    html += `<div>Total Events: ${stats.totalEvents}</div>`;
    html += `<div>Average Time: ${stats.averageTimeSpent.toFixed(2)}ms</div>`;
    html +=
      '<div style="margin-top: 5px; font-weight: bold;">Events by Stage:</div>';
    for (const [stage, count] of Object.entries(stats.eventsByStage)) {
      html += `<div style="margin-left: 10px;">${stage}: ${count}</div>`;
    }
    html += "</div>";

    // Issue Counts by Version (STEP 5: Show issue count per snapshot)
    if (issueCounts.size > 0) {
      html += '<div style="margin-bottom: 15px;">';
      html +=
        '<div style="font-weight: bold; margin-bottom: 5px;">Issues by Version</div>';
      const sortedVersions = Array.from(issueCounts.entries())
        .sort((a, b) => b[0] - a[0])
        .slice(0, 5);
      for (const [version, count] of sortedVersions) {
        html += `<div style="margin-left: 10px;">v${version}: <strong>${count}</strong> issues</div>`;
      }
      html += "</div>";
    }

    // Recent events (STEP 5: Trace full pipeline execution)
    html += "<div>";
    html +=
      '<div style="font-weight: bold; margin-bottom: 5px;">Recent Events (Chronological)</div>';
    if (recentEvents.length === 0) {
      html += '<div style="color: #888;">No events yet</div>';
    } else {
      // Show in chronological order (oldest first)
      for (const event of recentEvents) {
        html += this.formatEvent(event);
      }
    }
    html += "</div>";

    content.innerHTML = html;
  }

  /**
   * Get latest snapshot information
   */
  private getLatestSnapshotInfo(
    events: DebugEvent[]
  ): { version: number; textLength: number; issueCount?: number } | null {
    // Find the most recent snapshot_created event
    const snapshotEvents = events.filter((e) => e.stage === "snapshot_created");
    if (snapshotEvents.length === 0) {
      return null;
    }

    const latest = snapshotEvents[snapshotEvents.length - 1];
    if (!latest) {
      return null;
    }

    const version = latest.data.snapshotVersion as number | undefined;
    const textLength = latest.data.textLength as number | undefined;

    if (version === undefined || textLength === undefined) {
      return null;
    }

    // Find issue count for this version
    const issueEvents = events.filter(
      (e) => e.stage === "grammar_check_finished" || e.stage === "render_issues"
    );
    const versionIssueEvent = issueEvents.find(
      (e) => e.data.snapshotVersion === version
    );
    const issueCount = versionIssueEvent?.data.issueCount as number | undefined;

    const result: { version: number; textLength: number; issueCount?: number } =
      {
        version,
        textLength,
      };
    if (issueCount !== undefined) {
      result.issueCount = issueCount;
    }
    return result;
  }

  /**
   * Get total count of stale results discarded
   */
  private getStaleDiscardCount(events: DebugEvent[]): number {
    const staleEvents = events.filter(
      (e) => e.stage === "stale_issues_discarded"
    );
    let total = 0;
    for (const event of staleEvents) {
      const count = event.data.issueCount as number | undefined;
      if (count !== undefined) {
        total += count;
      }
    }
    return total;
  }

  /**
   * Get issue counts grouped by snapshot version
   */
  private getIssueCountsByVersion(events: DebugEvent[]): Map<number, number> {
    const counts = new Map<number, number>();
    const issueEvents = events.filter(
      (e) => e.stage === "grammar_check_finished" || e.stage === "render_issues"
    );

    for (const event of issueEvents) {
      const version = event.data.snapshotVersion as number | undefined;
      const count = event.data.issueCount as number | undefined;
      if (version !== undefined && count !== undefined) {
        counts.set(version, count);
      }
    }

    return counts;
  }

  /**
   * Format a debug event for display
   * STEP 5: Enhanced formatting with more details
   */
  private formatEvent(event: DebugEvent): string {
    const time = new Date(event.timestamp).toLocaleTimeString();
    const stageColor = this.getStageColor(event.stage);

    let html = `<div style="margin-bottom: 5px; padding: 5px; background: #2a2a2a; border-radius: 2px; border-left: 3px solid ${stageColor};">`;
    html += `<div style="color: ${stageColor}; font-weight: bold;">[${time}] ${event.stage}</div>`;

    if (event.data.snapshotVersion !== undefined) {
      html += `<div style="margin-left: 10px; font-size: 11px; color: #569cd6;">Version: <strong>${event.data.snapshotVersion}</strong></div>`;
    }
    if (event.data.textLength !== undefined) {
      html += `<div style="margin-left: 10px; font-size: 11px;">Text Length: ${event.data.textLength}</div>`;
    }
    if (event.data.issueCount !== undefined) {
      const count = event.data.issueCount as number;
      const color = count > 0 ? "#f48771" : "#4ec9b0";
      html += `<div style="margin-left: 10px; font-size: 11px; color: ${color};">Issues: <strong>${count}</strong></div>`;
    }
    if (event.data["validIssueCount"] !== undefined) {
      html += `<div style="margin-left: 10px; font-size: 11px; color: #4ec9b0;">Valid Issues: ${event.data["validIssueCount"]}</div>`;
    }
    if (event.data["totalDiscarded"] !== undefined) {
      html += `<div style="margin-left: 10px; font-size: 11px; color: #ce9178;">Total Discarded: ${event.data["totalDiscarded"]}</div>`;
    }
    if (event.data["currentVersion"] !== undefined) {
      html += `<div style="margin-left: 10px; font-size: 11px; color: #888;">Current Version: ${event.data["currentVersion"]}</div>`;
    }
    if (event.data.timeSpent !== undefined) {
      html += `<div style="margin-left: 10px; font-size: 11px; color: #888;">Time: ${event.data.timeSpent.toFixed(
        2
      )}ms</div>`;
    }
    if (event.data.error) {
      html += `<div style="margin-left: 10px; font-size: 11px; color: #f48771;">Error: ${event.data.error}</div>`;
    }
    if (event.elementId) {
      html += `<div style="margin-left: 10px; font-size: 11px; color: #888;">Element: ${event.elementId}</div>`;
    }

    html += "</div>";
    return html;
  }

  /**
   * Get color for a stage
   * STEP 5: Add colors for new stages
   */
  private getStageColor(stage: DebugEvent["stage"]): string {
    switch (stage) {
      case "snapshot_created":
        return "#4ec9b0";
      case "change_detected":
        return "#569cd6";
      case "pipeline_triggered":
        return "#dcdcaa";
      case "text_normalized":
        return "#b5cea8";
      case "grammar_check_started":
        return "#d7ba7d";
      case "grammar_check_finished":
        return "#ce9178";
      case "issues_computed":
        return "#ce9178";
      case "render_issues":
        return "#9cdcfe";
      case "stale_issues_discarded":
        return "#f48771";
      case "highlights_rendered":
        return "#9cdcfe";
      case "error":
        return "#f48771";
      default:
        return "#d4d4d4";
    }
  }
}

/**
 * Global debug UI instance
 */
export const globalDebugUI = new DebugUI();
