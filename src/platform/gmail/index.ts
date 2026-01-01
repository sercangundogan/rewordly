/**
 * Gmail Platform Adapter (TODO: Migrate)
 *
 * This adapter is NOT yet migrated to the new architecture.
 *
 * MIGRATION STEPS:
 * 1. Implement PlatformAdapter interface
 * 2. Use RedditPlatformAdapter as a template
 * 3. Wrap existing Gmail-specific helper logic initially
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
 * Gmail-specific text extraction that excludes signature
 * This function handles Gmail signature elements (.gmail_signature, .gmail_signature_prefix)
 * and should only be used for Gmail platform
 */
export function extractTextExcludingSignature(element: HTMLElement): {
  text: string;
  textSource: "value" | "textContent" | "innerText";
} {
  // Check if this is a Google Docs virtual element
  if (
    (element as any).__rewordlyIsGoogleDocs &&
    (element as any).__rewordlyGoogleDocsContainer
  ) {
    // For Google Docs, use the textContent that was set on the virtual element
    // This text was already filtered by getGoogleDocsText() function
    const text = element.textContent || element.innerText || "";
    return {
      text: text,
      textSource: "textContent",
    };
  }

  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement
  ) {
    return {
      text: element.value,
      textSource: "value",
    };
  } else if (
    element.getAttribute("contenteditable") === "true" ||
    element.isContentEditable
  ) {
    // Temporarily hide Gmail signature elements to exclude them from innerText
    // This preserves line breaks and formatting while excluding signature
    const signatureElements = element.querySelectorAll(
      '.gmail_signature, [class*="signature"], [id*="signature"]'
    );
    const signaturePrefix = element.querySelector(".gmail_signature_prefix");

    const hiddenElements: Array<{
      el: HTMLElement;
      originalDisplay: string;
    }> = [];

    // Hide signature elements
    signatureElements.forEach((sigEl) => {
      const htmlEl = sigEl as HTMLElement;
      const originalDisplay = htmlEl.style.display;
      htmlEl.style.display = "none";
      hiddenElements.push({ el: htmlEl, originalDisplay });
    });

    // Hide signature prefix
    if (signaturePrefix) {
      const htmlEl = signaturePrefix as HTMLElement;
      const originalDisplay = htmlEl.style.display;
      htmlEl.style.display = "none";
      hiddenElements.push({ el: htmlEl, originalDisplay });
    }

    // Get text with innerText (preserves line breaks from <br> and block elements)
    let text = element.innerText || element.textContent || "";

    // Restore original display styles
    hiddenElements.forEach(({ el, originalDisplay }) => {
      if (originalDisplay) {
        el.style.display = originalDisplay;
      } else {
        el.style.removeProperty("display");
      }
    });

    // Don't trim trailing whitespace - it's needed to maintain correct error positions
    // Signature exclusion is already handled by hiding signature elements above

    const textSource = "innerText";

    return { text, textSource };
  }

  // Fallback for other element types
  return {
    text: element.textContent || "",
    textSource: "textContent",
  };
}

/**
 * Gmail Platform Adapter
 * TODO: Implement PlatformAdapter interface
 */
export class GmailPlatformAdapter implements PlatformAdapter {
  readonly platform = "gmail";

  /**
   * Check if adapter is enabled for current page
   */
  isEnabled(): boolean {
    // TODO: Implement Gmail detection
    return window.location.hostname.toLowerCase().includes("mail.google.com");
  }

  /**
   * Initialize the adapter
   */
  initialize(): void {
    // TODO: Implement initialization
    // - Set up mutation observers
    // - Find and attach to editable elements (compose area)
    // - Set up input listeners
    throw new Error("Gmail adapter not yet implemented");
  }

  /**
   * Cleanup resources
   */
  cleanup(): void {
    // TODO: Implement cleanup
    throw new Error("Gmail adapter not yet implemented");
  }

  /**
   * Get current document snapshot
   */
  getSnapshot(): DocumentSnapshot {
    // TODO: Implement snapshot extraction
    // - Extract text from Gmail compose area
    // - Track version per element
    // - Return DocumentSnapshot
    throw new Error("Gmail adapter not yet implemented");
  }

  /**
   * Observe document changes
   */
  observeChanges(_callback: ChangeCallback): Unsubscribe {
    // TODO: Implement change observation
    // - Set up input/focus listeners
    // - Call callback on changes
    // - Return unsubscribe function
    throw new Error("Gmail adapter not yet implemented");
  }

  /**
   * Render issues on the document
   */
  renderIssues(_issues: Issue[], _snapshotVersion: number): void {
    // TODO: Implement issue rendering
    // - Map Issue[] to DOM highlights
    // - Use existing helper functions initially
    // - Mark with // TODO: migrate
    throw new Error("Gmail adapter not yet implemented");
  }

  /**
   * Apply a change to the document
   */
  applyChange(_change: Change): ApplyChangeResult {
    // TODO: Implement change application
    // - Map Change to DOM operations
    // - Increment version
    // - Return ApplyChangeResult
    throw new Error("Gmail adapter not yet implemented");
  }
}
