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
import { ChangeEmitter } from "../shared/changeEmitter";

/**
 * Reddit Platform Adapter
 * Handles Reddit-specific DOM operations
 */
export class RedditPlatformAdapter implements PlatformAdapter {
  readonly platform = "reddit";

  private editableElements: Set<HTMLElement> = new Set();
  private observer: MutationObserver | null = null;
  private changeEmitter: ChangeEmitter;
  private currentElement: HTMLElement | null = null;
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
  private isPerformingReplace: boolean = false; // Flag to track replace operations
  private currentUrl: string = "";
  private urlCheckInterval: number | null = null;

  constructor() {
    this.changeEmitter = new ChangeEmitter(this.platform);
  }

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
            this.changeEmitter.setCurrentElement(editableElement);

            // STEP 4: Skip aggressive validation - anchor system handles remapping
            // The orchestrator will remap anchors immediately on change, so we don't need
            // to validate and remove highlights here. This prevents highlights from
            // disappearing before the anchor remapping happens.
            // validateAndRemoveInvalidHighlights is now only called during replace operations
            // where it's needed to prevent stale highlights.

            this.changeEmitter.notifyChange(
              () => this.getFirstEditableElement(),
              extractText,
              getElementId
            );
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
              // Directly check if hidden class is present and hide/show highlights immediately
              const isHidden = target.classList.contains("hidden");
              if (isHidden && !this.isCommentSearchOpen) {
                // Search just opened - hide highlights immediately
                this.isCommentSearchOpen = true;
                hideAllGrammarHighlights({
                  highlightHelper: this.highlightHelper,
                });
              } else if (!isHidden && this.isCommentSearchOpen) {
                // Search just closed - show highlights immediately
                this.isCommentSearchOpen = false;
                showAllGrammarHighlights({
                  highlightHelper: this.highlightHelper,
                });
              } else {
                // Fallback to full state check
                this.checkCommentSearchState();
              }
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
            // Check if this is related to comment search (check state when hidden/class changes)
            if (
              target.tagName?.toLowerCase() === "pdp-comment-search-input" ||
              target.closest?.("pdp-comment-search-input") ||
              (target.tagName?.toLowerCase() === "shreddit-async-loader" &&
                target.getAttribute("bundlename") === "comment_composer") ||
              target.closest?.(
                'shreddit-async-loader[bundlename="comment_composer"]'
              )
            ) {
              // Directly check if hidden class is present for shreddit-async-loader
              if (
                target.tagName?.toLowerCase() === "shreddit-async-loader" &&
                target.getAttribute("bundlename") === "comment_composer"
              ) {
                const isHidden = target.classList.contains("hidden");
                if (isHidden && !this.isCommentSearchOpen) {
                  // Search just opened - hide highlights immediately
                  this.isCommentSearchOpen = true;
                  hideAllGrammarHighlights({
                    highlightHelper: this.highlightHelper,
                  });
                } else if (!isHidden && this.isCommentSearchOpen) {
                  // Search just closed - show highlights immediately
                  this.isCommentSearchOpen = false;
                  showAllGrammarHighlights({
                    highlightHelper: this.highlightHelper,
                  });
                }
              } else {
                // Fallback to full state check for other elements
                this.checkCommentSearchState();
              }
            }

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

    // Set up URL change detection for SPA navigation
    this.setupUrlChangeDetection();

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

    // Remove URL change detection
    this.removeUrlChangeDetection();

    // Cleanup change emitter
    this.changeEmitter.cleanup();

