/**
 * Rewordly Content Script
 * Handles text selection, rewrite button UI, and displaying rewritten text
 * Now includes real-time grammar checking for editable elements
 */

import { createRewordlyAPIUtil, RewordlyAPIUtil } from "./utils/api";
import {
  RewordlyConfig,
  GrammarError,
  GrammarCheckResponse,
  IPlatformAdapter,
} from "./types";
import {
  RewriteButtonHelper,
  ModalHelper,
  HighlightContainerHelper,
  getErrorTextRects,
  closeAllGrammarTooltips,
  isEditableElement,
  isElementVisible,
  getElementId,
  findAllEditableElements,
  findEditableInElement,
  findEditableInShadowDOM,
  shouldIgnoreElement,
  isNodeInDocument,
  findScrollableContainers,
  isSingleLineElement,
  loadConfig,
  isPageDisabled,
  isGrammarCheckAllowedSite,
  createPlatformAdapterForSite,
  generateErrorId,
  checkGrammarAPI,
  extractTextExcludingSignature,
  isElementIgnored,
  isErrorDismissed,
  mapInnerTextToTextNodes,
  adjustErrorPositionsForMultiWord,
  escapeHtml,
  formatSuggestionForDisplay,
  replaceTextInDraftJS,
  replaceTextInContentEditable,
} from "./helpers";

class RewordlyContentScript {
  private config: RewordlyConfig = {
    highlightsEnabled: true,
    rewriteEnabled: true,
  };

  // UI Helpers
  private rewriteButtonHelper: RewriteButtonHelper;
  private modalHelper: ModalHelper;

  // Highlight Helper
  private highlightHelper: HighlightContainerHelper;

  // Legacy references (deprecated - use helpers instead)
  private rewriteButton: HTMLDivElement | null = null;

  // Real-time grammar checking
  private grammarCheckTimeout: number | null = null;
  private grammarCheckThrottle: number | null = null; // Throttle timer
  private highlightPositionUpdateTimeout: number | null = null;
  private buttonBlurTimeout: number | null = null; // Timeout for hiding button on blur
  private currentFocusedElement: HTMLElement | null = null; // Track currently focused element - if set, button should not be hidden
  private grammarErrors: Map<HTMLElement, GrammarError[]> = new Map();
  private editableElements: Set<HTMLElement> = new Set();
  // Track active grammar check requests per element (for cancellation)
  private activeGrammarRequests: Map<HTMLElement, string> = new Map(); // element -> requestId

  // Track dismissed errors: key = elementId + word + start, value = true
  private dismissedErrors: Map<string, boolean> = new Map();

  // Ignore list for elements that should not have grammar checking
  // Stores element IDs (from getElementId) that should be ignored
  private ignoredElementIds: Set<string> = new Set();

  // Grammarly-style highlights container
  private highlightsContainer: HTMLElement | null = null;
  private highlightsShadowRoot: ShadowRoot | null = null;
  private highlightsContent: HTMLElement | null = null;

  // Store bound event handlers to allow proper removal
  private boundHandleOutsideClick = this.handleOutsideClick.bind(this);
  private boundHandleKeyDown = this.handleKeyDown.bind(this);
  private boundHandleInput = this.handleInput.bind(this);
  private boundHandleFocus = this.handleFocus.bind(this);
  private boundHandleBlur = this.handleBlur.bind(this);

  // Error ID counter removed - use generateErrorId() from helpers instead

  // Platform adapter (handles Google Docs, Reddit, Notion, etc.)
  private platformAdapter: IPlatformAdapter | null = null;

  // Track if we're currently performing a replace operation (to prevent blur from hiding highlights)
  private isPerformingReplace = false;

  // Track if we're currently performing a dismiss operation (to prevent blur from hiding highlights)
  private isPerformingDismiss = false;

  // Track scheduled blur handlers to cancel them if needed
  private scheduledBlurHandlers = new Map<HTMLElement, NodeJS.Timeout>();

  // Track scrollable containers for each editable element
  // Maps element -> Set of scrollable parent containers
  private scrollableContainers = new Map<HTMLElement, Set<HTMLElement>>();

  // Track scroll event listeners for cleanup
  // Maps scrollable container -> bound update function
  private scrollListeners = new Map<HTMLElement, () => void>();

  // Track scroll listener for AI rewrite button position updates
  private aiButtonScrollListener: (() => void) | null = null;

  // Request queue for batch processing API requests (deprecated - using direct requests now)
  private grammarCheckQueue: Array<{
    element: HTMLElement;
    priority?: number;
  }> = [];
  private isProcessingQueue: boolean = false;
  private readonly BATCH_SIZE: number = 3; // Process 3 requests at a time
  private readonly BATCH_DELAY: number = 200; // Delay between batches in milliseconds
  // Throttle delay for grammar checks (300ms - faster than debounce)
  private readonly GRAMMAR_CHECK_THROTTLE: number = 300;

  // WebSocket API instance
  private apiUtil: RewordlyAPIUtil;

  constructor() {
    // Initialize WebSocket API (production server with WSS)
    // Using wss://rewordly.store with Let's Encrypt SSL certificate
    this.apiUtil = createRewordlyAPIUtil("wss://rewordly.store");

    // Initialize helpers
    this.rewriteButtonHelper = new RewriteButtonHelper();
    this.modalHelper = new ModalHelper();
    this.highlightHelper = new HighlightContainerHelper();

    this.init();
  }

  private async init(): Promise<void> {
    // Check if this page is disabled - if so, don't initialize at all
    const pageDisabled = await isPageDisabled();
    if (pageDisabled) {
      return;
    }
    // Define custom element for highlights container to prevent Reddit's CSS from hiding it
    // Reddit uses :not(:defined) to hide undefined custom elements
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

    // Add global style to override Reddit's CSS that hides undefined custom elements
    // Reddit uses :not(:defined) to hide custom elements, so we need to explicitly show ours
    if (window.location.hostname.includes("reddit.com")) {
      const styleId = "rewordly-reddit-override";
      if (!document.getElementById(styleId)) {
        const style = document.createElement("style");
        style.id = styleId;
        style.textContent = `
          rewordly-highlights {
            visibility: visible !important;
          }
        `;
        document.head.appendChild(style);
      }
    }

    // Load configuration from storage
    this.config = await loadConfig();

    // Set up event listeners
    this.setupEventListeners();

    // Set up real-time grammar checking for editable elements
    this.setupRealtimeGrammarCheck();

    // Set up platform-specific adapter
    this.setupPlatformAdapter();

    // Create UI elements using helpers
    this.rewriteButtonHelper.create();
    this.modalHelper.create();
    this.highlightHelper.create();

    // Legacy references for backward compatibility
    this.rewriteButton = this.rewriteButtonHelper["button"];

    // Set up scroll/resize listeners for highlights
    this.setupHighlightsUpdateListeners();

    // Listen for settings updates from popup
    this.setupMessageListener();
  }

  private setupEventListeners(): void {
    // Remove existing listeners to prevent duplicates
    document.removeEventListener("click", this.boundHandleOutsideClick);
    document.removeEventListener("keydown", this.boundHandleKeyDown);

    // Listen for clicks outside to hide button/modal
    document.addEventListener("click", this.boundHandleOutsideClick, true);

    // Listen for escape key to close modal
    document.addEventListener("keydown", this.boundHandleKeyDown, true);

    // Note: Text selection listeners removed - button only shows on editable element focus
  }

