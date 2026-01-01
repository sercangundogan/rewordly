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
  clearGrammarErrors,
  clearAllGrammarErrors,
  hideAllGrammarHighlights,
  isEditableElement,
  getElementId,
  findEditableInElement,
  removeElementScrollListeners,
  EditableElementContext,
  GrammarCheckContext,
  UIStateContext,
  EventContext,
  ConfigContext,
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
  adjustErrorPositionsForMultiWord,
  replaceGrammarError as replaceGrammarErrorHelper,
  handleInput as handleInputHelper,
  handleFocus as handleFocusHelper,
  handleBlur as handleBlurHelper,
} from "./helpers";

class RewordlyContentScript {
  // Context'ler - tüm state'ler context'lerde organize edilmiş
  private grammarCheckContext: GrammarCheckContext | null = null;
  private uiStateContext: UIStateContext | null = null;
  private eventContext: EventContext | null = null;
  private configContext: ConfigContext | null = null;
  private editableElementContext: EditableElementContext | null = null;

  // State'ler - context'lerde organize edilmiş, doğrudan erişim için getter'lar kullanılabilir
  // Grammar Check State
  private _grammarErrors: Map<HTMLElement, GrammarError[]> = new Map();
  private _activeGrammarRequests: Map<HTMLElement, string> = new Map();
  private _dismissedErrors: Map<string, boolean> = new Map();
  private _grammarCheckQueue: Array<{
    element: HTMLElement;
    priority?: number;
  }> = [];
  private _isProcessingQueue: boolean = false;
  private _grammarCheckTimeout: number | null = null;
  private _grammarCheckThrottle: number | null = null;
  private readonly BATCH_SIZE: number = 3;
  private readonly BATCH_DELAY: number = 200;
  private readonly GRAMMAR_CHECK_THROTTLE: number = 300;
  private _apiUtil: RewordlyAPIUtil;

  // UI State
  private _rewriteButtonHelper: RewriteButtonHelper;
  private _modalHelper: ModalHelper;
  private _highlightHelper: HighlightContainerHelper;
  private _buttonBlurTimeout: number | null = null;
  private _currentFocusedElement: HTMLElement | null = null;
  private _highlightPositionUpdateTimeout: number | null = null;
  private _aiButtonScrollListener: (() => void) | null = null;

  // Event State
  private _boundHandleInput = (event: Event) => this.handleInput(event);
  private _boundHandleFocus = (event: Event) => this.handleFocus(event);
  private _boundHandleBlur = (event: Event) => this.handleBlur(event);
  private _scheduledBlurHandlers = new Map<HTMLElement, NodeJS.Timeout>();
  private _isPerformingReplace = false;
  private _isPerformingDismiss = false;

  // Config State
  private _config: RewordlyConfig = {
    highlightsEnabled: true,
    rewriteEnabled: true,
  };
  private _platformAdapter: IPlatformAdapter | null = null;

  // Editable Element State
  private _editableElements: Set<HTMLElement> = new Set();
  private _ignoredElementIds: Set<string> = new Set();
  private _scrollableContainers = new Map<HTMLElement, Set<HTMLElement>>();
  private _scrollListeners = new Map<HTMLElement, () => void>();

  constructor() {
    console.log("RewordlyContentScript çalıştı", this._config);

    // Initialize WebSocket API (production server with WSS)
    // Using wss://rewordly.store with Let's Encrypt SSL certificate
    this._apiUtil = createRewordlyAPIUtil("wss://rewordly.store");

    console.log("Bağlantı kuruldu");

    // Initialize helpers
    this._rewriteButtonHelper = new RewriteButtonHelper();
    this._modalHelper = new ModalHelper();
    this._highlightHelper = new HighlightContainerHelper();

    console.log("Helperlar başlatıldı");
    console.log("Rewrite buton helper:", this._rewriteButtonHelper);
    console.log("Modal helper:", this._modalHelper);
    console.log("Highlight helper:", this._highlightHelper);

    // Initialize contexts
    this.initializeContexts();

    this.init();
  }

