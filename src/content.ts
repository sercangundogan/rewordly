/**
 * Rewordly Content Script
 * Handles text selection, rewrite button UI, and displaying rewritten text
 * Now includes real-time grammar checking for editable elements
 */

import { createRewordlyAPIUtil, RewordlyAPIUtil } from "./utils/api";
import { RewordlyConfig, GrammarError, IPlatformAdapter } from "./types";
import {
  RewriteButtonHelper,
  ModalHelper,
  HighlightContainerHelper,
  getErrorTextRects,
  closeAllGrammarTooltips,
  validateAndRemoveInvalidHighlights,
  createHighlight,
  displayGrammarErrors,
  attachHighlightHoverListener,
  showGrammarOverlay,
  clearGrammarErrors,
  clearAllGrammarErrors,
  hideAllGrammarHighlights,
  isEditableElement,
  isElementVisible,
  getElementId,
  findAllEditableElements,
  findEditableInElement,
  findEditableInShadowDOM,
  shouldIgnoreElement,
  setupElementScrollListeners,
  removeElementScrollListeners,
  isSingleLineElement,
  loadConfig,
  isPageDisabled,
  isGrammarCheckAllowedSite,
  createPlatformAdapterForSite,
  checkGrammarAPI,
  extractTextExcludingSignature,
  isElementIgnored,
  isErrorDismissed,
  performGrammarCheckDirect,
  performGrammarCheck,
  queueGrammarCheck,
  processGrammarCheckQueue,
  checkAndPerformGrammarCheckForExistingText,
  adjustErrorPositionsForMultiWord,
  replaceGrammarError as replaceGrammarErrorHelper,
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

  // Store bound event handlers to allow proper removal
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
    console.log("RewordlyContentScript çalıştı", this.config);

    // Initialize WebSocket API (production server with WSS)
    // Using wss://rewordly.store with Let's Encrypt SSL certificate
    this.apiUtil = createRewordlyAPIUtil("wss://rewordly.store");

    console.log("Bağlantı kuruldu");

    // Initialize helpers
    this.rewriteButtonHelper = new RewriteButtonHelper();
    this.modalHelper = new ModalHelper();
    this.highlightHelper = new HighlightContainerHelper();

    console.log("Helperlar başlatıldı");
    console.log("Rewrite buton helper:", this.rewriteButtonHelper);
    console.log("Modal helper:", this.modalHelper);
    console.log("Highlight helper:", this.highlightHelper);

    this.init();
  }

  private async init(): Promise<void> {
    console.log("Başlatılıyor...");
    // Check if this page is disabled - if so, don't initialize at all
    const pageDisabled = await isPageDisabled();
    if (pageDisabled) {
      return;
    }
    console.log("Sayfa etkin");

    // Load configuration from storage
    this.config = await loadConfig();

    console.log("Config yüklendi", this.config);

    // Set up real-time grammar checking for editable elements
    this.setupRealtimeGrammarCheck();

    console.log("Realtime grammar checking ayarlandı");

    // Set up platform-specific adapter
    this.setupPlatformAdapter();

    // Create UI elements using helpers
    this.rewriteButtonHelper.create();
    this.modalHelper.create();
    this.highlightHelper.create();

    // Set up scroll/resize listeners for highlights
    this.setupHighlightsUpdateListeners();

    // Listen for settings updates from popup
    this.setupMessageListener();
  }

  /**
   * Set up real-time grammar checking for editable elements
   */
  private setupRealtimeGrammarCheck(): void {
    // Use event delegation at document level to catch all input events
    // This works even for dynamically added elements and Shadow DOM
    this.setupEventDelegation();
    console.log("Event delegation ayarlandı");

    console.log("Docuement ready state", document.readyState);

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
                clearGrammarErrors(element, {
                  grammarErrors: this.grammarErrors,
                  clearElementHighlights: (el: HTMLElement) =>
                    this.clearElementHighlights(el),
                });
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
                    clearGrammarErrors(errorElement, {
                      grammarErrors: this.grammarErrors,
                      clearElementHighlights: (el: HTMLElement) =>
                        this.clearElementHighlights(el),
                    });
                  }
                }
              });
            }
          });
        }
      });

      // Periodically clean up overlays for removed elements (skip during replace)
      if (!this.isPerformingReplace) {
        clearAllGrammarErrors({
          grammarErrors: this.grammarErrors,
          clearGrammarErrors: (el: HTMLElement) =>
            clearGrammarErrors(el, {
              grammarErrors: this.grammarErrors,
              clearElementHighlights: (elem: HTMLElement) =>
                this.clearElementHighlights(elem),
            }),
        });
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

    console.log("Input event listener ayarlandı");

    document.addEventListener(
      "beforeinput",
      (event) => {
        this.handleDelegatedInput(event);
      },
      true
    );

    console.log("Beforeinput event listener ayarlandı");

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

    console.log("Keyup event listener ayarlandı");
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

    // Gmail spell check marker removal is now handled by GmailAdapter

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
    checkAndPerformGrammarCheckForExistingText(element, {
      isGrammarCheckAllowedSite: () => isGrammarCheckAllowedSite(),
      config: this.config,
      queueGrammarCheck: (el: HTMLElement, priority: number) =>
        this.queueGrammarCheck(el, priority),
      isEditableElement,
      isElementVisible,
    });

    // Set up scroll listeners for scrollable containers
    setupElementScrollListeners(element, {
      scrollableContainers: this.scrollableContainers,
      scrollListeners: this.scrollListeners,
      grammarErrors: this.grammarErrors,
      highlightHelper: this.highlightHelper,
      getErrorTextRects: (el: HTMLElement, start: number, end: number) =>
        getErrorTextRects(el, start, end),
      removeElementScrollListeners: (el: HTMLElement) =>
        removeElementScrollListeners(el, {
          scrollableContainers: this.scrollableContainers,
          scrollListeners: this.scrollListeners,
        }),
    });
  }

  /**
   * Handle input events on editable elements
   */
  private handleInput(event: Event): void {
    // Skip programmatic input events triggered by our replace operations
    // This prevents unnecessary grammar checks after replacements
    if ((event as any).__rewordlyProgrammatic) {
      console.log("Programmatic input event detected");
      return;
    }

    const element = event.target as HTMLElement;

    if (!isEditableElement(element)) {
      console.log("Element is not editable");
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
      isGrammarCheckAllowedSite() &&
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

    // Update highlight positions when text changes (if highlights exist)
    if (this.config.highlightsEnabled && this.grammarErrors.has(element)) {
      // Clear previous position update timeout
      if (this.highlightPositionUpdateTimeout !== null) {
        clearTimeout(this.highlightPositionUpdateTimeout);
      }

      // Update positions after DOM updates (using double requestAnimationFrame to ensure DOM is fully updated)
      this.highlightPositionUpdateTimeout = window.setTimeout(() => {
        requestAnimationFrame(() => {
          this.highlightHelper.updatePositions(
            element,
            this.grammarErrors.get(element) || [],
            (error: GrammarError) =>
              getErrorTextRects(element, error.start, error.end)
          );
        });
      }, 10);
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
      isGrammarCheckAllowedSite() &&
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
      showGrammarOverlay(element, {
        grammarErrors: this.grammarErrors,
        highlightHelper: this.highlightHelper,
        displayGrammarErrors: (el: HTMLElement, errors: GrammarError[]) =>
          this.displayGrammarErrors(el, errors),
        isErrorDismissed: (el: HTMLElement, err: GrammarError) =>
          this.isErrorDismissed(el, err),
        getElementId,
      });
    }

    // Perform immediate grammar check on focus (if element has text)
    if (
      this.config.highlightsEnabled &&
      hasText &&
      isGrammarCheckAllowedSite()
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
    const button = this.rewriteButtonHelper["button"];
    const isClickingButton =
      relatedTarget &&
      (relatedTarget === button || button?.contains(relatedTarget));

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
        const button = this.rewriteButtonHelper["button"];
        const shouldHide =
          document.activeElement !== blurredElement &&
          document.activeElement !== button &&
          !button?.contains(document.activeElement) &&
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
            const highlightsContent = this.highlightHelper.getContent();
            if (highlightsContent) {
              const elementId = getElementId(element);
              const highlights = highlightsContent.querySelectorAll(
                `[data-element-id="${elementId}"]`
              );
              highlights.forEach((highlight: Element) => {
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
    queueGrammarCheck(element, priority, {
      isGrammarCheckAllowedSite: () => isGrammarCheckAllowedSite(),
      grammarCheckQueue: this.grammarCheckQueue,
      isProcessingQueue: {
        get: () => this.isProcessingQueue,
        set: (value: boolean) => {
          this.isProcessingQueue = value;
        },
      },
      processGrammarCheckQueue: () => this.processGrammarCheckQueue(),
    });
  }

  /**
   * Process grammar check queue in batches
   */
  private async processGrammarCheckQueue(): Promise<void> {
    await processGrammarCheckQueue({
      grammarCheckQueue: this.grammarCheckQueue,
      isProcessingQueue: {
        get: () => this.isProcessingQueue,
        set: (value: boolean) => {
          this.isProcessingQueue = value;
        },
      },
      performGrammarCheck: (el: HTMLElement) => this.performGrammarCheck(el),
      BATCH_SIZE: this.BATCH_SIZE,
      BATCH_DELAY: this.BATCH_DELAY,
    });
  }

  /**
   * Perform grammar check directly (new optimized method with request cancellation)
   */
  private async performGrammarCheckDirect(element: HTMLElement): Promise<void> {
    await performGrammarCheckDirect(element, {
      apiUtil: this.apiUtil,
      activeGrammarRequests: this.activeGrammarRequests,
      isGrammarCheckAllowedSite: () => isGrammarCheckAllowedSite(),
      isElementIgnored: (el: HTMLElement) => this.isElementIgnored(el),
      isPerformingReplace: this.isPerformingReplace,
      displayGrammarErrors: (el: HTMLElement, errors: GrammarError[]) =>
        this.displayGrammarErrors(el, errors),
    });
  }

  /**
   * Perform grammar check on an element (legacy method - kept for queue system)
   */
  private async performGrammarCheck(element: HTMLElement): Promise<void> {
    await performGrammarCheck(element, {
      apiUtil: this.apiUtil,
      isGrammarCheckAllowedSite: () => isGrammarCheckAllowedSite(),
      isElementIgnored: (el: HTMLElement) => this.isElementIgnored(el),
      isPerformingReplace: this.isPerformingReplace,
      displayGrammarErrors: (el: HTMLElement, errors: GrammarError[]) =>
        this.displayGrammarErrors(el, errors),
    });
  }

  /**
   * Validate and remove invalid highlights immediately when text changes
   */
  private validateAndRemoveInvalidHighlights(element: HTMLElement): void {
    validateAndRemoveInvalidHighlights(
      element,
      this.highlightHelper.getContent(),
      this.grammarErrors,
      extractTextExcludingSignature,
      getElementId,
      this.isPerformingReplace
    );
  }

  /**
   * Display grammar errors on an element using Grammarly-style highlights
   */
  private displayGrammarErrors(
    element: HTMLElement,
    errors: GrammarError[]
  ): void {
    displayGrammarErrors(element, errors, {
      grammarErrors: this.grammarErrors,
      highlightHelper: this.highlightHelper,
      dismissedErrors: this.dismissedErrors,
      isErrorDismissed: (el: HTMLElement, err: GrammarError) =>
        this.isErrorDismissed(el, err),
      createHighlight: (
        el: HTMLElement,
        err: GrammarError,
        idx: number,
        animate: boolean
      ) => this.createHighlight(el, err, idx, animate),
      attachHighlightHoverListener: (
        highlight: HTMLElement,
        err: GrammarError,
        el: HTMLElement
      ) => this.attachHighlightHoverListener(highlight, err, el),
      highlightsContent: this.highlightHelper.getContent(),
    });
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
   * Create a single highlight for an error
   * @param animate - Whether to animate the highlight (default: true)
   */
  private createHighlight(
    element: HTMLElement,
    error: GrammarError,
    index: number,
    animate: boolean = true
  ): void {
    createHighlight(
      element,
      error,
      index,
      this.highlightHelper.getContent(),
      getErrorTextRects,
      extractTextExcludingSignature,
      adjustErrorPositionsForMultiWord,
      getElementId,
      (el: HTMLElement, err: GrammarError) => this.isErrorDismissed(el, err),
      (highlight: HTMLElement, err: GrammarError, el: HTMLElement) =>
        this.attachHighlightHoverListener(highlight, err, el),
      animate
    );
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

  /**
   * Get error rect for contenteditable elements
   */

  /**
   * Clear highlights for a specific element
   */
  private clearElementHighlights(element: HTMLElement): void {
    // Use helper to clear highlights
    this.highlightHelper.clearElementHighlights(element);

    // Remove scroll listeners for this element
    removeElementScrollListeners(element, {
      scrollableContainers: this.scrollableContainers,
      scrollListeners: this.scrollListeners,
    });
  }

  /**
   * Attach hover listener to highlight
   */
  private attachHighlightHoverListener(
    highlight: HTMLElement,
    error: GrammarError,
    element: HTMLElement
  ): void {
    const self = this;
    const isPerformingDismissRef = {
      get value(): boolean {
        return self.isPerformingDismiss;
      },
      set value(v: boolean) {
        self.isPerformingDismiss = v;
      },
    };
    attachHighlightHoverListener(highlight, error, element, {
      grammarErrors: this.grammarErrors,
      dismissedErrors: this.dismissedErrors,
      highlightsContent: this.highlightHelper.getContent(),
      replaceGrammarError: (el: HTMLElement, err: GrammarError, rep: string) =>
        this.replaceGrammarError(el, err, rep),
      closeAllGrammarTooltips: () => this.closeAllGrammarTooltips(),
      scheduledBlurHandlers: this.scheduledBlurHandlers as unknown as Map<
        HTMLElement,
        number
      >,
      isPerformingDismiss: isPerformingDismissRef,
      getElementId,
    });
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
    closeAllGrammarTooltips();
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
    replaceGrammarErrorHelper(element, targetError, replacement, {
      grammarErrors: this.grammarErrors,
      highlightsContent: this.highlightHelper.getContent(),
      isPerformingReplace: {
        get: () => this.isPerformingReplace,
        set: (value: boolean) => {
          this.isPerformingReplace = value;
        },
      },
      highlightHelper: this.highlightHelper,
      scheduledBlurHandlers: this.scheduledBlurHandlers as unknown as Map<
        HTMLElement,
        number
      >,
      performGrammarCheck: (el: HTMLElement) => this.performGrammarCheck(el),
    });
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
            hideAllGrammarHighlights({
              highlightHelper: this.highlightHelper,
            });
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
   * Update AI rewrite button position based on element's current position
   * This is called both on initial show and on scroll/resize events
   */
  private updateAIRewriteButtonPosition(element: HTMLElement): void {
    const rewriteButton = this.rewriteButtonHelper["button"];
    if (!rewriteButton || !this.config.rewriteEnabled) {
      return;
    }

    // Only show rewrite button on sites where grammar check is enabled
    if (!isGrammarCheckAllowedSite() || !this.config.highlightsEnabled) {
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
    rewriteButton.style.left = `${buttonX}px`;
    rewriteButton.style.top = `${buttonY}px`;
  }

  /**
   * Show AI rewrite button at bottom-right of editable element
   * For single-line elements, positions button at right-center (vertically aligned)
   * For multi-line elements, positions button at bottom-right
   */
  private showAIRewriteButton(element: HTMLElement): void {
    this.rewriteButtonHelper.showAIRewriteButton(element, {
      rewriteEnabled: this.config.rewriteEnabled,
      highlightsEnabled: this.config.highlightsEnabled,
      isGrammarCheckAllowedSite: () => isGrammarCheckAllowedSite(),
      buttonBlurTimeout: {
        value: this.buttonBlurTimeout,
        set: (value: number | null) => {
          this.buttonBlurTimeout = value;
        },
      },
      addAIButtonScrollListener: (el: HTMLElement) =>
        this.addAIButtonScrollListener(el),
      removeAIButtonScrollListener: () => this.removeAIButtonScrollListener(),
    });
  }

  /**
   * Add scroll listener to update AI button position
   */
  private addAIButtonScrollListener(element: HTMLElement): void {
    this.rewriteButtonHelper.addAIButtonScrollListener(element, {
      updateAIRewriteButtonPosition: (el: HTMLElement) =>
        this.updateAIRewriteButtonPosition(el),
      removeAIButtonScrollListener: () => this.removeAIButtonScrollListener(),
      aiButtonScrollListener: {
        value: this.aiButtonScrollListener,
        set: (value: (() => void) | null) => {
          this.aiButtonScrollListener = value;
        },
      },
    });
  }

  /**
   * Remove scroll listener for AI button
   */
  private removeAIButtonScrollListener(): void {
    this.rewriteButtonHelper.removeAIButtonScrollListener({
      aiButtonScrollListener: {
        value: this.aiButtonScrollListener,
        set: (value: (() => void) | null) => {
          this.aiButtonScrollListener = value;
        },
      },
    });
  }

  /**
   * Hide rewrite button
   * Only hides if currentFocusedElement is not set or element doesn't have focus
   */
  private hideRewriteButton(): void {
    this.rewriteButtonHelper.hideRewriteButton({
      currentFocusedElement: this.currentFocusedElement,
      removeAIButtonScrollListener: () => this.removeAIButtonScrollListener(),
    });
  }

  /**
   * Handle rewrite action from context menu
   */
  private async handleContextMenuRewrite(selectedText: string): Promise<void> {
    if (!selectedText || selectedText.trim().length < 3) {
      return;
    }
    // TODO: Implement context menu rewrite functionality
  }
}

// Initialize the content script
new RewordlyContentScript();