    // Clear element tracking
    this.editableElements.clear();
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
    this.changeEmitter.setCurrentElement(null);
    this.isInitialized = false;
    this.currentUrl = "";
  }

  /**
   * Get current document snapshot
   * For Reddit, we track the focused element
   * STEP 4: Ensure version increments correctly on every meaningful change
   */
  getSnapshot(): DocumentSnapshot {
    return this.changeEmitter.getSnapshot(
      () => this.getFirstEditableElement(),
      extractText,
      getElementId
    );
  }

  /**
   * Observe document changes
   */
  observeChanges(callback: ChangeCallback): Unsubscribe {
    return this.changeEmitter.observeChanges(callback);
  }

  /**
   * Render issues on the document
   * Maps platform-agnostic issues to DOM highlights
   *
   * STEP 4: With anchor system, issues already have remapped positions.
   * The displayGrammarErrors function will reuse existing highlights by issue.id
   * and update their positions instead of recreating them.
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
            isPerformingReplace: {
              get: () => this.isPerformingReplace,
              set: (value: boolean) => {
                this.isPerformingReplace = value;
              },
            },
            highlightHelper: this.highlightHelper,
            scheduledBlurHandlers: this.scheduledBlurHandlers,
            performGrammarCheck: async () => {
              // Grammar check will be triggered after replace is complete
            },
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
      isPerformingReplace: this.isPerformingReplace,
    });
  }

  /**
   * Apply a change to the document
   */
  applyChange(change: Change): ApplyChangeResult {
    const element = this.currentElement || this.getFirstEditableElement();

    if (!element) {
      const version = 0;

      return {
        success: false,
        newVersion: version,
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

        // Set flag to prevent highlight validation during replace
        this.isPerformingReplace = true;

        replaceGrammarError(element, grammarError, change.text, {
          grammarErrors: this.grammarErrors,
          highlightsContent: this.highlightHelper.getContent(),
          isPerformingReplace: {
            get: () => this.isPerformingReplace,
            set: (value: boolean) => {
              this.isPerformingReplace = value;
            },
          },
          highlightHelper: this.highlightHelper,
          scheduledBlurHandlers: this.scheduledBlurHandlers,
          performGrammarCheck: async () => {
            // Grammar check will be triggered after replace is complete
          },
        });

        // Increment version
        const newVersion = this.changeEmitter.incrementVersion(element);

        return {
          success: true,
          newVersion,
          snapshot: this.getSnapshot(),
        };
      } else if (change.type === "insert") {
        // TODO: Implement insert
        const version = this.changeEmitter.getVersion(element);
        return {
          success: false,
          newVersion: version,
          error: "Insert not yet implemented",
        };
      } else if (change.type === "delete") {
        // TODO: Implement delete
        const version = this.changeEmitter.getVersion(element);
        return {
          success: false,
          newVersion: version,
          error: "Delete not yet implemented",
        };
      }

      const version = this.changeEmitter.getVersion(element);
      return {
        success: false,
        newVersion: version,
        error: "Unknown change type",
      };
    } catch (error) {
      const element = this.currentElement || this.getFirstEditableElement();
      const version = element ? this.changeEmitter.getVersion(element) : 0;

      return {
        success: false,
        newVersion: version,
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
    // Clear all highlights from the highlight helper
    const highlightsContent = this.highlightHelper.getContent();
    if (highlightsContent) {
      const allHighlights =
        highlightsContent.querySelectorAll("[data-element-id]");
      allHighlights.forEach((highlight) => {
        highlight.remove();
      });
    }

    // Clear all grammar errors
    this.grammarErrors.clear();
    this.dismissedErrors.clear();

    // Clear tracked elements in highlight helper
    this.highlightHelper.cleanup();
    // Recreate the highlight helper container
    this.highlightHelper = new HighlightContainerHelper();
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
    this.changeEmitter.initializeElement(element);

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

    // Ignore programmatic input events (triggered by replace operations)
    if ((event as any).__rewordlyProgrammatic) {
      return;
    }

    // Don't validate highlights during replace operations
    if (this.isPerformingReplace) {
      return;
    }

    this.currentElement = element;
    this.changeEmitter.setCurrentElement(element);

    // Get current and previous text to detect changes
    const { text: currentText } = extractText(element);
    const previousText = this.changeEmitter.getLastText(element) || "";

    // If text changed and we have errors, update their positions
    if (currentText !== previousText && this.grammarErrors.has(element)) {
      const errors = this.grammarErrors.get(element) || [];

      if (errors.length > 0) {
        // Calculate where the change occurred by finding the first difference
        const changePosition = this.findChangePosition(
          previousText,
          currentText
        );
        const lengthDiff = currentText.length - previousText.length;

        // Update error positions based on the change
        const updatedErrors = errors.map((error) => {
          // If error is after the change position, adjust its position
          if (error.start >= changePosition) {
            return {
              ...error,
              start: Math.max(0, error.start + lengthDiff),
              end: Math.max(0, error.end + lengthDiff),
            };
          }
          // If error overlaps with the change position, it might be invalid
          // (validateAndRemoveInvalidHighlights will handle this)
          return error;
        });

        // Update grammar errors with new positions
        this.grammarErrors.set(element, updatedErrors);

        // Immediately update highlight data-error attributes to reflect new positions
        // This must be done BEFORE validateAndRemoveInvalidHighlights so it uses updated positions
        const highlightsContent = this.highlightHelper.getContent();
        if (highlightsContent) {
          const elementId = getElementId(element);
          const highlights = highlightsContent.querySelectorAll(
            `[data-element-id="${elementId}"]`
          );
          highlights.forEach((highlight) => {
            const errorId = (highlight as HTMLElement).getAttribute(
              "data-error-id"
            );
            if (errorId) {
              const updatedError = updatedErrors.find((e) => e.id === errorId);
              if (updatedError) {
                (highlight as HTMLElement).setAttribute(
                  "data-error",
                  JSON.stringify(updatedError)
                );
              }
            }
          });
        }

        // Now validate with updated positions - this will only remove highlights where the word changed
        // (not where only position changed, since we've already updated data-error attributes)
        validateAndRemoveInvalidHighlights(
          element,
          this.highlightHelper.getContent(),
          this.grammarErrors,
          extractText,
          getElementId,
          this.isPerformingReplace
        );

        // Immediately update highlight positions to reflect the new error positions
        // Use requestAnimationFrame to ensure DOM has updated
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (this.grammarErrors.has(element)) {
              const currentErrors = this.grammarErrors.get(element) || [];
              if (currentErrors.length > 0) {
                // Update highlight positions with new positions
                this.highlightHelper.updatePositions(
                  element,
                  currentErrors,
                  (error: GrammarError) =>
                    getErrorTextRects(element, error.start, error.end)
                );
              }
            }
          });
        });

        // Notify change BEFORE updating last text so change can be detected
        this.changeEmitter.notifyChange(
          () => this.getFirstEditableElement(),
          extractText,
          getElementId
        );
        // Update last text after notifying (notifyChange updates it internally, but we ensure it's set)
        this.changeEmitter.setLastText(element, currentText);
        return; // Early return - we've already handled validation and position updates
      }
    }

    // Validate and remove invalid highlights when text changes
    // This ensures highlights for changed words are removed immediately
    // BUT: Only if we haven't already updated positions above (text didn't change or no errors)
    if (this.grammarErrors.has(element)) {
      validateAndRemoveInvalidHighlights(
        element,
        this.highlightHelper.getContent(),
        this.grammarErrors,
        extractText,
        getElementId,
        this.isPerformingReplace
      );
    }

    // Notify change BEFORE updating last text so change can be detected
    this.changeEmitter.notifyChange(
      () => this.getFirstEditableElement(),
      extractText,
      getElementId
    );
    // Update last text after notifying (notifyChange updates it internally, but we ensure it's set)
    this.changeEmitter.setLastText(element, currentText);
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
        this.changeEmitter.setCurrentElement(element);
        this.changeEmitter.setLastText(element, text);
        // Trigger initial check by notifying change
        this.changeEmitter.notifyChange(
          () => this.getFirstEditableElement(),
          extractText,
          getElementId
        );
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
    this.changeEmitter.setCurrentElement(element);

    // Always trigger check on focus (even if text is empty or unchanged)
    // This ensures connection is established immediately and highlights are shown
    const { text } = extractText(element);
    // Initialize lastText for this element if not set
    if (!this.changeEmitter.getLastText(element)) {
      this.changeEmitter.setLastText(element, text);
    }
    // Force check on focus - even if text hasn't changed
    this.changeEmitter.notifyChange(
      () => this.getFirstEditableElement(),
      extractText,
      getElementId,
      true // Pass true to force notification
    );
  };

  private getFirstEditableElement(): HTMLElement | null {
    if (this.editableElements.size === 0) {
      return null;
    }
    return Array.from(this.editableElements)[0] || null;
  }

  /**
   * Find the position where text changed between oldText and newText
   * Returns the position of the first difference
   */
  private findChangePosition(oldText: string, newText: string): number {
    // Find the first position where texts differ
    const minLength = Math.min(oldText.length, newText.length);
    let changePosition = minLength;

    for (let i = 0; i < minLength; i++) {
      if (oldText[i] !== newText[i]) {
        changePosition = i;
        break;
      }
    }

    // If texts are identical up to minLength, change is at the end
    // (either insertion or deletion)
    return changePosition;
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

    // Primary check: If shreddit-async-loader has 'hidden' class, search is open
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

  /**
   * Set up URL change detection for Reddit SPA navigation
   * Reddit uses client-side routing, so we need to detect URL changes
   */
  private setupUrlChangeDetection(): void {
    // Initialize current URL
    this.currentUrl = window.location.href;

    // Listen for popstate events (browser back/forward)
    window.addEventListener("popstate", this.handleUrlChange);

    // Monitor URL changes via interval (for programmatic navigation)
    // Reddit uses pushState/replaceState which doesn't trigger popstate
    this.urlCheckInterval = window.setInterval(() => {
      const newUrl = window.location.href;
      if (newUrl !== this.currentUrl) {
        this.handleUrlChange();
      }
    }, 500); // Check every 500ms
  }

  /**
   * Remove URL change detection
   */
  private removeUrlChangeDetection(): void {
    window.removeEventListener("popstate", this.handleUrlChange);
    if (this.urlCheckInterval !== null) {
      clearInterval(this.urlCheckInterval);
      this.urlCheckInterval = null;
    }
  }

  /**
   * Handle URL change - clear all highlights and reset state
   */
  private handleUrlChange = (): void => {
    const newUrl = window.location.href;

    // Only clear if URL actually changed (not just a hash change within same page)
    const currentPath = new URL(this.currentUrl).pathname;
    const newPath = new URL(newUrl).pathname;

    if (currentPath !== newPath) {
      console.log("Rewordly: Reddit page changed, clearing highlights");

      // Clear all highlights
      this.clearIssues();

      // Reset element tracking
      this.editableElements.clear();
      this.currentElement = null;
      this.changeEmitter.setCurrentElement(null);

      // Update current URL
      this.currentUrl = newUrl;

      // Re-find editable elements for the new page
      // Small delay to ensure DOM is ready
      setTimeout(() => {
        this.findAndAttachToEditableElements();
      }, 100);
    } else {
      // Just update URL (hash change or query param change)
      this.currentUrl = newUrl;
    }
  };
}