  /**
   * Tüm context'leri oluştur
   */
  private initializeContexts(): void {
    // Grammar Check Context
    this.grammarCheckContext = new GrammarCheckContext(
      this._grammarErrors,
      this._activeGrammarRequests,
      this._dismissedErrors,
      this._grammarCheckQueue,
      {
        get: () => this._isProcessingQueue,
        set: (value: boolean) => {
          this._isProcessingQueue = value;
        },
      },
      {
        get: () => this._grammarCheckTimeout,
        set: (value: number | null) => {
          this._grammarCheckTimeout = value;
        },
      },
      {
        get: () => this._grammarCheckThrottle,
        set: (value: number | null) => {
          this._grammarCheckThrottle = value;
        },
      },
      this._apiUtil,
      this.BATCH_SIZE,
      this.BATCH_DELAY,
      this.GRAMMAR_CHECK_THROTTLE
    );

    // UI State Context
    this.uiStateContext = new UIStateContext(
      this._rewriteButtonHelper,
      this._modalHelper,
      this._highlightHelper,
      {
        get: () => this._buttonBlurTimeout,
        set: (value: number | null) => {
          this._buttonBlurTimeout = value;
        },
      },
      {
        get: () => this._currentFocusedElement,
        set: (value: HTMLElement | null) => {
          this._currentFocusedElement = value;
        },
      },
      {
        get: () => this._highlightPositionUpdateTimeout,
        set: (value: number | null) => {
          this._highlightPositionUpdateTimeout = value;
        },
      },
      {
        get: () => this._aiButtonScrollListener,
        set: (value: (() => void) | null) => {
          this._aiButtonScrollListener = value;
        },
      }
    );

    // Event Context
    this.eventContext = new EventContext(
      this._boundHandleInput,
      this._boundHandleFocus,
      this._boundHandleBlur,
      this._scheduledBlurHandlers,
      {
        get: () => this._isPerformingReplace,
        set: (value: boolean) => {
          this._isPerformingReplace = value;
        },
      },
      {
        get: () => this._isPerformingDismiss,
        set: (value: boolean) => {
          this._isPerformingDismiss = value;
        },
      }
    );

    // Config Context
    this.configContext = new ConfigContext(this._config, this._platformAdapter);

    // Editable Element Context (diğer context'lere bağımlı)
    this.editableElementContext = new EditableElementContext(
      this._editableElements,
      this._ignoredElementIds,
      this._scrollableContainers,
      this._scrollListeners,
      this.grammarCheckContext!,
      this.uiStateContext!,
      this.eventContext!,
      this.configContext!,
      (el: HTMLElement, priority: number) =>
        this.queueGrammarCheck(el, priority),
      (el: HTMLElement, start: number, end: number) =>
        getErrorTextRects(el, start, end)
    );
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
    this._config = await loadConfig();
    // Update config context
    if (this.configContext) {
      (this.configContext as any).config = this._config;
    }

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
        this.editableElementContext!.findAndAttachToEditableElements();
      });
    } else {
      this.editableElementContext!.findAndAttachToEditableElements();
    }

    // Watch for new editable elements being added to the DOM
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        // Handle added nodes
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const element = node as HTMLElement;
            this.editableElementContext!.attachToEditableElement(element);
            // Also check child ren (including Shadow DOM)
            const editableChildren = findEditableInElement(element);
            editableChildren.forEach((el) => {
              this.editableElementContext!.attachToEditableElement(el);
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
      this.editableElementContext!.findAndAttachToEditableElements();
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
   * Get editable element context
   */
  private getEditableElementContext(): EditableElementContext {
    if (!this.editableElementContext) {
      this.initializeContexts();
    }
    return this.editableElementContext!;
  }

  /**
   * Get grammar check context
   */
  private getGrammarCheckContext(): GrammarCheckContext {
    if (!this.grammarCheckContext) {
      this.initializeContexts();
    }
    return this.grammarCheckContext!;
  }

  /**
   * Get UI state context
   */
  private getUIStateContext(): UIStateContext {
    if (!this.uiStateContext) {
      this.initializeContexts();
    }
    return this.uiStateContext!;
  }

  /**
   * Get event context
   */
  private getEventContext(): EventContext {
    if (!this.eventContext) {
      this.initializeContexts();
    }
    return this.eventContext!;
  }

  /**
   * Get config context
   */
  private getConfigContext(): ConfigContext {
    if (!this.configContext) {
      this.initializeContexts();
    }
    return this.configContext!;
  }

  // Getter'lar - eski property'lere erişim için (backward compatibility)
  // Bu getter'lar context'ler üzerinden state'lere erişim sağlar
  private get config() {
    return this.getConfigContext().config;
  }

  private set config(value: RewordlyConfig) {
    (this.getConfigContext() as any).config = value;
  }

  private get grammarErrors() {
    return this.getGrammarCheckContext().grammarErrors;
  }

  private get editableElements() {
    return this.getEditableElementContext().editableElements;
  }

  private get ignoredElementIds() {
    return this.getEditableElementContext().ignoredElementIds;
  }

  // private get scrollableContainers() {
  //   return this.getEditableElementContext().scrollableContainers;
  // }

  // private get scrollListeners() {
  //   return this.getEditableElementContext().scrollListeners;
  // }

  private get highlightHelper() {
    return this.getUIStateContext().highlightHelper;
  }

  private get rewriteButtonHelper() {
    return this.getUIStateContext().rewriteButtonHelper;
  }

  private get modalHelper() {
    return this.getUIStateContext().modalHelper;
  }

  // private get boundHandleInput() {
  //   return this.getEventContext().boundHandleInput;
  // }

  // private get boundHandleFocus() {
  //   return this.getEventContext().boundHandleFocus;
  // }

  // private get boundHandleBlur() {
  //   return this.getEventContext().boundHandleBlur;
  // }

  private get grammarCheckTimeout() {
    return this.getGrammarCheckContext().grammarCheckTimeout.get();
  }

  private set grammarCheckTimeout(value: number | null) {
    this.getGrammarCheckContext().grammarCheckTimeout.set(value);
  }

  private get grammarCheckThrottle() {
    return this.getGrammarCheckContext().grammarCheckThrottle.get();
  }

  private set grammarCheckThrottle(value: number | null) {
    this.getGrammarCheckContext().grammarCheckThrottle.set(value);
  }

  private get highlightPositionUpdateTimeout() {
    return this.getUIStateContext().highlightPositionUpdateTimeout.get();
  }

  private set highlightPositionUpdateTimeout(value: number | null) {
    this.getUIStateContext().highlightPositionUpdateTimeout.set(value);
  }

  private get buttonBlurTimeout() {
    return this.getUIStateContext().buttonBlurTimeout.get();
  }

  private set buttonBlurTimeout(value: number | null) {
    this.getUIStateContext().buttonBlurTimeout.set(value);
  }

  private get currentFocusedElement() {
    return this.getUIStateContext().currentFocusedElement.get();
  }

  private set currentFocusedElement(value: HTMLElement | null) {
    this.getUIStateContext().currentFocusedElement.set(value);
  }

  private get isPerformingReplace() {
    return this.getEventContext().isPerformingReplace.get();
  }

  private set isPerformingReplace(value: boolean) {
    this.getEventContext().isPerformingReplace.set(value);
  }

  private get isPerformingDismiss() {
    return this.getEventContext().isPerformingDismiss.get();
  }

  private set isPerformingDismiss(value: boolean) {
    this.getEventContext().isPerformingDismiss.set(value);
  }

  private get scheduledBlurHandlers() {
    return this.getEventContext().scheduledBlurHandlers;
  }

  private get activeGrammarRequests() {
    return this.getGrammarCheckContext().activeGrammarRequests;
  }

  private get dismissedErrors() {
    return this.getGrammarCheckContext().dismissedErrors;
  }

  private get grammarCheckQueue() {
    return this.getGrammarCheckContext().grammarCheckQueue;
  }

  private get isProcessingQueue() {
    return this.getGrammarCheckContext().isProcessingQueue.get();
  }

  private set isProcessingQueue(value: boolean) {
    this.getGrammarCheckContext().isProcessingQueue.set(value);
  }

  private get apiUtil() {
    return this.getGrammarCheckContext().apiUtil;
  }

  private get platformAdapter() {
    return this.getConfigContext().platformAdapter;
  }

  private set platformAdapter(value: IPlatformAdapter | null) {
    (this.getConfigContext() as any).platformAdapter = value;
  }

  private get aiButtonScrollListener() {
    return this.getUIStateContext().aiButtonScrollListener.get();
  }

  private set aiButtonScrollListener(value: (() => void) | null) {
    this.getUIStateContext().aiButtonScrollListener.set(value);
  }

  /**
   * Handle input events on editable elements
   */
  private handleInput(event: Event): void {
    handleInputHelper(event, {
      config: this.config,
      isPerformingReplace: this.isPerformingReplace,
      grammarCheckTimeout: this.grammarCheckTimeout,
      grammarCheckThrottle: this.grammarCheckThrottle,
      highlightPositionUpdateTimeout: this.highlightPositionUpdateTimeout,
      buttonBlurTimeout: this.buttonBlurTimeout,
      currentFocusedElement: this.currentFocusedElement,
      grammarErrors: this.grammarErrors,
      highlightHelper: this.highlightHelper,
      rewriteButtonHelper: this.rewriteButtonHelper,
      GRAMMAR_CHECK_THROTTLE: this.GRAMMAR_CHECK_THROTTLE,
      validateAndRemoveInvalidHighlights: (element: HTMLElement) =>
        this.validateAndRemoveInvalidHighlights(element),
      performGrammarCheckDirect: (element: HTMLElement) =>
        this.performGrammarCheckDirect(element),
      showAIRewriteButton: (element: HTMLElement) =>
        this.showAIRewriteButton(element),
      hideRewriteButton: () => this.hideRewriteButton(),
      setGrammarCheckTimeout: (timeout: number | null) => {
        this.grammarCheckTimeout = timeout;
      },
      setGrammarCheckThrottle: (throttle: number | null) => {
        this.grammarCheckThrottle = throttle;
      },
      setHighlightPositionUpdateTimeout: (timeout: number | null) => {
        this.highlightPositionUpdateTimeout = timeout;
      },
      setButtonBlurTimeout: (timeout: number | null) => {
        this.buttonBlurTimeout = timeout;
      },
      setCurrentFocusedElement: (element: HTMLElement | null) => {
        this.currentFocusedElement = element;
      },
    });
  }

  /**
   * Handle focus events on editable elements
   */
  private handleFocus(event: Event): void {
    handleFocusHelper(event, {
      config: this.config,
      grammarErrors: this.grammarErrors,
      highlightHelper: this.highlightHelper,
      rewriteButtonHelper: this.rewriteButtonHelper,
      grammarCheckThrottle: this.grammarCheckThrottle,
      buttonBlurTimeout: this.buttonBlurTimeout,
      scheduledBlurHandlers: this.scheduledBlurHandlers,
      currentFocusedElement: this.currentFocusedElement,
      isErrorDismissed: (element: HTMLElement, error: GrammarError) =>
        this.isErrorDismissed(element, error),
      createDisplayGrammarErrorsCallback: () =>
        this.createDisplayGrammarErrorsCallback(),
      performGrammarCheckDirect: (element: HTMLElement) =>
        this.performGrammarCheckDirect(element),
      showAIRewriteButton: (element: HTMLElement) =>
        this.showAIRewriteButton(element),
      hideRewriteButton: () => this.hideRewriteButton(),
      setGrammarCheckThrottle: (throttle: number | null) => {
        this.grammarCheckThrottle = throttle;
      },
      setButtonBlurTimeout: (timeout: number | null) => {
        this.buttonBlurTimeout = timeout;
      },
      setCurrentFocusedElement: (element: HTMLElement | null) => {
        this.currentFocusedElement = element;
      },
    });
  }

  /**
   * Handle blur events on editable elements
   */
  private handleBlur(event: Event): void {
    handleBlurHelper(event, {
      config: this.config,
      grammarCheckTimeout: this.grammarCheckTimeout,
      highlightPositionUpdateTimeout: this.highlightPositionUpdateTimeout,
      buttonBlurTimeout: this.buttonBlurTimeout,
      currentFocusedElement: this.currentFocusedElement,
      scheduledBlurHandlers: this.scheduledBlurHandlers,
      isPerformingReplace: this.isPerformingReplace,
      isPerformingDismiss: this.isPerformingDismiss,
      grammarErrors: this.grammarErrors,
      highlightHelper: this.highlightHelper,
      rewriteButtonHelper: this.rewriteButtonHelper,
      setGrammarCheckTimeout: (timeout: number | null) => {
        this.grammarCheckTimeout = timeout;
      },
      setHighlightPositionUpdateTimeout: (timeout: number | null) => {
        this.highlightPositionUpdateTimeout = timeout;
      },
      setButtonBlurTimeout: (timeout: number | null) => {
        this.buttonBlurTimeout = timeout;
      },
      setCurrentFocusedElement: (element: HTMLElement | null) => {
        this.currentFocusedElement = element;
      },
      hideRewriteButton: () => this.hideRewriteButton(),
    });
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
      displayGrammarErrors: this.createDisplayGrammarErrorsCallback(),
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
      displayGrammarErrors: this.createDisplayGrammarErrorsCallback(),
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
   * Get isPerformingDismiss reference object
   */
  private getIsPerformingDismissRef(): { value: boolean } {
    const self = this;
    return {
      get value(): boolean {
        return self.isPerformingDismiss;
      },
      set value(v: boolean) {
        self.isPerformingDismiss = v;
      },
    };
  }

  /**
   * Create attachHighlightHoverListener callback with all required parameters
   * This reduces code duplication across multiple call sites
   */
  private createAttachHighlightHoverListenerCallback(): (
    highlight: HTMLElement,
    error: GrammarError,
    element: HTMLElement
  ) => void {
    const isPerformingDismissRef = this.getIsPerformingDismissRef();
    return (
      highlight: HTMLElement,
      error: GrammarError,
      element: HTMLElement
    ) => {
      attachHighlightHoverListener(highlight, error, element, {
        grammarErrors: this.grammarErrors,
        dismissedErrors: this.dismissedErrors,
        highlightsContent: this.highlightHelper.getContent(),
        replaceGrammarError: (
          element: HTMLElement,
          error: GrammarError,
          rep: string
        ) => this.replaceGrammarError(element, error, rep),
        closeAllGrammarTooltips: () => this.closeAllGrammarTooltips(),
        scheduledBlurHandlers: this.scheduledBlurHandlers as unknown as Map<
          HTMLElement,
          number
        >,
        isPerformingDismiss: isPerformingDismissRef,
        getElementId,
      });
    };
  }

  /**
   * Create displayGrammarErrors callback with all required parameters
   * This reduces code duplication across multiple call sites
   */
  private createDisplayGrammarErrorsCallback(): (
    element: HTMLElement,
    errors: GrammarError[]
  ) => void {
    return (element: HTMLElement, errors: GrammarError[]) => {
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
        attachHighlightHoverListener:
          this.createAttachHighlightHoverListenerCallback(),
        highlightsContent: this.highlightHelper.getContent(),
      });
    };
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
      this.createAttachHighlightHoverListenerCallback(),
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
    const context = this.getEditableElementContext();
    removeElementScrollListeners(element, context);
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
   * Show AI rewrite button at bottom-right of editable element
   * For single-line elements, positions button at right-center (vertically aligned)
   * For multi-line elements, positions button at bottom-right
   */
  private showAIRewriteButton(element: HTMLElement): void {
    this.rewriteButtonHelper.showAIRewriteButton(element, {
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
        this.rewriteButtonHelper.updateAIRewriteButtonPosition(el),
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
