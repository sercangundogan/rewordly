/**
 * Reddit Platform Adapter (New Architecture)
 *
 * Implements PlatformAdapter interface for Reddit
 * Wraps existing helper logic to maintain compatibility
 *
 * TODO: Gradually migrate helper logic into this adapter
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
  Viewport,
} from "../../core/contracts";
import {
  isEditableElement,
  getElementId,
  disableSpellCheck,
} from "../../helpers/element-helper";
import {
  displayGrammarErrors,
  clearAllGrammarErrors,
  HighlightContainerHelper,
  createHighlight as createHighlightHelper,
  attachHighlightHoverListener as attachHighlightHoverListenerHelper,
  getErrorTextRects,
  closeAllGrammarTooltips,
  validateAndRemoveInvalidHighlights,
  hideAllGrammarHighlights,
  showAllGrammarHighlights,
} from "../../helpers/highlight-helper";
import {
  extractText,
  adjustErrorPositionsForMultiWord,
} from "../../helpers/text-processing-helper";
import { getDismissKey } from "../../helpers/grammar-check-helper";
import { replaceGrammarError } from "../../helpers/text-replacement-helper";
import { GrammarError } from "../../types";

/**
 * Reddit Platform Adapter
 * Handles Reddit-specific DOM operations
 */
export class RedditPlatformAdapter implements PlatformAdapter {
  readonly platform = "reddit";

  private editableElements: Set<HTMLElement> = new Set();
  private observer: MutationObserver | null = null;
  private changeCallbacks: Set<ChangeCallback> = new Set();
  private snapshotVersion: number = 0;
  private currentElement: HTMLElement | null = null;
  private lastTextMap: Map<HTMLElement, string> = new Map(); // Track last text per element
  private versionMap: Map<HTMLElement, number> = new Map();
  private isInitialized: boolean = false; // Prevent double initialization
  private highlightHelper: HighlightContainerHelper =
    new HighlightContainerHelper();
  private grammarErrors: Map<HTMLElement, GrammarError[]> = new Map();
  private dismissedErrors: Map<string, boolean> = new Map();
  private scheduledBlurHandlers: Map<HTMLElement, number> = new Map();
  private elementPositions: Map<HTMLElement, { top: number; left: number }> =
    new Map();
  private resizeObservers: Map<HTMLElement, ResizeObserver> = new Map();
  private isCommentSearchOpen: boolean = false;

  /**
   * Check if adapter is enabled for current page
   */
  isEnabled(): boolean {
    return window.location.hostname.toLowerCase().includes("reddit.com");
  }

  /**
   * Initialize the adapter
   * STEP 4: Ensure single observer, prevent double initialization
   */
  initialize(): void {
    if (!this.isEnabled()) {
      return;
    }

    // Prevent double initialization
    if (this.isInitialized) {
      console.warn("Rewordly: Reddit adapter already initialized, skipping");
      return;
    }

    console.log("Rewordly: Reddit adapter (new architecture) initializing...");

    // Reddit-specific styles
    this.setupRedditStyles();

    // Find and attach to editable elements
    this.findAndAttachToEditableElements();

    // Set up SINGLE mutation observer for new elements
    // Ensure previous observer is cleaned up (shouldn't happen, but safety check)
    if (this.observer) {
      this.observer.disconnect();
    }

    this.observer = new MutationObserver((mutations) => {
      let shouldUpdatePositions = false;
      const currentElement =
        this.currentElement || this.getFirstEditableElement();

      // Check if comment search input is open/visible
      this.checkCommentSearchState();

      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const element = node as HTMLElement;
            this.attachToEditableElement(element);
            this.findEditableInElement(element);

            // Check if this is the comment search input or shreddit-async-loader
            if (
              element.tagName?.toLowerCase() === "pdp-comment-search-input" ||
              element.querySelector?.("pdp-comment-search-input") ||
              (element.tagName?.toLowerCase() === "shreddit-async-loader" &&
                element.getAttribute("bundlename") === "comment_composer") ||
              element.querySelector?.(
                'shreddit-async-loader[bundlename="comment_composer"]'
              )
            ) {
              this.checkCommentSearchState();
            }

            // Check if this is a toolbar or formatting element that might affect positions
            // Reddit's formatting toolbar can be detected by class names or tag names
            const isToolbarRelated =
              element.tagName?.toLowerCase().includes("toolbar") ||
              element.classList?.toString().toLowerCase().includes("toolbar") ||
              element.classList?.toString().toLowerCase().includes("format") ||
              element.querySelector?.("toolbar") ||
              element.closest?.("reddit-rte") ||
              element.closest?.("shreddit-composer") ||
              element.closest?.('[slot="toolbar"]') ||
              element.closest?.('[slot="rte-toolbar"]') ||
              element.closest?.('[slot="toolbar-additions"]') ||
              element.hasAttribute?.("data-show-formatting-bar");

            if (isToolbarRelated) {
              shouldUpdatePositions = true;
            }
          }
        });

