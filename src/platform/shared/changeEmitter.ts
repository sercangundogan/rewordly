/**
 * Change Emitter
 *
 * Shared utility for managing change detection, versioning, and callback management
 * across platform adapters. This class handles:
 * - Change callback registration and notification
 * - Text change tracking per element
 * - Version management per element
 * - Snapshot generation
 *
 * RULES:
 * - DOM-aware but business-logic-free (no NLP/grammar pipeline)
 * - Generic and reusable across platforms
 * - Adapters provide platform-specific text extraction and element ID functions
 */

import { DocumentSnapshot } from "../../core/contracts";
import { ChangeCallback } from "../base/PlatformAdapter";

/**
 * Function to extract text from an element
 * Returns text and source type
 */
export type ExtractTextFn = (element: HTMLElement) => {
  text: string;
  textSource: "value" | "textContent" | "innerText";
};

/**
 * Function to get a unique ID for an element
 */
export type GetElementIdFn = (element: HTMLElement) => string;

/**
 * Change Emitter
 * Manages change detection, versioning, and callback notifications
 */
export class ChangeEmitter {
  private changeCallbacks: Set<ChangeCallback> = new Set();
  private lastTextMap: Map<HTMLElement, string> = new Map();
  private versionMap: Map<HTMLElement, number> = new Map();
  private currentElement: HTMLElement | null = null;
  private platform: string;

  constructor(platform: string) {
    this.platform = platform;
  }

  /**
   * Set the current active element
   */
  setCurrentElement(element: HTMLElement | null): void {
    this.currentElement = element;
  }

  /**
   * Get the current active element
   */
  getCurrentElement(): HTMLElement | null {
    return this.currentElement;
  }

  /**
   * Observe document changes
   * Registers a callback that will be called when changes are detected
   * @returns Unsubscribe function
   */
  observeChanges(callback: ChangeCallback): () => void {
    this.changeCallbacks.add(callback);

    return () => {
      this.changeCallbacks.delete(callback);
    };
  }

  /**
   * Get a snapshot of the current document state
   * @param getElement - Function to get the element to snapshot (fallback if currentElement is null)
   * @param extractTextFn - Function to extract text from an element
   * @param getElementIdFn - Function to get element ID
   * @returns Document snapshot
   */
  getSnapshot(
    getElement: () => HTMLElement | null,
    extractTextFn: ExtractTextFn,
    getElementIdFn: GetElementIdFn
  ): DocumentSnapshot {
    const element = this.currentElement || getElement();

    if (!element) {
      return {
        text: "",
        version: 0,
        meta: {
          platform: this.platform,
        },
      };
    }

    // Extract text using platform-specific function
    const { text } = extractTextFn(element);

    // Get version from map, or initialize to 0 if not tracked
    let version = this.versionMap.get(element);
    if (version === undefined) {
      version = 0;
      this.versionMap.set(element, version);
    }

    return {
      text,
      version,
      meta: {
        elementId: getElementIdFn(element),
        platform: this.platform,
      },
    };
  }

  /**
   * Notify change callbacks when document changes
   * @param getElement - Function to get the element (fallback if currentElement is null)
   * @param extractTextFn - Function to extract text from an element
   * @param getElementIdFn - Function to get element ID
   * @param force - If true, notify even if text hasn't changed (useful for focus events)
   */
  notifyChange(
    getElement: () => HTMLElement | null,
    extractTextFn: ExtractTextFn,
    getElementIdFn: GetElementIdFn,
    force: boolean = false
  ): void {
    const element = this.currentElement || getElement();
    if (!element) {
      return;
    }

    const { text: currentText } = extractTextFn(element);
    const lastTextForElement = this.lastTextMap.get(element) || "";

    // Notify if text changed OR if forced (e.g., on focus)
    if (force || currentText !== lastTextForElement) {
      if (currentText !== lastTextForElement) {
        this.lastTextMap.set(element, currentText);
      }

      // Increment version for this element on every meaningful change
      const currentVersion = this.versionMap.get(element) || 0;
      const newVersion = currentVersion + 1;
      this.versionMap.set(element, newVersion);

      // Get updated snapshot with new version
      const updatedSnapshot = this.getSnapshot(
        getElement,
        extractTextFn,
        getElementIdFn
      );

      // Notify all callbacks (they should handle debouncing)
      // Use Array.from to avoid issues if callbacks modify the Set during iteration
      const callbacks = Array.from(this.changeCallbacks);
      callbacks.forEach((callback) => {
        try {
          callback(updatedSnapshot);
        } catch (error) {
          console.error("Rewordly: Error in change callback:", error);
        }
      });
    }
  }

  /**
   * Initialize version tracking for an element
   * Call this when attaching to a new element
   */
  initializeElement(element: HTMLElement): void {
    if (!this.versionMap.has(element)) {
      this.versionMap.set(element, 0);
    }
  }

  /**
   * Update last text for an element
   * Useful for initializing text tracking
   */
  setLastText(element: HTMLElement, text: string): void {
    this.lastTextMap.set(element, text);
  }

  /**
   * Get last text for an element
   */
  getLastText(element: HTMLElement): string | undefined {
    return this.lastTextMap.get(element);
  }

  /**
   * Increment version for an element
   * Useful when applying changes programmatically
   */
  incrementVersion(element: HTMLElement): number {
    const currentVersion = this.versionMap.get(element) || 0;
    const newVersion = currentVersion + 1;
    this.versionMap.set(element, newVersion);
    return newVersion;
  }

  /**
   * Get version for an element
   */
  getVersion(element: HTMLElement): number {
    return this.versionMap.get(element) || 0;
  }

  /**
   * Cleanup resources
   * Clears all callbacks and tracking data
   */
  cleanup(): void {
    this.changeCallbacks.clear();
    this.lastTextMap.clear();
    this.versionMap.clear();
    this.currentElement = null;
  }
}