  /**
   * Set up real-time grammar checking for editable elements
   */
  private setupRealtimeGrammarCheck(): void {
    // Use event delegation at document level to catch all input events
    // This works even for dynamically added elements and Shadow DOM
    this.setupEventDelegation();

    // Wait for DOM to be ready
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => {
        this.findAndAttachToEditableElements();
      });
    } else {
      this.findAndAttachToEditableElements();
    }

    // Watch for new editable elements being added to the DOM
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        // Handle added nodes
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const element = node as HTMLElement;
            this.attachToEditableElement(element);
            // Also check children (including Shadow DOM)
            const editableChildren = findEditableInElement(element);
            editableChildren.forEach((el) => {
              this.attachToEditableElement(el);
            });
          }
        });

        // Handle removed nodes - clean up overlays for removed elements
        // Skip during replace operations to prevent accidental cleanup
        if (!this.isPerformingReplace) {
          mutation.removedNodes.forEach((node) => {
            if (node.nodeType === Node.ELEMENT_NODE) {
              const element = node as HTMLElement;
              // Check if this element or its children had grammar errors
              if (this.grammarErrors.has(element)) {
                this.clearGrammarErrors(element);
              }
              // Also check children
              const childOverlays = element.querySelectorAll(
                ".rewordly-grammar-overlay"
              );
              childOverlays.forEach((overlay) => {
                const elementId = overlay.getAttribute("data-element-id");
                if (elementId) {
                  // Find the element and clear its errors
                  const errorElement = Array.from(
                    this.grammarErrors.keys()
                  ).find((el) => getElementId(el) === elementId);
                  if (errorElement) {
                    this.clearGrammarErrors(errorElement);
                  }
                }
              });
            }
          });
        }
      });

      // Periodically clean up overlays for removed elements (skip during replace)
      if (!this.isPerformingReplace) {
        this.clearAllGrammarErrors();
      }
    });

    if (document.body) {
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["contenteditable"],
      });
    } else {
      const bodyObserver = new MutationObserver(() => {
        if (document.body) {
          observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["contenteditable"],
          });
          bodyObserver.disconnect();
        }
      });
      bodyObserver.observe(document.documentElement, {
        childList: true,
      });
    }

    // Periodically scan for new editable elements (for very dynamic pages)
    setInterval(() => {
      this.findAndAttachToEditableElements();
    }, 2000);
  }

  /**
   * Set up event delegation at document level
   * This catches all input events even from dynamically added elements
   */
  private setupEventDelegation(): void {
    // Listen to all input events at document level (capture phase)
    document.addEventListener(
      "input",
      (event) => {
        this.handleDelegatedInput(event);
      },
      true
    );

    document.addEventListener(
      "beforeinput",
      (event) => {
        this.handleDelegatedInput(event);
      },
      true
    );

    // Also listen to keyup for contenteditable elements
    document.addEventListener(
      "keyup",
      (event) => {
        const target = event.target as HTMLElement;
        if (isEditableElement(target)) {
          this.handleDelegatedInput(event);
        }
      },
      true
    );
  }

  /**
   * Handle delegated input events
   */
  private handleDelegatedInput(event: Event): void {
    const element = event.target as HTMLElement;

    if (!element || !isEditableElement(element)) {
      return;
    }

    // Ensure element is tracked
    if (!this.editableElements.has(element)) {
      this.editableElements.add(element);
    }

    // Process the input event
    this.handleInput(event);
  }

  /**
   * Find all editable elements and attach listeners
   */
  private findAndAttachToEditableElements(): void {
    const allEditable = findAllEditableElements();
    allEditable.forEach((element) => {
      this.attachToEditableElement(element);
    });

    // Check Shadow DOM
    const shadowEditable = findEditableInShadowDOM(document.body);
    shadowEditable.forEach((element) => {
      this.attachToEditableElement(element);
    });
  }

  /**
   * Attach event listeners to an editable element
   */
  private attachToEditableElement(element: HTMLElement): void {
    if (!isEditableElement(element)) {
      return;
    }

    if (this.editableElements.has(element)) {
      return;
    }

    this.editableElements.add(element);

    // Check if this element should be ignored (e.g., Gmail's "To" field)
    if (shouldIgnoreElement(element)) {
      const elementId = getElementId(element);
      this.ignoredElementIds.add(elementId);
      return; // Don't attach grammar checking to ignored elements
    }

    // Disable browser's native spell check
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
    ) {
      element.spellcheck = false;
    } else {
      element.setAttribute("spellcheck", "false");
    }

    // Disable Gmail's spell check (writingsuggestions)
    element.setAttribute("writingsuggestions", "false");

    // Remove Gmail's spell check markers (aria-invalid spans)
    this.removeGmailSpellCheckMarkers(element);

    // Watch for Gmail adding spell check markers and remove them
    this.setupGmailSpellCheckObserver(element);

    // Add multiple event listeners to catch all input types
    // Use capture phase to catch events before they're stopped
    element.addEventListener("input", this.boundHandleInput, true);
    element.addEventListener("beforeinput", this.boundHandleInput, true);
    element.addEventListener("keyup", this.boundHandleInput, true);
    element.addEventListener("focus", this.boundHandleFocus, true);
    element.addEventListener("blur", this.boundHandleBlur, true);

    // For contenteditable, also listen to textInput
    if (element.getAttribute("contenteditable") === "true") {
      element.addEventListener("textInput", this.boundHandleInput, true);
    }

    // Check if element already has text and perform grammar check
    // Wait for element to be visible and rendered (especially for dynamic content like Google)
    this.checkAndPerformGrammarCheckForExistingText(element);

    // Set up scroll listeners for scrollable containers
    this.setupElementScrollListeners(element);
  }

  /**
   * Check if element has existing text and perform grammar check when element is visible
   */
  private checkAndPerformGrammarCheckForExistingText(
    element: HTMLElement
  ): void {
    // Only perform grammar check on allowed sites (Twitter, Gmail, Reddit, Medium)
    if (!this.isGrammarCheckAllowedSite()) {
      return;
    }

    if (!this.config.highlightsEnabled) {
      return;
    }

    // Check if element has text
    let hasText = false;
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
    ) {
      hasText = element.value.trim().length >= 3;
    } else if (
      element.getAttribute("contenteditable") === "true" ||
      element.isContentEditable
    ) {
      hasText =
        (element.innerText || element.textContent || "").trim().length >= 3;
    }

    if (!hasText || !isEditableElement(element)) {
      return;
    }

    // Check if element is visible
    const isVisible = isElementVisible(element);

    if (isVisible) {
      // Element is visible, queue grammar check
      setTimeout(() => {
        if (isEditableElement(element)) {
          this.queueGrammarCheck(element, 0);
        }
      }, 300); // Small delay to ensure element is fully rendered
    } else {
      // Element is not visible yet, wait for it to become visible
      // Use IntersectionObserver to detect when element becomes visible
      const observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting && entry.intersectionRatio > 0) {
              // Element is now visible, queue grammar check
              setTimeout(() => {
                if (isEditableElement(element)) {
                  this.queueGrammarCheck(element, 0);
                }
              }, 300);
              observer.disconnect();
            }
          });
        },
        {
          threshold: 0.1, // Trigger when at least 10% of element is visible
          rootMargin: "50px", // Start checking slightly before element enters viewport
        }
      );

      observer.observe(element);

      // Also try after a delay in case IntersectionObserver doesn't work
      setTimeout(() => {
        if (isElementVisible(element) && isEditableElement(element)) {
          this.queueGrammarCheck(element, 0);
        }
        observer.disconnect();
      }, 2000); // Fallback: try after 2 seconds
    }
  }

  /**
   * Remove Gmail's spell check markers (spans with aria-invalid)
   */
  /**
   * Remove Gmail spell check markers
   * @deprecated Moved to GmailAdapter. This method is kept for backward compatibility.
   */
  private removeGmailSpellCheckMarkers(_element: HTMLElement): void {
    // Moved to GmailAdapter
  }

  /**
   * Set up observer to watch for Gmail adding spell check markers
   * @deprecated Moved to GmailAdapter. This method is kept for backward compatibility.
   */
  private setupGmailSpellCheckObserver(_element: HTMLElement): void {
    // Moved to GmailAdapter
  }

  /**
   * Handle input events on editable elements
   */
  private handleInput(event: Event): void {
    // Skip programmatic input events triggered by our replace operations
    // This prevents unnecessary grammar checks after replacements
    if ((event as any).__rewordlyProgrammatic) {
      return;
    }

    const element = event.target as HTMLElement;

    if (!isEditableElement(element)) {
      return;
    }

    // Ignore input events during replace operations
    // This prevents grammar check from running after programmatic text replacement
    // (e.g., when execCommand('insertText') triggers input events in Lexical/Reddit)
    if (this.isPerformingReplace) {
      // Clear any pending grammar check timeout
      if (this.grammarCheckTimeout !== null) {
        clearTimeout(this.grammarCheckTimeout);
        this.grammarCheckTimeout = null;
      }
      return;
    }

    // Show AI button if element has focus and rewrite is enabled
    // For textarea/input: always show when focused (regardless of text length)
    // For contenteditable: only show if has text (at least 3 characters)
    // Only show on sites where grammar check is enabled
    if (
      this.config.rewriteEnabled &&
      this.isGrammarCheckAllowedSite() &&
      this.config.highlightsEnabled
    ) {
      // Cancel button blur timeout to prevent button from hiding
      if (this.buttonBlurTimeout !== null) {
        clearTimeout(this.buttonBlurTimeout);
        this.buttonBlurTimeout = null;
      }

      // Check if element has focus (or is the active element)
      const hasFocus =
        document.activeElement === element ||
        (element instanceof HTMLInputElement &&
          document.activeElement === element) ||
        (element instanceof HTMLTextAreaElement &&
          document.activeElement === element);

      if (hasFocus) {
        // For textarea/input: always show button when focused
        if (
          element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement
        ) {
          // Set current focused element - this prevents button from being hidden
          this.currentFocusedElement = element;
          this.showAIRewriteButton(element);
        } else {
          // For contenteditable: check if has text
          let hasText = false;
          if (
            element.getAttribute("contenteditable") === "true" ||
            element.isContentEditable
          ) {
            hasText =
              (element.innerText || element.textContent || "").trim().length >=
              3;
          }

          if (hasText) {
            this.showAIRewriteButton(element);
          } else {
            // Hide button if text is less than 3 characters
            this.hideRewriteButton();
          }
        }
      }
    }

    // Clear previous timeout
    if (this.grammarCheckTimeout !== null) {
      clearTimeout(this.grammarCheckTimeout);
    }

    // Check if this is a Draft.js editor (Twitter)
    const isDraftJS =
      element.classList.contains("public-DraftEditor-content") ||
      element.closest(".DraftEditor-root") !== null;

    if (isDraftJS) {
      // For Draft.js, delay validation to allow DOM to update after programmatic changes
      // This prevents false invalidation of highlights after replace operations
      setTimeout(() => {
        this.validateAndRemoveInvalidHighlights(element);
      }, 50);
    } else {
      // For other editors, validate immediately (when user deletes characters)
      this.validateAndRemoveInvalidHighlights(element);
    }

    // Don't clear existing errors - keep overlays visible while user is typing

    // Update highlight positions when text changes (if highlights exist)
    if (this.config.highlightsEnabled && this.grammarErrors.has(element)) {
      // Clear previous position update timeout
      if (this.highlightPositionUpdateTimeout !== null) {
        clearTimeout(this.highlightPositionUpdateTimeout);
      }

      // Update positions after DOM updates (using double requestAnimationFrame to ensure DOM is fully updated)
      this.highlightPositionUpdateTimeout = window.setTimeout(() => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            this.highlightHelper.updatePositions(
              element,
              this.grammarErrors.get(element) || [],
              (error: GrammarError) =>
                getErrorTextRects(element, error.start, error.end)
            );
          });
        });
      }, 0);
    }

    // Only perform grammar check if highlights are enabled
    if (this.config.highlightsEnabled) {
      // Use throttle instead of debounce for faster response
      // Cancel previous throttle if exists
      if (this.grammarCheckThrottle !== null) {
        clearTimeout(this.grammarCheckThrottle);
      }

      // Throttle: check every 300ms while user is typing
      this.grammarCheckThrottle = window.setTimeout(() => {
        this.performGrammarCheckDirect(element);
        this.grammarCheckThrottle = null;
      }, this.GRAMMAR_CHECK_THROTTLE);
    }
  }

  /**
   * Handle focus events on editable elements
   */
  private handleFocus(event: Event): void {
    const element = event.target as HTMLElement;

    if (!element || !isEditableElement(element)) {
      return;
    }

    // Cancel any scheduled blur handlers for this element when focus is restored
    // This prevents highlights from being hidden after replace operations
    const existingBlurTimeout = this.scheduledBlurHandlers.get(element);
    if (existingBlurTimeout) {
      clearTimeout(existingBlurTimeout);
      this.scheduledBlurHandlers.delete(element);
    }

    // Cancel button blur timeout if exists (prevents button from hiding after focus)
    if (this.buttonBlurTimeout !== null) {
      clearTimeout(this.buttonBlurTimeout);
      this.buttonBlurTimeout = null;
    }

    // Track currently focused element - this prevents button from being hidden
    this.currentFocusedElement = element;

    // Check if element has text (at least 3 characters)
    let hasText = false;
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
    ) {
      hasText = element.value.trim().length >= 3;
    } else if (
      element.getAttribute("contenteditable") === "true" ||
      element.isContentEditable
    ) {
      hasText =
        (element.innerText || element.textContent || "").trim().length >= 3;
    }

    // Show AI button on focus for textarea/input elements (always show on focus)
    // For contenteditable elements, only show if has text (at least 3 characters)
    // Only show on sites where grammar check is enabled
    if (
      this.config.rewriteEnabled &&
      this.isGrammarCheckAllowedSite() &&
      this.config.highlightsEnabled
    ) {
      // For textarea/input: show button immediately on focus, regardless of text length
      if (
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement
      ) {
        // Set current focused element - this prevents button from being hidden
        this.currentFocusedElement = element;
        this.showAIRewriteButton(element);
      } else if (hasText) {
        // For contenteditable: only show if has text
        this.showAIRewriteButton(element);
      } else {
        // Hide button if contenteditable and text is less than 3 characters
        this.hideRewriteButton();
      }
    }

    // If element has grammar errors and highlights are enabled, show the overlay again
    if (this.config.highlightsEnabled && this.grammarErrors.has(element)) {
      this.showGrammarOverlay(element);
    }

    // Perform immediate grammar check on focus (if element has text)
    if (
      this.config.highlightsEnabled &&
      hasText &&
      this.isGrammarCheckAllowedSite()
    ) {
      // Cancel any pending throttle
      if (this.grammarCheckThrottle !== null) {
        clearTimeout(this.grammarCheckThrottle);
        this.grammarCheckThrottle = null;
      }
      // Check immediately on focus
      this.performGrammarCheckDirect(element);
    }
  }

  /**
   * Handle blur events on editable elements
   */
  private handleBlur(event: Event): void {
    const element = event.target as HTMLElement;

    // Clear timeout if user leaves the field
    if (this.grammarCheckTimeout !== null) {
      clearTimeout(this.grammarCheckTimeout);
      this.grammarCheckTimeout = null;
    }

    // Clear highlight position update timeout
    if (this.highlightPositionUpdateTimeout !== null) {
      clearTimeout(this.highlightPositionUpdateTimeout);
      this.highlightPositionUpdateTimeout = null;
    }

    // Hide AI button when focus is lost (with delay to allow button click)
    // Check if the blur is caused by clicking the button
    const relatedTarget = (event as FocusEvent)
      .relatedTarget as HTMLElement | null;
    const isClickingButton =
      relatedTarget &&
      (relatedTarget === this.rewriteButton ||
        this.rewriteButton?.contains(relatedTarget));

    if (!isClickingButton) {
      // Cancel any existing button blur timeout
      if (this.buttonBlurTimeout !== null) {
        clearTimeout(this.buttonBlurTimeout);
        this.buttonBlurTimeout = null;
      }

      // Clear current focused element - allow button to be hidden
      // But use a delay to allow for focus transfer (e.g., clicking on button)
      const blurredElement = element;
      this.currentFocusedElement = null;

      // Small delay to allow for focus transfer (e.g., clicking on button)
      this.buttonBlurTimeout = window.setTimeout(() => {
        // Check if element still doesn't have focus and button wasn't clicked
        const shouldHide =
          document.activeElement !== blurredElement &&
          document.activeElement !== this.rewriteButton &&
          !this.rewriteButton?.contains(document.activeElement) &&
          this.currentFocusedElement !== blurredElement; // Check if element is no longer the focused element

        // Only hide if element truly lost focus and is not the current focused element
        if (shouldHide) {
          // Double-check: if element regained focus, don't hide
          if (document.activeElement === blurredElement) {
            // Element regained focus, update current focused element
            this.currentFocusedElement = blurredElement;
            this.buttonBlurTimeout = null;
            return;
          }
          this.hideRewriteButton();
        }
        this.buttonBlurTimeout = null;
      }, 150);
    }

    // Hide grammar errors/overlay when focus is lost (but don't delete)
    // However, if element has text, keep highlights visible even without focus
    if (element && isEditableElement(element)) {
      // Cancel any existing scheduled blur handler for this element
      const existingTimeout = this.scheduledBlurHandlers.get(element);
      if (existingTimeout) {
        clearTimeout(existingTimeout);
        this.scheduledBlurHandlers.delete(element);
      }

      // Small delay to allow for focus transfer (e.g., clicking on overlay)
      // For Draft.js (Twitter), use longer delay as DOM updates are asynchronous
      const isDraftJS =
        element.classList.contains("public-DraftEditor-content") ||
        element.closest(".DraftEditor-root") !== null;
      const blurDelay = isDraftJS ? 400 : 100; // Longer delay for Draft.js to account for async DOM updates

      const timeoutId = setTimeout(() => {
        // Remove from map when executed
        this.scheduledBlurHandlers.delete(element);

        // Don't hide if we're performing a replace or dismiss operation (prevents highlights from being hidden during replace/dismiss)
        if (this.isPerformingReplace || this.isPerformingDismiss) {
          return;
        }

        // Check if element still doesn't have focus
        if (document.activeElement !== element) {
          // Keep highlights visible as long as element is in the DOM and has text
          // Only hide if element is removed from DOM or has no text
          let hasText = false;
          if (
            element instanceof HTMLInputElement ||
            element instanceof HTMLTextAreaElement
          ) {
            hasText = element.value.trim().length > 0;
          } else if (
            element.getAttribute("contenteditable") === "true" ||
            element.isContentEditable
          ) {
            hasText =
              (element.innerText || element.textContent || "").trim().length >
              0;
          }

          // Check if element is still in the DOM
          const isInDOM =
            document.body.contains(element) || element.isConnected;

          // Only hide highlights if element has no text or is removed from DOM
          if (!hasText || !isInDOM) {
            // Element has no text or was removed, hide highlights
            if (this.highlightsContent) {
              const elementId = getElementId(element);
              const highlights = this.highlightsContent.querySelectorAll(
                `[data-element-id="${elementId}"]`
              );
              highlights.forEach((highlight) => {
                highlight.remove();
              });
            }
            // Clear errors for this element
            this.grammarErrors.delete(element);
          }
          // Otherwise, keep highlights visible even without focus
        }
      }, blurDelay);

      // Store timeout ID so we can cancel it if needed
      this.scheduledBlurHandlers.set(element, timeoutId);
    }
  }

  /**
   * Add element to grammar check queue
   */
  private queueGrammarCheck(element: HTMLElement, priority: number = 0): void {
    // Only queue grammar check on allowed sites (Twitter, Gmail, Reddit, Medium)
    if (!this.isGrammarCheckAllowedSite()) {
      return;
    }

    // Check if element is already in queue
    const existingIndex = this.grammarCheckQueue.findIndex(
      (item) => item.element === element
    );

    if (existingIndex !== -1) {
      // Update priority if new priority is higher
      const existingItem = this.grammarCheckQueue[existingIndex];
      if (existingItem && priority > (existingItem.priority || 0)) {
        existingItem.priority = priority;
      }
      return;
    }

    // Add to queue
    this.grammarCheckQueue.push({ element, priority });

    // Sort queue by priority (higher priority first)
    this.grammarCheckQueue.sort(
      (a, b) => (b.priority || 0) - (a.priority || 0)
    );

    // Start processing queue if not already processing
    if (!this.isProcessingQueue) {
      this.processGrammarCheckQueue();
    }
  }

  /**
   * Process grammar check queue in batches
   */
  private async processGrammarCheckQueue(): Promise<void> {
    if (this.isProcessingQueue || this.grammarCheckQueue.length === 0) {
      return;
    }

    this.isProcessingQueue = true;

    while (this.grammarCheckQueue.length > 0) {
      // Get next batch
      const batch = this.grammarCheckQueue.splice(0, this.BATCH_SIZE);

      // Process batch in parallel
      const promises = batch.map((item) => {
        // Check if element still exists and is valid
        if (!item.element || !item.element.isConnected) {
          return Promise.resolve();
        }
        return this.performGrammarCheck(item.element).catch((error) => {
          console.error("Rewordly: Grammar check error in queue:", error);
        });
      });

      // Wait for batch to complete
      await Promise.all(promises);

      // Wait before processing next batch (if there are more items)
      if (this.grammarCheckQueue.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.BATCH_DELAY));
      }
    }

    this.isProcessingQueue = false;
  }

  /**
   * Extract text from element excluding signature blocks
   * This prevents grammar checking on email signatures which contain formatting
   * that can trigger false positives (like whitespace, special characters, etc.)
   * Preserves line breaks by using innerText which properly handles <br> tags and block elements.
   * Also handles Google Docs virtual elements specially.
   */
  private extractTextExcludingSignature(element: HTMLElement): {
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
      // Temporarily hide signature elements to exclude them from innerText
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
   * Perform grammar check directly (new optimized method with request cancellation)
   */
  private async performGrammarCheckDirect(element: HTMLElement): Promise<void> {
    // Only perform grammar check on allowed sites
    if (!this.isGrammarCheckAllowedSite()) {
      return;
    }

    // Check if element is in ignore list
    if (this.isElementIgnored(element)) {
      return;
    }

    // Don't perform grammar check if we're currently performing a replace operation
    if (this.isPerformingReplace) {
      return;
    }

    // Extract text excluding signature blocks
    const { text, textSource } = extractTextExcludingSignature(element);

    // Skip if text is too short
    if (text.trim().length < 3) {
      return;
    }

    // Store text source for overlay creation
    (element as any).__rewordlyTextSource = textSource;
    (element as any).__rewordlyText = text;

    // Cancel previous request for this element if exists
    const previousRequestId = this.activeGrammarRequests.get(element);
    if (previousRequestId) {
      this.apiUtil.cancelRequest(previousRequestId);
      this.activeGrammarRequests.delete(element);
    }

    try {
      // Call WebSocket API with cancellation support
      const result = await this.apiUtil.checkGrammar(
        text,
        "default",
        previousRequestId
      );

      console.log("Rewordly: Grammar check result", {
        errorsCount: result.errors.length,
        errors: result.errors,
        text: text.substring(0, 50) + "...",
        textLength: text.length,
      });

      // Store the new request ID
      this.activeGrammarRequests.set(element, result.requestId);

      // Check if detected language is English
      // For short texts, language detection can be inaccurate, so we allow grammar checking
      // if the text contains English words or if language detection confidence is low
      const textLength = text.trim().length;
      const isShortText = textLength < 50; // Consider text short if less than 50 characters

      if (
        result.detectedLanguage &&
        !result.detectedLanguage.code.toLowerCase().startsWith("en")
      ) {
        // For short texts, be more lenient - allow grammar checking if text contains English words
        if (isShortText) {
          // Check if text contains common English words or patterns
          const englishPattern =
            /\b(the|and|or|but|in|on|at|to|for|of|with|by|from|as|is|are|was|were|be|been|have|has|had|do|does|did|will|would|should|could|can|may|might|this|that|these|those|a|an)\b/i;
          const hasEnglishWords = englishPattern.test(text);

          if (hasEnglishWords) {
            console.log(
              "Rewordly: Short text with English words, allowing grammar check despite language detection",
              {
                detectedLanguage: result.detectedLanguage,
                textLength,
              }
            );
            // Continue with grammar check even if language is not detected as English
          } else {
            console.log(
              "Rewordly: Language is not English and no English words detected",
              result.detectedLanguage
            );
            this.displayGrammarErrors(element, []);
            this.activeGrammarRequests.delete(element);
            return;
          }
        } else {
          // For longer texts, trust language detection
          console.log(
            "Rewordly: Language is not English",
            result.detectedLanguage
          );
          this.displayGrammarErrors(element, []);
          this.activeGrammarRequests.delete(element);
          return;
        }
      }

      // Map errors to include id field
      const errorsWithId: GrammarError[] = result.errors.map((error) => ({
        id: generateErrorId(),
        start: error.start,
        end: error.end,
        word: error.word,
        suggestions: error.suggestions,
        type: error.type,
      }));

      console.log("Rewordly: Mapped errors", {
        errorsWithId,
        textLength: text.length,
      });

      // Display errors (or clear if no errors)
      this.displayGrammarErrors(element, errorsWithId);
      this.activeGrammarRequests.delete(element);
    } catch (error) {
      // Don't log cancellation errors
      if (error instanceof Error && error.message === "Request cancelled") {
        return;
      }
      console.error("Rewordly: Grammar check error:", error);
      this.activeGrammarRequests.delete(element);
      // Clear highlights on error
      this.displayGrammarErrors(element, []);
    }
  }

  /**
   * Perform grammar check on an element (legacy method - kept for queue system)
   */
  private async performGrammarCheck(element: HTMLElement): Promise<void> {
    // Only perform grammar check on allowed sites (Twitter, Gmail, Reddit, Medium)
    if (!this.isGrammarCheckAllowedSite()) {
      return;
    }

    // Check if element is in ignore list
    if (this.isElementIgnored(element)) {
      return;
    }

    // Don't perform grammar check if we're currently performing a replace operation
    // This prevents race conditions where API returns old errors while we're updating positions
    if (this.isPerformingReplace) {
      return;
    }

    // Extract text excluding signature blocks
    const { text, textSource } = extractTextExcludingSignature(element);

    // Skip if text is too short
    if (text.trim().length < 3) {
      return;
    }

    // Store text source for overlay creation
    (element as any).__rewordlyTextSource = textSource;
    (element as any).__rewordlyText = text;

    try {
      // Call real API
      const response = await this.checkGrammarAPI(text);

      // Check if detected language is English
      if (
        response.detectedLanguage &&
        !response.detectedLanguage.code.toLowerCase().startsWith("en")
      ) {
        // Language is not English, clear all highlights and skip grammar check
        this.displayGrammarErrors(element, []);
        return;
      }

      // Display errors (or clear if no errors)
      this.displayGrammarErrors(element, response.errors);
    } catch (error) {
      console.error("Rewordly: Grammar check error:", error);
      // Fallback to mock if API fails (for development)
      try {
        const mockResponse = this.mockGrammarCheck(text);
        // Mock always assumes English, so we can proceed
        this.displayGrammarErrors(element, mockResponse.errors);
      } catch (mockError) {
        console.error("Rewordly: Mock grammar check also failed:", mockError);
        // Clear all highlights if both API and mock fail
        this.displayGrammarErrors(element, []);
      }
    }
  }

  /**
   * Check grammar using WebSocket API (legacy method - kept for compatibility)
   */
  private async checkGrammarAPI(text: string): Promise<GrammarCheckResponse> {
    try {
      // Use WebSocket API for grammar check
      const result = await this.apiUtil.checkGrammar(text, "default");

      // Map errors to include id field (required by GrammarError interface)
      const errorsWithId: GrammarError[] = result.errors.map((error) => ({
        id: generateErrorId(),
        start: error.start,
        end: error.end,
        word: error.word,
        suggestions: error.suggestions,
        type: error.type,
      }));

      return {
        errors: errorsWithId,
        corrected: result.corrected,
        ...(result.detectedLanguage && {
          detectedLanguage: result.detectedLanguage,
        }),
      };
    } catch (error) {
      // Don't log cancellation errors
      if (error instanceof Error && error.message === "Request cancelled") {
        throw error;
      }
      console.error("Rewordly: WebSocket API request failed:", error);
      throw error;
    }
  }

  /**
   * Mock grammar check API - returns grammar errors with positions
   * Used as fallback when API is unavailable
   */
  private mockGrammarCheck(text: string): GrammarCheckResponse {
    // Mock grammar check with multiple error types
    // This is a mock - in real implementation, this would call the API

    const errors: GrammarError[] = [];
    const lowerText = text.toLowerCase();

    // Find ALL occurrences of "goes" (not just the first one)
    let searchIndex = 0;
    while (true) {
      const goesIndex = lowerText.indexOf(" goes ", searchIndex);
      if (goesIndex === -1) break;

      const start = text.indexOf(" goes ", goesIndex);
      if (start !== -1) {
        errors.push({
          id: generateErrorId(),
          start: start + 1,
          end: start + 5,
          word: "goes",
          suggestions: ["went", "go"],
          type: "grammar",
        });
      }
      searchIndex = goesIndex + 1;
    }

    // Find ALL occurrences of "buyed"
    searchIndex = 0;
    while (true) {
      const buyedIndex = lowerText.indexOf("buyed", searchIndex);
      if (buyedIndex === -1) break;

      errors.push({
        id: generateErrorId(),
        start: buyedIndex,
        end: buyedIndex + 5,
        word: "buyed",
        suggestions: ["bought", "buy"],
        type: "grammar",
      });
      searchIndex = buyedIndex + 1;
    }

    // Find ALL occurrences of "have" with singular subject
    searchIndex = 0;
    while (true) {
      const haveIndex = lowerText.indexOf(" have ", searchIndex);
      if (haveIndex === -1) break;

      if (haveIndex > 0) {
        const beforeHave = text
          .substring(Math.max(0, haveIndex - 20), haveIndex)
          .trim();
        const wordsBefore = beforeHave.split(/\s+/);
        const lastWord = wordsBefore[wordsBefore.length - 1];
        if (
          lastWord &&
          !lastWord.toLowerCase().endsWith("s") &&
          lastWord.toLowerCase() !== "they" &&
          lastWord.toLowerCase() !== "we" &&
          lastWord.toLowerCase() !== "you" &&
          lastWord.toLowerCase() !== "i"
        ) {
          const start = text.indexOf(" have ", haveIndex);
          if (start !== -1) {
            errors.push({
              id: generateErrorId(),
              start: start + 1,
              end: start + 5,
              word: "have",
              suggestions: ["has", "have"],
              type: "grammar",
            });
          }
        }
      }
      searchIndex = haveIndex + 1;
    }

    // Find ALL occurrences of "was" with plural subject
    searchIndex = 0;
    while (true) {
      const wasIndex = lowerText.indexOf(" was ", searchIndex);
      if (wasIndex === -1) break;

      if (wasIndex > 0) {
        const beforeWas = text
          .substring(Math.max(0, wasIndex - 10), wasIndex)
          .trim();
        const wordsBefore = beforeWas.split(/\s+/);
        const lastWord = wordsBefore[wordsBefore.length - 1];
        if (
          lastWord &&
          (lastWord.toLowerCase() === "they" ||
            lastWord.toLowerCase() === "we" ||
            lastWord.toLowerCase() === "you")
        ) {
          const start = text.indexOf(" was ", wasIndex);
          if (start !== -1) {
            errors.push({
              id: generateErrorId(),
              start: start + 1,
              end: start + 4,
              word: "was",
              suggestions: ["were", "was"],
              type: "grammar",
            });
          }
        }
      }
      searchIndex = wasIndex + 1;
    }

    // Find ALL occurrences of "do" with singular subject (e.g., "he do")
    searchIndex = 0;
    while (true) {
      const doIndex = lowerText.indexOf(" do ", searchIndex);
      if (doIndex === -1) break;

      if (doIndex > 0) {
        const beforeDo = text
          .substring(Math.max(0, doIndex - 10), doIndex)
          .trim();
        const wordsBefore = beforeDo.split(/\s+/);
        const lastWord = wordsBefore[wordsBefore.length - 1];
        if (
          lastWord &&
          (lastWord.toLowerCase() === "he" ||
            lastWord.toLowerCase() === "she" ||
            lastWord.toLowerCase() === "it")
        ) {
          const start = text.indexOf(" do ", doIndex);
          if (start !== -1) {
            errors.push({
              id: generateErrorId(),
              start: start + 1,
              end: start + 3,
              word: "do",
              suggestions: ["does", "do"],
              type: "grammar",
            });
          }
        }
      }
      searchIndex = doIndex + 1;
    }

    // Find ALL occurrences of "are" with singular subject (e.g., "he are")
    searchIndex = 0;
    while (true) {
      const areIndex = lowerText.indexOf(" are ", searchIndex);
      if (areIndex === -1) break;

      if (areIndex > 0) {
        const beforeAre = text
          .substring(Math.max(0, areIndex - 10), areIndex)
          .trim();
        const wordsBefore = beforeAre.split(/\s+/);
        const lastWord = wordsBefore[wordsBefore.length - 1];
        if (
          lastWord &&
          (lastWord.toLowerCase() === "he" ||
            lastWord.toLowerCase() === "she" ||
            lastWord.toLowerCase() === "it")
        ) {
          const start = text.indexOf(" are ", areIndex);
          if (start !== -1) {
            errors.push({
              id: generateErrorId(),
              start: start + 1,
              end: start + 4,
              word: "are",
              suggestions: ["is", "are"],
              type: "grammar",
            });
          }
        }
      }
      searchIndex = areIndex + 1;
    }

    // Remove duplicate errors (same position)
    const uniqueErrors = errors.filter(
      (error, index, self) =>
        index ===
        self.findIndex((e) => e.start === error.start && e.end === error.end)
    );

    // Generate corrected text
    let corrected = text;
    // Sort errors by position (reverse order to maintain indices)
    const sortedErrors = [...uniqueErrors].sort((a, b) => b.start - a.start);
    for (const error of sortedErrors) {
      if (error.suggestions.length > 0) {
        const before = corrected.substring(0, error.start);
        const after = corrected.substring(error.end);
        corrected = before + error.suggestions[0] + after;
      }
    }

    return {
      errors: uniqueErrors,
      corrected,
    };
  }

  /**
   * Validate and remove invalid highlights immediately when text changes
   */
  private validateAndRemoveInvalidHighlights(element: HTMLElement): void {
    // Don't validate during replace operations - positions are being updated
    if (this.isPerformingReplace) {
      return;
    }

    const currentErrors = this.grammarErrors.get(element);
    if (!currentErrors || currentErrors.length === 0) {
      return;
    }

    // Get current text (excluding signature to match error positions)
    const { text } = this.extractTextExcludingSignature(element);

    if (!this.highlightsContent) {
      return;
    }

    const elementId = this.getElementId(element);
    const highlights = this.highlightsContent.querySelectorAll(
      `[data-element-id="${elementId}"]`
    );

    highlights.forEach((highlight) => {
      const errorData = (highlight as HTMLElement).getAttribute("data-error");
      if (!errorData) {
        highlight.remove();
        return;
      }

      try {
        const error: GrammarError = JSON.parse(errorData);

        // Check if error position is still valid
        if (
          error.start < 0 ||
          error.end > text.length ||
          error.start >= error.end
        ) {
          // Position out of bounds, remove highlight
          highlight.remove();
          return;
        }

        // Check if the error word still matches at that position
        const errorWord = text.substring(error.start, error.end);
        // Strict matching: word must match exactly (case-insensitive, whitespace variations allowed)
        // If the word at that position has changed (e.g., "asd" -> "asdf"), highlight should be removed
        const isStillValid =
          errorWord.toLowerCase().trim() === error.word.toLowerCase().trim();

        if (!isStillValid) {
          // Word changed or deleted, remove highlight immediately
          highlight.remove();
        }
      } catch (e) {
        // Error parsing, remove highlight
        highlight.remove();
      }
    });

    // Update stored errors - remove invalid ones
    const validErrors = currentErrors.filter((error) => {
      if (
        error.start < 0 ||
        error.end > text.length ||
        error.start >= error.end
      ) {
        return false;
      }
      const errorWord = text.substring(error.start, error.end);
      // Strict matching: word must match exactly (case-insensitive, whitespace variations allowed)
      return errorWord.toLowerCase().trim() === error.word.toLowerCase().trim();
    });

    this.grammarErrors.set(element, validErrors);
  }

  /**
   * Display grammar errors on an element using Grammarly-style highlights
   */
  private displayGrammarErrors(
    element: HTMLElement,
    errors: GrammarError[]
  ): void {
    const isGoogleDocsElement =
      (element as any).__rewordlyIsGoogleDocs === true;
    console.log("Rewordly: displayGrammarErrors called", {
      errorsCount: errors.length,
      errors: errors,
      element: element.tagName,
      elementId: this.getElementId(element),
      isGoogleDocs: isGoogleDocsElement,
      hasContainer: !!(element as any).__rewordlyGoogleDocsContainer,
      elementTextPreview: (
        element.textContent ||
        element.innerText ||
        ""
      ).substring(0, 100),
    });

    // Ensure all errors have unique IDs (assign if missing from API response)
    const errorsWithIds = errors.map((error) => {
      if (!error.id) {
        return { ...error, id: generateErrorId() };
      }
      return error;
    });

    // Store errors (empty array if no errors)
    this.grammarErrors.set(element, errorsWithIds);

    // Ensure highlights container exists
    if (
      !this.highlightsContainer ||
      !this.highlightsShadowRoot ||
      !this.highlightsContent
    ) {
      this.createHighlightsContainer();
      if (
        !this.highlightsContainer ||
        !this.highlightsShadowRoot ||
        !this.highlightsContent
      ) {
        console.error("Rewordly: Failed to create highlights container");
        return;
      }
    }

    // Get existing highlights to compare by error ID and position/word (for matching after replace)
    const elementId = this.getElementId(element);
    const existingHighlights = this.highlightsContent.querySelectorAll(
      `[data-element-id="${elementId}"]`
    );
    const existingErrorMap = new Map<string, HTMLElement>(); // Key: error ID
    const existingErrorByPositionMap = new Map<string, HTMLElement>(); // Key: "start-end-word" for position-based matching

    existingHighlights.forEach((highlight) => {
      const errorData = (highlight as HTMLElement).getAttribute("data-error");
      if (errorData) {
        try {
          const error: GrammarError = JSON.parse(errorData);
          if (error.id) {
            existingErrorMap.set(error.id, highlight as HTMLElement);
          }
          // Also create position-based key for matching after replace (when IDs might differ)
          if (
            error.start !== undefined &&
            error.end !== undefined &&
            error.word
          ) {
            const positionKey = `${error.start}-${error.end}-${error.word
              .toLowerCase()
              .trim()}`;
            // Only set if not already set (prefer first highlight found for this position)
            if (!existingErrorByPositionMap.has(positionKey)) {
              existingErrorByPositionMap.set(
                positionKey,
                highlight as HTMLElement
              );
            }
          }
        } catch (e) {
          // Error parsing, skip
        }
      }
    });

    // If no errors, remove all highlights for this element
    if (errorsWithIds.length === 0) {
      existingErrorMap.forEach((highlight) => {
        highlight.remove();
      });
      return;
    }

    // Validate error positions against current text (excluding signature)
    // Use the same text extraction method as grammar check to ensure positions match
    const { text } = extractTextExcludingSignature(element);

    // Filter out errors that are no longer valid (text changed, error position out of bounds)
    const validErrors = errorsWithIds.filter((error) => {
      if (
        error.start < 0 ||
        error.end > text.length ||
        error.start >= error.end
      ) {
        console.warn("Rewordly: Error position out of bounds", {
          error,
          textLength: text.length,
          start: error.start,
          end: error.end,
        });
        return false;
      }
      // Check if the error word still matches at that position
      const errorWord = text.substring(error.start, error.end);
      // Strict matching: word must match exactly (case-insensitive, whitespace variations allowed)
      // If the word at that position has changed (e.g., "asd" -> "asdf"), highlight should be removed
      const isValid =
        errorWord.toLowerCase().trim() === error.word.toLowerCase().trim();

      if (!isValid) {
        console.warn("Rewordly: Error word mismatch", {
          error,
          errorWord,
          expectedWord: error.word,
          text: text.substring(
            Math.max(0, error.start - 5),
            Math.min(text.length, error.end + 5)
          ),
        });
        // Word changed, remove from dismissed list if it was dismissed
        const dismissKey = this.getDismissKey(elementId, error, text);
        this.dismissedErrors.delete(dismissKey);
        return false;
      }

      // Check if this error was dismissed
      if (this.isErrorDismissed(element, error)) {
        // Error is dismissed, filter it out
        return false;
      }

      return isValid;
    });

    console.log("Rewordly: displayGrammarErrors", {
      totalErrors: errorsWithIds.length,
      validErrors: validErrors.length,
      textLength: text.length,
      text: text.substring(0, 50) + "...",
    });

    // Update stored errors with only valid ones
    this.grammarErrors.set(element, validErrors);

    // Update or create highlights for each valid error
    validErrors.forEach((error, index) => {
      // First try to match by error ID
      let existingHighlight = existingErrorMap.get(error.id);

      // If not found by ID, try to match by position and word (for cases where API returns new IDs after replace)
      if (
        !existingHighlight &&
        error.start !== undefined &&
        error.end !== undefined &&
        error.word
      ) {
        const positionKey = `${error.start}-${error.end}-${error.word
          .toLowerCase()
          .trim()}`;
        existingHighlight = existingErrorByPositionMap.get(positionKey);

        // If found by position, update the error ID in the highlight to match the new error
        if (existingHighlight) {
          // Update error ID in all highlights for this position
          if (this.highlightsContent) {
            const allHighlightsForPosition = Array.from(
              this.highlightsContent.querySelectorAll(
                `[data-element-id="${elementId}"][data-error-id="${existingHighlight.getAttribute(
                  "data-error-id"
                )}"]`
              )
            ) as HTMLElement[];
            allHighlightsForPosition.forEach((h) => {
              h.setAttribute("data-error-id", error.id);
              h.setAttribute("data-error", JSON.stringify(error));
            });
          }
          // Update the map to reflect the new ID
          existingErrorMap.set(error.id, existingHighlight);
        }
      }

      if (existingHighlight) {
        // Check if this error is dismissed - if so, remove the highlight
        if (this.isErrorDismissed(element, error)) {
          // Remove all highlights for this dismissed error
          if (!this.highlightsContent) return;
          const errorHighlights = Array.from(
            this.highlightsContent.querySelectorAll(
              `[data-element-id="${this.getElementId(
                element
              )}"][data-error-id="${error.id}"]`
            )
          ) as HTMLElement[];
          errorHighlights.forEach((h) => h.remove());
          return;
        }

        // Same error position, just update position (text might have changed)
        // Get text to adjust positions for multi-word errors
        let text = "";
        if (
          element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement
        ) {
          text = element.value;
        } else if (
          element.getAttribute("contenteditable") === "true" ||
          element.isContentEditable
        ) {
          text = element.innerText || element.textContent || "";
        }

        // Adjust positions for multi-word grammar errors
        const adjustedPositions = text
          ? adjustErrorPositionsForMultiWord(text, error)
          : { start: error.start, end: error.end };
        const highlightRects = getErrorTextRects(
          element,
          adjustedPositions.start,
          adjustedPositions.end
        );

        // Get all existing highlights for this error
        if (!this.highlightsContent) return;
        const errorHighlights = Array.from(
          this.highlightsContent.querySelectorAll(
            `[data-element-id="${this.getElementId(element)}"][data-error-id="${
              error.id
            }"]`
          )
        ) as HTMLElement[];

        if (highlightRects.length > 0) {
          // Update or create highlights for each line
          highlightRects.forEach((highlightRect, lineIndex) => {
            let highlight = errorHighlights.find(
              (h) => h.getAttribute("data-line-index") === lineIndex.toString()
            );

            if (!highlight) {
              // Create new highlight for this line (no animation - this is an existing error, just new line)
              highlight = document.createElement("div");
              highlight.className = "rewordly-highlight";
              highlight.setAttribute("data-rewordly-part", "highlight");
              highlight.setAttribute("data-highlight-format", "underline");
              highlight.setAttribute("data-highlight-color-name", "red");
              highlight.setAttribute(
                "data-element-id",
                this.getElementId(element)
              );
              highlight.setAttribute("data-error-index", index.toString());
              highlight.setAttribute("data-error-id", error.id);
              highlight.setAttribute("data-line-index", lineIndex.toString());

              // Add hover listeners to all lines
              this.attachHighlightHoverListener(highlight, error, element);

              // Set position and size immediately (no animation for existing error's new line)
              highlight.style.top = `${highlightRect.top}px`;
              highlight.style.left = `${highlightRect.left}px`;
              highlight.style.width = `${highlightRect.width}px`;
              highlight.style.height = `${highlightRect.height}px`;
              highlight.style.opacity = "1";
              highlight.style.overflow = "visible";

              this.highlightsContent!.appendChild(highlight);
            }

            // Update position and size
            highlight.style.top = `${highlightRect.top}px`;
            highlight.style.left = `${highlightRect.left}px`;
            highlight.style.width = `${highlightRect.width}px`;
            highlight.style.height = `${highlightRect.height}px`;
            highlight.setAttribute("data-error", JSON.stringify(error));
            highlight.setAttribute("data-error-index", index.toString());
          });

          // Remove extra highlights if rect count decreased
          errorHighlights.forEach((highlight) => {
            const lineIndex = parseInt(
              highlight.getAttribute("data-line-index") || "0",
              10
            );
            if (lineIndex >= highlightRects.length) {
              highlight.remove();
            }
          });
        } else {
          // Position calculation failed - for Draft.js (Twitter), keep the highlight
          // It will be updated on the next position update after DOM settles
          console.warn(
            "Rewordly: Could not calculate position for existing error:",
            error.id
          );
          // Update error data anyway
          existingHighlight.setAttribute("data-error", JSON.stringify(error));
          existingHighlight.setAttribute("data-error-index", index.toString());
        }

        // If element has text, ensure highlight is visible (even if not focused)
        let hasText = false;
        if (
          element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement
        ) {
          hasText = element.value.trim().length > 0;
        } else if (
          element.getAttribute("contenteditable") === "true" ||
          element.isContentEditable
        ) {
          hasText =
            (element.innerText || element.textContent || "").trim().length > 0;
        }

        if (hasText) {
          // Make sure highlight is visible
          existingHighlight.style.display = "";
          existingHighlight.removeAttribute("data-hidden-by-blur");
        }
      } else {
        // New error or error position changed, create new highlight with animation
        this.createHighlight(element, error, index, true);
      }
    });

    // Remove highlights that no longer exist (errors that were fixed or removed)
    const currentErrorIds = new Set(validErrors.map((err) => err.id));
    existingErrorMap.forEach((highlight, errorId) => {
      if (!currentErrorIds.has(errorId)) {
        // Remove all highlights for this error (multi-line support)
        if (this.highlightsContent) {
          const allErrorHighlights = this.highlightsContent.querySelectorAll(
            `[data-element-id="${elementId}"][data-error-id="${errorId}"]`
          );
          allErrorHighlights.forEach((h) => h.remove());
        } else {
          highlight.remove();
        }
      } else {
        // Also check if this error is dismissed (double-check to be safe)
        const errorData = highlight.getAttribute("data-error");
        if (errorData) {
          try {
            const error: GrammarError = JSON.parse(errorData);
            if (this.isErrorDismissed(element, error)) {
              // Remove all highlights for this dismissed error (multi-line support)
              if (this.highlightsContent) {
                const allErrorHighlights =
                  this.highlightsContent.querySelectorAll(
                    `[data-element-id="${elementId}"][data-error-id="${errorId}"]`
                  );
                allErrorHighlights.forEach((h) => h.remove());
              } else {
                highlight.remove();
              }
            }
          } catch (e) {
            // Error parsing, skip
          }
        }
      }
    });

    // If element has text, ensure all highlights are visible (even if not focused)
    // For Google Docs, always show highlights
    const isGoogleDocs = (element as any).__rewordlyIsGoogleDocs === true;
    let hasText = false;
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
    ) {
      hasText = element.value.trim().length > 0;
    } else if (
      element.getAttribute("contenteditable") === "true" ||
      element.isContentEditable
    ) {
      hasText =
        (element.innerText || element.textContent || "").trim().length > 0;
    }

    if ((isGoogleDocs || hasText) && this.highlightsContent) {
      const elementId = this.getElementId(element);
      const allHighlights = this.highlightsContent.querySelectorAll(
        `[data-element-id="${elementId}"]`
      );
      allHighlights.forEach((highlight) => {
        (highlight as HTMLElement).style.display = "";
        (highlight as HTMLElement).style.opacity = "1";
        (highlight as HTMLElement).removeAttribute("data-hidden-by-blur");
        (highlight as HTMLElement).removeAttribute("data-hidden-by-modal");
        (highlight as HTMLElement).removeAttribute("data-hidden-by-scroll");
      });
    }

    // Update highlights on scroll/resize
    this.highlightHelper.updatePositions(
      element,
      errors,
      (error: GrammarError) =>
        getErrorTextRects(element, error.start, error.end)
    );
  }

  /**
   * Get unique ID for an element
   */
  private getElementId(element: HTMLElement): string {
    if (!(element as any).__rewordlyId) {
      (element as any).__rewordlyId = `rewordly-${Date.now()}-${Math.random()
        .toString(36)
        .substr(2, 9)}`;
    }
    return (element as any).__rewordlyId;
  }

  /**
   * Check if grammar check is allowed on the current site
   * Delegates to helper function
   */
  private isGrammarCheckAllowedSite(): boolean {
    return isGrammarCheckAllowedSite();
  }

  /**
   * Set up platform-specific adapter
   */
  private setupPlatformAdapter(): void {
    // Create grammar check callback
    const onGrammarCheck = async (text: string): Promise<GrammarError[]> => {
      try {
        const response = await checkGrammarAPI(this.apiUtil, text);

        // Check if detected language is English
        if (
          response.detectedLanguage &&
          !response.detectedLanguage.code.toLowerCase().startsWith("en")
        ) {
          return [];
        }

        // Errors already have IDs from checkGrammarAPI
        return response.errors;
      } catch (error) {
        console.error("Rewordly: Grammar check error:", error);
        return [];
      }
    };

    // Create platform adapter using helper
    this.platformAdapter = createPlatformAdapterForSite(onGrammarCheck);

    if (this.platformAdapter && this.platformAdapter.isGrammarCheckEnabled()) {
      console.log(
        `Rewordly: Initializing ${this.platformAdapter.platform} adapter`
      );
      this.platformAdapter.initialize();
    }
  }

  /**
   * Show grammar highlights for an element (if errors exist)
   */
  private showGrammarOverlay(element: HTMLElement): void {
    if (!this.grammarErrors.has(element)) {
      return;
    }

    if (!this.highlightsContent) {
      // Recreate if doesn't exist
      const errors = this.grammarErrors.get(element);
      if (errors) {
        this.displayGrammarErrors(element, errors);
      }
      return;
    }

    const elementId = this.getElementId(element);
    const highlights = this.highlightsContent.querySelectorAll(
      `[data-element-id="${elementId}"]`
    );

    if (highlights.length === 0) {
      // Recreate if doesn't exist
      const errors = this.grammarErrors.get(element);
      if (errors) {
        this.displayGrammarErrors(element, errors);
      }
    } else {
      // Show existing highlights, but skip dismissed ones
      const errors = this.grammarErrors.get(element) || [];
      const errorIdToError = new Map<string, GrammarError>();
      errors.forEach((err) => {
        if (err.id) {
          errorIdToError.set(err.id, err);
        }
      });

      const dismissedErrorIds = new Set<string>();

      highlights.forEach((highlight) => {
        const htmlHighlight = highlight as HTMLElement;
        const errorId = htmlHighlight.getAttribute("data-error-id");

        if (errorId) {
          const error = errorIdToError.get(errorId);
          if (error && this.isErrorDismissed(element, error)) {
            // Mark this error as dismissed - we'll remove all highlights for it
            dismissedErrorIds.add(errorId);
            return;
          }
        }

        // Not dismissed, show it
        htmlHighlight.style.display = "";
        htmlHighlight.removeAttribute("data-hidden-by-blur");
        htmlHighlight.removeAttribute("data-hidden-by-modal");
      });

      // Remove all highlights for dismissed errors (multi-line support)
      if (dismissedErrorIds.size > 0 && this.highlightsContent) {
        dismissedErrorIds.forEach((errorId) => {
          const allErrorHighlights = this.highlightsContent!.querySelectorAll(
            `[data-element-id="${elementId}"][data-error-id="${errorId}"]`
          );
          allErrorHighlights.forEach((h) => h.remove());
        });
      }
      // Update positions
      this.highlightHelper.updatePositions(
        element,
        errors,
        (error: GrammarError) =>
          getErrorTextRects(element, error.start, error.end)
      );
    }
  }

  /**
   * Clear grammar errors from an element (permanently remove)
   */
  private clearGrammarErrors(element: HTMLElement): void {
    // Remove highlights for this element
    this.clearElementHighlights(element);

    // Clear stored errors
    this.grammarErrors.delete(element);
  }

  /**
   * Clear all grammar errors (cleanup function)
   */
  private clearAllGrammarErrors(): void {
    // Get all elements with errors
    const elementsWithErrors = Array.from(this.grammarErrors.keys());

    elementsWithErrors.forEach((element) => {
      // Check if element still exists in DOM
      if (!document.contains(element) && !element.isConnected) {
        this.clearGrammarErrors(element);
      }
    });
  }

  /**
   * Create Grammarly-style highlights container with Shadow DOM
   */
  private createHighlightsContainer(): void {
    // Remove existing container if any
    if (this.highlightsContainer) {
      this.highlightsContainer.remove();
    }

    // Create container element (like <grammarly-highlights>)
    this.highlightsContainer = document.createElement("rewordly-highlights");
    this.highlightsContainer.setAttribute("data-rewordly-shadow-root", "true");

    // Use maximum z-index for Reddit (Reddit has high z-index modals)
    const isReddit = window.location.hostname.includes("reddit.com");
    const zIndex = isReddit ? "2147483647" : "2147483645";

    this.highlightsContainer.style.cssText = `
      position: fixed !important;
      top: 0 !important;
      left: 0 !important;
      width: 0 !important;
      height: 0 !important;
      pointer-events: none !important;
      z-index: ${zIndex} !important;
      overflow: visible !important;
      visibility: visible !important;
    `;

    // Create Shadow DOM
    this.highlightsShadowRoot = this.highlightsContainer.attachShadow({
      mode: "open",
    });

    // Create content div inside Shadow DOM
    this.highlightsContent = document.createElement("div");
    this.highlightsContent.setAttribute("data-rewordly-part", "highlights");
    this.highlightsContent.style.cssText = `
      position: absolute !important;
      top: 0 !important;
      left: 0 !important;
      width: 100vw !important;
      height: 100vh !important;
      pointer-events: none !important;
      overflow: visible !important;
    `;

    // Add styles to Shadow DOM
    const style = document.createElement("style");
    // Use the same isReddit variable defined above
    style.textContent = `
      .rewordly-highlight {
        position: absolute !important;
        pointer-events: auto !important;
        cursor: pointer !important;
        border-bottom: 2px solid #ef4444 !important;
        box-sizing: content-box !important;
        z-index: ${isReddit ? "2147483647" : "1"} !important;
        /* No transition for position updates - only animate on initial creation */
        transition: none !important;
        transform-origin: left center !important;
        ${isReddit ? "background: rgba(239, 68, 68, 0.05) !important;" : ""}
      }
      .rewordly-highlight:hover {
        background: rgba(239, 68, 68, 0.1) !important;
      }
      .rewordly-highlight.rewordly-highlight-enter {
        overflow: hidden !important;
      }
      .rewordly-highlight.rewordly-no-transition {
        transition: none !important;
        will-change: auto !important;
      }
    `;

    this.highlightsShadowRoot.appendChild(style);
    this.highlightsShadowRoot.appendChild(this.highlightsContent);

    // Append to document body (at the end, like Grammarly)
    document.body.appendChild(this.highlightsContainer);
  }

  /**
   * Create a single highlight for an error
   * @param animate - Whether to animate the highlight (default: true)
   */
  private createHighlight(
    element: HTMLElement,
    error: GrammarError,
    index: number,
    animate: boolean = true
  ): void {
    if (!this.highlightsContent) {
      return;
    }

    // Don't create highlight if error is dismissed
    if (this.isErrorDismissed(element, error)) {
      return;
    }

    // Get text from element (excluding signature)
    const { text } = extractTextExcludingSignature(element);

    if (!text || error.start >= text.length || error.end > text.length) {
      return;
    }

    // Adjust positions for multi-word grammar errors to highlight only problematic word(s)
    const adjustedPositions = adjustErrorPositionsForMultiWord(text, error);
    const highlightStart = adjustedPositions.start;
    const highlightEnd = adjustedPositions.end;

    // Get all rects for multi-line support (one rect per line)
    const highlightRects = getErrorTextRects(
      element,
      highlightStart,
      highlightEnd
    );
    if (highlightRects.length === 0) {
      const isGoogleDocs = (element as any).__rewordlyIsGoogleDocs === true;
      console.warn("Rewordly: No highlight rects found", {
        error,
        highlightStart,
        highlightEnd,
        textLength: text.length,
        elementType:
          element instanceof HTMLInputElement
            ? "input"
            : element instanceof HTMLTextAreaElement
            ? "textarea"
            : "contenteditable",
        isGoogleDocs,
        errorText: text.substring(
          Math.max(0, highlightStart - 10),
          Math.min(text.length, highlightEnd + 10)
        ),
        elementTextPreview: (
          element.textContent ||
          element.innerText ||
          ""
        ).substring(0, 100),
      });
      return;
    }

    console.log("Rewordly: Creating highlight", {
      error,
      highlightRects: highlightRects.length,
      highlightStart,
      highlightEnd,
      firstRect: highlightRects[0]
        ? {
            left: highlightRects[0].left,
            top: highlightRects[0].top,
            width: highlightRects[0].width,
            height: highlightRects[0].height,
          }
        : null,
      isGoogleDocs: (element as any).__rewordlyIsGoogleDocs === true,
    });

    // Create a highlight element for each rect (each line)
    highlightRects.forEach((highlightRect, lineIndex) => {
      // Create highlight element
      const highlight = document.createElement("div");
      highlight.className = "rewordly-highlight";
      highlight.setAttribute("data-rewordly-part", "highlight");
      highlight.setAttribute("data-highlight-format", "underline");
      highlight.setAttribute("data-highlight-color-name", "red");
      highlight.setAttribute("data-element-id", this.getElementId(element));
      highlight.setAttribute("data-error-index", index.toString());
      highlight.setAttribute("data-error-id", error.id); // Store error ID for quick lookup
      highlight.setAttribute("data-line-index", lineIndex.toString()); // Track which line this highlight is for
      highlight.setAttribute("data-error", JSON.stringify(error));

      // Set position and size
      highlight.style.top = `${highlightRect.top}px`;
      highlight.style.left = `${highlightRect.left}px`;
      highlight.style.height = `${highlightRect.height}px`;

      // Store target width for animation
      const targetWidth = highlightRect.width;

      // Add hover listeners to all lines - tooltip will be shared by error ID
      this.attachHighlightHoverListener(highlight, error, element);

      // Append to highlights content
      if (!this.highlightsContent) return;
      this.highlightsContent.appendChild(highlight);

      if (animate) {
        // Initially set width to 0 for animation
        highlight.style.width = "0px";
        highlight.style.overflow = "hidden";
        highlight.style.opacity = "0";

        // Add animation class
        highlight.classList.add("rewordly-highlight-enter");

        // Force reflow to ensure animation starts
        void highlight.offsetWidth;

        // Animate width using requestAnimationFrame for smooth animation
        const startTime = performance.now();
        const duration = 300; // 300ms
        const startWidth = 0;
        const startOpacity = 0;
        const endOpacity = 1;

        const animateFn = (currentTime: number) => {
          const elapsed = currentTime - startTime;
          const progress = Math.min(elapsed / duration, 1);

          // Ease-in-out function
          const easeInOut =
            progress < 0.5
              ? 2 * progress * progress
              : 1 - Math.pow(-2 * progress + 2, 2) / 2;

          const currentWidth =
            startWidth + (targetWidth - startWidth) * easeInOut;
          const currentOpacity =
            startOpacity + (endOpacity - startOpacity) * easeInOut;

          highlight.style.width = `${currentWidth}px`;
          highlight.style.opacity = `${currentOpacity}`;

          if (progress < 1) {
            requestAnimationFrame(animateFn);
          } else {
            // Animation complete
            highlight.style.width = `${targetWidth}px`;
            highlight.style.opacity = "1";
            highlight.style.overflow = "visible";
            highlight.classList.remove("rewordly-highlight-enter");
          }
        };

        requestAnimationFrame(animateFn);
      } else {
        // No animation - set final values immediately
        highlight.style.width = `${targetWidth}px`;
        highlight.style.opacity = "1";
        highlight.style.overflow = "visible";
      }
    });
  }

  private isElementIgnored(element: HTMLElement): boolean {
    return isElementIgnored(getElementId(element), this.ignoredElementIds);
  }

  private isErrorDismissed(element: HTMLElement, error: GrammarError): boolean {
    const elementId = getElementId(element);

    // Get current text to verify position is still valid
    let text = "";
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
    ) {
      text = element.value;
    } else if (
      element.getAttribute("contenteditable") === "true" ||
      element.isContentEditable
    ) {
      text = element.innerText || element.textContent || "";
    }

    return isErrorDismissed(elementId, error, text, this.dismissedErrors);
  }

  private getDismissKey(
    elementId: string,
    error: GrammarError,
    text: string
  ): string {
    const wordLower = error.word.toLowerCase().trim();
    const beforeContext = text
      .substring(Math.max(0, error.start - 10), error.start)
      .toLowerCase()
      .trim();
    const afterContext = text
      .substring(error.end, Math.min(text.length, error.end + 10))
      .toLowerCase()
      .trim();

    return `${elementId}:${wordLower}:${beforeContext}:${afterContext}`;
  }

  /**
   * Get error rect for contenteditable elements
   */

  /**
   * Clear highlights for a specific element
   */
  private clearElementHighlights(element: HTMLElement): void {
    if (!this.highlightsContent) return;

    const elementId = this.getElementId(element);
    const highlights = this.highlightsContent.querySelectorAll(
      `[data-element-id="${elementId}"]`
    );
    highlights.forEach((highlight) => highlight.remove());

    // Remove scroll listeners for this element
    this.removeElementScrollListeners(element);
  }

  /**
   * Attach hover listener to highlight
   */
  private attachHighlightHoverListener(
    highlight: HTMLElement,
    error: GrammarError,
    element: HTMLElement
  ): void {
    let tooltipTimeout: number | null = null;

    const closeTooltip = () => {
      if (tooltipTimeout !== null) {
        clearTimeout(tooltipTimeout);
        tooltipTimeout = null;
      }
    };

    highlight.addEventListener("mouseenter", () => {
      // Close any existing tooltip for this error ID
      closeTooltip();

      // Close all other tooltips when opening a new one
      closeAllGrammarTooltips();

      // Get current errors
      const currentErrors = this.grammarErrors.get(element) || [];

      // Find the current error by ID (guaranteed to find the exact error)
      let currentError = currentErrors.find((err) => err.id === error.id);

      // If error not found (shouldn't happen), use the stored error as fallback
      if (!currentError) {
        currentError = error;
      }

      // Create tooltip
      const tooltip = document.createElement("div");
      tooltip.className = "rewordly-grammar-tooltip";

      // Limit initial suggestions display (show first 5, rest with "see more")
      const INITIAL_SUGGESTIONS_LIMIT = 5;
      const allSuggestions = currentError.suggestions || [];
      const hasMoreSuggestions =
        allSuggestions.length > INITIAL_SUGGESTIONS_LIMIT;
      const initialSuggestions = hasMoreSuggestions
        ? allSuggestions.slice(0, INITIAL_SUGGESTIONS_LIMIT)
        : allSuggestions;
      const remainingSuggestions = hasMoreSuggestions
        ? allSuggestions.slice(INITIAL_SUGGESTIONS_LIMIT)
        : [];

      const initialSuggestionsHtml =
        initialSuggestions.length > 0
          ? initialSuggestions
              .map((suggestion, index) => {
                // Format suggestion for display - make whitespace visible
                const displayText = formatSuggestionForDisplay(
                  suggestion,
                  currentError.word
                );
                return `<button class="rewordly-grammar-suggestion" data-suggestion="${escapeHtml(
                  suggestion
                )}" data-error-start="${currentError.start}" data-error-end="${
                  currentError.end
                }" data-suggestion-index="${index}">${escapeHtml(
                  displayText
                )}</button>`;
              })
              .join("")
          : '<div class="rewordly-grammar-no-suggestions">No suggestions available</div>';

      const remainingSuggestionsHtml =
        remainingSuggestions.length > 0
          ? remainingSuggestions
              .map((suggestion, index) => {
                const displayText = formatSuggestionForDisplay(
                  suggestion,
                  currentError.word
                );
                return `<button class="rewordly-grammar-suggestion rewordly-grammar-suggestion-hidden" data-suggestion="${escapeHtml(
                  suggestion
                )}" data-error-start="${currentError.start}" data-error-end="${
                  currentError.end
                }" data-suggestion-index="${
                  initialSuggestions.length + index
                }">${escapeHtml(displayText)}</button>`;
              })
              .join("")
          : "";

      const seeMoreButtonHtml = hasMoreSuggestions
        ? `<button class="rewordly-grammar-see-more" data-error-id="${currentError.id}">See more (${remainingSuggestions.length})</button>`
        : "";

      tooltip.innerHTML = `
        <div class="rewordly-grammar-tooltip-content">
          <div class="rewordly-grammar-tooltip-word">${escapeHtml(
            currentError.word
          )}</div>
          <div class="rewordly-grammar-tooltip-suggestions">
            ${initialSuggestionsHtml}
            ${remainingSuggestionsHtml}
          </div>
          ${seeMoreButtonHtml}
          <button class="rewordly-grammar-dismiss" data-error-id="${
            currentError.id
          }">Dismiss</button>
        </div>
      `;

      document.body.appendChild(tooltip);

      // Calculate available screen space for max-height
      const highlightRect = highlight.getBoundingClientRect();
      const viewportHeight = window.innerHeight;
      const viewportWidth = window.innerWidth;

      // Calculate space above and below the highlight
      const spaceAbove = highlightRect.top;
      const spaceBelow = viewportHeight - highlightRect.bottom;

      // Use the larger space, but leave some margin (at least 16px from edges)
      const maxAvailableHeight = Math.max(spaceAbove, spaceBelow) - 32; // 16px margin top + 16px margin bottom

      // Set a reasonable minimum and maximum
      const MIN_TOOLTIP_HEIGHT = 100;
      const MAX_TOOLTIP_HEIGHT = 400;
      const calculatedMaxHeight = Math.max(
        MIN_TOOLTIP_HEIGHT,
        Math.min(MAX_TOOLTIP_HEIGHT, maxAvailableHeight)
      );

      // Apply max-height to suggestions container
      const suggestionsContainer = tooltip.querySelector(
        ".rewordly-grammar-tooltip-suggestions"
      ) as HTMLElement;
      if (suggestionsContainer) {
        suggestionsContainer.style.maxHeight = `${calculatedMaxHeight}px`;
        suggestionsContainer.style.overflowY = "auto";
        suggestionsContainer.style.overflowX = "hidden";
      }

      // Position tooltip
      const tooltipRect = tooltip.getBoundingClientRect();
      const tooltipTop = highlightRect.top - tooltipRect.height - 8;
      const tooltipLeft =
        highlightRect.left + highlightRect.width / 2 - tooltipRect.width / 2;

      // Ensure tooltip doesn't go outside screen bounds horizontally
      const adjustedLeft = Math.max(
        8,
        Math.min(tooltipLeft, viewportWidth - tooltipRect.width - 8)
      );

      // Ensure tooltip doesn't go outside screen bounds vertically
      let adjustedTop = tooltipTop;
      if (tooltipTop < 8) {
        // Not enough space above, try below
        adjustedTop = highlightRect.bottom + 8;
        // If still doesn't fit below, adjust to fit within viewport
        if (adjustedTop + tooltipRect.height > viewportHeight - 8) {
          adjustedTop = Math.max(8, viewportHeight - tooltipRect.height - 8);
        }
      } else if (adjustedTop + tooltipRect.height > viewportHeight - 8) {
        // Doesn't fit below, adjust to fit within viewport
        adjustedTop = Math.max(8, viewportHeight - tooltipRect.height - 8);
      }

      tooltip.style.top = `${adjustedTop}px`;
      tooltip.style.left = `${adjustedLeft}px`;

      // Attach click handlers
      const suggestionButtons = tooltip.querySelectorAll(
        ".rewordly-grammar-suggestion"
      );
      suggestionButtons.forEach((button) => {
        button.addEventListener("click", (e) => {
          e.stopPropagation();
          e.preventDefault();

          const suggestion = (button as HTMLElement).getAttribute(
            "data-suggestion"
          );
          if (!suggestion) return;

          // Get error data directly from highlight - this is the most reliable source
          const errorData = highlight.getAttribute("data-error");
          const errorId = highlight.getAttribute("data-error-id");

          if (!errorId || !errorData) {
            console.error("Rewordly: No error data found on highlight", {
              errorId,
              hasErrorData: !!errorData,
            });
            return;
          }

          let targetError: GrammarError;
          try {
            targetError = JSON.parse(errorData);
          } catch (e) {
            console.error(
              "Rewordly: Failed to parse error data from highlight",
              e
            );
            return;
          }

          closeTooltip();
          this.closeAllGrammarTooltips();

          // Use the error directly from highlight - no need to search in maps
          this.replaceGrammarError(element, targetError, suggestion);
        });
      });

      // Attach "see more" button handler
      const seeMoreButton = tooltip.querySelector(".rewordly-grammar-see-more");
      if (seeMoreButton) {
        seeMoreButton.addEventListener("click", (e) => {
          e.stopPropagation();
          e.preventDefault();

          // Show all hidden suggestions
          const hiddenSuggestions = tooltip.querySelectorAll(
            ".rewordly-grammar-suggestion-hidden"
          );
          hiddenSuggestions.forEach((suggestion) => {
            suggestion.classList.remove("rewordly-grammar-suggestion-hidden");
          });

          // Hide the "see more" button
          seeMoreButton.remove();

          // Recalculate tooltip position after showing all suggestions
          const updatedTooltipRect = tooltip.getBoundingClientRect();
          const updatedHighlightRect = highlight.getBoundingClientRect();
          const updatedTooltipTop =
            updatedHighlightRect.top - updatedTooltipRect.height - 8;
          const updatedTooltipLeft =
            updatedHighlightRect.left +
            updatedHighlightRect.width / 2 -
            updatedTooltipRect.width / 2;

          const updatedAdjustedLeft = Math.max(
            8,
            Math.min(
              updatedTooltipLeft,
              window.innerWidth - updatedTooltipRect.width - 8
            )
          );
          let updatedAdjustedTop = updatedTooltipTop;

          if (updatedTooltipTop < 8) {
            updatedAdjustedTop = updatedHighlightRect.bottom + 8;
            if (
              updatedAdjustedTop + updatedTooltipRect.height >
              window.innerHeight - 8
            ) {
              updatedAdjustedTop = Math.max(
                8,
                window.innerHeight - updatedTooltipRect.height - 8
              );
            }
          } else if (
            updatedAdjustedTop + updatedTooltipRect.height >
            window.innerHeight - 8
          ) {
            updatedAdjustedTop = Math.max(
              8,
              window.innerHeight - updatedTooltipRect.height - 8
            );
          }

          tooltip.style.top = `${updatedAdjustedTop}px`;
          tooltip.style.left = `${updatedAdjustedLeft}px`;
        });
      }

      // Attach dismiss button handler
      const dismissButton = tooltip.querySelector(".rewordly-grammar-dismiss");
      if (dismissButton) {
        dismissButton.addEventListener("click", (e) => {
          e.stopPropagation();
          e.preventDefault();

          // Get error ID from the highlight
          const errorId = highlight.getAttribute("data-error-id");
          if (!errorId) {
            console.error("Rewordly: No error ID found on highlight");
            return;
          }

          // Find the error in the stored errors
          const errors = this.grammarErrors.get(element) || [];
          const error = errors.find((err) => err.id === errorId);

          if (error) {
            // Add to dismissed list
            // Dismiss based on word + context (handles position changes)
            const elementId = this.getElementId(element);

            // Get current text to generate context-based key
            let text = "";
            if (
              element instanceof HTMLInputElement ||
              element instanceof HTMLTextAreaElement
            ) {
              text = element.value;
            } else if (
              element.getAttribute("contenteditable") === "true" ||
              element.isContentEditable
            ) {
              text = element.innerText || element.textContent || "";
            }

            const dismissKey = this.getDismissKey(elementId, error, text);
            this.dismissedErrors.set(dismissKey, true);

            // Remove error from grammarErrors map to prevent it from reappearing
            const currentErrors = this.grammarErrors.get(element) || [];
            const updatedErrors = currentErrors.filter(
              (err) => err.id !== error.id
            );
            this.grammarErrors.set(element, updatedErrors);

            // Remove all highlights for this error (multi-line support)
            if (this.highlightsContent) {
              const allErrorHighlights =
                this.highlightsContent.querySelectorAll(
                  `[data-element-id="${elementId}"][data-error-id="${error.id}"]`
                );
              allErrorHighlights.forEach((h) => h.remove());
            } else {
              highlight.remove();
            }

            // Close tooltip
            closeTooltip();
            this.closeAllGrammarTooltips();

            // Restore focus after dismiss (similar to replace)
            // Cancel any scheduled blur handlers for this element
            const existingBlurTimeout = this.scheduledBlurHandlers.get(element);
            if (existingBlurTimeout) {
              clearTimeout(existingBlurTimeout);
              this.scheduledBlurHandlers.delete(element);
            }

            // Use requestAnimationFrame to ensure DOM is ready before focusing
            requestAnimationFrame(() => {
              // Keep flag true during focus restore to prevent blur handler from hiding highlights
              this.isPerformingDismiss = true;

              element.focus();

              // Set cursor position to the end of the dismissed error
              if (error) {
                const cursorPosition = error.end;

                if (
                  element instanceof HTMLInputElement ||
                  element instanceof HTMLTextAreaElement
                ) {
                  // For input/textarea, use setSelectionRange
                  element.setSelectionRange(cursorPosition, cursorPosition);
                } else if (
                  element.getAttribute("contenteditable") === "true" ||
                  element.isContentEditable
                ) {
                  // For contenteditable, use Range API
                  const selection = window.getSelection();
                  if (selection) {
                    const cursorMapping = mapInnerTextToTextNodes(
                      element,
                      cursorPosition,
                      cursorPosition
                    );
                    if (cursorMapping && cursorMapping.startNode) {
                      const cursorRange = document.createRange();
                      const offset = Math.min(
                        cursorMapping.startOffset,
                        cursorMapping.startNode.textContent!.length
                      );
                      cursorRange.setStart(cursorMapping.startNode, offset);
                      cursorRange.collapse(true);
                      selection.removeAllRanges();
                      selection.addRange(cursorRange);
                    }
                  }
                }
              }

              // Clear the dismiss flag after a short delay to ensure focus is stable
              setTimeout(() => {
                this.isPerformingDismiss = false;
              }, 150);
            });
          }
        });
      }

      tooltip.addEventListener("mouseleave", () => {
        tooltipTimeout = window.setTimeout(() => {
          // Check if any highlight for this error is still hovered
          const allHighlightsForError =
            this.highlightsContent?.querySelectorAll(
              `[data-error-id="${error.id}"]`
            ) || [];
          const isAnyHighlightHovered = Array.from(allHighlightsForError).some(
            (h) => (h as HTMLElement).matches(":hover")
          );

          if (!isAnyHighlightHovered && !tooltip.matches(":hover")) {
            closeTooltip();
          }
        }, 100);
      });
    });
  }

  /**
   * Set up scroll listeners for a specific editable element
   */
  private setupElementScrollListeners(element: HTMLElement): void {
    // Remove existing listeners for this element
    this.removeElementScrollListeners(element);

    // Find scrollable containers
    const containers = this.scrollableContainers.get(element) || new Set();
    this.scrollableContainers.set(element, containers);

    // Add scroll listeners to each scrollable container
    containers.forEach((container) => {
      // Check if we already have a listener for this container
      if (!this.scrollListeners.has(container)) {
        const updateAllForContainer = () => {
          // Update highlights for all elements that have this container as a scrollable parent
          this.scrollableContainers.forEach((containers, el) => {
            if (containers.has(container) && this.grammarErrors.has(el)) {
              this.highlightHelper.updatePositions(
                el,
                this.grammarErrors.get(el) || [],
                (error: GrammarError) =>
                  getErrorTextRects(el, error.start, error.end)
              );
            }
          });
        };

        container.addEventListener("scroll", updateAllForContainer, {
          passive: true,
        });
        this.scrollListeners.set(container, updateAllForContainer);
      }
    });
  }

  /**
   * Remove scroll listeners for a specific editable element
   */
  private removeElementScrollListeners(element: HTMLElement): void {
    const containers = this.scrollableContainers.get(element);
    if (!containers) return;

    // Check if any other elements use these containers
    containers.forEach((container) => {
      let isUsedByOthers = false;
      this.scrollableContainers.forEach((otherContainers, otherElement) => {
        if (otherElement !== element && otherContainers.has(container)) {
          isUsedByOthers = true;
        }
      });

      // If no other elements use this container, remove the listener
      if (!isUsedByOthers) {
        const listener = this.scrollListeners.get(container);
        if (listener) {
          container.removeEventListener("scroll", listener);
          this.scrollListeners.delete(container);
        }
      }
    });

    this.scrollableContainers.delete(element);
  }

  /**
   * Set up scroll/resize listeners for highlights
   */
  private setupHighlightsUpdateListeners(): void {
    const updateAllHighlights = () => {
      // Update highlights for all elements with errors
      // Skip transitions during scroll for instant position updates
      this.grammarErrors.forEach((_errors, element) => {
        this.highlightHelper.updatePositions(
          element,
          _errors,
          (error: GrammarError) =>
            getErrorTextRects(element, error.start, error.end)
        );
      });
    };

    window.addEventListener("scroll", updateAllHighlights, true);
    window.addEventListener("resize", updateAllHighlights);
  }

  /**
   * Close all grammar tooltips
   */
  private closeAllGrammarTooltips(): void {
    const allTooltips = document.querySelectorAll(".rewordly-grammar-tooltip");
    allTooltips.forEach((tooltip) => {
      tooltip.remove();
    });
  }

  /**
   * Replace grammar error by error ID (most reliable - handles duplicate words perfectly)
   */

  /**
   * Replace grammar error with suggestion
   * @param element - The element containing the error
   * @param targetError - The error to replace (from highlight's data-error attribute)
   * @param replacement - The replacement text
   */
  private replaceGrammarError(
    element: HTMLElement,
    targetError: GrammarError,
    replacement: string
  ): void {
    if (!targetError || !targetError.id) {
      console.error("Rewordly: Invalid error provided", targetError);
      return;
    }

    const errorId = targetError.id;

    // Close all tooltips before replacement
    this.closeAllGrammarTooltips();

    // Get current errors for position updates
    const currentErrors = this.grammarErrors.get(element) || [];

    // Use the error's positions (they are always up-to-date if from grammarErrors,
    // but might be outdated if from highlight - we'll validate below)
    let actualStart = targetError.start;
    let actualEnd = targetError.end;

    // Validate positions against current text length
    let currentText = "";
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
    ) {
      currentText = element.value;
    } else if (
      element.getAttribute("contenteditable") === "true" ||
      element.isContentEditable
    ) {
      currentText = element.innerText || element.textContent || "";
    }

    // Validate positions
    if (
      actualStart < 0 ||
      actualEnd > currentText.length ||
      actualStart >= actualEnd
    ) {
      // If positions are invalid, try to find the word in current text as fallback
      if (targetError.word) {
        // Try to find the word near the original position (within 50 chars)
        const searchStart = Math.max(
          0,
          Math.min(actualStart, currentText.length - 1)
        );
        const wordIndex = currentText.indexOf(
          targetError.word,
          Math.max(0, searchStart - 50)
        );
        if (wordIndex !== -1) {
          actualStart = wordIndex;
          actualEnd = wordIndex + targetError.word.length;
          console.warn(
            "Rewordly: Recalculated error positions (original positions were invalid)",
            {
              errorId,
              oldStart: targetError.start,
              oldEnd: targetError.end,
              newStart: actualStart,
              newEnd: actualEnd,
              word: targetError.word,
            }
          );
        } else {
          console.error(
            "Rewordly: Invalid error positions and word not found in text",
            {
              actualStart,
              actualEnd,
              textLength: currentText.length,
              errorId: targetError.id,
              word: targetError.word,
            }
          );
          return;
        }
      } else {
        console.error(
          "Rewordly: Invalid error positions and no word to search for",
          {
            actualStart,
            actualEnd,
            textLength: currentText.length,
            errorId: targetError.id,
          }
        );
        return;
      }
    }

    // Update stored errors - remove the replaced error by ID
    const updatedErrors = currentErrors.filter((err) => err.id !== errorId);
    this.grammarErrors.set(element, updatedErrors);

    // Remove only the replaced error's highlight (not all highlights) - match by ID
    // Do this AFTER updating grammarErrors to ensure consistency
    if (this.highlightsContent) {
      const elementId = this.getElementId(element);
      const highlights = this.highlightsContent.querySelectorAll(
        `[data-element-id="${elementId}"]`
      );
      highlights.forEach((highlight) => {
        const highlightErrorId = (highlight as HTMLElement).getAttribute(
          "data-error-id"
        );
        if (highlightErrorId === errorId) {
          highlight.remove();
        }
      });
    }

    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
    ) {
      // For input/textarea
      // Set flag to prevent blur handler from hiding highlights during replace
      this.isPerformingReplace = true;

      const text = element.value;
      const newText =
        text.substring(0, actualStart) +
        replacement +
        text.substring(actualEnd);
      const replacementLength = replacement.length;
      const originalLength = actualEnd - actualStart;
      const lengthDiff = replacementLength - originalLength;

      element.value = newText;

      // Update error positions for remaining errors (they may have shifted)
      const updatedErrorsAfterReplace = updatedErrors.map((err) => {
        // If error is after the replaced text, adjust its position
        if (err.start > actualEnd) {
          return {
            ...err,
            start: err.start + lengthDiff,
            end: err.end + lengthDiff,
          };
        }
        // If error overlaps with replaced text, it's already removed
        return err;
      });
      this.grammarErrors.set(element, updatedErrorsAfterReplace);

      // Update all highlight data-error attributes with new positions - match by ID
      // This ensures all highlights have the most up-to-date error data
      // IMPORTANT: Do this BEFORE updateHighlightsPosition to ensure highlights have correct data
      if (this.highlightsContent) {
        const elementId = this.getElementId(element);
        const highlights = this.highlightsContent.querySelectorAll(
          `[data-element-id="${elementId}"]`
        );
        highlights.forEach((highlight) => {
          const highlightErrorId = (highlight as HTMLElement).getAttribute(
            "data-error-id"
          );
          if (!highlightErrorId) return;

          // Find the updated error by ID (guaranteed unique match)
          const updatedError = updatedErrorsAfterReplace.find(
            (err) => err.id === highlightErrorId
          );

          if (updatedError) {
            // Update data-error attribute with new positions (ID remains the same)
            (highlight as HTMLElement).setAttribute(
              "data-error",
              JSON.stringify(updatedError)
            );
          } else {
            // This error was removed, highlight should already be removed
            // But remove it here as safety measure
            highlight.remove();
          }
        });
      }

      // Update highlight positions after DOM has updated (for proper text wrapping calculation)
      // Use requestAnimationFrame to ensure text wrapping is recalculated after replace
      // This will also update data-error attributes again, ensuring consistency
      requestAnimationFrame(() => {
        this.highlightHelper.updatePositions(
          element,
          updatedErrorsAfterReplace,
          (error: GrammarError) =>
            getErrorTextRects(element, error.start, error.end)
        );
      });

      // Cancel any scheduled blur handlers for this element
      const existingBlurTimeout = this.scheduledBlurHandlers.get(element);
      if (existingBlurTimeout) {
        clearTimeout(existingBlurTimeout);
        this.scheduledBlurHandlers.delete(element);
      }

      // Restore focus and set cursor position after replacement
      // Calculate new cursor position (after the replaced text)
      const newCursorPosition = actualStart + replacement.length;

      // Use requestAnimationFrame to ensure DOM is ready before focusing
      requestAnimationFrame(() => {
        // Keep flag true during focus restore to prevent blur handler from hiding highlights
        this.isPerformingReplace = true;

        element.focus();
        // Set cursor position to the end of the replacement
        element.setSelectionRange(newCursorPosition, newCursorPosition);

        // Clear the replace flag after a short delay to ensure focus is stable
        setTimeout(() => {
          this.isPerformingReplace = false;
          // Trigger grammar check after replace is complete
          this.performGrammarCheck(element).catch((error) => {
            console.error(
              "Rewordly: Error performing grammar check after replace:",
              error
            );
          });
        }, 150);

        // Trigger input event (this will reset timeout but won't clear errors)
        const inputEvent = new Event("input", { bubbles: true });
        // Mark as programmatic to prevent handleInput from processing it
        (inputEvent as any).__rewordlyProgrammatic = true;
        element.dispatchEvent(inputEvent);
      });
    } else if (
      element.getAttribute("contenteditable") === "true" ||
      element.isContentEditable
    ) {
      // For contenteditable - check if it's Lexical (Reddit) or Draft.js (Twitter)
      const isLexical =
        element.getAttribute("data-lexical-editor") === "true" ||
        element.closest('[data-lexical-editor="true"]') !== null;
      const isDraftJS =
        element.classList.contains("public-DraftEditor-content") ||
        element.closest(".DraftEditor-root") !== null;

      if (isLexical) {
        // For Lexical editors (Reddit), use execCommand to maintain editor state
        // This simulates user typing, which Lexical handles correctly
        this.isPerformingReplace = true;

        try {
          // Use execCommand('insertText') which is safest for Lexical
          replaceTextInContentEditable(
            element,
            actualStart,
            actualEnd,
            replacement,
            true
          );

          // Calculate length difference for position adjustment
          const replacementLength = replacement.length;
          const originalLength = actualEnd - actualStart;
          const lengthDiff = replacementLength - originalLength;

          // Update stored errors - adjust positions but keep IDs intact
          const updatedErrorsAfterReplace = updatedErrors.map((err) => {
            // If error is after the replaced text, adjust its position (keep ID!)
            if (err.start > actualEnd) {
              return {
                ...err,
                start: err.start + lengthDiff,
                end: err.end + lengthDiff,
              };
            }
            // If error overlaps with replaced text, it's already removed
            return err;
          });
          this.grammarErrors.set(element, updatedErrorsAfterReplace);

          // Update all highlight data-error attributes with new positions - match by ID
          if (this.highlightsContent) {
            const elementId = this.getElementId(element);
            const highlights = this.highlightsContent.querySelectorAll(
              `[data-element-id="${elementId}"]`
            );
            highlights.forEach((highlight) => {
              const highlightErrorId = (highlight as HTMLElement).getAttribute(
                "data-error-id"
              );
              if (!highlightErrorId) return;

              // Find the updated error by ID
              const updatedError = updatedErrorsAfterReplace.find(
                (err) => err.id === highlightErrorId
              );

              if (updatedError) {
                // Update data-error attribute with new positions (ID remains the same)
                (highlight as HTMLElement).setAttribute(
                  "data-error",
                  JSON.stringify(updatedError)
                );
              } else {
                // This error was removed
                highlight.remove();
              }
            });
          }

          // Wait for Lexical to update its DOM before repositioning highlights
          // Also keep flag true longer to catch any input events triggered by execCommand
          setTimeout(() => {
            this.highlightHelper.updatePositions(
              element,
              updatedErrorsAfterReplace,
              (error: GrammarError) =>
                getErrorTextRects(element, error.start, error.end)
            );

            // Cancel any scheduled blur handlers for this element
            const existingBlurTimeout = this.scheduledBlurHandlers.get(element);
            if (existingBlurTimeout) {
              clearTimeout(existingBlurTimeout);
              this.scheduledBlurHandlers.delete(element);
            }

            // Restore focus and set cursor position after replacement
            // Use requestAnimationFrame to ensure DOM is ready before focusing
            requestAnimationFrame(() => {
              // Keep flag true during focus restore to prevent blur handler from hiding highlights
              this.isPerformingReplace = true;

              element.focus();

              // Keep flag true longer (300ms) to catch input events triggered by execCommand
              // Lexical may trigger input events asynchronously after execCommand
              setTimeout(() => {
                this.isPerformingReplace = false;
                // Trigger grammar check after replace is complete
                this.performGrammarCheck(element).catch((error) => {
                  console.error(
                    "Rewordly: Error performing grammar check after replace:",
                    error
                  );
                });
              }, 300);
            });
          }, 100);
        } catch (err) {
          console.error("Rewordly: Error replacing text in Lexical:", err);
          this.isPerformingReplace = false;
        }
      } else if (isDraftJS) {
        // Set flag to prevent blur handler from hiding highlights during replace
        this.isPerformingReplace = true;

        // Cancel any scheduled blur handlers immediately to prevent them from hiding highlights
        const existingBlurTimeout = this.scheduledBlurHandlers.get(element);
        if (existingBlurTimeout) {
          clearTimeout(existingBlurTimeout);
          this.scheduledBlurHandlers.delete(element);
        }

        // Store original text for verification
        const originalText = element.innerText || element.textContent || "";

        // For Draft.js editors (Twitter), use execCommand-based replacement
        const replaceSuccess = replaceTextInDraftJS(
          element,
          actualStart,
          actualEnd,
          replacement
        );

        if (!replaceSuccess) {
          console.error("Rewordly: Failed to replace text in Draft.js");
          this.isPerformingReplace = false;
          return; // Don't update highlights if replace failed
        }

        // Calculate length difference for position adjustment (do this immediately, not in timeout)
        const replacementLength = replacement.length;
        const originalLength = actualEnd - actualStart;
        const lengthDiff = replacementLength - originalLength;

        // Update stored errors - adjust positions but keep IDs intact
        const updatedErrorsAfterReplace = updatedErrors.map((err) => {
          // If error is after the replaced text, adjust its position (keep ID!)
          if (err.start > actualEnd) {
            return {
              ...err,
              start: err.start + lengthDiff,
              end: err.end + lengthDiff,
            };
          }
          // If error overlaps with replaced text, it's already removed
          return err;
        });
        this.grammarErrors.set(element, updatedErrorsAfterReplace);

        // Update all highlight data-error attributes with new positions - match by ID
        if (this.highlightsContent) {
          const elementId = this.getElementId(element);
          const highlights = this.highlightsContent.querySelectorAll(
            `[data-element-id="${elementId}"]`
          );

          highlights.forEach((highlight) => {
            const highlightErrorId = (highlight as HTMLElement).getAttribute(
              "data-error-id"
            );
            if (!highlightErrorId) return;

            // Find the updated error by ID
            const updatedError = updatedErrorsAfterReplace.find(
              (err) => err.id === highlightErrorId
            );

            if (updatedError) {
              // Update data-error attribute with new positions (ID remains the same)
              (highlight as HTMLElement).setAttribute(
                "data-error",
                JSON.stringify(updatedError)
              );
            } else {
              // This error was removed - fade out and remove
              (highlight as HTMLElement).style.opacity = "0";
              setTimeout(() => highlight.remove(), 150);
            }
          });
        }

        // IMMEDIATELY update highlight positions after replace (no timeout for Twitter)
        // This ensures highlights move instantly to their new positions
        requestAnimationFrame(() => {
          this.highlightHelper.updatePositions(
            element,
            updatedErrorsAfterReplace,
            (error: GrammarError) =>
              getErrorTextRects(element, error.start, error.end)
          );
        });

        // Restore focus and cursor position
        requestAnimationFrame(() => {
          element.focus();

          // Set cursor position using Selection API
          const selection = window.getSelection();
          if (selection) {
            const newCursorPosition = actualStart + replacement.length;

            // Map cursor position to text node
            const cursorMapping = mapInnerTextToTextNodes(
              element,
              newCursorPosition,
              newCursorPosition
            );
            if (cursorMapping && cursorMapping.startNode) {
              try {
                // Check if node is still in document before using range
                if (isNodeInDocument(cursorMapping.startNode)) {
                  const cursorRange = document.createRange();
                  const offset = Math.min(
                    cursorMapping.startOffset,
                    cursorMapping.startNode.textContent!.length
                  );
                  cursorRange.setStart(cursorMapping.startNode, offset);
                  cursorRange.collapse(true);
                  selection.removeAllRanges();
                  selection.addRange(cursorRange);
                }
              } catch (e) {
                // Cursor positioning failed - not critical, user can click to reposition
                console.warn(
                  "Rewordly: Could not set cursor position after replacement",
                  e
                );
              }
            }
          }
        });

        // For Draft.js, also do a delayed verification to catch any DOM changes that Draft.js makes asynchronously
        // But the immediate update above ensures highlights move instantly
        setTimeout(() => {
          const newText = element.innerText || element.textContent || "";

          // Verify replacement was successful - check if text changed
          if (newText === originalText && originalText.length > 0) {
            console.warn(
              "Rewordly: Replacement verification failed - text was not replaced"
            );
            this.isPerformingReplace = false;
            return;
          }

          // Cancel any blur handlers that might have been scheduled
          const existingBlurTimeout2 = this.scheduledBlurHandlers.get(element);
          if (existingBlurTimeout2) {
            clearTimeout(existingBlurTimeout2);
            this.scheduledBlurHandlers.delete(element);
          }

          // Verify and update highlights (in case Draft.js made additional DOM changes)
          this.highlightHelper.updatePositions(
            element,
            updatedErrorsAfterReplace,
            (error: GrammarError) =>
              getErrorTextRects(element, error.start, error.end)
          );

          // Keep isPerformingReplace true a bit longer to catch async Draft.js events
          setTimeout(() => {
            this.isPerformingReplace = false;
            // Trigger grammar check after replace is complete
            this.performGrammarCheck(element).catch((error) => {
              console.error(
                "Rewordly: Error performing grammar check after replace:",
                error
              );
            });
          }, 200);
        }, 200); // Small delay only for verification, not for initial update
      } else {
        // Check if this is Slate.js (Medium)
        const isSlate =
          element.getAttribute("data-slate-editor") === "true" ||
          element.querySelector('[data-slate-editor="true"]') !== null ||
          element.closest('[data-slate-editor="true"]') !== null;

        // Check if this is Notion
        const isNotion =
          element.getAttribute("data-content-editable-leaf") === "true" ||
          element.classList.contains("notion-selectable") ||
          window.location.hostname.includes("notion.so");

        if (isSlate) {
          // For Slate.js editors (Medium), use a special approach that properly updates Slate's internal state
          this.isPerformingReplace = true;

          // Use an async IIFE to handle the async operations
          (async () => {
            try {
              // Focus the element first
              element.focus();

              // Get current text to validate positions
              const currentText =
                element.innerText || element.textContent || "";
              if (
                actualStart < 0 ||
                actualEnd > currentText.length ||
                actualStart >= actualEnd
              ) {
                console.error(
                  "Rewordly: Invalid positions for Slate.js replacement",
                  {
                    start: actualStart,
                    end: actualEnd,
                    textLength: currentText.length,
                  }
                );
                this.isPerformingReplace = false;
                return;
              }

              const selection = window.getSelection();
              if (!selection) {
                this.isPerformingReplace = false;
                return;
              }

              // Map innerText positions to text node positions
              const mapping = mapInnerTextToTextNodes(
                element,
                actualStart,
                actualEnd
              );

              if (!mapping || !mapping.startNode) {
                console.error(
                  "Rewordly: Could not map innerText positions to text nodes for Slate.js"
                );
                this.isPerformingReplace = false;
                return;
              }

              // Create range for the text to replace
              const range = document.createRange();

              // Set range start
              const startNodeLength = mapping.startNode.textContent!.length;
              const startOffset = Math.min(
                mapping.startOffset,
                startNodeLength
              );
              range.setStart(mapping.startNode, startOffset);

              // Set range end
              if (mapping.endNode && mapping.startNode !== mapping.endNode) {
                const endNodeLength = mapping.endNode.textContent!.length;
                const endOffset = Math.min(mapping.endOffset, endNodeLength);
                range.setEnd(mapping.endNode, endOffset);
              } else {
                const endPos = Math.min(mapping.endOffset, startNodeLength);
                range.setEnd(mapping.startNode, endPos);
              }

              // Select the text first - this is important for Slate.js
              selection.removeAllRanges();
              selection.addRange(range);

              // Wait a bit for Slate.js to recognize the selection
              await new Promise((resolve) => setTimeout(resolve, 20));

              // For Slate.js, we need to use beforeinput events properly
              // Slate.js listens to beforeinput events to update its internal state
              // We'll use deleteContent to delete selected text, then insertText to insert replacement

              // Step 1: Delete the selected content using deleteContent inputType
              const deleteBeforeInputEvent = new InputEvent("beforeinput", {
                bubbles: true,
                cancelable: true,
                inputType: "deleteContent",
                isComposing: false,
              });
              // Add getTargetRanges method for Slate.js compatibility
              (deleteBeforeInputEvent as any).getTargetRanges = () => [
                range.cloneRange(),
              ];
              (deleteBeforeInputEvent as any).__rewordlyProgrammatic = true;

              const deleteCancelled = !element.dispatchEvent(
                deleteBeforeInputEvent
              );

              if (!deleteCancelled) {
                // Delete the selected content from DOM
                range.deleteContents();

                // Trigger input event for deletion
                const deleteInputEvent = new InputEvent("input", {
                  bubbles: true,
                  cancelable: false,
                  inputType: "deleteContent",
                  isComposing: false,
                });
                (deleteInputEvent as any).__rewordlyProgrammatic = true;
                element.dispatchEvent(deleteInputEvent);
              }

              // Wait for Slate.js to process the deletion
              await new Promise((resolve) => setTimeout(resolve, 20));

              // Step 2: Insert the replacement text
              // Get the current selection (should be collapsed at deletion point)
              const currentRange =
                selection.rangeCount > 0 ? selection.getRangeAt(0) : range;

              // Ensure range is collapsed
              if (!currentRange.collapsed) {
                currentRange.collapse(true);
              }

              // Trigger beforeinput event for insertion
              const insertBeforeInputEvent = new InputEvent("beforeinput", {
                bubbles: true,
                cancelable: true,
                inputType: "insertText",
                data: replacement,
                isComposing: false,
              });
              // Add getTargetRanges method for Slate.js compatibility
              (insertBeforeInputEvent as any).getTargetRanges = () => [
                currentRange.cloneRange(),
              ];
              (insertBeforeInputEvent as any).__rewordlyProgrammatic = true;

              const insertCancelled = !element.dispatchEvent(
                insertBeforeInputEvent
              );

              if (!insertCancelled) {
                // Insert the replacement text into DOM
                const textNode = document.createTextNode(replacement);
                currentRange.insertNode(textNode);

                // Move cursor after the inserted text
                currentRange.setStartAfter(textNode);
                currentRange.collapse(true);
                selection.removeAllRanges();
                selection.addRange(currentRange);

                // Trigger input event for insertion
                const insertInputEvent = new InputEvent("input", {
                  bubbles: true,
                  cancelable: false,
                  inputType: "insertText",
                  data: replacement,
                  isComposing: false,
                });
                (insertInputEvent as any).__rewordlyProgrammatic = true;
                element.dispatchEvent(insertInputEvent);
              }

              // Also try execCommand as a backup (some Slate.js versions may prefer it)
              // But only if the above didn't work
              try {
                // Re-select the text we just inserted to verify it's there
                const verifyRange = document.createRange();
                const verifyMapping = mapInnerTextToTextNodes(
                  element,
                  actualStart,
                  actualStart + replacement.length
                );
                if (verifyMapping && verifyMapping.startNode) {
                  verifyRange.setStart(
                    verifyMapping.startNode,
                    Math.min(
                      verifyMapping.startOffset,
                      verifyMapping.startNode.textContent!.length
                    )
                  );
                  if (
                    verifyMapping.endNode &&
                    verifyMapping.endNode !== verifyMapping.startNode
                  ) {
                    verifyRange.setEnd(
                      verifyMapping.endNode,
                      Math.min(
                        verifyMapping.endOffset,
                        verifyMapping.endNode.textContent!.length
                      )
                    );
                  } else {
                    verifyRange.setEnd(
                      verifyMapping.startNode,
                      Math.min(
                        verifyMapping.endOffset,
                        verifyMapping.startNode.textContent!.length
                      )
                    );
                  }
                  selection.removeAllRanges();
                  selection.addRange(verifyRange);
                }
              } catch (e) {
                // Ignore errors in verification
              }

              // Wait longer for Slate.js to fully process the changes
              await new Promise((resolve) => setTimeout(resolve, 100));

              // Verify the replacement was successful by checking the text content
              const newText = element.innerText || element.textContent || "";
              const expectedText =
                currentText.substring(0, actualStart) +
                replacement +
                currentText.substring(actualEnd);

              // If replacement didn't work, try one more time with execCommand
              if (newText !== expectedText) {
                console.warn(
                  "Rewordly: Slate.js replacement verification failed, trying execCommand fallback",
                  {
                    expected: expectedText.substring(0, 50),
                    actual: newText.substring(0, 50),
                  }
                );

                // Try execCommand as a last resort
                try {
                  // Re-select the original text range
                  const retryMapping = mapInnerTextToTextNodes(
                    element,
                    actualStart,
                    actualEnd
                  );
                  if (retryMapping && retryMapping.startNode) {
                    const retryRange = document.createRange();
                    retryRange.setStart(
                      retryMapping.startNode,
                      Math.min(
                        retryMapping.startOffset,
                        retryMapping.startNode.textContent!.length
                      )
                    );
                    if (
                      retryMapping.endNode &&
                      retryMapping.endNode !== retryMapping.startNode
                    ) {
                      retryRange.setEnd(
                        retryMapping.endNode,
                        Math.min(
                          retryMapping.endOffset,
                          retryMapping.endNode.textContent!.length
                        )
                      );
                    } else {
                      retryRange.setEnd(
                        retryMapping.startNode,
                        Math.min(
                          retryMapping.endOffset,
                          retryMapping.startNode.textContent!.length
                        )
                      );
                    }

                    selection.removeAllRanges();
                    selection.addRange(retryRange);

                    await new Promise((resolve) => setTimeout(resolve, 20));

                    // Try execCommand insertText which should replace selected text
                    const execSuccess = document.execCommand(
                      "insertText",
                      false,
                      replacement
                    );
                    if (execSuccess) {
                      await new Promise((resolve) => setTimeout(resolve, 50));
                      // Verify again
                      const retryText =
                        element.innerText || element.textContent || "";
                      if (retryText === expectedText) {
                        console.log(
                          "Rewordly: execCommand fallback succeeded for Slate.js"
                        );
                      }
                    }
                  }
                } catch (e) {
                  console.error("Rewordly: execCommand fallback failed", e);
                }
              }

              // Calculate length difference for position adjustment
              const replacementLength = replacement.length;
              const originalLength = actualEnd - actualStart;
              const lengthDiff = replacementLength - originalLength;

              // Update stored errors - adjust positions but keep IDs intact
              const updatedErrorsAfterReplace = updatedErrors.map((err) => {
                if (err.start > actualEnd) {
                  return {
                    ...err,
                    start: err.start + lengthDiff,
                    end: err.end + lengthDiff,
                  };
                }
                return err;
              });
              this.grammarErrors.set(element, updatedErrorsAfterReplace);

              // Update highlights
              if (this.highlightsContent) {
                const elementId = getElementId(element);
                const highlights = this.highlightsContent.querySelectorAll(
                  `[data-element-id="${elementId}"]`
                );
                highlights.forEach((highlight) => {
                  const highlightErrorId = (
                    highlight as HTMLElement
                  ).getAttribute("data-error-id");
                  if (!highlightErrorId) return;

                  const updatedError = updatedErrorsAfterReplace.find(
                    (err) => err.id === highlightErrorId
                  );
                  if (updatedError) {
                    (highlight as HTMLElement).setAttribute(
                      "data-error",
                      JSON.stringify(updatedError)
                    );
                  } else {
                    highlight.remove();
                  }
                });
              }

              // Update highlight positions after Slate.js has updated its DOM
              // Use longer delay to ensure Slate.js has fully updated its internal state
              setTimeout(() => {
                // First, update highlight positions with the adjusted error positions
                this.highlightHelper.updatePositions(
                  element,
                  updatedErrorsAfterReplace,
                  (error: GrammarError) =>
                    getErrorTextRects(element, error.start, error.end)
                );

                // Cancel blur handlers
                const existingBlurTimeout =
                  this.scheduledBlurHandlers.get(element);
                if (existingBlurTimeout) {
                  clearTimeout(existingBlurTimeout);
                  this.scheduledBlurHandlers.delete(element);
                }

                // Restore focus and cursor position
                requestAnimationFrame(() => {
                  element.focus();
                  const newCursorPosition = actualStart + replacement.length;
                  const cursorMapping = mapInnerTextToTextNodes(
                    element,
                    newCursorPosition,
                    newCursorPosition
                  );
                  if (cursorMapping && cursorMapping.startNode) {
                    const cursorRange = document.createRange();
                    const offset = Math.min(
                      cursorMapping.startOffset,
                      cursorMapping.startNode.textContent!.length
                    );
                    cursorRange.setStart(cursorMapping.startNode, offset);
                    cursorRange.collapse(true);
                    const sel = window.getSelection();
                    if (sel) {
                      sel.removeAllRanges();
                      sel.addRange(cursorRange);
                    }
                  }

                  // Keep flag true longer to catch any async Slate.js events
                  setTimeout(() => {
                    // Update highlight positions again after a delay to ensure they're correct
                    // This ensures highlights are positioned correctly after Slate.js has fully updated
                    setTimeout(() => {
                      this.highlightHelper.updatePositions(
                        element,
                        updatedErrorsAfterReplace,
                        (error: GrammarError) =>
                          getErrorTextRects(element, error.start, error.end)
                      );

                      // Update again after another delay to catch any late DOM updates
                      setTimeout(() => {
                        this.highlightHelper.updatePositions(
                          element,
                          updatedErrorsAfterReplace,
                          (error: GrammarError) =>
                            getErrorTextRects(element, error.start, error.end)
                        );

                        // One more update to ensure positions are stable
                        setTimeout(() => {
                          this.highlightHelper.updatePositions(
                            element,
                            updatedErrorsAfterReplace,
                            (error: GrammarError) =>
                              getErrorTextRects(element, error.start, error.end)
                          );
                          this.isPerformingReplace = false;

                          // Don't trigger grammar check immediately after replace
                          // The existing highlights with updated positions should be sufficient
                          // Grammar check will happen naturally on next user input or focus change
                          // This prevents highlights from disappearing due to re-checking
                        }, 200);
                      }, 200);
                    }, 200);
                  }, 300);
                });
              }, 200); // Increased delay to ensure Slate.js has updated its DOM
            } catch (err) {
              console.error("Rewordly: Error replacing text in Slate.js:", err);
              this.isPerformingReplace = false;
            }
          })();
        } else if (isNotion) {
          // For Notion, use a more reliable approach that works with their complex DOM structure
          this.isPerformingReplace = true;

          // Use an async IIFE to handle the async operations
          (async () => {
            try {
              // Focus the element first
              element.focus();

              // Get current text to validate positions
              const currentText =
                element.innerText || element.textContent || "";
              if (
                actualStart < 0 ||
                actualEnd > currentText.length ||
                actualStart >= actualEnd
              ) {
                console.error(
                  "Rewordly: Invalid positions for Notion replacement",
                  {
                    start: actualStart,
                    end: actualEnd,
                    textLength: currentText.length,
                  }
                );
                this.isPerformingReplace = false;
                return;
              }

              const selection = window.getSelection();
              if (!selection) {
                this.isPerformingReplace = false;
                return;
              }

              // For Notion, we need to create a range that spans the correct text nodes
              // Notion's DOM has nested spans, so we need to be careful
              const range = document.createRange();

              // Map innerText positions to text node positions
              const mapping = mapInnerTextToTextNodes(
                element,
                actualStart,
                actualEnd
              );

              if (!mapping || !mapping.startNode) {
                console.error(
                  "Rewordly: Could not map innerText positions to text nodes for Notion"
                );
                this.isPerformingReplace = false;
                return;
              }

              // Set range start
              const startNodeLength = mapping.startNode.textContent!.length;
              const startOffset = Math.min(
                mapping.startOffset,
                startNodeLength
              );
              range.setStart(mapping.startNode, startOffset);

              // Set range end
              if (mapping.endNode && mapping.startNode !== mapping.endNode) {
                const endNodeLength = mapping.endNode.textContent!.length;
                const endOffset = Math.min(mapping.endOffset, endNodeLength);
                range.setEnd(mapping.endNode, endOffset);
              } else {
                const endPos = Math.min(mapping.endOffset, startNodeLength);
                range.setEnd(mapping.startNode, endPos);
              }

              // Select the text first - this is important for Notion
              selection.removeAllRanges();
              selection.addRange(range);

              // Wait a bit for Notion to recognize the selection
              await new Promise((resolve) => setTimeout(resolve, 10));

              // Try execCommand first (some browsers still support it)
              let success = false;
              try {
                success = document.execCommand(
                  "insertText",
                  false,
                  replacement
                );
              } catch (e) {
                // execCommand might fail, use fallback
                success = false;
              }

              if (!success) {
                // Fallback: manually delete and insert
                // Delete the selected content
                range.deleteContents();

                // Insert the replacement text
                // For Notion, we need to preserve the structure, so we insert as a text node
                const textNode = document.createTextNode(replacement);
                range.insertNode(textNode);

                // Collapse range to the end of inserted text
                range.setStartAfter(textNode);
                range.collapse(true);

                // Update selection
                selection.removeAllRanges();
                selection.addRange(range);
              }

              // Clear selection after a brief moment
              setTimeout(() => {
                selection.removeAllRanges();
              }, 10);

              // Trigger beforeinput event first (Notion listens to this)
              const beforeInputEvent = new InputEvent("beforeinput", {
                bubbles: true,
                cancelable: true,
                inputType: "insertText",
                data: replacement,
                isComposing: false,
              });
              (beforeInputEvent as any).__rewordlyProgrammatic = true;
              element.dispatchEvent(beforeInputEvent);

              // Trigger input event (Notion uses this to update internal state)
              const inputEvent = new InputEvent("input", {
                bubbles: true,
                cancelable: false,
                inputType: "insertText",
                data: replacement,
                isComposing: false,
              });
              (inputEvent as any).__rewordlyProgrammatic = true;
              element.dispatchEvent(inputEvent);

              // Also trigger a composition event (some editors listen to this)
              const compositionStartEvent = new CompositionEvent(
                "compositionstart",
                {
                  bubbles: true,
                  cancelable: true,
                  data: replacement,
                }
              );
              (compositionStartEvent as any).__rewordlyProgrammatic = true;
              element.dispatchEvent(compositionStartEvent);

              const compositionEndEvent = new CompositionEvent(
                "compositionend",
                {
                  bubbles: true,
                  cancelable: true,
                  data: replacement,
                }
              );
              (compositionEndEvent as any).__rewordlyProgrammatic = true;
              element.dispatchEvent(compositionEndEvent);

              // Calculate length difference for position adjustment
              const replacementLength = replacement.length;
              const originalLength = actualEnd - actualStart;
              const lengthDiff = replacementLength - originalLength;

              // Update stored errors - adjust positions but keep IDs intact
              const updatedErrorsAfterReplace = updatedErrors.map((err) => {
                if (err.start > actualEnd) {
                  return {
                    ...err,
                    start: err.start + lengthDiff,
                    end: err.end + lengthDiff,
                  };
                }
                return err;
              });
              this.grammarErrors.set(element, updatedErrorsAfterReplace);

              // Update highlights
              if (this.highlightsContent) {
                const elementId = getElementId(element);
                const highlights = this.highlightsContent.querySelectorAll(
                  `[data-element-id="${elementId}"]`
                );
                highlights.forEach((highlight) => {
                  const highlightErrorId = (
                    highlight as HTMLElement
                  ).getAttribute("data-error-id");
                  if (!highlightErrorId) return;

                  const updatedError = updatedErrorsAfterReplace.find(
                    (err) => err.id === highlightErrorId
                  );
                  if (updatedError) {
                    (highlight as HTMLElement).setAttribute(
                      "data-error",
                      JSON.stringify(updatedError)
                    );
                  } else {
                    highlight.remove();
                  }
                });
              }

              // Update highlight positions
              setTimeout(() => {
                this.highlightHelper.updatePositions(
                  element,
                  updatedErrorsAfterReplace,
                  (error: GrammarError) =>
                    getErrorTextRects(element, error.start, error.end)
                );

                // Cancel blur handlers
                const existingBlurTimeout =
                  this.scheduledBlurHandlers.get(element);
                if (existingBlurTimeout) {
                  clearTimeout(existingBlurTimeout);
                  this.scheduledBlurHandlers.delete(element);
                }

                // Restore focus and cursor position
                requestAnimationFrame(() => {
                  element.focus();
                  const newCursorPosition = actualStart + replacement.length;
                  const cursorMapping = mapInnerTextToTextNodes(
                    element,
                    newCursorPosition,
                    newCursorPosition
                  );
                  if (cursorMapping && cursorMapping.startNode) {
                    const cursorRange = document.createRange();
                    const offset = Math.min(
                      cursorMapping.startOffset,
                      cursorMapping.startNode.textContent!.length
                    );
                    cursorRange.setStart(cursorMapping.startNode, offset);
                    cursorRange.collapse(true);
                    selection.removeAllRanges();
                    selection.addRange(cursorRange);
                  }

                  setTimeout(() => {
                    this.isPerformingReplace = false;
                    // Trigger grammar check after replace is complete
                    this.performGrammarCheck(element).catch((error) => {
                      console.error(
                        "Rewordly: Error performing grammar check after replace:",
                        error
                      );
                    });
                  }, 150);
                });
              }, 100);
            } catch (err) {
              console.error("Rewordly: Error replacing text in Notion:", err);
              this.isPerformingReplace = false;
            }
          })();

          // Return early since we're handling everything in the async IIFE
          return;
        } else {
          // For regular contenteditable
          // Set flag to prevent blur handler from hiding highlights during replace
          this.isPerformingReplace = true;

          const selection = window.getSelection();
          if (!selection) {
            this.isPerformingReplace = false;
            return;
          }

          // Get current text to validate positions
          const currentText = element.innerText || element.textContent || "";
          if (
            actualStart < 0 ||
            actualEnd > currentText.length ||
            actualStart >= actualEnd
          ) {
            console.error("Rewordly: Invalid positions for replacement", {
              start: actualStart,
              end: actualEnd,
              textLength: currentText.length,
              currentErrors: this.grammarErrors.get(element),
            });
            this.isPerformingReplace = false;
            return;
          }

          // Map innerText positions to text node positions
          const mapping = mapInnerTextToTextNodes(
            element,
            actualStart,
            actualEnd
          );

          if (!mapping || !mapping.startNode) {
            console.error(
              "Rewordly: Could not map innerText positions to text nodes",
              {
                start: actualStart,
                end: actualEnd,
                textLength: currentText.length,
                innerText: currentText.substring(
                  Math.max(0, actualStart - 10),
                  Math.min(currentText.length, actualEnd + 10)
                ),
              }
            );
            this.isPerformingReplace = false;
            return;
          }

          try {
            const range = document.createRange();

            // Validate positions
            const startNodeLength = mapping.startNode.textContent!.length;
            if (
              mapping.startOffset < 0 ||
              mapping.startOffset > startNodeLength
            ) {
              console.error("Rewordly: Invalid start offset in text node", {
                startOffset: mapping.startOffset,
                nodeLength: startNodeLength,
                globalStart: actualStart,
              });
              return;
            }

            if (mapping.endNode && mapping.startNode !== mapping.endNode) {
              // Error spans multiple text nodes
              const endNodeLength = mapping.endNode.textContent!.length;
              if (mapping.endOffset < 0 || mapping.endOffset > endNodeLength) {
                console.error("Rewordly: Invalid end offset in text node", {
                  endOffset: mapping.endOffset,
                  nodeLength: endNodeLength,
                  globalEnd: actualEnd,
                });
                return;
              }

              range.setStart(
                mapping.startNode,
                Math.min(mapping.startOffset, startNodeLength)
              );
              range.setEnd(
                mapping.endNode,
                Math.min(mapping.endOffset, endNodeLength)
              );
            } else {
              // Error is within a single text node
              const endPos = mapping.endOffset;

              if (endPos > startNodeLength) {
                console.error("Rewordly: Invalid end position in text node", {
                  startOffset: mapping.startOffset,
                  endPos,
                  nodeLength: startNodeLength,
                  globalStart: actualStart,
                  globalEnd: actualEnd,
                });
                return;
              }

              range.setStart(mapping.startNode, mapping.startOffset);
              range.setEnd(mapping.startNode, endPos);
            }

            selection.removeAllRanges();
            selection.addRange(range);

            // Replace selected text
            range.deleteContents();
            const textNode = document.createTextNode(replacement);
            range.insertNode(textNode);

            // Clear selection
            selection.removeAllRanges();

            // Trigger multiple events to ensure contenteditable picks it up
            const events = ["beforeinput", "input", "textInput"];
            events.forEach((eventType) => {
              const event = new Event(eventType, {
                bubbles: true,
                cancelable: true,
              });
              (event as any).data = replacement;
              // Mark as programmatic to prevent handleInput from processing it
              (event as any).__rewordlyProgrammatic = true;
              element.dispatchEvent(event);
            });

            // Calculate length difference for position adjustment
            const replacementLength = replacement.length;
            const originalLength = actualEnd - actualStart;
            const lengthDiff = replacementLength - originalLength;

            // Update stored errors - adjust positions but keep IDs intact
            const updatedErrorsAfterReplace = updatedErrors.map((err) => {
              // If error is after the replaced text, adjust its position (keep ID!)
              if (err.start > actualEnd) {
                return {
                  ...err,
                  start: err.start + lengthDiff,
                  end: err.end + lengthDiff,
                };
              }
              // If error overlaps with replaced text, it's already removed
              return err;
            });
            this.grammarErrors.set(element, updatedErrorsAfterReplace);

            // Update all highlight data-error attributes with new positions - match by ID
            if (this.highlightsContent) {
              const elementId = getElementId(element);
              const highlights = this.highlightsContent.querySelectorAll(
                `[data-element-id="${elementId}"]`
              );
              highlights.forEach((highlight) => {
                const highlightErrorId = (
                  highlight as HTMLElement
                ).getAttribute("data-error-id");
                if (!highlightErrorId) return;

                // Find the updated error by ID
                const updatedError = updatedErrorsAfterReplace.find(
                  (err) => err.id === highlightErrorId
                );

                if (updatedError) {
                  // Update data-error attribute with new positions (ID remains the same)
                  (highlight as HTMLElement).setAttribute(
                    "data-error",
                    JSON.stringify(updatedError)
                  );
                } else {
                  // This error was removed
                  highlight.remove();
                }
              });
            }

            // Update highlight positions after DOM has updated (for proper text wrapping calculation)
            // Use requestAnimationFrame to ensure text wrapping is recalculated after replace
            requestAnimationFrame(() => {
              this.highlightHelper.updatePositions(
                element,
                updatedErrorsAfterReplace,
                (error: GrammarError) =>
                  getErrorTextRects(element, error.start, error.end)
              );
            });

            // Cancel any scheduled blur handlers for this element
            const existingBlurTimeout = this.scheduledBlurHandlers.get(element);
            if (existingBlurTimeout) {
              clearTimeout(existingBlurTimeout);
              this.scheduledBlurHandlers.delete(element);
            }

            // Restore focus and set cursor position after replacement
            // Use requestAnimationFrame to ensure DOM is ready before focusing
            requestAnimationFrame(() => {
              // Keep flag true during focus restore to prevent blur handler from hiding highlights
              this.isPerformingReplace = true;

              element.focus();
              // Set cursor position to the end of the replacement
              const newCursorPosition = actualStart + replacement.length;
              const cursorMapping = mapInnerTextToTextNodes(
                element,
                newCursorPosition,
                newCursorPosition
              );
              if (cursorMapping && cursorMapping.startNode) {
                const cursorRange = document.createRange();
                const offset = Math.min(
                  cursorMapping.startOffset,
                  cursorMapping.startNode.textContent!.length
                );
                cursorRange.setStart(cursorMapping.startNode, offset);
                cursorRange.collapse(true);
                selection.removeAllRanges();
                selection.addRange(cursorRange);
              }

              // Clear the replace flag after a short delay to ensure focus is stable
              setTimeout(() => {
                this.isPerformingReplace = false;
                // Trigger grammar check after replace is complete
                this.performGrammarCheck(element).catch((error) => {
                  console.error(
                    "Rewordly: Error performing grammar check after replace:",
                    error
                  );
                });
              }, 150);
            });
          } catch (err) {
            console.error("Rewordly: Error replacing text:", err);
            console.error("Rewordly: Error details:", {
              start: actualStart,
              end: actualEnd,
              mapping,
            });
            // Clear flag even on error
            this.isPerformingReplace = false;
          }
        }
      }
    }
  }

  private setupMessageListener(): void {
    // Listen for messages from popup/background script
    chrome.runtime.onMessage.addListener((request) => {
      if (request.type === "SETTINGS_UPDATED") {
        // Reload config when settings are updated
        loadConfig().then((config) => {
          this.config = config;

          // Hide button if rewrite is disabled
          if (!this.config.rewriteEnabled) {
            this.hideRewriteButton();
          }

          // Hide all highlights if highlights are disabled
          if (!this.config.highlightsEnabled) {
            this.hideAllGrammarHighlights();
          }
        });
      } else if (request.type === "CONTEXT_MENU_CLICKED") {
        // Handle context menu clicks - open modal and process text
        const selectedText = request.selectedText || "";

        if (!selectedText || selectedText.trim().length < 3) {
          console.warn("Rewordly: Selected text is too short");
          return;
        }

        if (request.action === "rewrite") {
          this.handleContextMenuRewrite(selectedText);
        }
      }
    });
  }

  /**
   * Hide all grammar highlights across all elements
   */
  private hideAllGrammarHighlights(): void {
    if (!this.highlightsContent) return;

    // Hide all highlights by setting display to none
    const allHighlights =
      this.highlightsContent.querySelectorAll("[data-element-id]");
    allHighlights.forEach((highlight) => {
      (highlight as HTMLElement).style.display = "none";
    });
  }

  // Text selection handlers removed - button only shows on editable element focus
  // No longer needed since we only show button for editable elements

  private handleOutsideClick(event: Event): void {
    const target = event.target as HTMLElement;

    // Hide rewrite button if clicking outside
    if (this.rewriteButton && !this.rewriteButton.contains(target)) {
      this.hideRewriteButton();
    }
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      this.hideRewriteButton();
    }
  }

  /**
   * Update AI rewrite button position based on element's current position
   * This is called both on initial show and on scroll/resize events
   */
  private updateAIRewriteButtonPosition(element: HTMLElement): void {
    if (!this.rewriteButton || !this.config.rewriteEnabled) {
      return;
    }

    // Only show rewrite button on sites where grammar check is enabled
    if (!this.isGrammarCheckAllowedSite() || !this.config.highlightsEnabled) {
      return;
    }

    // Check if element is still in the DOM
    if (!document.body.contains(element)) {
      return;
    }

    const hostname = window.location.hostname.toLowerCase();
    const isMedium = hostname.includes("medium.com");

    let elementRect: DOMRect;

    // Medium-specific positioning: position relative to actual content area
    if (isMedium) {
      // Try to find .section-inner - it could be a parent (closest) or child (querySelector)
      let sectionInner =
        element.closest(".section-inner") ||
        element.querySelector(".section-inner");

      if (sectionInner) {
        // Use .section-inner's bounding rect directly - it's already sized correctly with max-width
        elementRect = sectionInner.getBoundingClientRect();
      } else {
        elementRect = element.getBoundingClientRect();
      }
    } else {
      elementRect = element.getBoundingClientRect();
    }

    const buttonSize = 28; // Button size (reduced from 32)
    const offset = 8; // Offset from edge

    // Check if element is single-line
    const isSingleLine = isSingleLineElement(element);

    let buttonX: number;
    let buttonY: number;

    if (isSingleLine) {
      // For single-line elements: position at right-center (vertically aligned)
      buttonX = elementRect.right - buttonSize - offset;
      // Center vertically within the element
      buttonY = elementRect.top + elementRect.height / 2 - buttonSize / 2;
    } else {
      // For multi-line elements: position at bottom-right (existing behavior)
      buttonX = elementRect.right - buttonSize - offset;
      buttonY = elementRect.bottom - buttonSize - offset;
    }

    // Keep within viewport bounds
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    // Check if element is completely outside viewport
    const elementTop = elementRect.top;
    const elementBottom = elementRect.bottom;

    // Horizontal bounds check
    if (buttonX < 0) {
      buttonX = elementRect.left + offset;
    }
    if (buttonX + buttonSize > viewportWidth) {
      buttonX = viewportWidth - buttonSize - offset;
    }

    // Vertical bounds check - only constrain if element is partially visible
    // If element is completely above viewport, let button follow element
    if (elementBottom < 0) {
      // Element is completely above viewport - keep button relative to element
      // Don't constrain to viewport
    }
    // If element is completely below viewport, let button follow element
    else if (elementTop > viewportHeight) {
      // Element is completely below viewport - keep button relative to element
      // Don't constrain to viewport
    }
    // Element is partially or fully visible - apply viewport constraints
    else {
      if (buttonY < 0) {
        // If button goes above viewport, position at top of element (for single-line) or top with offset
        buttonY = isSingleLine
          ? elementRect.top + offset
          : elementRect.top + offset;
      }
      if (buttonY + buttonSize > viewportHeight) {
        // If button goes below viewport, position at bottom of viewport
        buttonY = viewportHeight - buttonSize - offset;
      }
    }

    // Update button position (transition is disabled during scroll by scroll listener)
    this.rewriteButton.style.left = `${buttonX}px`;
    this.rewriteButton.style.top = `${buttonY}px`;
  }

  /**
   * Show AI rewrite button at bottom-right of editable element
   * For single-line elements, positions button at right-center (vertically aligned)
   * For multi-line elements, positions button at bottom-right
   */
  private showAIRewriteButton(element: HTMLElement): void {
    if (!this.rewriteButton || !this.config.rewriteEnabled) {
      return;
    }

    // Only show rewrite button on sites where grammar check is enabled
    if (!this.isGrammarCheckAllowedSite() || !this.config.highlightsEnabled) {
      return;
    }

    // Remove existing scroll listener if any
    this.removeAIButtonScrollListener();

    // Update button position
    this.updateAIRewriteButtonPosition(element);

    // Ensure button is visible
    this.rewriteButton.style.display = "flex";
    this.rewriteButton.style.visibility = "visible";
    this.rewriteButton.style.opacity = "1";
    this.rewriteButton.classList.add("show");

    // Cancel any pending button blur timeout to prevent button from hiding
    if (this.buttonBlurTimeout !== null) {
      clearTimeout(this.buttonBlurTimeout);
      this.buttonBlurTimeout = null;
    }

    // Store reference to current element for rewrite functionality
    (this.rewriteButton as any).__currentElement = element;

    // Add scroll listener to update button position on scroll
    this.addAIButtonScrollListener(element);
  }

  /**
   * Add scroll listener to update AI button position
   */
  private addAIButtonScrollListener(element: HTMLElement): void {
    // Remove existing listener if any
    this.removeAIButtonScrollListener();

    // Create throttled update function for better performance
    let rafId: number | null = null;
    const updatePosition = () => {
      if (rafId !== null) {
        return; // Already scheduled
      }
      rafId = requestAnimationFrame(() => {
        rafId = null;
        // Check if button is still visible and element still exists
        if (
          this.rewriteButton &&
          this.rewriteButton.classList.contains("show") &&
          document.body.contains(element)
        ) {
          this.updateAIRewriteButtonPosition(element);
        }
      });
    };

    // Store the bound function
    this.aiButtonScrollListener = updatePosition;

    // Add listeners to window and document for comprehensive scroll detection
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    document.addEventListener("scroll", updatePosition, true);

    // Also listen to scrollable parent containers (important for Medium and other sites with nested scroll containers)
    const scrollableContainers = findScrollableContainers(element);
    scrollableContainers.forEach((container) => {
      container.addEventListener("scroll", updatePosition, {
        passive: true,
        capture: true,
      });
    });

    // Store containers for cleanup
    (this.rewriteButton as any).__scrollContainers = scrollableContainers;
  }

  /**
   * Remove scroll listener for AI button
   */
  private removeAIButtonScrollListener(): void {
    const updatePosition = this.aiButtonScrollListener;

    if (updatePosition) {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
      document.removeEventListener("scroll", updatePosition, true);
      this.aiButtonScrollListener = null;
    }

    // Remove scroll listeners from scrollable containers
    if (
      this.rewriteButton &&
      (this.rewriteButton as any).__scrollContainers &&
      updatePosition
    ) {
      const containers = (this.rewriteButton as any)
        .__scrollContainers as Set<HTMLElement>;
      containers.forEach((container) => {
        try {
          container.removeEventListener("scroll", updatePosition, {
            capture: true,
          } as any);
        } catch (e) {
          // Fallback if capture option causes issues
          container.removeEventListener("scroll", updatePosition, true);
        }
      });
      delete (this.rewriteButton as any).__scrollContainers;
    }
  }

  /**
   * Hide rewrite button
   * Only hides if currentFocusedElement is not set or element doesn't have focus
   */
  private hideRewriteButton(): void {
    if (this.rewriteButton) {
      // Don't hide button if there's a current focused element that still has focus
      if (
        this.currentFocusedElement &&
        document.activeElement === this.currentFocusedElement
      ) {
        // Element still has focus, don't hide button
        return;
      }

      // Hide button
      this.rewriteButton.classList.remove("show");

      // Remove scroll listener when button is hidden
      this.removeAIButtonScrollListener();
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  // @ts-ignore - Kept for compatibility, no longer used
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async handleGrammarClick(): Promise<void> {
    // Grammar click is no longer used - kept for compatibility
    // Grammar checking is now done automatically in real-time
    return;
  }

  /**
   * Handle rewrite action from context menu
   */
  private async handleContextMenuRewrite(selectedText: string): Promise<void> {
    if (!selectedText || selectedText.trim().length < 3) {
      return;
    }
  }

  // @ts-ignore - Kept for compatibility, no longer used
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async grammarText(_text: string): Promise<string> {
    const response = await fetch(
      "https://rewordly-web.vercel.app/api/grammar",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: _text,
          mode: "ai",
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`API request failed: ${response.status}`);
    }

    const data = await response.json();
    return data.corrected || "Failed to fix grammar.";
  }
}

// Initialize the content script
new RewordlyContentScript();