        // Also detect text changes in editable elements
        if (
          mutation.type === "characterData" ||
          mutation.type === "childList"
        ) {
          // Check if mutation is in an editable element
          let target = mutation.target as HTMLElement;
          if (target.nodeType === Node.TEXT_NODE) {
            target = target.parentElement as HTMLElement;
          }

          let editableElement: HTMLElement | null = null;
          if (target && isEditableElement(target)) {
            editableElement = target;
          } else if (target) {
            // Check if mutation is inside an editable element
            const editableParent = target.closest(
              'textarea, [contenteditable="true"]'
            ) as HTMLElement;
            if (editableParent && isEditableElement(editableParent)) {
              editableElement = editableParent;
            }
          }

          if (editableElement) {
            this.currentElement = editableElement;

            // Immediately validate and remove invalid highlights when text changes
            if (this.grammarErrors.has(editableElement)) {
              validateAndRemoveInvalidHighlights(
                editableElement,
                this.highlightHelper.getContent(),
                this.grammarErrors,
                extractText,
                getElementId,
                false // isPerformingReplace
              );
            }

            this.notifyChange();
          }
        }

        // Check for removed nodes (e.g., comment search input being removed)
        mutation.removedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const element = node as HTMLElement;
            // Check if comment search input or shreddit-async-loader was removed
            if (
              element.tagName?.toLowerCase() === "pdp-comment-search-input" ||
              element.querySelector?.("pdp-comment-search-input") ||
              (element.tagName?.toLowerCase() === "shreddit-async-loader" &&
                element.getAttribute("bundlename") === "comment_composer") ||
              element.querySelector?.(
                'shreddit-async-loader[bundlename="comment_composer"]'
              )
            ) {
              this.checkCommentSearchState();
            }
          }
        });

        // Check for attribute changes that might affect layout (like toolbar opening)
        if (mutation.type === "attributes") {
          const target = mutation.target as HTMLElement;

          // Check if this is the comment search input or shreddit-async-loader
          if (
            target.tagName?.toLowerCase() === "pdp-comment-search-input" ||
            target.closest?.("pdp-comment-search-input") ||
            (target.tagName?.toLowerCase() === "shreddit-async-loader" &&
              target.getAttribute("bundlename") === "comment_composer") ||
            target.closest?.(
              'shreddit-async-loader[bundlename="comment_composer"]'
            )
          ) {
            // Especially check for class changes (hidden class being added/removed)
            if (mutation.attributeName === "class") {
              this.checkCommentSearchState();
            }
          }

          // Check for data-show-formatting-bar attribute change (Reddit toolbar toggle)
          if (mutation.attributeName === "data-show-formatting-bar") {
            shouldUpdatePositions = true;
          }

          // Check if this is related to toolbar or formatting
          const isToolbarRelated =
            target.tagName?.toLowerCase().includes("toolbar") ||
            target.classList?.toString().toLowerCase().includes("toolbar") ||
            target.classList?.toString().toLowerCase().includes("format") ||
            target.closest?.("reddit-rte") ||
            target.closest?.("shreddit-composer") ||
            target.closest?.('[contenteditable="true"]') ||
            target.closest?.('[slot="toolbar"]') ||
            target.closest?.('[slot="rte-toolbar"]') ||
            target.closest?.('[slot="toolbar-additions"]') ||
            target.hasAttribute?.("data-show-formatting-bar");

          if (isToolbarRelated) {
            shouldUpdatePositions = true;
          }

          // Also check for style/class changes that might affect layout
          if (
            mutation.attributeName === "style" ||
            mutation.attributeName === "class" ||
            mutation.attributeName === "hidden" ||
            mutation.attributeName === "aria-expanded"
          ) {
            // Check if this is near the editable element
            if (currentElement) {
              const isNearEditable =
                target === currentElement ||
                target.contains(currentElement) ||
                currentElement.contains(target) ||
                target.closest?.("reddit-rte") ===
                  currentElement.closest?.("reddit-rte") ||
                target.closest?.("shreddit-composer") ===
                  currentElement.closest?.("shreddit-composer");

              if (isNearEditable) {
                shouldUpdatePositions = true;
              }
            }
          }
        }
      });

      // Check if element position changed (indicates layout shift)
      // Also check parent container position for toolbar-related shifts
      if (currentElement) {
        const rect = currentElement.getBoundingClientRect();
        const lastPosition = this.elementPositions.get(currentElement);

        // Check element position
        if (lastPosition) {
          const positionChanged =
            Math.abs(rect.top - lastPosition.top) > 1 ||
            Math.abs(rect.left - lastPosition.left) > 1;

          if (positionChanged) {
            shouldUpdatePositions = true;
          }
        }

        // Also check parent container (reddit-rte or shreddit-composer) position for toolbar shifts
        const parentContainer =
          currentElement.closest("reddit-rte") ||
          currentElement.closest("shreddit-composer");
        if (parentContainer) {
          const parentRect = parentContainer.getBoundingClientRect();
          const lastParentPosition = this.elementPositions.get(
            parentContainer as HTMLElement
          );

          if (lastParentPosition) {
            const parentPositionChanged =
              Math.abs(parentRect.top - lastParentPosition.top) > 1 ||
              Math.abs(parentRect.left - lastParentPosition.left) > 1;

            if (parentPositionChanged) {
              shouldUpdatePositions = true;
            }
          }

          // Update stored parent position
          this.elementPositions.set(parentContainer as HTMLElement, {
            top: parentRect.top,
            left: parentRect.left,
          });
        }

        // Update stored position
        this.elementPositions.set(currentElement, {
          top: rect.top,
          left: rect.left,
        });
      }

      // Update highlight positions if toolbar or layout changed
      if (shouldUpdatePositions && currentElement) {
        if (this.grammarErrors.has(currentElement)) {
          const errors = this.grammarErrors.get(currentElement) || [];
          if (errors.length > 0) {
            // Use multiple requestAnimationFrame calls to ensure DOM has fully settled
            // Toolbar animations can take time
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                  this.highlightHelper.updatePositions(
                    currentElement!,
                    errors,
                    (error: GrammarError) =>
                      getErrorTextRects(currentElement!, error.start, error.end)
                  );
                });
              });
            });

            // Also schedule an additional update after a short delay
            // This catches any delayed layout changes from toolbar animations
            setTimeout(() => {
              if (this.grammarErrors.has(currentElement)) {
                const delayedErrors =
                  this.grammarErrors.get(currentElement) || [];
                if (delayedErrors.length > 0) {
                  this.highlightHelper.updatePositions(
                    currentElement!,
                    delayedErrors,
                    (error: GrammarError) =>
                      getErrorTextRects(currentElement!, error.start, error.end)
                  );
                }
              }
            }, 100);
          }
        }
      }
    });

    if (document.body) {
      this.observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [
          "contenteditable",
          "data-show-formatting-bar", // Track Reddit toolbar state
          "style",
          "class", // Track class changes (e.g., hidden class on shreddit-async-loader)
          "hidden",
          "aria-expanded",
        ],
        characterData: true, // Detect text changes
      });
    }

    // Set up ResizeObserver for editable elements to catch layout changes
    this.setupResizeObservers();

    // Set up input listeners for change detection
    this.setupInputListeners();

    // Check for existing text in editable elements and trigger initial check
    this.checkExistingTextAndNotify();

    this.isInitialized = true;
  }

  /**
   * Cleanup resources
   * STEP 4: Ensure clean unsubscribe, no memory leaks
   */
  cleanup(): void {
    // Disconnect observer
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }

    // Remove event listeners
    this.removeInputListeners();

    // Clear all callbacks (they should have been unsubscribed, but clear anyway)
    this.changeCallbacks.clear();

    // Clear element tracking
    this.editableElements.clear();
    this.versionMap.clear();
    this.lastTextMap.clear();
    this.elementPositions.clear();

    // Disconnect all ResizeObservers
    this.resizeObservers.forEach((observer) => {
      observer.disconnect();
    });
    this.resizeObservers.clear();

    // Clear grammar errors
    this.grammarErrors.clear();
    this.dismissedErrors.clear();
    this.scheduledBlurHandlers.clear();

    // Cleanup highlight helper
    this.highlightHelper.cleanup();

    // Reset state
    this.currentElement = null;
    this.isInitialized = false;
  }

  /**
   * Get current document snapshot
   * For Reddit, we track the focused element
   * STEP 4: Ensure version increments correctly on every meaningful change
   */
  getSnapshot(): DocumentSnapshot {
    const element = this.currentElement || this.getFirstEditableElement();

    if (!element) {
      return {
        text: "",
        version: this.snapshotVersion,
        meta: {
          platform: this.platform,
        },
      };
    }

    // Use extractText to get the text content
    // This ensures API positions match DOM text positions exactly
    const { text } = extractText(element);

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
        elementId: getElementId(element),
        platform: this.platform,
      },
    };
  }

  /**
   * Observe document changes
   */
  observeChanges(callback: ChangeCallback): Unsubscribe {
    this.changeCallbacks.add(callback);

    return () => {
      this.changeCallbacks.delete(callback);
    };
  }

  /**
   * Render issues on the document
   * Maps platform-agnostic issues to DOM highlights
   */
  renderIssues(issues: Issue[], _snapshotVersion: number): void {
    const element = this.currentElement || this.getFirstEditableElement();

    if (!element) {
      return;
    }

    // Convert Issue[] to GrammarError[] for existing helper
    const grammarErrorsArray: GrammarError[] = issues.map((issue) => ({
      id: issue.id,
      start: issue.start,
      end: issue.end,
      word: issue.word,
      suggestions: issue.suggestions,
      type: issue.type,
    }));

    // Create wrapper for createHighlight with all required dependencies
    const createHighlightWrapper = (
      elem: HTMLElement,
      error: GrammarError,
      index: number,
      animate: boolean
    ): void => {
      const highlightsContent = this.highlightHelper.getContent();
      createHighlightHelper(
        elem,
        error,
        index,
        highlightsContent,
        (el: HTMLElement, start: number, end: number) =>
          getErrorTextRects(el, start, end),
        extractText,
        adjustErrorPositionsForMultiWord,
        getElementId,
        (el: HTMLElement, err: GrammarError) => {
          const elementId = getElementId(el);
          const { text } = extractText(el);
          const dismissKey = getDismissKey(elementId, err, text);
          return this.dismissedErrors.get(dismissKey) === true;
        },
        attachHighlightHoverListenerWrapper,
        animate
      );
    };

    // Create wrapper for attachHighlightHoverListener with all required dependencies
    const attachHighlightHoverListenerWrapper = (
      highlight: HTMLElement,
      error: GrammarError,
      elem: HTMLElement
    ): void => {
      attachHighlightHoverListenerHelper(highlight, error, elem, {
        grammarErrors: this.grammarErrors,
        dismissedErrors: this.dismissedErrors,
        highlightsContent: this.highlightHelper.getContent(),
        replaceGrammarError: (
          el: HTMLElement,
          targetError: GrammarError,
          replacement: string
        ) => {
          replaceGrammarError(el, targetError, replacement, {
            grammarErrors: this.grammarErrors,
            highlightsContent: this.highlightHelper.getContent(),
            isPerformingReplace: { get: () => false, set: () => {} },
            highlightHelper: this.highlightHelper,
            scheduledBlurHandlers: this.scheduledBlurHandlers,
            performGrammarCheck: async () => {},
          });
        },
        closeAllGrammarTooltips,
        scheduledBlurHandlers: this.scheduledBlurHandlers,
        isPerformingDismiss: { value: false },
        getElementId,
      });
    };

    // Use existing helper to display errors
    displayGrammarErrors(element, grammarErrorsArray, {
      grammarErrors: this.grammarErrors,
      highlightHelper: this.highlightHelper,
      dismissedErrors: this.dismissedErrors,
      isErrorDismissed: (el: HTMLElement, err: GrammarError) => {
        const elementId = getElementId(el);
        const { text } = extractText(el);
        const dismissKey = getDismissKey(elementId, err, text);
        return this.dismissedErrors.get(dismissKey) === true;
      },
      createHighlight: createHighlightWrapper,
      attachHighlightHoverListener: attachHighlightHoverListenerWrapper,
      highlightsContent: this.highlightHelper.getContent(),
    });
  }

  /**
   * Apply a change to the document
   */
  applyChange(change: Change): ApplyChangeResult {
    const element = this.currentElement || this.getFirstEditableElement();

    if (!element) {
      return {
        success: false,
        newVersion: this.snapshotVersion,
        error: "No editable element available",
      };
    }

    try {
      if (change.type === "replace") {
        // Use existing helper for text replacement
        // TODO: Migrate to new system
        const grammarError: GrammarError = {
          id: "",
          start: change.range.start,
          end: change.range.end,
          word: "",
          suggestions: [change.text],
          type: "grammar",
        };

        replaceGrammarError(element, grammarError, change.text, {
          grammarErrors: new Map(),
          highlightsContent: null,
          isPerformingReplace: { get: () => false, set: () => {} },
          highlightHelper: this.highlightHelper,
          scheduledBlurHandlers: new Map(),
          performGrammarCheck: async () => {},
        });

        // Increment version
        const currentVersion = this.versionMap.get(element) || 0;
        const newVersion = currentVersion + 1;
        this.versionMap.set(element, newVersion);

        return {
          success: true,
          newVersion,
          snapshot: this.getSnapshot(),
        };
      } else if (change.type === "insert") {
        // TODO: Implement insert
        return {
          success: false,
          newVersion: this.snapshotVersion,
          error: "Insert not yet implemented",
        };
      } else if (change.type === "delete") {
        // TODO: Implement delete
        return {
          success: false,
          newVersion: this.snapshotVersion,
          error: "Delete not yet implemented",
        };
      }

      return {
        success: false,
        newVersion: this.snapshotVersion,
        error: "Unknown change type",
      };
    } catch (error) {
      return {
        success: false,
        newVersion: this.snapshotVersion,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Get current viewport
   */
  getViewport(): Viewport {
    return {
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      width: window.innerWidth,
      height: window.innerHeight,
    };
  }

  /**
   * Clear all rendered issues
   */
  clearIssues(): void {
    const element = this.currentElement || this.getFirstEditableElement();
    if (element) {
      clearAllGrammarErrors({
        grammarErrors: new Map(),
        clearGrammarErrors: () => {},
      });
    }
  }

  // Private helper methods

  private setupRedditStyles(): void {
    // Define custom element for highlights container
    if (
      typeof customElements !== "undefined" &&
      customElements &&
      !customElements.get("rewordly-highlights")
    ) {
      customElements.define(
        "rewordly-highlights",
        class extends HTMLElement {
          constructor() {
            super();
          }
        }
      );
    }

    // Add global style override
    const styleId = "rewordly-reddit-override";
    if (!document.getElementById(styleId)) {
      const style = document.createElement("style");
      style.id = styleId;
      style.textContent = `
        rewordly-highlights {
          visibility: visible !important;
        }
        /* Hide browser's default spellcheck highlights */
        [contenteditable="true"]::spelling-error,
        [contenteditable="true"]::grammar-error,
        textarea::spelling-error,
        textarea::grammar-error,
        input[type="text"]::spelling-error,
        input[type="text"]::grammar-error,
        input[type="email"]::spelling-error,
        input[type="email"]::grammar-error,
        input[type="search"]::spelling-error,
        input[type="search"]::grammar-error,
        input[type="url"]::spelling-error,
        input[type="url"]::grammar-error {
          text-decoration: none !important;
          background: none !important;
          border: none !important;
          box-shadow: none !important;
        }
        /* Also hide any spellcheck markers */
        [contenteditable="true"] mark[data-spellcheck],
        textarea mark[data-spellcheck],
        input mark[data-spellcheck] {
          display: none !important;
        }
      `;
      document.head.appendChild(style);
    }
  }

  private findAndAttachToEditableElements(): void {
    const selectors = [
      'textarea[placeholder*="What are your thoughts"]',
      'textarea[placeholder*="Add a comment"]',
      '[contenteditable="true"]',
      "textarea",
    ];

    selectors.forEach((selector) => {
      const elements = document.querySelectorAll(selector);
      elements.forEach((el) => {
        this.attachToEditableElement(el as HTMLElement);
      });
    });
  }

  private findEditableInElement(element: HTMLElement): void {
    const selectors = ["textarea", '[contenteditable="true"]'];

    selectors.forEach((selector) => {
      const children = element.querySelectorAll(selector);
      children.forEach((child) => {
        this.attachToEditableElement(child as HTMLElement);
      });
    });
  }

  private attachToEditableElement(element: HTMLElement): void {
    if (!isEditableElement(element) || this.editableElements.has(element)) {
      return;
    }

    this.editableElements.add(element);
    this.versionMap.set(element, 0);

    // Disable browser's native spellcheck
    disableSpellCheck(element);

    // Set up ResizeObserver for this element to catch layout changes
    this.setupResizeObserverForElement(element);

    console.log("Rewordly: Reddit adapter attached to element", element);
  }

  /**
   * Set up ResizeObserver for all editable elements
   */
  private setupResizeObservers(): void {
    // This will be called for each element via attachToEditableElement
  }

  /**
   * Set up ResizeObserver for a specific element to catch layout changes
   */
  private setupResizeObserverForElement(element: HTMLElement): void {
    // Remove existing observer if any
    const existingObserver = this.resizeObservers.get(element);
    if (existingObserver) {
      existingObserver.disconnect();
    }

    // Create new ResizeObserver
    const resizeObserver = new ResizeObserver(() => {
      // Element size changed, update highlight positions
      if (this.grammarErrors.has(element)) {
        const errors = this.grammarErrors.get(element) || [];
        if (errors.length > 0) {
          // Use requestAnimationFrame to ensure DOM has settled
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              this.highlightHelper.updatePositions(
                element,
                errors,
                (error: GrammarError) =>
                  getErrorTextRects(element, error.start, error.end)
              );
            });
          });
        }
      }
    });

    // Observe the element and its parent container
    resizeObserver.observe(element);

    // Also observe parent container (shreddit-composer) for toolbar-related changes
    const parentContainer =
      element.closest("reddit-rte") || element.closest("shreddit-composer");
    if (parentContainer) {
      resizeObserver.observe(parentContainer);
    }

    this.resizeObservers.set(element, resizeObserver);
  }

  private setupInputListeners(): void {
    document.addEventListener("input", this.handleInput, true);
    document.addEventListener("focusin", this.handleFocus, true);
  }

  private removeInputListeners(): void {
    document.removeEventListener("input", this.handleInput, true);
    document.removeEventListener("focusin", this.handleFocus, true);
  }

  private handleInput = (event: Event): void => {
    const element = event.target as HTMLElement;
    if (!element || !isEditableElement(element)) {
      return;
    }

    this.currentElement = element;

    // Validate and remove invalid highlights when text changes
    // This ensures highlights for changed words are removed immediately
    if (this.grammarErrors.has(element)) {
      validateAndRemoveInvalidHighlights(
        element,
        this.highlightHelper.getContent(),
        this.grammarErrors,
        extractText,
        getElementId,
        false // isPerformingReplace
      );
    }

    this.notifyChange();
  };

  /**
   * Check for existing text in editable elements and trigger initial check
   */
  private checkExistingTextAndNotify(): void {
    // Find first editable element with text
    for (const element of this.editableElements) {
      const { text } = extractText(element);
      if (text.trim().length > 0) {
        // Found element with text, set as current and notify
        this.currentElement = element;
        this.lastTextMap.set(element, text);
        // Trigger initial check by notifying change
        this.notifyChange();
        break; // Only check first element with text
      }
    }
  }

  private handleFocus = (event: Event): void => {
    const element = event.target as HTMLElement;
    if (!element || !isEditableElement(element)) {
      return;
    }

    this.currentElement = element;

    // Always trigger check on focus (even if text is empty or unchanged)
    // This ensures connection is established immediately and highlights are shown
    const { text } = extractText(element);
    // Initialize lastText for this element if not set
    if (!this.lastTextMap.has(element)) {
      this.lastTextMap.set(element, text);
    }
    // Force check on focus - even if text hasn't changed
    this.notifyChange(true); // Pass true to force notification
  };

  /**
   * Notify change callbacks when document changes
   * STEP 4: Ensure version increments on every meaningful change
   * @param force - If true, notify even if text hasn't changed (useful for focus events)
   */
  private notifyChange(force: boolean = false): void {
    const element = this.currentElement || this.getFirstEditableElement();
    if (!element) {
      return;
    }

    const { text: currentText } = extractText(element);
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
      const updatedSnapshot = this.getSnapshot();

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

  private getFirstEditableElement(): HTMLElement | null {
    if (this.editableElements.size === 0) {
      return null;
    }
    return Array.from(this.editableElements)[0] || null;
  }

  /**
   * Check if comment search input is open/visible and hide/show highlights accordingly
   * When shreddit-async-loader has 'hidden' class, comment search is open
   */
  private checkCommentSearchState(): void {
    // Check if shreddit-async-loader element with bundlename="comment_composer" has hidden class
    // When comment search is open, this element gets the 'hidden' class
    const commentComposerLoader = document.querySelector(
      'shreddit-async-loader[bundlename="comment_composer"]'
    ) as HTMLElement | null;

    const isSearchOpen =
      commentComposerLoader !== null &&
      commentComposerLoader.classList.contains("hidden");

    // Only update if state changed
    if (isSearchOpen !== this.isCommentSearchOpen) {
      this.isCommentSearchOpen = isSearchOpen;

      if (isSearchOpen) {
        // Hide highlights when search is open
        hideAllGrammarHighlights({
          highlightHelper: this.highlightHelper,
        });
      } else {
        // Show highlights when search is closed
        showAllGrammarHighlights({
          highlightHelper: this.highlightHelper,
        });
      }
    }
  }
}
