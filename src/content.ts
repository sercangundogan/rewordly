/**
 * Rewordly Content Script
 * Handles text selection, floating button UI, and displaying rewritten text
 * Now includes real-time grammar checking for editable elements
 */

import { createRewordlyAPIUtil, RewordlyAPIUtil } from './utils/api';

interface RewordlyConfig {
  highlightsEnabled: boolean;
  rewriteEnabled: boolean;
}

/**
 * Grammar error with unique ID for reliable tracking.
 * The ID persists across position updates, enabling correct handling of duplicate words.
 */
interface GrammarError {
  id: string; // Unique identifier for this error instance (persists across replacements)
  start: number; // Start position in text (may be updated after other replacements)
  end: number; // End position in text (may be updated after other replacements)
  word: string; // The error word/phrase
  suggestions: string[]; // Correction suggestions
  type: 'grammar' | 'spelling'; // Error type
}

interface GrammarCheckResponse {
  errors: GrammarError[];
  corrected: string;
  detectedLanguage?: {
    code: string;
    name: string;
  };
}

class RewordlyContentScript {
  private config: RewordlyConfig = {
    highlightsEnabled: true,
    rewriteEnabled: true
  };
  
  private floatingButton: HTMLDivElement | null = null;
  private modal: HTMLDivElement | null = null;
  private selectedText: string = '';
  private isProcessing: boolean = false;
  private isModalOpen: boolean = false; // Add flag to track modal state
  private currentOperation: 'rewrite' | 'grammar' = 'rewrite'; // Track current operation
  private observer: MutationObserver | null = null;
  
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
  
  // Track active tooltips by error ID to prevent duplicates
  private activeTooltips: Map<string, HTMLElement> = new Map();
  
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

  // Error ID counter for generating unique IDs
  private errorIdCounter = 0;

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

  // Request queue for batch processing API requests (deprecated - using direct requests now)
  private grammarCheckQueue: Array<{ element: HTMLElement; priority?: number }> = [];
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
    this.apiUtil = createRewordlyAPIUtil('wss://rewordly.store');
    this.init();
  }

  /**
   * Generate a unique ID for an error
   */
  private generateErrorId(): string {
    return `error-${Date.now()}-${this.errorIdCounter++}`;
  }

  /**
   * Check if the current page is disabled
   */
  private async isPageDisabled(): Promise<boolean> {
    try {
      const result = await chrome.storage.sync.get(['rewordlyDisabledPages']);
      const disabledPages: string[] = result['rewordlyDisabledPages'] || [];
      
      const currentUrl = window.location.href;
      const currentOrigin = window.location.origin;
      
      // Check if exact URL or origin is disabled
      return disabledPages.some(disabledUrl => {
        // Exact URL match
        if (disabledUrl === currentUrl) {
          return true;
        }
        // Origin match (for disabling entire domain)
        if (disabledUrl === currentOrigin) {
          return true;
        }
        return false;
      });
    } catch (error) {
      console.error('Failed to check if page is disabled:', error);
      return false;
    }
  }

  private async init(): Promise<void> {
    // Check if this page is disabled - if so, don't initialize at all
    const pageDisabled = await this.isPageDisabled();
    if (pageDisabled) {
      return;
    }
    // Define custom element for highlights container to prevent Reddit's CSS from hiding it
    // Reddit uses :not(:defined) to hide undefined custom elements
    if (typeof customElements !== 'undefined' && customElements && !customElements.get('rewordly-highlights')) {
      customElements.define('rewordly-highlights', class extends HTMLElement {
        constructor() {
          super();
        }
      });
    }
    
    // Add global style to override Reddit's CSS that hides undefined custom elements
    // Reddit uses :not(:defined) to hide custom elements, so we need to explicitly show ours
    if (window.location.hostname.includes('reddit.com')) {
      const styleId = 'rewordly-reddit-override';
      if (!document.getElementById(styleId)) {
        const style = document.createElement('style');
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
    await this.loadConfig();
    
    // Set up event listeners
    this.setupEventListeners();
    
    // Set up real-time grammar checking for editable elements
    this.setupRealtimeGrammarCheck();
    
    // Create floating button (initially hidden)
    this.createFloatingButton();
    
    // Create modal (initially hidden)
    this.createModal();
    
    // Create Grammarly-style highlights container
    this.createHighlightsContainer();
    
    // Set up scroll/resize listeners for highlights
    this.setupHighlightsUpdateListeners();
    
    // Set up observer for dynamically loaded content
    this.setupContentObserver();
    
    // Listen for settings updates from popup
    this.setupMessageListener();
  }

  private async loadConfig(): Promise<void> {
    try {
      const result = await chrome.storage.sync.get(['rewordlyHighlightsEnabled', 'rewordlyRewriteEnabled']);
      
      // Use environment variables as defaults if not set in storage
      this.config.highlightsEnabled = result['rewordlyHighlightsEnabled'] !== false;
      this.config.rewriteEnabled = result['rewordlyRewriteEnabled'] !== false;

    } catch (error) {
      console.error('Failed to load Rewordly config:', error);
    }
  }

  private setupEventListeners(): void {
    // Remove existing listeners to prevent duplicates
    document.removeEventListener('click', this.boundHandleOutsideClick);
    document.removeEventListener('keydown', this.boundHandleKeyDown);
    
    // Listen for clicks outside to hide button/modal
    document.addEventListener('click', this.boundHandleOutsideClick, true);
    
    // Listen for escape key to close modal
    document.addEventListener('keydown', this.boundHandleKeyDown, true);
    
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
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
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
            this.findEditableInElement(element);
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
              const childOverlays = element.querySelectorAll('.rewordly-grammar-overlay');
              childOverlays.forEach((overlay) => {
                const elementId = overlay.getAttribute('data-element-id');
                if (elementId) {
                  // Find the element and clear its errors
                  const errorElement = Array.from(this.grammarErrors.keys()).find(
                    (el) => this.getElementId(el) === elementId
                  );
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
        attributeFilter: ['contenteditable']
      });
    } else {
      const bodyObserver = new MutationObserver(() => {
        if (document.body) {
          observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['contenteditable']
          });
          bodyObserver.disconnect();
        }
      });
      bodyObserver.observe(document.documentElement, {
        childList: true
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
    document.addEventListener('input', (event) => {
      this.handleDelegatedInput(event);
    }, true);
    
    document.addEventListener('beforeinput', (event) => {
      this.handleDelegatedInput(event);
    }, true);
    
    // Also listen to keyup for contenteditable elements
    document.addEventListener('keyup', (event) => {
      const target = event.target as HTMLElement;
      if (this.isEditableElement(target)) {
        this.handleDelegatedInput(event);
      }
    }, true);
  }

  /**
   * Handle delegated input events
   */
  private handleDelegatedInput(event: Event): void {
    const element = event.target as HTMLElement;
    
    if (!element || !this.isEditableElement(element)) {
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
   * Find editable elements within an element (including Shadow DOM)
   */
  private findEditableInElement(element: HTMLElement): void {
    // Regular querySelector
    const editableChildren = element.querySelectorAll(`
      input[type="text"], 
      input[type="email"], 
      input[type="search"], 
      input:not([type]), 
      input[type="url"],
      textarea, 
      [contenteditable="true"],
      [contenteditable=""],
      [contenteditable]
    `);
    
    editableChildren.forEach((child) => {
      this.attachToEditableElement(child as HTMLElement);
    });
    
    // Check Shadow DOM
    if (element.shadowRoot) {
      const shadowEditable = element.shadowRoot.querySelectorAll(`
        input[type="text"], 
        input[type="email"], 
        input[type="search"], 
        input:not([type]), 
        input[type="url"],
        textarea, 
        [contenteditable="true"],
        [contenteditable=""],
        [contenteditable]
      `);
      
      shadowEditable.forEach((child) => {
        this.attachToEditableElement(child as HTMLElement);
      });
    }
    
    // Recursively check for elements with shadow roots
    const allElements = element.querySelectorAll('*');
    allElements.forEach((el) => {
      if ((el as HTMLElement).shadowRoot) {
        this.findEditableInElement(el as HTMLElement);
      }
    });
  }

  /**
   * Find all editable elements and attach listeners
   */
  private findAndAttachToEditableElements(): void {
    // More comprehensive selector to catch all editable elements
    const inputs = document.querySelectorAll(`
      input[type="text"], 
      input[type="email"], 
      input[type="search"], 
      input:not([type]), 
      input[type="url"],
      textarea, 
      [contenteditable="true"],
      [contenteditable=""],
      [contenteditable]
    `);
    
    // Also check all elements for contenteditable (some sites set it dynamically)
    const allElements = document.querySelectorAll('*');
    const contentEditableElements: HTMLElement[] = [];
    allElements.forEach((el) => {
      const htmlEl = el as HTMLElement;
      if (htmlEl.isContentEditable || htmlEl.getAttribute('contenteditable') === 'true' || htmlEl.getAttribute('contenteditable') === '') {
        contentEditableElements.push(htmlEl);
      }
    });
    
    // Combine and deduplicate
    const allEditable = new Set([...inputs, ...contentEditableElements]);
        
    allEditable.forEach((element) => {
      const el = element as HTMLElement;
      this.attachToEditableElement(el);
    });
    
    // Check Shadow DOM
    this.findEditableInShadowDOM(document.body);
  }

  /**
   * Find editable elements in Shadow DOM
   */
  private findEditableInShadowDOM(root: Node): void {
    if (!root) return;
    
    // Walk the tree
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node: Node | null;
    
    while ((node = walker.nextNode())) {
      const element = node as HTMLElement;
      
      // Check if element itself is editable
      if (this.isEditableElement(element)) {
        this.attachToEditableElement(element);
      }
      
      // Check Shadow DOM
      if (element.shadowRoot) {
        this.findEditableInShadowDOM(element.shadowRoot);
      }
    }
  }

  /**
   * Check if element is editable
   */
  private isEditableElement(element: HTMLElement): boolean {
    if (element instanceof HTMLInputElement) {
      const type = element.type.toLowerCase();
      return type === 'text' || type === 'email' || type === 'search' || type === '' || type === 'url';
    }
    if (element instanceof HTMLTextAreaElement) {
      return true;
    }
    // Check for contenteditable (can be "true", "", or just present)
    const contentEditable = element.getAttribute('contenteditable');
    if (contentEditable === 'true' || contentEditable === '' || (contentEditable !== null && contentEditable !== 'false')) {
      return true;
    }
    return false;
  }

  /**
   * Attach event listeners to an editable element
   */
  private attachToEditableElement(element: HTMLElement): void {
    if (!this.isEditableElement(element)) {
      return;
    }
    
    if (this.editableElements.has(element)) {
      return;
    }

    this.editableElements.add(element);
    
    // Check if this element should be ignored (e.g., Gmail's "To" field)
    if (this.shouldIgnoreElement(element)) {
      const elementId = this.getElementId(element);
      this.ignoredElementIds.add(elementId);
      return; // Don't attach grammar checking to ignored elements
    }
    
    // Disable browser's native spell check
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      element.spellcheck = false;
    } else {
      element.setAttribute('spellcheck', 'false');
    }
    
    // Disable Gmail's spell check (writingsuggestions)
    element.setAttribute('writingsuggestions', 'false');
    
    // Remove Gmail's spell check markers (aria-invalid spans)
    this.removeGmailSpellCheckMarkers(element);
    
    // Watch for Gmail adding spell check markers and remove them
    this.setupGmailSpellCheckObserver(element);
    
    // Add multiple event listeners to catch all input types
    // Use capture phase to catch events before they're stopped
    element.addEventListener('input', this.boundHandleInput, true);
    element.addEventListener('beforeinput', this.boundHandleInput, true);
    element.addEventListener('keyup', this.boundHandleInput, true);
    element.addEventListener('focus', this.boundHandleFocus, true);
    element.addEventListener('blur', this.boundHandleBlur, true);
    
    // For contenteditable, also listen to textInput
    if (element.getAttribute('contenteditable') === 'true') {
      element.addEventListener('textInput', this.boundHandleInput, true);
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
  private checkAndPerformGrammarCheckForExistingText(element: HTMLElement): void {
    // Only perform grammar check on allowed sites (Twitter, Gmail, Reddit, Medium)
    if (!this.isGrammarCheckAllowedSite()) {
      return;
    }
    
    if (!this.config.highlightsEnabled) {
      return;
    }
    
    // Check if element has text
    let hasText = false;
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      hasText = element.value.trim().length >= 3;
    } else if (element.getAttribute('contenteditable') === 'true' || element.isContentEditable) {
      hasText = (element.innerText || element.textContent || '').trim().length >= 3;
    }
    
    if (!hasText || !this.isEditableElement(element)) {
      return;
    }
    
    // Check if element is visible
    const isVisible = this.isElementVisible(element);
    
    if (isVisible) {
      // Element is visible, queue grammar check
      setTimeout(() => {
        if (this.isEditableElement(element)) {
          this.queueGrammarCheck(element, 0);
        }
      }, 300); // Small delay to ensure element is fully rendered
    } else {
      // Element is not visible yet, wait for it to become visible
      // Use IntersectionObserver to detect when element becomes visible
      const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && entry.intersectionRatio > 0) {
            // Element is now visible, queue grammar check
            setTimeout(() => {
              if (this.isEditableElement(element)) {
                this.queueGrammarCheck(element, 0);
              }
            }, 300);
            observer.disconnect();
          }
        });
      }, {
        threshold: 0.1, // Trigger when at least 10% of element is visible
        rootMargin: '50px' // Start checking slightly before element enters viewport
      });
      
      observer.observe(element);
      
      // Also try after a delay in case IntersectionObserver doesn't work
      setTimeout(() => {
        if (this.isElementVisible(element) && this.isEditableElement(element)) {
          this.queueGrammarCheck(element, 0);
        }
        observer.disconnect();
      }, 2000); // Fallback: try after 2 seconds
    }
  }
  
  /**
   * Check if element is visible in viewport
   */
  private isElementVisible(element: HTMLElement): boolean {
    if (!element) return false;
    
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    
    // Check if element has display: none or visibility: hidden
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    
    // Check if element has dimensions
    if (rect.width === 0 && rect.height === 0) {
      return false;
    }
    
    // Check if element is in viewport (at least partially)
    const isInViewport = rect.top < window.innerHeight && rect.bottom > 0 && 
                         rect.left < window.innerWidth && rect.right > 0;
    
    return isInViewport;
  }

  /**
   * Remove Gmail's spell check markers (spans with aria-invalid)
   */
  private removeGmailSpellCheckMarkers(element: HTMLElement): void {
    // Find all spans with aria-invalid attribute (Gmail's spell check markers)
    const spellCheckSpans = element.querySelectorAll('span[aria-invalid]');
    spellCheckSpans.forEach((span) => {
      const parent = span.parentNode;
      if (parent) {
        // Replace span with its text content
        const textNode = document.createTextNode(span.textContent || '');
        parent.replaceChild(textNode, span);
        // Normalize adjacent text nodes
        parent.normalize();
      }
    });
  }

  /**
   * Set up observer to watch for Gmail adding spell check markers
   */
  private setupGmailSpellCheckObserver(element: HTMLElement): void {
    // Only set up observer once per element
    if ((element as any).__rewordlyGmailObserver) {
      return;
    }

    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const el = node as HTMLElement;
            // Check if it's a spell check span
            if (el.tagName === 'SPAN' && el.hasAttribute('aria-invalid')) {
              // Remove the spell check marker
              const parent = el.parentNode;
              if (parent) {
                const textNode = document.createTextNode(el.textContent || '');
                parent.replaceChild(textNode, el);
                parent.normalize();
              }
            }
            // Also check children
            const spellCheckSpans = el.querySelectorAll('span[aria-invalid]');
            spellCheckSpans.forEach((span) => {
              const parent = span.parentNode;
              if (parent) {
                const textNode = document.createTextNode(span.textContent || '');
                parent.replaceChild(textNode, span);
                parent.normalize();
              }
            });
          }
        });
      });
    });

    observer.observe(element, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-invalid', 'class']
    });

    // Store observer reference for cleanup
    (element as any).__rewordlyGmailObserver = observer;
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
    
    if (!this.isEditableElement(element)) {
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
    if (this.config.rewriteEnabled && 
        this.isGrammarCheckAllowedSite() && this.config.highlightsEnabled) {
      // Cancel button blur timeout to prevent button from hiding
      if (this.buttonBlurTimeout !== null) {
        clearTimeout(this.buttonBlurTimeout);
        this.buttonBlurTimeout = null;
      }
      
      // Check if element has focus (or is the active element)
      const hasFocus = document.activeElement === element || 
                       (element instanceof HTMLInputElement && document.activeElement === element) ||
                       (element instanceof HTMLTextAreaElement && document.activeElement === element);
      
      if (hasFocus) {
        // For textarea/input: always show button when focused
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
          // Set current focused element - this prevents button from being hidden
          this.currentFocusedElement = element;
          this.showAIFloatingButton(element);
        } else {
          // For contenteditable: check if has text
          let hasText = false;
          if (element.getAttribute('contenteditable') === 'true' || element.isContentEditable) {
            hasText = (element.innerText || element.textContent || '').trim().length >= 3;
          }
          
          if (hasText) {
            this.showAIFloatingButton(element);
          } else {
            // Hide button if text is less than 3 characters
            this.hideFloatingButton();
          }
        }
      }
    }

    // Clear previous timeout
    if (this.grammarCheckTimeout !== null) {
      clearTimeout(this.grammarCheckTimeout);
    }

    // Check if this is a Draft.js editor (Twitter)
    const isDraftJS = element.classList.contains('public-DraftEditor-content') || 
                      element.closest('.DraftEditor-root') !== null;

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
            this.updateHighlightsPosition(element);
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
    
    if (!element || !this.isEditableElement(element)) {
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
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      hasText = element.value.trim().length >= 3;
    } else if (element.getAttribute('contenteditable') === 'true' || element.isContentEditable) {
      hasText = (element.innerText || element.textContent || '').trim().length >= 3;
    }
    
    // Show AI button on focus for textarea/input elements (always show on focus)
    // For contenteditable elements, only show if has text (at least 3 characters)
    // Only show on sites where grammar check is enabled
    if (this.config.rewriteEnabled && 
        this.isGrammarCheckAllowedSite() && this.config.highlightsEnabled) {
      // For textarea/input: show button immediately on focus, regardless of text length
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        // Set current focused element - this prevents button from being hidden
        this.currentFocusedElement = element;
        this.showAIFloatingButton(element);
      } else if (hasText) {
        // For contenteditable: only show if has text
        this.showAIFloatingButton(element);
      } else {
        // Hide button if contenteditable and text is less than 3 characters
        this.hideFloatingButton();
      }
    }
    
    // If element has grammar errors and highlights are enabled, show the overlay again
    if (this.config.highlightsEnabled && this.grammarErrors.has(element)) {
      this.showGrammarOverlay(element);
    }
    
    // Perform immediate grammar check on focus (if element has text)
    if (this.config.highlightsEnabled && hasText && this.isGrammarCheckAllowedSite()) {
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
    const relatedTarget = (event as FocusEvent).relatedTarget as HTMLElement | null;
    const isClickingButton = relatedTarget && (
      relatedTarget === this.floatingButton ||
      this.floatingButton?.contains(relatedTarget)
    );
    
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
        const shouldHide = document.activeElement !== blurredElement && 
                          document.activeElement !== this.floatingButton &&
                          !this.floatingButton?.contains(document.activeElement) &&
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
          this.hideFloatingButton();
        }
        this.buttonBlurTimeout = null;
      }, 150);
    }
    
    // Hide grammar errors/overlay when focus is lost (but don't delete)
    // However, if element has text, keep highlights visible even without focus
    if (element && this.isEditableElement(element)) {
      // Cancel any existing scheduled blur handler for this element
      const existingTimeout = this.scheduledBlurHandlers.get(element);
      if (existingTimeout) {
        clearTimeout(existingTimeout);
        this.scheduledBlurHandlers.delete(element);
      }
      
      // Small delay to allow for focus transfer (e.g., clicking on overlay)
      // For Draft.js (Twitter), use longer delay as DOM updates are asynchronous
      const isDraftJS = element.classList.contains('public-DraftEditor-content') || 
                        element.closest('.DraftEditor-root') !== null;
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
          if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
            hasText = element.value.trim().length > 0;
          } else if (element.getAttribute('contenteditable') === 'true' || element.isContentEditable) {
            hasText = (element.innerText || element.textContent || '').trim().length > 0;
          }
          
          // Check if element is still in the DOM
          const isInDOM = document.body.contains(element) || element.isConnected;
          
          // Only hide highlights if element has no text or is removed from DOM
          if (!hasText || !isInDOM) {
            // Element has no text or was removed, hide highlights
            if (this.highlightsContent) {
              const elementId = this.getElementId(element);
              const highlights = this.highlightsContent.querySelectorAll(`[data-element-id="${elementId}"]`);
              highlights.forEach(highlight => {
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
      item => item.element === element
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
    this.grammarCheckQueue.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    
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
      const promises = batch.map(item => {
        // Check if element still exists and is valid
        if (!item.element || !item.element.isConnected) {
          return Promise.resolve();
        }
        return this.performGrammarCheck(item.element).catch(error => {
          console.error('Rewordly: Grammar check error in queue:', error);
        });
      });

      // Wait for batch to complete
      await Promise.all(promises);

      // Wait before processing next batch (if there are more items)
      if (this.grammarCheckQueue.length > 0) {
        await new Promise(resolve => setTimeout(resolve, this.BATCH_DELAY));
      }
    }

    this.isProcessingQueue = false;
  }

  /**
   * Extract text from element excluding signature blocks
   * This prevents grammar checking on email signatures which contain formatting
   * that can trigger false positives (like whitespace, special characters, etc.)
   * Preserves line breaks by using innerText which properly handles <br> tags and block elements.
   */
  private extractTextExcludingSignature(element: HTMLElement): { text: string; textSource: 'value' | 'textContent' | 'innerText' } {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      return {
        text: element.value,
        textSource: 'value'
      };
    } else if (element.getAttribute('contenteditable') === 'true' || element.isContentEditable) {
      // Temporarily hide signature elements to exclude them from innerText
      // This preserves line breaks and formatting while excluding signature
      const signatureElements = element.querySelectorAll('.gmail_signature, [class*="signature"], [id*="signature"]');
      const signaturePrefix = element.querySelector('.gmail_signature_prefix');
      
      const hiddenElements: Array<{ el: HTMLElement; originalDisplay: string }> = [];
      
      // Hide signature elements
      signatureElements.forEach(sigEl => {
        const htmlEl = sigEl as HTMLElement;
        const originalDisplay = htmlEl.style.display;
        htmlEl.style.display = 'none';
        hiddenElements.push({ el: htmlEl, originalDisplay });
      });
      
      // Hide signature prefix
      if (signaturePrefix) {
        const htmlEl = signaturePrefix as HTMLElement;
        const originalDisplay = htmlEl.style.display;
        htmlEl.style.display = 'none';
        hiddenElements.push({ el: htmlEl, originalDisplay });
      }
      
      // Get text with innerText (preserves line breaks from <br> and block elements)
      let text = element.innerText || element.textContent || '';
      
      // Restore original display styles
      hiddenElements.forEach(({ el, originalDisplay }) => {
        if (originalDisplay) {
          el.style.display = originalDisplay;
        } else {
          el.style.removeProperty('display');
        }
      });
      
      // Don't trim trailing whitespace - it's needed to maintain correct error positions
      // Signature exclusion is already handled by hiding signature elements above
      
      const textSource = 'innerText';
      
      return { text, textSource };
    }
    
    // Fallback for other element types
    return {
      text: element.textContent || '',
      textSource: 'textContent'
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
    const { text, textSource } = this.extractTextExcludingSignature(element);

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
      const result = await this.apiUtil.checkGrammar(text, 'default', previousRequestId);
      
      console.log('Rewordly: Grammar check result', {
        errorsCount: result.errors.length,
        errors: result.errors,
        text: text.substring(0, 50) + '...',
        textLength: text.length
      });
      
      // Store the new request ID
      this.activeGrammarRequests.set(element, result.requestId);
      
      // Check if detected language is English
      // For short texts, language detection can be inaccurate, so we allow grammar checking
      // if the text contains English words or if language detection confidence is low
      const textLength = text.trim().length;
      const isShortText = textLength < 50; // Consider text short if less than 50 characters
      
      if (result.detectedLanguage && !result.detectedLanguage.code.toLowerCase().startsWith('en')) {
        // For short texts, be more lenient - allow grammar checking if text contains English words
        if (isShortText) {
          // Check if text contains common English words or patterns
          const englishPattern = /\b(the|and|or|but|in|on|at|to|for|of|with|by|from|as|is|are|was|were|be|been|have|has|had|do|does|did|will|would|should|could|can|may|might|this|that|these|those|a|an)\b/i;
          const hasEnglishWords = englishPattern.test(text);
          
          if (hasEnglishWords) {
            console.log('Rewordly: Short text with English words, allowing grammar check despite language detection', {
              detectedLanguage: result.detectedLanguage,
              textLength
            });
            // Continue with grammar check even if language is not detected as English
          } else {
            console.log('Rewordly: Language is not English and no English words detected', result.detectedLanguage);
            this.displayGrammarErrors(element, []);
            this.activeGrammarRequests.delete(element);
            return;
          }
        } else {
          // For longer texts, trust language detection
          console.log('Rewordly: Language is not English', result.detectedLanguage);
          this.displayGrammarErrors(element, []);
          this.activeGrammarRequests.delete(element);
          return;
        }
      }
      
      // Map errors to include id field
      const errorsWithId: GrammarError[] = result.errors.map((error) => ({
        id: this.generateErrorId(),
        start: error.start,
        end: error.end,
        word: error.word,
        suggestions: error.suggestions,
        type: error.type,
      }));
      
      console.log('Rewordly: Mapped errors', {
        errorsWithId,
        textLength: text.length
      });
      
      // Display errors (or clear if no errors)
      this.displayGrammarErrors(element, errorsWithId);
      this.activeGrammarRequests.delete(element);
    } catch (error) {
      // Don't log cancellation errors
      if (error instanceof Error && error.message === 'Request cancelled') {
        return;
      }
      console.error('Rewordly: Grammar check error:', error);
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
    const { text, textSource } = this.extractTextExcludingSignature(element);

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
      if (response.detectedLanguage && !response.detectedLanguage.code.toLowerCase().startsWith('en')) {
        // Language is not English, clear all highlights and skip grammar check
        this.displayGrammarErrors(element, []);
        return;
      }
      
      // Display errors (or clear if no errors)
      this.displayGrammarErrors(element, response.errors);
    } catch (error) {
      console.error('Rewordly: Grammar check error:', error);
      // Fallback to mock if API fails (for development)
      try {
        const mockResponse = this.mockGrammarCheck(text);
        // Mock always assumes English, so we can proceed
        this.displayGrammarErrors(element, mockResponse.errors);
      } catch (mockError) {
        console.error('Rewordly: Mock grammar check also failed:', mockError);
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
      const result = await this.apiUtil.checkGrammar(text, 'default');
      
      // Map errors to include id field (required by GrammarError interface)
      const errorsWithId: GrammarError[] = result.errors.map((error) => ({
        id: this.generateErrorId(),
        start: error.start,
        end: error.end,
        word: error.word,
        suggestions: error.suggestions,
        type: error.type,
      }));
      
      return {
        errors: errorsWithId,
        corrected: result.corrected,
        ...(result.detectedLanguage && { detectedLanguage: result.detectedLanguage }),
      };
    } catch (error) {
      // Don't log cancellation errors
      if (error instanceof Error && error.message === 'Request cancelled') {
        throw error;
      }
      console.error('Rewordly: WebSocket API request failed:', error);
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
      const goesIndex = lowerText.indexOf(' goes ', searchIndex);
      if (goesIndex === -1) break;
      
      const start = text.indexOf(' goes ', goesIndex);
      if (start !== -1) {
        errors.push({
          id: this.generateErrorId(),
          start: start + 1,
          end: start + 5,
          word: 'goes',
          suggestions: ['went', 'go'],
          type: 'grammar'
        });
      }
      searchIndex = goesIndex + 1;
    }
    
    // Find ALL occurrences of "buyed"
    searchIndex = 0;
    while (true) {
      const buyedIndex = lowerText.indexOf('buyed', searchIndex);
      if (buyedIndex === -1) break;
      
      errors.push({
        id: this.generateErrorId(),
        start: buyedIndex,
        end: buyedIndex + 5,
        word: 'buyed',
        suggestions: ['bought', 'buy'],
        type: 'grammar'
      });
      searchIndex = buyedIndex + 1;
    }
    
    // Find ALL occurrences of "have" with singular subject
    searchIndex = 0;
    while (true) {
      const haveIndex = lowerText.indexOf(' have ', searchIndex);
      if (haveIndex === -1) break;
      
      if (haveIndex > 0) {
        const beforeHave = text.substring(Math.max(0, haveIndex - 20), haveIndex).trim();
        const wordsBefore = beforeHave.split(/\s+/);
        const lastWord = wordsBefore[wordsBefore.length - 1];
        if (lastWord && !lastWord.toLowerCase().endsWith('s') && 
            lastWord.toLowerCase() !== 'they' && 
            lastWord.toLowerCase() !== 'we' && 
            lastWord.toLowerCase() !== 'you' &&
            lastWord.toLowerCase() !== 'i') {
          const start = text.indexOf(' have ', haveIndex);
          if (start !== -1) {
            errors.push({
              id: this.generateErrorId(),
              start: start + 1,
              end: start + 5,
              word: 'have',
              suggestions: ['has', 'have'],
              type: 'grammar'
            });
          }
        }
      }
      searchIndex = haveIndex + 1;
    }
    
    // Find ALL occurrences of "was" with plural subject
    searchIndex = 0;
    while (true) {
      const wasIndex = lowerText.indexOf(' was ', searchIndex);
      if (wasIndex === -1) break;
      
      if (wasIndex > 0) {
        const beforeWas = text.substring(Math.max(0, wasIndex - 10), wasIndex).trim();
        const wordsBefore = beforeWas.split(/\s+/);
        const lastWord = wordsBefore[wordsBefore.length - 1];
        if (lastWord && (lastWord.toLowerCase() === 'they' || 
                         lastWord.toLowerCase() === 'we' || 
                         lastWord.toLowerCase() === 'you')) {
          const start = text.indexOf(' was ', wasIndex);
          if (start !== -1) {
            errors.push({
              id: this.generateErrorId(),
              start: start + 1,
              end: start + 4,
              word: 'was',
              suggestions: ['were', 'was'],
              type: 'grammar'
            });
          }
        }
      }
      searchIndex = wasIndex + 1;
    }
    
    // Find ALL occurrences of "do" with singular subject (e.g., "he do")
    searchIndex = 0;
    while (true) {
      const doIndex = lowerText.indexOf(' do ', searchIndex);
      if (doIndex === -1) break;
      
      if (doIndex > 0) {
        const beforeDo = text.substring(Math.max(0, doIndex - 10), doIndex).trim();
        const wordsBefore = beforeDo.split(/\s+/);
        const lastWord = wordsBefore[wordsBefore.length - 1];
        if (lastWord && (lastWord.toLowerCase() === 'he' || 
                         lastWord.toLowerCase() === 'she' || 
                         lastWord.toLowerCase() === 'it')) {
          const start = text.indexOf(' do ', doIndex);
          if (start !== -1) {
            errors.push({
              id: this.generateErrorId(),
              start: start + 1,
              end: start + 3,
              word: 'do',
              suggestions: ['does', 'do'],
              type: 'grammar'
            });
          }
        }
      }
      searchIndex = doIndex + 1;
    }
    
    // Find ALL occurrences of "are" with singular subject (e.g., "he are")
    searchIndex = 0;
    while (true) {
      const areIndex = lowerText.indexOf(' are ', searchIndex);
      if (areIndex === -1) break;
      
      if (areIndex > 0) {
        const beforeAre = text.substring(Math.max(0, areIndex - 10), areIndex).trim();
        const wordsBefore = beforeAre.split(/\s+/);
        const lastWord = wordsBefore[wordsBefore.length - 1];
        if (lastWord && (lastWord.toLowerCase() === 'he' || 
                         lastWord.toLowerCase() === 'she' || 
                         lastWord.toLowerCase() === 'it')) {
          const start = text.indexOf(' are ', areIndex);
          if (start !== -1) {
            errors.push({
              id: this.generateErrorId(),
              start: start + 1,
              end: start + 4,
              word: 'are',
              suggestions: ['is', 'are'],
              type: 'grammar'
            });
          }
        }
      }
      searchIndex = areIndex + 1;
    }

    // Remove duplicate errors (same position)
    const uniqueErrors = errors.filter((error, index, self) =>
      index === self.findIndex(e => e.start === error.start && e.end === error.end)
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
      corrected
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
    const highlights = this.highlightsContent.querySelectorAll(`[data-element-id="${elementId}"]`);
    
    highlights.forEach((highlight) => {
      const errorData = (highlight as HTMLElement).getAttribute('data-error');
      if (!errorData) {
        highlight.remove();
        return;
      }

      try {
        const error: GrammarError = JSON.parse(errorData);
        
        // Check if error position is still valid
        if (error.start < 0 || error.end > text.length || error.start >= error.end) {
          // Position out of bounds, remove highlight
          highlight.remove();
          return;
        }

        // Check if the error word still matches at that position
        const errorWord = text.substring(error.start, error.end);
        // Strict matching: word must match exactly (case-insensitive, whitespace variations allowed)
        // If the word at that position has changed (e.g., "asd" -> "asdf"), highlight should be removed
        const isStillValid = errorWord.toLowerCase().trim() === error.word.toLowerCase().trim();

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
    const validErrors = currentErrors.filter(error => {
      if (error.start < 0 || error.end > text.length || error.start >= error.end) {
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
  private displayGrammarErrors(element: HTMLElement, errors: GrammarError[]): void {
    console.log('Rewordly: displayGrammarErrors called', {
      errorsCount: errors.length,
      errors: errors,
      element: element.tagName,
      elementId: this.getElementId(element),
      stackTrace: new Error().stack
    });
    
    // Ensure all errors have unique IDs (assign if missing from API response)
    const errorsWithIds = errors.map(error => {
      if (!error.id) {
        return { ...error, id: this.generateErrorId() };
      }
      return error;
    });

    // Store errors (empty array if no errors)
    this.grammarErrors.set(element, errorsWithIds);

    // Ensure highlights container exists
    if (!this.highlightsContainer || !this.highlightsShadowRoot || !this.highlightsContent) {
      this.createHighlightsContainer();
      if (!this.highlightsContainer || !this.highlightsShadowRoot || !this.highlightsContent) {
        console.error('Rewordly: Failed to create highlights container');
        return;
      }
    }

    // Get existing highlights to compare by error ID and position/word (for matching after replace)
    const elementId = this.getElementId(element);
    const existingHighlights = this.highlightsContent.querySelectorAll(`[data-element-id="${elementId}"]`);
    const existingErrorMap = new Map<string, HTMLElement>(); // Key: error ID
    const existingErrorByPositionMap = new Map<string, HTMLElement>(); // Key: "start-end-word" for position-based matching
    
    existingHighlights.forEach((highlight) => {
      const errorData = (highlight as HTMLElement).getAttribute('data-error');
      if (errorData) {
        try {
          const error: GrammarError = JSON.parse(errorData);
          if (error.id) {
            existingErrorMap.set(error.id, highlight as HTMLElement);
          }
          // Also create position-based key for matching after replace (when IDs might differ)
          if (error.start !== undefined && error.end !== undefined && error.word) {
            const positionKey = `${error.start}-${error.end}-${error.word.toLowerCase().trim()}`;
            // Only set if not already set (prefer first highlight found for this position)
            if (!existingErrorByPositionMap.has(positionKey)) {
              existingErrorByPositionMap.set(positionKey, highlight as HTMLElement);
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
    const { text } = this.extractTextExcludingSignature(element);

    // Filter out errors that are no longer valid (text changed, error position out of bounds)
    const validErrors = errorsWithIds.filter(error => {
      if (error.start < 0 || error.end > text.length || error.start >= error.end) {
        console.warn('Rewordly: Error position out of bounds', { 
          error, 
          textLength: text.length, 
          start: error.start, 
          end: error.end 
        });
        return false;
      }
      // Check if the error word still matches at that position
      const errorWord = text.substring(error.start, error.end);
      // Strict matching: word must match exactly (case-insensitive, whitespace variations allowed)
      // If the word at that position has changed (e.g., "asd" -> "asdf"), highlight should be removed
      const isValid = errorWord.toLowerCase().trim() === error.word.toLowerCase().trim();
      
      if (!isValid) {
        console.warn('Rewordly: Error word mismatch', { 
          error, 
          errorWord, 
          expectedWord: error.word,
          text: text.substring(Math.max(0, error.start - 5), Math.min(text.length, error.end + 5))
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
    
    console.log('Rewordly: displayGrammarErrors', {
      totalErrors: errorsWithIds.length,
      validErrors: validErrors.length,
      textLength: text.length,
      text: text.substring(0, 50) + '...'
    });

    // Update stored errors with only valid ones
    this.grammarErrors.set(element, validErrors);

    // Update or create highlights for each valid error
    validErrors.forEach((error, index) => {
      // First try to match by error ID
      let existingHighlight = existingErrorMap.get(error.id);
      
      // If not found by ID, try to match by position and word (for cases where API returns new IDs after replace)
      if (!existingHighlight && error.start !== undefined && error.end !== undefined && error.word) {
        const positionKey = `${error.start}-${error.end}-${error.word.toLowerCase().trim()}`;
        existingHighlight = existingErrorByPositionMap.get(positionKey);
        
        // If found by position, update the error ID in the highlight to match the new error
        if (existingHighlight) {
          // Update error ID in all highlights for this position
          if (this.highlightsContent) {
            const allHighlightsForPosition = Array.from(this.highlightsContent.querySelectorAll(
              `[data-element-id="${elementId}"][data-error-id="${existingHighlight.getAttribute('data-error-id')}"]`
            )) as HTMLElement[];
            allHighlightsForPosition.forEach(h => {
              h.setAttribute('data-error-id', error.id);
              h.setAttribute('data-error', JSON.stringify(error));
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
          const errorHighlights = Array.from(this.highlightsContent.querySelectorAll(
            `[data-element-id="${this.getElementId(element)}"][data-error-id="${error.id}"]`
          )) as HTMLElement[];
          errorHighlights.forEach(h => h.remove());
          return;
        }
        
        // Same error position, just update position (text might have changed)
        // Get text to adjust positions for multi-word errors
        let text = '';
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
          text = element.value;
        } else if (element.getAttribute('contenteditable') === 'true' || element.isContentEditable) {
          text = element.innerText || element.textContent || '';
        }

        // Adjust positions for multi-word grammar errors
        const adjustedPositions = text ? this.adjustErrorPositionsForMultiWord(text, error) : { start: error.start, end: error.end };
        const highlightRects = this.getErrorTextRects(element, adjustedPositions.start, adjustedPositions.end);
        
        // Get all existing highlights for this error
        if (!this.highlightsContent) return;
        const errorHighlights = Array.from(this.highlightsContent.querySelectorAll(
          `[data-element-id="${this.getElementId(element)}"][data-error-id="${error.id}"]`
        )) as HTMLElement[];
        
        if (highlightRects.length > 0) {
          // Update or create highlights for each line
          highlightRects.forEach((highlightRect, lineIndex) => {
            let highlight = errorHighlights.find(h => 
              h.getAttribute('data-line-index') === lineIndex.toString()
            );
            
            if (!highlight) {
              // Create new highlight for this line (no animation - this is an existing error, just new line)
              highlight = document.createElement('div');
              highlight.className = 'rewordly-highlight';
              highlight.setAttribute('data-rewordly-part', 'highlight');
              highlight.setAttribute('data-highlight-format', 'underline');
              highlight.setAttribute('data-highlight-color-name', 'red');
              highlight.setAttribute('data-element-id', this.getElementId(element));
              highlight.setAttribute('data-error-index', index.toString());
              highlight.setAttribute('data-error-id', error.id);
              highlight.setAttribute('data-line-index', lineIndex.toString());
              
              // Add hover listeners to all lines
              this.attachHighlightHoverListener(highlight, error, element);
              
              // Set position and size immediately (no animation for existing error's new line)
              highlight.style.top = `${highlightRect.top}px`;
              highlight.style.left = `${highlightRect.left}px`;
              highlight.style.width = `${highlightRect.width}px`;
              highlight.style.height = `${highlightRect.height}px`;
              highlight.style.opacity = '1';
              highlight.style.overflow = 'visible';
              
              this.highlightsContent!.appendChild(highlight);
            }
            
            // Update position and size
            highlight.style.top = `${highlightRect.top}px`;
            highlight.style.left = `${highlightRect.left}px`;
            highlight.style.width = `${highlightRect.width}px`;
            highlight.style.height = `${highlightRect.height}px`;
            highlight.setAttribute('data-error', JSON.stringify(error));
            highlight.setAttribute('data-error-index', index.toString());
          });
          
          // Remove extra highlights if rect count decreased
          errorHighlights.forEach((highlight) => {
            const lineIndex = parseInt(highlight.getAttribute('data-line-index') || '0', 10);
            if (lineIndex >= highlightRects.length) {
              highlight.remove();
            }
          });
        } else {
          // Position calculation failed - for Draft.js (Twitter), keep the highlight
          // It will be updated on the next position update after DOM settles
          console.warn('Rewordly: Could not calculate position for existing error:', error.id);
          // Update error data anyway
          existingHighlight.setAttribute('data-error', JSON.stringify(error));
          existingHighlight.setAttribute('data-error-index', index.toString());
        }
        
        // If element has text, ensure highlight is visible (even if not focused)
        let hasText = false;
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
          hasText = element.value.trim().length > 0;
        } else if (element.getAttribute('contenteditable') === 'true' || element.isContentEditable) {
          hasText = (element.innerText || element.textContent || '').trim().length > 0;
        }
        
        if (hasText) {
          // Make sure highlight is visible
          existingHighlight.style.display = '';
          existingHighlight.removeAttribute('data-hidden-by-blur');
        }
      } else {
        // New error or error position changed, create new highlight with animation
        this.createHighlight(element, error, index, true);
      }
    });

    // Remove highlights that no longer exist (errors that were fixed or removed)
    const currentErrorIds = new Set(validErrors.map(err => err.id));
    existingErrorMap.forEach((highlight, errorId) => {
      if (!currentErrorIds.has(errorId)) {
        // Remove all highlights for this error (multi-line support)
        if (this.highlightsContent) {
          const allErrorHighlights = this.highlightsContent.querySelectorAll(
            `[data-element-id="${elementId}"][data-error-id="${errorId}"]`
          );
          allErrorHighlights.forEach(h => h.remove());
        } else {
          highlight.remove();
        }
      } else {
        // Also check if this error is dismissed (double-check to be safe)
        const errorData = highlight.getAttribute('data-error');
        if (errorData) {
          try {
            const error: GrammarError = JSON.parse(errorData);
            if (this.isErrorDismissed(element, error)) {
              // Remove all highlights for this dismissed error (multi-line support)
              if (this.highlightsContent) {
                const allErrorHighlights = this.highlightsContent.querySelectorAll(
                  `[data-element-id="${elementId}"][data-error-id="${errorId}"]`
                );
                allErrorHighlights.forEach(h => h.remove());
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
    let hasText = false;
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      hasText = element.value.trim().length > 0;
    } else if (element.getAttribute('contenteditable') === 'true' || element.isContentEditable) {
      hasText = (element.innerText || element.textContent || '').trim().length > 0;
    }
    
    if (hasText && this.highlightsContent) {
      const elementId = this.getElementId(element);
      const allHighlights = this.highlightsContent.querySelectorAll(`[data-element-id="${elementId}"]`);
      allHighlights.forEach(highlight => {
        (highlight as HTMLElement).style.display = '';
        (highlight as HTMLElement).removeAttribute('data-hidden-by-blur');
      });
    }

    // Update highlights on scroll/resize
    this.updateHighlightsPosition(element);
  }

  /**
   * Create error overlay for input/textarea elements
   * @deprecated Use Grammarly-style highlights instead
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  // private createErrorOverlay(element: HTMLInputElement | HTMLTextAreaElement, errors: GrammarError[]): void {
  //   // Remove existing overlay
  //   const existingOverlay = document.querySelector(`.rewordly-grammar-overlay[data-element-id="${this.getElementId(element)}"]`);
  //   if (existingOverlay) {
  //     existingOverlay.remove();
  //   }

  //   // Create overlay
  //   const overlay = document.createElement('div');
  //   overlay.className = 'rewordly-grammar-overlay';
  //   overlay.setAttribute('data-element-id', this.getElementId(element));
    
  //   // Copy ALL relevant styles from the element to ensure perfect alignment
  //   const styles = window.getComputedStyle(element);
    
  //   // Get all CSS properties that affect text rendering
  //   const cssProperties = [
  //     'direction', 'text-align', 'text-indent', 'text-decoration', 'text-shadow',
  //     'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant',
  //     'font-stretch', 'font-size-adjust', 'line-height', 'letter-spacing', 
  //     'word-spacing', 'text-transform', 'white-space', 'word-wrap', 'word-break',
  //     'overflow-wrap', 'hyphens', 'tab-size', 'text-rendering',
  //     'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  //     'border', 'border-top', 'border-right', 'border-bottom', 'border-left',
  //     'box-sizing', 'width', 'min-width', 'max-width'
  //   ];
    
  //   let overlayStyles = 'position: absolute !important; pointer-events: none !important; z-index: 2147483645 !important; color: transparent !important; background: transparent !important; border-color: transparent !important;';
    
  //   cssProperties.forEach(prop => {
  //     const value = styles.getPropertyValue(prop);
  //     if (value) {
  //       overlayStyles += `${prop}: ${value} !important; `;
  //     }
  //   });
    
  //   // Ensure white-space matches element
  //   const whiteSpace = element instanceof HTMLInputElement ? 'pre' : (styles.whiteSpace || 'pre-wrap');
  //   overlayStyles += `white-space: ${whiteSpace} !important; `;
  //   overlayStyles += `word-wrap: ${styles.wordWrap || 'break-word'} !important; `;
  //   overlayStyles += `overflow: hidden !important; `;
    
  //   overlay.style.cssText = overlayStyles;

  //   // Position overlay exactly over the element using absolute positioning
  //   // Find the best parent container for the overlay
  //   const parentContainer = this.findOverlayParent(element);
    
  //   // Ensure parent has position: relative
  //   const parentStyles = window.getComputedStyle(parentContainer);
  //   if (parentStyles.position === 'static') {
  //     parentContainer.style.position = 'relative';
  //   }
    
  //   // Calculate position relative to parent
  //   const elementRect = element.getBoundingClientRect();
  //   const parentRect = parentContainer.getBoundingClientRect();
    
  //   // Use scrollWidth to ensure overlay covers all text
  //   const scrollWidth = element.scrollWidth || elementRect.width;
  //   const scrollHeight = element.scrollHeight || elementRect.height;
    
  //   // Position relative to parent
  //   overlay.style.top = `${elementRect.top - parentRect.top}px`;
  //   overlay.style.left = `${elementRect.left - parentRect.left}px`;
  //   overlay.style.width = `${Math.max(elementRect.width, scrollWidth)}px`;
  //   overlay.style.height = `${Math.max(elementRect.height, scrollHeight)}px`;
  //   overlay.style.minHeight = `${Math.max(elementRect.height, scrollHeight)}px`;

  //   // Create text with error highlights
  //   const text = element.value;
  //   const errorSpans: string[] = [];
    
  //   // Sort errors by position
  //   const sortedErrors = [...errors].sort((a, b) => a.start - b.start);
    
  //   let lastIndex = 0;
  //   for (const error of sortedErrors) {
  //     // Add text before error
  //     errorSpans.push(this.escapeHtml(text.substring(lastIndex, error.start)));
      
  //     // Add error word with underline - use exact substring
  //     const errorWord = text.substring(error.start, error.end);
  //     errorSpans.push(`<span class="rewordly-grammar-error" style="border-bottom: 2px solid #ef4444 !important; cursor: pointer !important; background: rgba(239, 68, 68, 0.1) !important; display: inline !important;" data-error="${this.escapeHtml(JSON.stringify(error))}">${this.escapeHtml(errorWord)}</span>`);
      
  //     lastIndex = error.end;
  //   }
    
  //   // Add remaining text
  //   errorSpans.push(this.escapeHtml(text.substring(lastIndex)));
    
  //   overlay.innerHTML = errorSpans.join('');
    
  //   // Enable pointer events on error spans for hover interaction
  //   const errorSpansElements = overlay.querySelectorAll('.rewordly-grammar-error');
  //   errorSpansElements.forEach(span => {
  //     (span as HTMLElement).style.pointerEvents = 'auto';
  //     (span as HTMLElement).style.cursor = 'pointer';
  //   });
    
  //   // Attach hover event listeners to error spans
  //   this.attachGrammarErrorHoverListeners(overlay, element);
    
  //   // Append to parent container (not body) for absolute positioning
  //   parentContainer.appendChild(overlay);
    
  //   // Force a reflow to ensure styles are applied
  //   void overlay.offsetHeight;
    
  //   // Update overlay position on scroll/resize
  //   // For absolute positioning, calculate relative to parent
  //   const updatePosition = () => {
  //     const parentContainer = overlay.parentElement || this.findOverlayParent(element);
  //     const newElementRect = element.getBoundingClientRect();
  //     const newParentRect = parentContainer.getBoundingClientRect();
  //     const newScrollWidth = element.scrollWidth || newElementRect.width;
  //     const newScrollHeight = element.scrollHeight || newElementRect.height;
      
  //     // Calculate position relative to parent, accounting for scroll
  //     const parentScrollTop = parentContainer.scrollTop || 0;
  //     const parentScrollLeft = parentContainer.scrollLeft || 0;
      
  //     // Position relative to parent (accounting for parent's scroll position)
  //     const topOffset = newElementRect.top - newParentRect.top + parentScrollTop;
  //     const leftOffset = newElementRect.left - newParentRect.left + parentScrollLeft;
      
  //     overlay.style.top = `${topOffset}px`;
  //     overlay.style.left = `${leftOffset}px`;
  //     overlay.style.width = `${Math.max(newElementRect.width, newScrollWidth)}px`;
  //     overlay.style.height = `${Math.max(newElementRect.height, newScrollHeight)}px`;
  //     overlay.style.minHeight = `${Math.max(newElementRect.height, newScrollHeight)}px`;
  //   };
    
  //   window.addEventListener('scroll', updatePosition, true);
  //   window.addEventListener('resize', updatePosition);
    
  //   // Store cleanup function
  //   (overlay as any).__cleanup = () => {
  //     window.removeEventListener('scroll', updatePosition, true);
  //     window.removeEventListener('resize', updatePosition);
  //   };
  // }

  /**
   * Get unique ID for an element
   */
  private getElementId(element: HTMLElement): string {
    if (!(element as any).__rewordlyId) {
      (element as any).__rewordlyId = `rewordly-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }
    return (element as any).__rewordlyId;
  }

  /**
   * Check if grammar check is allowed on the current site
   * Only Twitter, Gmail, Reddit, and Medium are allowed for real-time grammar checking
   */
  private isGrammarCheckAllowedSite(): boolean {
    const hostname = window.location.hostname.toLowerCase();
    
    // Twitter
    if (hostname.includes('twitter.com') || hostname.includes('x.com')) {
      return true;
    }
    
    // Gmail
    if (hostname.includes('mail.google.com') || hostname.includes('gmail.com')) {
      return true;
    }
    
    // Reddit
    if (hostname.includes('reddit.com')) {
      return true;
    }
    
    // Medium
    if (hostname.includes('medium.com')) {
      return true;
    }
    
    return false;
  }

  /**
   * Check if an element should be ignored for grammar checking
   * Returns true if the element matches ignore patterns (e.g., Gmail's "To" field)
   */
  private shouldIgnoreElement(element: HTMLElement): boolean {
    // Check if element is Gmail's "To" field
    // Gmail's "To" field has specific structure:
    // - Container with class "aoD hl" (the main container)
    // - Input with name="to" attribute
    // - Contenteditable div with class "oL aDm az9" containing span with class "aQ2"
    
    // Check for Gmail's "To" field container
    const gmailToContainer = element.closest('.aoD.hl');
    if (gmailToContainer) {
      // Check if this is the actual input/editable element within the "To" field
      const hasToName = element.closest('[name="to"]') !== null;
      const hasToClasses = element.classList.contains('oL') && 
                          element.classList.contains('aDm') && 
                          element.classList.contains('az9');
      const hasToSpan = element.querySelector('.aQ2') !== null || 
                       element.closest('.aQ2') !== null ||
                       (element.parentElement && element.parentElement.querySelector('.aQ2') !== null);
      
      if (hasToName || hasToClasses || hasToSpan) {
        return true;
      }
    }
    
    // Check if element is inside a Gmail "To" field input
    if (element.closest('[name="to"]') !== null) {
      return true;
    }
    
    // Check if element is the Gmail "To" field input itself
    if (element.getAttribute('name') === 'to' || 
        (element instanceof HTMLInputElement && element.name === 'to')) {
      return true;
    }
    
    // Check if element contains or is inside the Gmail "To" field span
    if (element.classList.contains('aQ2') || 
        element.closest('.aQ2') !== null ||
        element.querySelector('.aQ2') !== null) {
      // Make sure it's actually the "To" field, not just any element with aQ2 class
      const toContainer = element.closest('.aoD.hl');
      if (toContainer) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * Check if an element is in the ignore list
   */
  private isElementIgnored(element: HTMLElement): boolean {
    const elementId = this.getElementId(element);
    
    // Check if element ID is in ignore list
    if (this.ignoredElementIds.has(elementId)) {
      return true;
    }
    
    // Also check if element should be ignored based on patterns
    // (in case element was added to DOM after initial check)
    if (this.shouldIgnoreElement(element)) {
      this.ignoredElementIds.add(elementId);
      return true;
    }
    
    return false;
  }

  /**
   * Add an element to the ignore list (for future user customization)
   */
  public addElementToIgnoreList(element: HTMLElement): void {
    const elementId = this.getElementId(element);
    this.ignoredElementIds.add(elementId);
    
    // Clear any existing highlights for this element
    this.clearElementHighlights(element);
    this.grammarErrors.delete(element);
  }

  /**
   * Remove an element from the ignore list (for future user customization)
   */
  public removeElementFromIgnoreList(element: HTMLElement): void {
    const elementId = this.getElementId(element);
    this.ignoredElementIds.delete(elementId);
    
    // Re-attach to element if it's still editable
    if (this.isEditableElement(element)) {
      this.attachToEditableElement(element);
    }
  }

  /**
   * Generate a unique key for dismissing an error
   * Uses elementId + word + context to handle position changes
   * Context includes surrounding text to uniquely identify the word location
   */
  private getDismissKey(elementId: string, error: GrammarError, text: string): string {
    // Get context around the word (30 chars before and after)
    const contextBefore = Math.max(0, error.start - 30);
    const contextAfter = Math.min(text.length, error.end + 30);
    const beforeText = text.substring(contextBefore, error.start).toLowerCase().trim();
    const afterText = text.substring(error.end, contextAfter).toLowerCase().trim();
    const wordText = error.word.toLowerCase().trim();
    
    // Create a stable key based on word + context (not position)
    // This allows dismiss to persist even when text is added/removed above
    return `${elementId}:${wordText}:${beforeText.slice(-20)}:${afterText.slice(0, 20)}`;
  }

  /**
   * Check if an error is dismissed
   * Uses word + context instead of position to handle text updates
   * If word at location changes, dismiss is automatically cleared
   */
  private isErrorDismissed(element: HTMLElement, error: GrammarError): boolean {
    const elementId = this.getElementId(element);
    
    // Get current text to verify position is still valid
    let text = '';
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      text = element.value;
    } else if (element.getAttribute('contenteditable') === 'true' || element.isContentEditable) {
      text = element.innerText || element.textContent || '';
    }
    
    // If position is invalid, try to find the word by matching context from dismiss keys
    // This handles cases where text was added/removed above the error
    if (error.start < 0 || error.end > text.length || error.start >= error.end) {
      const wordLower = error.word.toLowerCase().trim();
      const elementIdPrefix = `${elementId}:${wordLower}:`;
      const searchText = text.toLowerCase();
      let foundMatch = false;
      
      // Check all dismiss keys for this element and word
      for (const [dismissKey, _] of this.dismissedErrors.entries()) {
        if (!dismissKey.startsWith(elementIdPrefix)) continue;
        
        // Extract context from dismiss key (format: elementId:word:before:after)
        // Note: context may contain colons, so we need to be careful
        const afterPrefix = dismissKey.substring(elementIdPrefix.length);
        const lastColonIndex = afterPrefix.lastIndexOf(':');
        if (lastColonIndex === -1) continue;
        
        const beforeContext = afterPrefix.substring(0, lastColonIndex);
        const afterContext = afterPrefix.substring(lastColonIndex + 1);
        
        // Search for word with matching context
        let searchIndex = 0;
        while (true) {
          const wordIndex = searchText.indexOf(wordLower, searchIndex);
          if (wordIndex === -1) break;
          
          // Get context around this occurrence
          const beforeText = searchText.substring(Math.max(0, wordIndex - 30), wordIndex).trim();
          const afterText = searchText.substring(wordIndex + wordLower.length, Math.min(text.length, wordIndex + wordLower.length + 30)).trim();
          
          // Check if context matches (using last 20 chars of before and first 20 chars of after)
          if (beforeText.endsWith(beforeContext.slice(-20)) && afterText.startsWith(afterContext.slice(0, 20))) {
            // Found matching word with context, update position
            error.start = wordIndex;
            error.end = wordIndex + wordLower.length;
            foundMatch = true;
            break;
          }
          
          searchIndex = wordIndex + 1;
        }
        
        if (foundMatch) break;
      }
      
      // If still invalid, word not found or context doesn't match
      if (!foundMatch || error.start < 0 || error.end > text.length || error.start >= error.end) {
        return false;
      }
    }
    
    // Generate dismiss key using word + context (not position)
    const dismissKey = this.getDismissKey(elementId, error, text);
    
    if (!this.dismissedErrors.has(dismissKey)) {
      return false;
    }
    
    // Verify the word at current position still matches
    const currentWord = text.substring(error.start, error.end);
    const originalWord = error.word;
    
    // If word changed significantly, clear dismiss
    if (currentWord.toLowerCase().trim() !== originalWord.toLowerCase().trim()) {
      this.dismissedErrors.delete(dismissKey);
      return false;
    }
    
    // Still dismissed
    return true;
  }

  /**
   * Create error overlay for contenteditable elements
   * This avoids DOM manipulation which can cause text loss
   * @deprecated Use Grammarly-style highlights instead
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  // private createErrorOverlayForContentEditable(element: HTMLElement, errors: GrammarError[]): void {
  //   // Remove existing overlay
  //   const existingOverlay = document.querySelector(`.rewordly-grammar-overlay[data-element-id="${this.getElementId(element)}"]`);
  //   if (existingOverlay) {
  //     existingOverlay.remove();
  //   }

  //   // Get text content - use the same source as grammar check
  //   const textSource = (element as any).__rewordlyTextSource || 'innerText';
  //   let text = '';
    
  //   if (textSource === 'innerText') {
  //     text = element.innerText || element.textContent || '';
  //   } else if (textSource === 'textContent') {
  //     text = element.textContent || element.innerText || '';
  //   } else {
  //     // Fallback
  //     text = element.innerText || element.textContent || '';
  //   }
    
  //   // If we have stored text from grammar check, use it for exact matching
  //   if ((element as any).__rewordlyText) {
  //     text = (element as any).__rewordlyText;
  //   }
    
  //   if (!text) return;
    

  //   // Create overlay
  //   const overlay = document.createElement('div');
  //   overlay.className = 'rewordly-grammar-overlay';
  //   overlay.setAttribute('data-element-id', this.getElementId(element));
    
  //   // Copy ALL relevant styles from the element to ensure perfect alignment
  //   const styles = window.getComputedStyle(element);
    
  //   // Get all CSS properties that affect text rendering
  //   const cssProperties = [
  //     'direction', 'text-align', 'text-indent', 'text-decoration', 'text-shadow',
  //     'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant',
  //     'font-stretch', 'font-size-adjust', 'line-height', 'letter-spacing', 
  //     'word-spacing', 'text-transform', 'white-space', 'word-wrap', 'word-break',
  //     'overflow-wrap', 'hyphens', 'tab-size', 'text-rendering',
  //     'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  //     'border', 'border-top', 'border-right', 'border-bottom', 'border-left',
  //     'box-sizing', 'width', 'min-width', 'max-width',
  //     'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left'
  //   ];
    
  //   let overlayStyles = 'position: absolute !important; pointer-events: none !important; z-index: 2147483645 !important; color: transparent !important; background: transparent !important; border-color: transparent !important;';
    
  //   cssProperties.forEach(prop => {
  //     const value = styles.getPropertyValue(prop);
  //     if (value) {
  //       overlayStyles += `${prop}: ${value} !important; `;
  //     }
  //   });
    
  //   // Ensure white-space matches element
  //   overlayStyles += `white-space: ${styles.whiteSpace || 'pre-wrap'} !important; `;
  //   overlayStyles += `word-wrap: ${styles.wordWrap || 'break-word'} !important; `;
  //   overlayStyles += `overflow: hidden !important; `;
    
  //   overlay.style.cssText = overlayStyles;

  //   // Position overlay exactly over the element using absolute positioning
  //   // Find the best parent container for the overlay
  //   const parentContainer = this.findOverlayParent(element);
    
  //   // Ensure parent has position: relative
  //   const parentStyles = window.getComputedStyle(parentContainer);
  //   if (parentStyles.position === 'static') {
  //     parentContainer.style.position = 'relative';
  //   }
    
  //   // Calculate position relative to parent
  //   const elementRect = element.getBoundingClientRect();
  //   const parentRect = parentContainer.getBoundingClientRect();
    
  //   // Use scrollWidth to ensure overlay covers all text, especially for contenteditable
  //   const scrollWidth = element.scrollWidth || elementRect.width;
  //   const scrollHeight = element.scrollHeight || elementRect.height;
    
  //   // Calculate position relative to parent, accounting for scroll
  //   const parentScrollTop = parentContainer.scrollTop || 0;
  //   const parentScrollLeft = parentContainer.scrollLeft || 0;
    
  //   // Position relative to parent (accounting for parent's scroll position)
  //   const topOffset = elementRect.top - parentRect.top + parentScrollTop;
  //   const leftOffset = elementRect.left - parentRect.left + parentScrollLeft;
    
  //   overlay.style.top = `${topOffset}px`;
  //   overlay.style.left = `${leftOffset}px`;
  //   overlay.style.width = `${Math.max(elementRect.width, scrollWidth)}px`;
  //   overlay.style.height = `${Math.max(elementRect.height, scrollHeight)}px`;
  //   overlay.style.minHeight = `${Math.max(elementRect.height, scrollHeight)}px`;
  //   overlay.style.maxHeight = `${Math.max(elementRect.height, scrollHeight)}px`;

  //   // Universal approach: Clone element structure, make all text transparent, add only underlines for errors
  //   const sortedErrors = [...errors].sort((a, b) => a.start - b.start);
    
  //   // Clone the element to preserve all formatting structure
  //   // But remove Twitter's own highlights (background-color spans)
  //   const clone = element.cloneNode(true) as HTMLElement;
    
  //   // Remove Twitter's highlight spans (they have background-color style)
  //   // Also remove any spans with inline background-color styles
  //   const allSpans = clone.querySelectorAll('span');
  //   allSpans.forEach(span => {
  //     const spanElement = span as HTMLElement;
  //     const style = spanElement.getAttribute('style');
  //     if (style && style.includes('background-color')) {
  //       const parent = span.parentNode;
  //       if (parent) {
  //         // Replace highlight span with just its text content
  //         const textNode = document.createTextNode(span.textContent || '');
  //         parent.replaceChild(textNode, span);
  //         parent.normalize();
  //       }
  //     }
  //   });
    
  //   // Remove any existing grammar error markers from clone
  //   const existingErrors = clone.querySelectorAll('.rewordly-grammar-error');
  //   existingErrors.forEach(err => {
  //     const parent = err.parentNode;
  //     if (parent) {
  //       parent.replaceChild(document.createTextNode(err.textContent || ''), err);
  //       parent.normalize();
  //     }
  //   });
    
  //   // Build a map of error positions for quick lookup
  //   const errorMap = new Map<number, GrammarError>();
  //   sortedErrors.forEach(error => {
  //     for (let i = error.start; i < error.end; i++) {
  //       errorMap.set(i, error);
  //     }
  //   });
    
  //   // First pass: Make all text transparent
  //   const allTextNodes: { node: Text; startIndex: number; endIndex: number }[] = [];
  //   const walker = document.createTreeWalker(
  //     clone,
  //     NodeFilter.SHOW_TEXT,
  //     null
  //   );
    
  //   let textIndex = 0;
  //   let node: Text | null;
  //   while ((node = walker.nextNode() as Text | null)) {
  //     if (node && node.textContent) {
  //       const nodeText = node.textContent;
  //       const startIndex = textIndex;
  //       const endIndex = textIndex + nodeText.length;
  //       allTextNodes.push({ node, startIndex, endIndex });
  //       textIndex = endIndex;
  //     }
  //   }
    
  //   // Make all text transparent
  //   allTextNodes.forEach(({ node: textNode }) => {
  //     if (textNode && textNode.textContent) {
  //       const transparentSpan = document.createElement('span');
  //       transparentSpan.style.cssText = 'color: transparent !important; display: inline !important;';
  //       const parent = textNode.parentNode;
  //       if (parent) {
  //         parent.replaceChild(transparentSpan, textNode);
  //         transparentSpan.appendChild(textNode);
  //       }
  //     }
  //   });
    
  //   // Second pass: Insert error underlines at correct positions
  //   // Process in reverse order to avoid index shifting
  //   for (let i = allTextNodes.length - 1; i >= 0; i--) {
  //     const item = allTextNodes[i];
  //     if (!item) continue;
      
  //     const { node: textNode, startIndex } = item;
  //     if (!textNode || !textNode.textContent) continue;
      
  //     // Find the transparent span that now contains this text node
  //     let transparentSpan = textNode.parentElement;
  //     while (transparentSpan && !transparentSpan.style.color.includes('transparent')) {
  //       transparentSpan = transparentSpan.parentElement;
  //     }
      
  //     if (!transparentSpan) continue;
      
  //     const nodeText = textNode.textContent;
  //     const fragments: (Text | HTMLElement)[] = [];
  //     let lastPos = 0;
      
  //     // Check for errors in this text node
  //     for (let j = 0; j < nodeText.length; j++) {
  //       const globalIndex = startIndex + j;
  //       const error = errorMap.get(globalIndex);
        
  //       if (error && error.start === globalIndex) {
  //         // Add text before error (already transparent)
  //         if (j > lastPos) {
  //           const beforeText = nodeText.substring(lastPos, j);
  //           const beforeNode = document.createTextNode(beforeText);
  //           fragments.push(beforeNode);
  //         }
          
  //         // Add error underline span (NO TEXT, just underline)
  //         const errorWord = text.substring(error.start, error.end);
  //         const errorSpan = document.createElement('span');
  //         errorSpan.className = 'rewordly-grammar-error';
  //         errorSpan.setAttribute('data-error', JSON.stringify(error));
          
  //         // Get the actual element's text node at this position to copy its styles
  //         const originalTextNodes: { node: Text; startIndex: number; endIndex: number }[] = [];
  //         const originalWalker = document.createTreeWalker(
  //           element,
  //           NodeFilter.SHOW_TEXT,
  //           null
  //         );
          
  //         let originalIndex = 0;
  //         let originalNode: Text | null;
  //         while ((originalNode = originalWalker.nextNode() as Text | null)) {
  //           if (originalNode && originalNode.textContent) {
  //             const originalText = originalNode.textContent;
  //             const origStart = originalIndex;
  //             const origEnd = originalIndex + originalText.length;
  //             originalTextNodes.push({ node: originalNode, startIndex: origStart, endIndex: origEnd });
  //             originalIndex = origEnd;
  //           }
  //         }
          
  //         // Find the original text node that contains this error
  //         let originalParent: HTMLElement | null = null;
  //         for (const { node: origNode, startIndex: origStart, endIndex: origEnd } of originalTextNodes) {
  //           if (error.start >= origStart && error.start < origEnd) {
  //             originalParent = origNode.parentElement;
  //             break;
  //           }
  //         }
          
  //         // Calculate width using the original element's styles
  //         const tempSpan = document.createElement('span');
  //         tempSpan.style.cssText = 'position: absolute !important; visibility: hidden !important; white-space: pre !important; pointer-events: none !important; top: -9999px !important; left: -9999px !important;';
          
  //         if (originalParent) {
  //           const parentStyles = window.getComputedStyle(originalParent);
  //           const relevantStyles = [
  //             'font-size', 'font-weight', 'font-style', 'font-family',
  //             'line-height', 'letter-spacing', 'text-decoration',
  //             'text-transform', 'font-variant', 'font-stretch'
  //           ];
            
  //           relevantStyles.forEach(prop => {
  //             const value = parentStyles.getPropertyValue(prop);
  //             if (value && value !== 'normal' && value !== 'none' && value !== 'auto') {
  //               tempSpan.style.setProperty(prop, value, 'important');
  //             }
  //           });
  //         }
          
  //         tempSpan.textContent = errorWord;
  //         document.body.appendChild(tempSpan);
  //         const width = Math.max(1, tempSpan.offsetWidth);
  //         const height = Math.max(1, tempSpan.offsetHeight);
  //         document.body.removeChild(tempSpan);
          
  //         // Create style string with calculated width and only underline (no text)
  //         let styleString = `border-bottom: 2px solid #ef4444 !important; cursor: pointer !important; display: inline-block !important; position: relative !important; width: ${width}px !important; min-width: ${width}px !important; height: ${height}px !important; vertical-align: baseline !important; overflow: visible !important; line-height: ${height}px !important;`;
          
  //         if (originalParent) {
  //           const parentStyles = window.getComputedStyle(originalParent);
  //           const relevantStyles = [
  //             'font-size', 'font-weight', 'font-style', 'font-family',
  //             'letter-spacing', 'text-decoration', 'text-transform', 'font-variant'
  //           ];
            
  //           relevantStyles.forEach(prop => {
  //             const value = parentStyles.getPropertyValue(prop);
  //             if (value && value !== 'normal' && value !== 'none' && value !== 'auto') {
  //               styleString += `${prop}: ${value} !important; `;
  //             }
  //           });
  //         }
          
  //         errorSpan.setAttribute('style', styleString);
  //         fragments.push(errorSpan);
          
  //         lastPos = j + errorWord.length;
  //         j += errorWord.length - 1; // Skip processed characters
  //       }
  //     }
      
  //     // Add remaining text (already transparent)
  //     if (lastPos < nodeText.length) {
  //       const afterText = nodeText.substring(lastPos);
  //       fragments.push(document.createTextNode(afterText));
  //     }
      
  //     // Replace the transparent span's content with fragments
  //     if (fragments.length > 0 && transparentSpan) {
  //       // Clear the span and add fragments
  //       transparentSpan.innerHTML = '';
  //       fragments.forEach(fragment => {
  //         transparentSpan.appendChild(fragment);
  //       });
  //     }
  //   }
    
  //   overlay.innerHTML = clone.innerHTML;
    
  //   // Enable pointer events on error spans for hover interaction
  //   const errorSpans = overlay.querySelectorAll('.rewordly-grammar-error');
  //   errorSpans.forEach(span => {
  //     (span as HTMLElement).style.pointerEvents = 'auto';
  //     (span as HTMLElement).style.cursor = 'pointer';
  //   });
    
  //   // Attach hover event listeners to error spans
  //   this.attachGrammarErrorHoverListeners(overlay, element);
    
  //   // Ensure overlay is visible and properly positioned
  //   overlay.style.display = 'block';
  //   overlay.style.visibility = 'visible';
  //   overlay.style.opacity = '1';
  //   overlay.style.pointerEvents = 'none';
    
  //   // Remove any hidden attributes
  //   overlay.removeAttribute('data-hidden-by-blur');
  //   overlay.removeAttribute('data-hidden-by-modal');
    
  //   // Append to parent container (not body) for absolute positioning
  //   parentContainer.appendChild(overlay);
    
  //   // Force a reflow to ensure styles are applied
  //   void overlay.offsetHeight;
    
  //   // Debug: Check if overlay is actually visible
  //   const overlayRect = overlay.getBoundingClientRect();
  //   const computedStyle = window.getComputedStyle(overlay);
    
  //   // Additional check: verify overlay is actually in DOM and visible
  //   if (!document.body.contains(overlay)) {
  //     console.error('Rewordly: Overlay not in DOM!');
  //   }
  //   if (overlayRect.width === 0 || overlayRect.height === 0) {
  //     console.warn('Rewordly: Overlay has zero dimensions!');
  //   }
    
  //     // Update overlay position on scroll/resize
  //     // Note: position: fixed uses viewport coordinates, getBoundingClientRect() already gives viewport coords
  //     const updatePosition = () => {
  //       const newRect = element.getBoundingClientRect();
  //       const newScrollWidth = element.scrollWidth || newRect.width;
  //       const newScrollHeight = element.scrollHeight || newRect.height;
        
  //       // For position: fixed, use viewport coordinates directly (no scroll offset needed)
  //       overlay.style.top = `${newRect.top}px`;
  //       overlay.style.left = `${newRect.left}px`;
  //       overlay.style.width = `${Math.max(newRect.width, newScrollWidth)}px`;
  //       overlay.style.height = `${Math.max(newRect.height, newScrollHeight)}px`;
  //       overlay.style.minHeight = `${Math.max(newRect.height, newScrollHeight)}px`;
  //       overlay.style.maxHeight = `${Math.max(newRect.height, newScrollHeight)}px`;
  //     };
    
  //   window.addEventListener('scroll', updatePosition, true);
  //   window.addEventListener('resize', updatePosition);
    
  //   // Store cleanup function
  //   (overlay as any).__cleanup = () => {
  //     window.removeEventListener('scroll', updatePosition, true);
  //     window.removeEventListener('resize', updatePosition);
  //   };
  // }



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
    const highlights = this.highlightsContent.querySelectorAll(`[data-element-id="${elementId}"]`);
    
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
      errors.forEach(err => {
        if (err.id) {
          errorIdToError.set(err.id, err);
        }
      });
      
      const dismissedErrorIds = new Set<string>();
      
      highlights.forEach(highlight => {
        const htmlHighlight = highlight as HTMLElement;
        const errorId = htmlHighlight.getAttribute('data-error-id');
        
        if (errorId) {
          const error = errorIdToError.get(errorId);
          if (error && this.isErrorDismissed(element, error)) {
            // Mark this error as dismissed - we'll remove all highlights for it
            dismissedErrorIds.add(errorId);
            return;
          }
        }
        
        // Not dismissed, show it
        htmlHighlight.style.display = '';
        htmlHighlight.removeAttribute('data-hidden-by-blur');
        htmlHighlight.removeAttribute('data-hidden-by-modal');
      });
      
      // Remove all highlights for dismissed errors (multi-line support)
      if (dismissedErrorIds.size > 0 && this.highlightsContent) {
        dismissedErrorIds.forEach(errorId => {
          const allErrorHighlights = this.highlightsContent!.querySelectorAll(
            `[data-element-id="${elementId}"][data-error-id="${errorId}"]`
          );
          allErrorHighlights.forEach(h => h.remove());
        });
      }
      // Update positions
      this.updateHighlightsPosition(element);
    }
  }

  /**
   * Find the best parent container for overlay positioning
   */
  // private findOverlayParent(element: HTMLElement): HTMLElement {
  //   // For Draft.js editors (Twitter), use the editor container
  //   if (element.classList.contains('public-DraftEditor-content')) {
  //     const editorContainer = element.closest('.DraftEditor-editorContainer');
  //     if (editorContainer) {
  //       return editorContainer as HTMLElement;
  //     }
  //     const draftRoot = element.closest('.DraftEditor-root');
  //     if (draftRoot) {
  //       return draftRoot as HTMLElement;
  //     }
  //   }
    
  //   // For Gmail, use the contenteditable wrapper
  //   if (element.classList.contains('Am') && element.classList.contains('aiL') && element.classList.contains('Al')) {
  //     // Gmail's contenteditable is inside .aO7 or .Ar.Au
  //     const gmailWrapper = element.closest('.aO7') || element.closest('.Ar.Au') || element.closest('.Ar');
  //     if (gmailWrapper) {
  //       return gmailWrapper as HTMLElement;
  //     }
  //   }
    
  //   // Try to find a suitable parent with positioning context
  //   let parent = element.parentElement;
    
  //   // Look for a parent with position: relative, absolute, or fixed
  //   while (parent && parent !== document.body) {
  //     const styles = window.getComputedStyle(parent);
  //     if (styles.position !== 'static') {
  //       return parent;
  //     }
  //     parent = parent.parentElement;
  //   }
    
  //   // If no positioned parent found, use the element's immediate parent
  //   const immediateParent = element.parentElement;
  //   if (immediateParent && immediateParent !== document.body) {
  //     return immediateParent;
  //   }
    
  //   // Fallback to body (shouldn't happen often)
  //   return document.body;
  // }

  /**
   * Update overlay position
   * @deprecated Use updateHighlightsPosition instead
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  // private updateOverlayPosition(element: HTMLElement, overlay: HTMLElement): void {
  //   // For absolute positioning, calculate relative to parent
  //   const parentContainer = overlay.parentElement || this.findOverlayParent(element);
  //   const elementRect = element.getBoundingClientRect();
  //   const parentRect = parentContainer.getBoundingClientRect();
  //   const scrollWidth = element.scrollWidth || elementRect.width;
  //   const scrollHeight = element.scrollHeight || elementRect.height;
    
  //   // Calculate position relative to parent, accounting for scroll
  //   const parentScrollTop = parentContainer.scrollTop || 0;
  //   const parentScrollLeft = parentContainer.scrollLeft || 0;
    
  //   // Position relative to parent (accounting for parent's scroll position)
  //   const topOffset = elementRect.top - parentRect.top + parentScrollTop;
  //   const leftOffset = elementRect.left - parentRect.left + parentScrollLeft;
    
  //   overlay.style.top = `${topOffset}px`;
  //   overlay.style.left = `${leftOffset}px`;
  //   overlay.style.width = `${Math.max(elementRect.width, scrollWidth)}px`;
  //   overlay.style.height = `${Math.max(elementRect.height, scrollHeight)}px`;
  //   overlay.style.minHeight = `${Math.max(elementRect.height, scrollHeight)}px`;
  //   overlay.style.maxHeight = `${Math.max(elementRect.height, scrollHeight)}px`;
  // }

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
   * Hide all grammar error highlights
   */
  private hideAllGrammarOverlays(): void {
    if (!this.highlightsContent) return;
    
    const allHighlights = this.highlightsContent.querySelectorAll('.rewordly-highlight');
    allHighlights.forEach((highlight) => {
      (highlight as HTMLElement).style.display = 'none';
      (highlight as HTMLElement).setAttribute('data-hidden-by-modal', 'true');
    });
  }

  /**
   * Restore grammar highlights that were hidden by modal
   */
  private restoreGrammarOverlays(): void {
    if (!this.highlightsContent) return;
    
    const hiddenHighlights = this.highlightsContent.querySelectorAll('.rewordly-highlight[data-hidden-by-modal="true"]');
    hiddenHighlights.forEach((highlight) => {
      const htmlHighlight = highlight as HTMLElement;
      htmlHighlight.style.display = '';
      htmlHighlight.removeAttribute('data-hidden-by-modal');
    });
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
    this.highlightsContainer = document.createElement('rewordly-highlights');
    this.highlightsContainer.setAttribute('data-rewordly-shadow-root', 'true');
    
    // Use maximum z-index for Reddit (Reddit has high z-index modals)
    const isReddit = window.location.hostname.includes('reddit.com');
    const zIndex = isReddit ? '2147483647' : '2147483645';
    
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
    this.highlightsShadowRoot = this.highlightsContainer.attachShadow({ mode: 'open' });
    
    // Create content div inside Shadow DOM
    this.highlightsContent = document.createElement('div');
    this.highlightsContent.setAttribute('data-rewordly-part', 'highlights');
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
    const style = document.createElement('style');
    // Use the same isReddit variable defined above
    style.textContent = `
      .rewordly-highlight {
        position: absolute !important;
        pointer-events: auto !important;
        cursor: pointer !important;
        border-bottom: 2px solid #ef4444 !important;
        box-sizing: content-box !important;
        z-index: ${isReddit ? '2147483647' : '1'} !important;
        /* No transition for position updates - only animate on initial creation */
        transition: none !important;
        transform-origin: left center !important;
        ${isReddit ? 'background: rgba(239, 68, 68, 0.05) !important;' : ''}
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
  private createHighlight(element: HTMLElement, error: GrammarError, index: number, animate: boolean = true): void {
    
    if (!this.highlightsContent) {
      return;
    }

    // Don't create highlight if error is dismissed
    if (this.isErrorDismissed(element, error)) {
      return;
    }

    // Get text from element (excluding signature)
    const { text } = this.extractTextExcludingSignature(element);

    if (!text || error.start >= text.length || error.end > text.length) {
      return;
    }

    // Adjust positions for multi-word grammar errors to highlight only problematic word(s)
    const adjustedPositions = this.adjustErrorPositionsForMultiWord(text, error);
    const highlightStart = adjustedPositions.start;
    const highlightEnd = adjustedPositions.end;

    // Get all rects for multi-line support (one rect per line)
    const highlightRects = this.getErrorTextRects(element, highlightStart, highlightEnd);
    if (highlightRects.length === 0) {
      console.warn('Rewordly: No highlight rects found', {
        error,
        highlightStart,
        highlightEnd,
        textLength: text.length,
        elementType: element instanceof HTMLInputElement ? 'input' : element instanceof HTMLTextAreaElement ? 'textarea' : 'contenteditable'
      });
      return;
    }
    
    console.log('Rewordly: Creating highlight', {
      error,
      highlightRects: highlightRects.length,
      highlightStart,
      highlightEnd
    });

    // Create a highlight element for each rect (each line)
    highlightRects.forEach((highlightRect, lineIndex) => {
      // Create highlight element
      const highlight = document.createElement('div');
      highlight.className = 'rewordly-highlight';
      highlight.setAttribute('data-rewordly-part', 'highlight');
      highlight.setAttribute('data-highlight-format', 'underline');
      highlight.setAttribute('data-highlight-color-name', 'red');
      highlight.setAttribute('data-element-id', this.getElementId(element));
      highlight.setAttribute('data-error-index', index.toString());
      highlight.setAttribute('data-error-id', error.id); // Store error ID for quick lookup
      highlight.setAttribute('data-line-index', lineIndex.toString()); // Track which line this highlight is for
      highlight.setAttribute('data-error', JSON.stringify(error));
      
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
        highlight.style.width = '0px';
        highlight.style.overflow = 'hidden';
        highlight.style.opacity = '0';
        
        // Add animation class
        highlight.classList.add('rewordly-highlight-enter');
        
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
          const easeInOut = progress < 0.5
            ? 2 * progress * progress
            : 1 - Math.pow(-2 * progress + 2, 2) / 2;
          
          const currentWidth = startWidth + (targetWidth - startWidth) * easeInOut;
          const currentOpacity = startOpacity + (endOpacity - startOpacity) * easeInOut;
          
          highlight.style.width = `${currentWidth}px`;
          highlight.style.opacity = `${currentOpacity}`;
          
          if (progress < 1) {
            requestAnimationFrame(animateFn);
          } else {
            // Animation complete
            highlight.style.width = `${targetWidth}px`;
            highlight.style.opacity = '1';
            highlight.style.overflow = 'visible';
            highlight.classList.remove('rewordly-highlight-enter');
          }
        };
        
        requestAnimationFrame(animateFn);
      } else {
        // No animation - set final values immediately
        highlight.style.width = `${targetWidth}px`;
        highlight.style.opacity = '1';
        highlight.style.overflow = 'visible';
      }
    });
  }

  /**
   * Adjust error positions for multi-word grammar errors to highlight only problematic word(s)
   * For errors like "an important meetings", we should highlight only "meetings" (the noun)
   */
  private adjustErrorPositionsForMultiWord(_text: string, error: GrammarError): { start: number; end: number } {
    // Always return original positions to highlight the entire error phrase
    // This ensures multi-word grammar errors like "an important meetings" 
    // are fully highlighted, not just the last word
    return { start: error.start, end: error.end };
  }


  /**
   * Get all rects for error text (supports multi-line highlights)
   * Returns an array of DOMRects, one for each line the error spans
   */
  private getErrorTextRects(element: HTMLElement, start: number, end: number): DOMRect[] {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      return this.getInputTextareaErrorRects(element, start, end);
    } else if (element.getAttribute('contenteditable') === 'true' || element.isContentEditable) {
      return this.getContentEditableErrorRects(element, start, end);
    }
    return [];
  }

  /**
   * Get error rects for input/textarea elements (supports multi-line)
   */
  private getInputTextareaErrorRects(element: HTMLInputElement | HTMLTextAreaElement, start: number, end: number): DOMRect[] {
    const text = element.value;
    if (start >= text.length || end > text.length) {
      return [];
    }

    const elementRect = element.getBoundingClientRect();
    const styles = window.getComputedStyle(element);
    
    // Get padding and border for accurate width calculation
    const paddingLeft = parseFloat(styles.paddingLeft) || 0;
    const paddingRight = parseFloat(styles.paddingRight) || 0;
    const borderLeft = parseFloat(styles.borderLeftWidth) || 0;
    const borderRight = parseFloat(styles.borderRightWidth) || 0;
    const paddingTop = parseFloat(styles.paddingTop) || 0;
    const borderTop = parseFloat(styles.borderTopWidth) || 0;
    
    // Calculate content width (element width minus padding and borders)
    const contentWidth = elementRect.width - paddingLeft - paddingRight - borderLeft - borderRight;
    
    // Create a mirror div to measure text position
    const div = document.createElement('div');
    const divStyle = div.style;
    
    // Copy all relevant styles
    const properties = [
      'direction', 'boxSizing', 'overflowX', 'overflowY',
      'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderStyle',
      'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
      'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize', 'fontSizeAdjust', 'lineHeight', 'fontFamily',
      'textAlign', 'textTransform', 'textIndent', 'textDecoration', 'letterSpacing', 'wordSpacing',
      'tabSize', 'MozTabSize', 'whiteSpace'
    ];
    
    properties.forEach(prop => {
      // @ts-ignore
      divStyle[prop] = styles[prop];
    });
    
    // Set exact content width to ensure proper text wrapping
    divStyle.width = `${contentWidth}px`;
    divStyle.position = 'absolute';
    divStyle.visibility = 'hidden';
    divStyle.top = '-9999px';
    divStyle.left = '-9999px';
    divStyle.whiteSpace = element instanceof HTMLInputElement ? 'pre' : 'pre-wrap';
    if (!(element instanceof HTMLInputElement)) {
      divStyle.wordWrap = 'break-word';
    }
    
    // Build the complete text structure for accurate measurement
    div.textContent = text;
    
    document.body.appendChild(div);
    
    // Force layout calculation
    void div.offsetHeight;
    
    // Use Range API to measure the exact position of the error text
    const range = document.createRange();
    const textNode = div.firstChild;
    
    if (!textNode || textNode.nodeType !== Node.TEXT_NODE) {
      document.body.removeChild(div);
      return [];
    }
    
    // Set range to cover the error text
    const startOffset = Math.min(start, textNode.textContent!.length);
    const endOffset = Math.min(end, textNode.textContent!.length);
    
    range.setStart(textNode, startOffset);
    range.setEnd(textNode, endOffset);
    
    // Get all client rects (one for each line the error spans)
    const clientRects = range.getClientRects();
    const divRect = div.getBoundingClientRect();
    
    // Account for scroll
    const scrollLeft = element.scrollLeft || 0;
    const scrollTop = element.scrollTop || 0;
    
    // For Reddit, measure the actual text start position to account for container offsets
    // This fixes the issue where highlights appear offset to the right
    const isReddit = window.location.hostname.includes('reddit.com');
    let textStartOffset = 0;
    
    if (isReddit && text.length > 0) {
      // Measure the first character's position in the mirror div
      // The mirror div should have the same text layout as the textarea
      const firstCharRange = document.createRange();
      const firstCharTextNode = div.firstChild;
      if (firstCharTextNode && firstCharTextNode.nodeType === Node.TEXT_NODE && firstCharTextNode.textContent!.length > 0) {
        firstCharRange.setStart(firstCharTextNode, 0);
        firstCharRange.setEnd(firstCharTextNode, 1);
        const firstCharRect = firstCharRange.getBoundingClientRect();
        
        // The first character in the mirror div should start at divRect.left (accounting for padding)
        // But in Reddit's textarea, there might be an additional offset
        // We calculate where the first char actually is relative to the div
        const firstCharRelativeLeft = firstCharRect.left - divRect.left;
        
        // The expected position should be 0 (or very close) since we copied all styles
        // If there's a difference, it means Reddit has additional container offsets
        // We'll use this to adjust the highlight positions
        if (firstCharRelativeLeft > 0.1) { // Only apply if there's a noticeable offset (>0.1px)
          textStartOffset = firstCharRelativeLeft;
        }
      }
    }
    
    // Convert each client rect to viewport coordinates
    const rects: DOMRect[] = [];
    for (let i = 0; i < clientRects.length; i++) {
      const clientRect = clientRects[i];
      if (!clientRect) continue;
      
      // Calculate left position: element position + padding/border + relative position in mirror div - scroll - text start offset
      // The textStartOffset corrects for Reddit's container-specific positioning
      const left = elementRect.left + paddingLeft + borderLeft + (clientRect.left - divRect.left) - scrollLeft - textStartOffset;
      const top = elementRect.top + paddingTop + borderTop + (clientRect.top - divRect.top) - scrollTop;
      const width = clientRect.width;
      const height = clientRect.height || parseFloat(styles.lineHeight) || parseFloat(styles.fontSize) * 1.2;
      
      rects.push(new DOMRect(left, top, width, height));
    }
    
    document.body.removeChild(div);
    
    return rects;
  }

  /**
   * Map innerText positions to text node positions for contenteditable elements
   * Returns mapping information for start and end positions
   */
  private mapInnerTextToTextNodes(
    element: HTMLElement, 
    start: number, 
    end: number
  ): { 
    startNode: Text | null; 
    startOffset: number; 
    endNode: Text | null; 
    endOffset: number;
  } | null {
    // Use text extraction that excludes signature to match error positions
    const { text: extractedText } = this.extractTextExcludingSignature(element);
    const innerText = extractedText;
    
    if (start >= innerText.length || end > innerText.length) {
      return null;
    }

    // Find text nodes and map their positions to innerText
    const walker = document.createTreeWalker(
      element,
      NodeFilter.SHOW_TEXT,
      null
    );

    const textNodes: Array<{ node: Text; innerTextStart: number; innerTextEnd: number }> = [];
    let searchStart = 0;

    let node: Text | null;
    while ((node = walker.nextNode() as Text | null)) {
      if (!node || !node.textContent) continue;
      
      const parent = node.parentElement;
      if (!parent) continue;
      
      // Skip signature elements (Gmail and other email clients)
      // Check if this node is inside a signature block
      const isInSignature = parent.closest('.gmail_signature, [class*="signature"], [id*="signature"]') !== null;
      if (isInSignature) {
        continue; // Skip signature text nodes
      }
      
      // Check visibility
      const style = window.getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      
      const nodeText = node.textContent;
      
      // Find where this node's text appears in innerText
      let foundIndex = -1;
      let searchPos = searchStart;
      
      while (searchPos < innerText.length) {
        // Skip \n characters in innerText
        while (searchPos < innerText.length && innerText[searchPos] === '\n') {
          searchPos++;
        }
        
        if (searchPos >= innerText.length) break;
        
        // Try to match node text
        let match = true;
        let innerPos = searchPos;
        let nodePos = 0;
        
        while (nodePos < nodeText.length && innerPos < innerText.length) {
          const nodeChar = nodeText[nodePos];
          const innerChar = innerText[innerPos];
          
          if (nodeChar === innerChar) {
            innerPos++;
            nodePos++;
          } else if (innerChar === '\n') {
            innerPos++;
          } else if (nodeChar === '\r' || nodeChar === '\n') {
            nodePos++;
          } else {
            match = false;
            break;
          }
        }
        
        if (match && nodePos === nodeText.length) {
          foundIndex = searchPos;
          break;
        }
        
        searchPos++;
      }
      
      if (foundIndex !== -1) {
        // Calculate end position
        let innerTextEnd = foundIndex;
        let nodePos = 0;
        
        while (nodePos < nodeText.length && innerTextEnd < innerText.length) {
          const nodeChar = nodeText[nodePos];
          const innerChar = innerText[innerTextEnd];
          
          if (nodeChar === innerChar) {
            innerTextEnd++;
            nodePos++;
          } else if (innerChar === '\n') {
            innerTextEnd++;
          } else if (nodeChar === '\r' || nodeChar === '\n') {
            nodePos++;
          } else {
            break;
          }
        }
        
        textNodes.push({
          node,
          innerTextStart: foundIndex,
          innerTextEnd: innerTextEnd
        });
        
        searchStart = innerTextEnd;
      }
    }

    // Find the node(s) containing the error
    const startNodeInfo = textNodes.find(tn => start >= tn.innerTextStart && start < tn.innerTextEnd);
    const endNodeInfo = textNodes.find(tn => end > tn.innerTextStart && end <= tn.innerTextEnd);

    if (!startNodeInfo) {
      return null;
    }

    // Calculate local positions within the text nodes (skipping \n characters)
    let startNodeLocalPos = 0;
    let endNodeLocalPos = 0;
    
    // For start position: count characters from innerTextStart to start, skipping \n
    let pos = startNodeInfo.innerTextStart;
    while (pos < start && pos < innerText.length) {
      if (innerText[pos] !== '\n') {
        startNodeLocalPos++;
      }
      pos++;
    }
    
    if (endNodeInfo && endNodeInfo.node !== startNodeInfo.node) {
      // Error spans multiple nodes
      pos = endNodeInfo.innerTextStart;
      while (pos < end && pos < innerText.length) {
        if (innerText[pos] !== '\n') {
          endNodeLocalPos++;
        }
        pos++;
      }
      
      return {
        startNode: startNodeInfo.node,
        startOffset: startNodeLocalPos,
        endNode: endNodeInfo.node,
        endOffset: endNodeLocalPos
      };
    } else {
      // Error is within a single node
      pos = startNodeInfo.innerTextStart;
      while (pos < end && pos < innerText.length) {
        if (innerText[pos] !== '\n') {
          endNodeLocalPos++;
        }
        pos++;
      }
      
      return {
        startNode: startNodeInfo.node,
        startOffset: startNodeLocalPos,
        endNode: startNodeInfo.node,
        endOffset: endNodeLocalPos
      };
    }
  }

  /**
   * Get error rect for contenteditable elements
   */

  /**
   * Get error rects for contenteditable elements (supports multi-line)
   */
  private getContentEditableErrorRects(element: HTMLElement, start: number, end: number): DOMRect[] {
    const mapping = this.mapInnerTextToTextNodes(element, start, end);
    if (!mapping || !mapping.startNode) {
      return [];
    }

    try {
      const range = document.createRange();
      
      if (mapping.endNode && mapping.startNode !== mapping.endNode) {
        // Error spans multiple nodes
        range.setStart(mapping.startNode, Math.min(mapping.startOffset, mapping.startNode.textContent!.length));
        range.setEnd(mapping.endNode, Math.min(mapping.endOffset, mapping.endNode.textContent!.length));
      } else {
        // Error is within a single node
        range.setStart(mapping.startNode, mapping.startOffset);
        range.setEnd(mapping.startNode, Math.min(mapping.endOffset, mapping.startNode.textContent!.length));
      }
      
      // Get all client rects (one for each line the error spans)
      const clientRects = range.getClientRects();
      const rects: DOMRect[] = [];
      
      for (let i = 0; i < clientRects.length; i++) {
        const clientRect = clientRects[i];
        if (clientRect && clientRect.width > 0 && clientRect.height > 0) {
          rects.push(new DOMRect(clientRect.left, clientRect.top, clientRect.width, clientRect.height));
        }
      }
      
      return rects;
    } catch (e) {
      console.error('Rewordly: Error getting contenteditable error rects:', e);
    }

    return [];
  }

  /**
   * Clear highlights for a specific element
   */
  private clearElementHighlights(element: HTMLElement): void {
    if (!this.highlightsContent) return;
    
    const elementId = this.getElementId(element);
    const highlights = this.highlightsContent.querySelectorAll(`[data-element-id="${elementId}"]`);
    highlights.forEach(highlight => highlight.remove());
    
    // Remove scroll listeners for this element
    this.removeElementScrollListeners(element);
  }

  /**
   * Update highlights position on scroll/resize
   */
  private updateHighlightsPosition(element: HTMLElement, skipTransition: boolean = false): void {
    if (!this.highlightsContent) return;

    const elementId = this.getElementId(element);
    const errors = this.grammarErrors.get(element);
    if (!errors) return;

    // Group highlights by error ID to handle multi-line highlights
    const highlightsByErrorId = new Map<string, HTMLElement[]>();
    const allHighlights = this.highlightsContent.querySelectorAll(`[data-element-id="${elementId}"]`);
    
    allHighlights.forEach((highlight) => {
      const highlightErrorId = (highlight as HTMLElement).getAttribute('data-error-id');
      if (!highlightErrorId) return;
      
      if (!highlightsByErrorId.has(highlightErrorId)) {
        highlightsByErrorId.set(highlightErrorId, []);
      }
      highlightsByErrorId.get(highlightErrorId)!.push(highlight as HTMLElement);
    });

    // Update each error's highlights
    errors.forEach((error) => {
      const errorHighlights = highlightsByErrorId.get(error.id) || [];
      
      // Get text to adjust positions for multi-word errors
      let text = '';
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        text = element.value;
      } else if (element.getAttribute('contenteditable') === 'true' || element.isContentEditable) {
        text = element.innerText || element.textContent || '';
      }

      // Adjust positions for multi-word grammar errors
      const adjustedPositions = text ? this.adjustErrorPositionsForMultiWord(text, error) : { start: error.start, end: error.end };
      const highlightRects = this.getErrorTextRects(element, adjustedPositions.start, adjustedPositions.end);
      
      if (highlightRects.length === 0) {
        // Could not calculate position - check if this is during a replace operation
        // For Draft.js, DOM might be updating, so don't remove highlights immediately
        const isDraftJS = element.classList.contains('public-DraftEditor-content') || 
                          element.closest('.DraftEditor-root') !== null;
        
        if (isDraftJS && this.isPerformingReplace) {
          // During replace in Draft.js, DOM is updating - don't remove highlights
          // They will be updated when DOM stabilizes
          // Also, check if the error still exists in the text (might be temporarily unmappable)
          const currentText = element.innerText || element.textContent || '';
          if (error.word && currentText.includes(error.word)) {
            // Error word still exists, just temporarily unmappable - keep highlight
            return;
          }
        }
        
        // Could not calculate position - remove all highlights for this error
        // But only if we're not in the middle of a replace operation
        if (!this.isPerformingReplace) {
          errorHighlights.forEach(highlight => highlight.remove());
        }
        return;
      }

      // Update or create highlights for each line
      highlightRects.forEach((highlightRect, lineIndex) => {
        let highlight = errorHighlights.find(h => 
          h.getAttribute('data-line-index') === lineIndex.toString()
        );

        if (!highlight) {
          // Need to create a new highlight for this line
          // Find the error index
          const errorIndex = errors.findIndex(err => err.id === error.id);
          if (errorIndex !== -1) {
            // Create a temporary error object to pass to createHighlight
            // But we'll create the highlight manually here to avoid duplicate tooltip listeners
            highlight = document.createElement('div');
            highlight.className = 'rewordly-highlight';
            highlight.setAttribute('data-rewordly-part', 'highlight');
            highlight.setAttribute('data-highlight-format', 'underline');
            highlight.setAttribute('data-highlight-color-name', 'red');
            highlight.setAttribute('data-element-id', this.getElementId(element));
            highlight.setAttribute('data-error-index', errorIndex.toString());
            highlight.setAttribute('data-error-id', error.id);
            highlight.setAttribute('data-line-index', lineIndex.toString());
            highlight.setAttribute('data-error', JSON.stringify(error));
            // Ensure new highlight is visible
            highlight.style.display = '';
            highlight.removeAttribute('data-hidden-by-blur');
            highlight.removeAttribute('data-hidden-by-modal');
            
              // Add hover listeners to all lines
              this.attachHighlightHoverListener(highlight, error, element);
            
            this.highlightsContent!.appendChild(highlight);
          } else {
            return; // Skip if error not found
          }
        }

        // Check if element is visible
        const elementRect = element.getBoundingClientRect();
        const isElementVisible = elementRect.width > 0 && elementRect.height > 0;
        
        // Check if highlight rect is within element bounds
        // getBoundingClientRect() already accounts for scroll position, so we just check bounds
        const isHighlightWithinElement = 
          isElementVisible &&
          highlightRect.top >= elementRect.top &&
          highlightRect.bottom <= elementRect.bottom &&
          highlightRect.left >= elementRect.left &&
          highlightRect.right <= elementRect.right;
        
        // Check if highlight is within any scrollable container's visible bounds
        // getBoundingClientRect() already accounts for scroll, so we check if highlight
        // is within the container's visible viewport
        let isWithinScrollableContainer = true;
        const scrollableContainers = this.scrollableContainers.get(element);
        if (scrollableContainers && scrollableContainers.size > 0) {
          scrollableContainers.forEach(container => {
            const containerRect = container.getBoundingClientRect();
            // Check if highlight rect intersects with container's visible bounds
            // Highlight should be visible if it's within or intersects the container's viewport
            const highlightIntersectsContainer = 
              highlightRect.bottom > containerRect.top &&
              highlightRect.top < containerRect.bottom &&
              highlightRect.right > containerRect.left &&
              highlightRect.left < containerRect.right;
            
            if (!highlightIntersectsContainer) {
              isWithinScrollableContainer = false;
            }
          });
        }
        
        // Update highlight position and size (instant, no animation)
        // Disable transitions during scroll for instant position updates
        if (skipTransition) {
          highlight.classList.add('rewordly-no-transition');
        }
        highlight.style.top = `${highlightRect.top}px`;
        highlight.style.left = `${highlightRect.left}px`;
        highlight.style.width = `${highlightRect.width}px`;
        highlight.style.height = `${highlightRect.height}px`;
        
        // Show or hide highlight based on visibility
        if (isHighlightWithinElement && isWithinScrollableContainer) {
          // Ensure highlight is visible (may have been hidden by blur/modal)
          highlight.style.display = '';
          highlight.style.opacity = '1'; // Restore opacity if it was faded
          highlight.removeAttribute('data-hidden-by-blur');
          highlight.removeAttribute('data-hidden-by-modal');
        } else {
          // Hide highlight if element is not visible or highlight is outside bounds
          highlight.style.display = 'none';
          highlight.setAttribute('data-hidden-by-scroll', 'true');
        }
        
        highlight.setAttribute('data-error', JSON.stringify(error));
        
        // Remove the no-transition class after position update is complete
        if (skipTransition) {
          // Use requestAnimationFrame to ensure the position update is applied first
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              highlight.classList.remove('rewordly-no-transition');
            });
          });
        }
      });

      // Remove any extra highlights that are no longer needed (if rect count decreased)
      errorHighlights.forEach((highlight) => {
        const lineIndex = parseInt(highlight.getAttribute('data-line-index') || '0', 10);
        if (lineIndex >= highlightRects.length) {
          highlight.remove();
        }
      });
    });

    // Remove highlights for errors that no longer exist
    highlightsByErrorId.forEach((highlights, errorId) => {
      if (!errors.find(err => err.id === errorId)) {
        highlights.forEach(highlight => highlight.remove());
      }
    });
  }

  /**
   * Attach hover listener to highlight
   */
  private attachHighlightHoverListener(highlight: HTMLElement, error: GrammarError, element: HTMLElement): void {
    let tooltipTimeout: number | null = null;

    const closeTooltip = () => {
      if (tooltipTimeout !== null) {
        clearTimeout(tooltipTimeout);
        tooltipTimeout = null;
      }
      // Close tooltip for this error ID if it exists
      const existingTooltip = this.activeTooltips.get(error.id);
      if (existingTooltip) {
        existingTooltip.remove();
        this.activeTooltips.delete(error.id);
      }
    };

    highlight.addEventListener('mouseenter', () => {
      // Close any existing tooltip for this error ID
      closeTooltip();
      
      // Close all other tooltips when opening a new one
      this.closeAllGrammarTooltips();

      // Get current errors
      const currentErrors = this.grammarErrors.get(element) || [];
      
      // Find the current error by ID (guaranteed to find the exact error)
      let currentError = currentErrors.find(err => err.id === error.id);
      
      // If error not found (shouldn't happen), use the stored error as fallback
      if (!currentError) {
        currentError = error;
      }

      // Create tooltip
      const tooltip = document.createElement('div');
      tooltip.className = 'rewordly-grammar-tooltip';

      // Limit initial suggestions display (show first 5, rest with "see more")
      const INITIAL_SUGGESTIONS_LIMIT = 5;
      const allSuggestions = currentError.suggestions || [];
      const hasMoreSuggestions = allSuggestions.length > INITIAL_SUGGESTIONS_LIMIT;
      const initialSuggestions = hasMoreSuggestions 
        ? allSuggestions.slice(0, INITIAL_SUGGESTIONS_LIMIT)
        : allSuggestions;
      const remainingSuggestions = hasMoreSuggestions 
        ? allSuggestions.slice(INITIAL_SUGGESTIONS_LIMIT)
        : [];

      const initialSuggestionsHtml = initialSuggestions.length > 0
        ? initialSuggestions.map((suggestion, index) => {
            // Format suggestion for display - make whitespace visible
            const displayText = this.formatSuggestionForDisplay(suggestion, currentError.word);
            return `<button class="rewordly-grammar-suggestion" data-suggestion="${this.escapeHtml(suggestion)}" data-error-start="${currentError.start}" data-error-end="${currentError.end}" data-suggestion-index="${index}">${this.escapeHtml(displayText)}</button>`;
          }).join('')
        : '<div class="rewordly-grammar-no-suggestions">No suggestions available</div>';

      const remainingSuggestionsHtml = remainingSuggestions.length > 0
        ? remainingSuggestions.map((suggestion, index) => {
            const displayText = this.formatSuggestionForDisplay(suggestion, currentError.word);
            return `<button class="rewordly-grammar-suggestion rewordly-grammar-suggestion-hidden" data-suggestion="${this.escapeHtml(suggestion)}" data-error-start="${currentError.start}" data-error-end="${currentError.end}" data-suggestion-index="${initialSuggestions.length + index}">${this.escapeHtml(displayText)}</button>`;
          }).join('')
        : '';

      const seeMoreButtonHtml = hasMoreSuggestions
        ? `<button class="rewordly-grammar-see-more" data-error-id="${currentError.id}">See more (${remainingSuggestions.length})</button>`
        : '';

      tooltip.innerHTML = `
        <div class="rewordly-grammar-tooltip-content">
          <div class="rewordly-grammar-tooltip-word">${this.escapeHtml(currentError.word)}</div>
          <div class="rewordly-grammar-tooltip-suggestions">
            ${initialSuggestionsHtml}
            ${remainingSuggestionsHtml}
          </div>
          ${seeMoreButtonHtml}
          <button class="rewordly-grammar-dismiss" data-error-id="${currentError.id}">Dismiss</button>
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
      const calculatedMaxHeight = Math.max(MIN_TOOLTIP_HEIGHT, Math.min(MAX_TOOLTIP_HEIGHT, maxAvailableHeight));
      
      // Apply max-height to suggestions container
      const suggestionsContainer = tooltip.querySelector('.rewordly-grammar-tooltip-suggestions') as HTMLElement;
      if (suggestionsContainer) {
        suggestionsContainer.style.maxHeight = `${calculatedMaxHeight}px`;
        suggestionsContainer.style.overflowY = 'auto';
        suggestionsContainer.style.overflowX = 'hidden';
      }

      // Position tooltip
      const tooltipRect = tooltip.getBoundingClientRect();
      const tooltipTop = highlightRect.top - tooltipRect.height - 8;
      const tooltipLeft = highlightRect.left + (highlightRect.width / 2) - (tooltipRect.width / 2);

      // Ensure tooltip doesn't go outside screen bounds horizontally
      const adjustedLeft = Math.max(8, Math.min(tooltipLeft, viewportWidth - tooltipRect.width - 8));
      
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

      // Store tooltip by error ID to prevent duplicates
      this.activeTooltips.set(error.id, tooltip);

      // Attach click handlers
      const suggestionButtons = tooltip.querySelectorAll('.rewordly-grammar-suggestion');
      suggestionButtons.forEach(button => {
        button.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();

          const suggestion = (button as HTMLElement).getAttribute('data-suggestion');
          if (!suggestion) return;

          // Get error data directly from highlight - this is the most reliable source
          const errorData = highlight.getAttribute('data-error');
          const errorId = highlight.getAttribute('data-error-id');
          
          if (!errorId || !errorData) {
            console.error('Rewordly: No error data found on highlight', { errorId, hasErrorData: !!errorData });
            return;
          }

          let targetError: GrammarError;
          try {
            targetError = JSON.parse(errorData);
          } catch (e) {
            console.error('Rewordly: Failed to parse error data from highlight', e);
            return;
          }

          closeTooltip();
          this.closeAllGrammarTooltips();
          
          // Use the error directly from highlight - no need to search in maps
          this.replaceGrammarError(element, targetError, suggestion);
        });
      });

      // Attach "see more" button handler
      const seeMoreButton = tooltip.querySelector('.rewordly-grammar-see-more');
      if (seeMoreButton) {
        seeMoreButton.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();

          // Show all hidden suggestions
          const hiddenSuggestions = tooltip.querySelectorAll('.rewordly-grammar-suggestion-hidden');
          hiddenSuggestions.forEach(suggestion => {
            suggestion.classList.remove('rewordly-grammar-suggestion-hidden');
          });

          // Hide the "see more" button
          seeMoreButton.remove();

          // Recalculate tooltip position after showing all suggestions
          const updatedTooltipRect = tooltip.getBoundingClientRect();
          const updatedHighlightRect = highlight.getBoundingClientRect();
          const updatedTooltipTop = updatedHighlightRect.top - updatedTooltipRect.height - 8;
          const updatedTooltipLeft = updatedHighlightRect.left + (updatedHighlightRect.width / 2) - (updatedTooltipRect.width / 2);

          const updatedAdjustedLeft = Math.max(8, Math.min(updatedTooltipLeft, window.innerWidth - updatedTooltipRect.width - 8));
          let updatedAdjustedTop = updatedTooltipTop;
          
          if (updatedTooltipTop < 8) {
            updatedAdjustedTop = updatedHighlightRect.bottom + 8;
            if (updatedAdjustedTop + updatedTooltipRect.height > window.innerHeight - 8) {
              updatedAdjustedTop = Math.max(8, window.innerHeight - updatedTooltipRect.height - 8);
            }
          } else if (updatedAdjustedTop + updatedTooltipRect.height > window.innerHeight - 8) {
            updatedAdjustedTop = Math.max(8, window.innerHeight - updatedTooltipRect.height - 8);
          }

          tooltip.style.top = `${updatedAdjustedTop}px`;
          tooltip.style.left = `${updatedAdjustedLeft}px`;
        });
      }

      // Attach dismiss button handler
      const dismissButton = tooltip.querySelector('.rewordly-grammar-dismiss');
      if (dismissButton) {
        dismissButton.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();

          // Get error ID from the highlight
          const errorId = highlight.getAttribute('data-error-id');
          if (!errorId) {
            console.error('Rewordly: No error ID found on highlight');
            return;
          }

          // Find the error in the stored errors
          const errors = this.grammarErrors.get(element) || [];
          const error = errors.find(err => err.id === errorId);
          
          if (error) {
            // Add to dismissed list
            // Dismiss based on word + context (handles position changes)
            const elementId = this.getElementId(element);
            
            // Get current text to generate context-based key
            let text = '';
            if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
              text = element.value;
            } else if (element.getAttribute('contenteditable') === 'true' || element.isContentEditable) {
              text = element.innerText || element.textContent || '';
            }
            
            const dismissKey = this.getDismissKey(elementId, error, text);
            this.dismissedErrors.set(dismissKey, true);
            
            // Remove error from grammarErrors map to prevent it from reappearing
            const currentErrors = this.grammarErrors.get(element) || [];
            const updatedErrors = currentErrors.filter(err => err.id !== error.id);
            this.grammarErrors.set(element, updatedErrors);
            
            // Remove all highlights for this error (multi-line support)
            if (this.highlightsContent) {
              const allErrorHighlights = this.highlightsContent.querySelectorAll(
                `[data-element-id="${elementId}"][data-error-id="${error.id}"]`
              );
              allErrorHighlights.forEach(h => h.remove());
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
                
                if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
                  // For input/textarea, use setSelectionRange
                  element.setSelectionRange(cursorPosition, cursorPosition);
                } else if (element.getAttribute('contenteditable') === 'true' || element.isContentEditable) {
                  // For contenteditable, use Range API
                  const selection = window.getSelection();
                  if (selection) {
                    const cursorMapping = this.mapInnerTextToTextNodes(element, cursorPosition, cursorPosition);
                    if (cursorMapping && cursorMapping.startNode) {
                      const cursorRange = document.createRange();
                      const offset = Math.min(cursorMapping.startOffset, cursorMapping.startNode.textContent!.length);
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

      tooltip.addEventListener('mouseleave', () => {
        tooltipTimeout = window.setTimeout(() => {
          // Check if any highlight for this error is still hovered
          const allHighlightsForError = this.highlightsContent?.querySelectorAll(
            `[data-error-id="${error.id}"]`
          ) || [];
          const isAnyHighlightHovered = Array.from(allHighlightsForError).some(h => 
            (h as HTMLElement).matches(':hover')
          );
          
          if (!isAnyHighlightHovered && !tooltip.matches(':hover')) {
            closeTooltip();
          }
        }, 100);
      });
    });

    highlight.addEventListener('mouseleave', () => {
      tooltipTimeout = window.setTimeout(() => {
        // Check if any highlight for this error is still hovered
        const allHighlightsForError = this.highlightsContent?.querySelectorAll(
          `[data-error-id="${error.id}"]`
        ) || [];
        const isAnyHighlightHovered = Array.from(allHighlightsForError).some(h => 
          (h as HTMLElement).matches(':hover')
        );
        
        const tooltip = this.activeTooltips.get(error.id);
        if (tooltip && !tooltip.matches(':hover') && !isAnyHighlightHovered) {
          closeTooltip();
        }
      }, 100);
    });
  }


  /**
   * Escape HTML to prevent XSS
   */
  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Format suggestion for display - makes whitespace-only suggestions visible
   */
  private formatSuggestionForDisplay(suggestion: string, errorWord: string): string {
    // If suggestion is only whitespace, provide a descriptive message
    if (/^\s+$/.test(suggestion)) {
      const suggestionSpaceCount = suggestion.length;
      
      // If error word is also whitespace and has more spaces than suggestion
      if (/^\s+$/.test(errorWord) && errorWord.length > suggestionSpaceCount) {
        if (suggestionSpaceCount === 1) {
          return 'Remove extra space';
        } else {
          return `Remove extra spaces (keep ${suggestionSpaceCount})`;
        }
      }
      
      // If suggestion is a single space
      if (suggestionSpaceCount === 1) {
        return 'Use single space';
      } else {
        return `Use ${suggestionSpaceCount} spaces`;
      }
    }
    return suggestion;
  }

  /**
   * Find all scrollable parent containers for an element
   * Also checks if the element itself is scrollable (e.g., textarea)
   */
  private findScrollableContainers(element: HTMLElement): Set<HTMLElement> {
    const scrollableContainers = new Set<HTMLElement>();
    
    // Check if element itself is scrollable (e.g., textarea, contenteditable div)
    const elementStyle = window.getComputedStyle(element);
    const elementOverflowY = elementStyle.overflowY;
    const elementOverflowX = elementStyle.overflowX;
    const elementOverflow = elementStyle.overflow;
    
    const isElementScrollable = 
      (elementOverflowY === 'auto' || elementOverflowY === 'scroll' || elementOverflow === 'auto' || elementOverflow === 'scroll') &&
      element.scrollHeight > element.clientHeight;
    
    const isElementScrollableX = 
      (elementOverflowX === 'auto' || elementOverflowX === 'scroll' || elementOverflow === 'auto' || elementOverflow === 'scroll') &&
      element.scrollWidth > element.clientWidth;
    
    if (isElementScrollable || isElementScrollableX) {
      scrollableContainers.add(element);
    }
    
    // Check parent containers
    let current: HTMLElement | null = element.parentElement;

    while (current && current !== document.body && current !== document.documentElement) {
      const style = window.getComputedStyle(current);
      const overflowY = style.overflowY;
      const overflowX = style.overflowX;
      const overflow = style.overflow;
      
      // Check if element is scrollable
      const isScrollable = 
        (overflowY === 'auto' || overflowY === 'scroll' || overflow === 'auto' || overflow === 'scroll') &&
        current.scrollHeight > current.clientHeight;
      
      // Also check for overflow-x scrollable containers
      const isScrollableX = 
        (overflowX === 'auto' || overflowX === 'scroll' || overflow === 'auto' || overflow === 'scroll') &&
        current.scrollWidth > current.clientWidth;

      if (isScrollable || isScrollableX) {
        scrollableContainers.add(current);
      }

      current = current.parentElement;
    }

    return scrollableContainers;
  }

  /**
   * Set up scroll listeners for a specific editable element
   */
  private setupElementScrollListeners(element: HTMLElement): void {
    // Remove existing listeners for this element
    this.removeElementScrollListeners(element);

    // Find scrollable containers
    const containers = this.findScrollableContainers(element);
    this.scrollableContainers.set(element, containers);

    // Add scroll listeners to each scrollable container
    containers.forEach(container => {
      // Check if we already have a listener for this container
      if (!this.scrollListeners.has(container)) {
        const updateAllForContainer = () => {
          // Update highlights for all elements that have this container as a scrollable parent
          this.scrollableContainers.forEach((containers, el) => {
            if (containers.has(container) && this.grammarErrors.has(el)) {
              this.updateHighlightsPosition(el, true);
            }
          });
        };
        
        container.addEventListener('scroll', updateAllForContainer, { passive: true });
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
    containers.forEach(container => {
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
          container.removeEventListener('scroll', listener);
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
        this.updateHighlightsPosition(element, true);
      });
    };

    window.addEventListener('scroll', updateAllHighlights, true);
    window.addEventListener('resize', updateAllHighlights);
  }

  /**
   * Close all grammar tooltips
   */
  private closeAllGrammarTooltips(): void {
    const allTooltips = document.querySelectorAll('.rewordly-grammar-tooltip');
    allTooltips.forEach(tooltip => {
      tooltip.remove();
    });
    // Clear the active tooltips map
    this.activeTooltips.clear();
  }

  /**
   * Attach hover event listeners to grammar error spans
   */
  // private attachGrammarErrorHoverListeners(overlay: HTMLElement, element: HTMLElement): void {
  //   const errorSpans = overlay.querySelectorAll('.rewordly-grammar-error');
  //   let currentTooltip: HTMLElement | null = null;
  //   let tooltipTimeout: number | null = null;
    
  //   // Helper function to close tooltip
  //   const closeTooltip = () => {
  //     if (tooltipTimeout !== null) {
  //       clearTimeout(tooltipTimeout);
  //       tooltipTimeout = null;
  //     }
  //     if (currentTooltip) {
  //       currentTooltip.remove();
  //       currentTooltip = null;
  //     }
  //   };
    
  //   errorSpans.forEach(span => {
  //     const errorSpan = span as HTMLElement;
      
  //     errorSpan.addEventListener('mouseenter', (_e) => {
  //       // Remove existing tooltip
  //       closeTooltip();
        
  //       // Get error data
  //       const errorData = errorSpan.getAttribute('data-error');
  //       if (!errorData) return;
        
  //       try {
  //         const error: GrammarError = JSON.parse(errorData);
          
  //         // Create tooltip
  //         const tooltip = document.createElement('div');
  //         tooltip.className = 'rewordly-grammar-tooltip';
          
  //         // Get error span position
  //         const spanRect = errorSpan.getBoundingClientRect();
          
  //         // Create suggestions list
  //         const suggestionsHtml = error.suggestions && error.suggestions.length > 0
  //           ? error.suggestions.map((suggestion) => 
  //               `<button class="rewordly-grammar-suggestion" data-suggestion="${this.escapeHtml(suggestion)}" data-error-start="${error.start}" data-error-end="${error.end}">${this.escapeHtml(suggestion)}</button>`
  //             ).join('')
  //           : '<div class="rewordly-grammar-no-suggestions">No suggestions available</div>';
          
  //         tooltip.innerHTML = `
  //           <div class="rewordly-grammar-tooltip-content">
  //             <div class="rewordly-grammar-tooltip-word">${this.escapeHtml(error.word)}</div>
  //             <div class="rewordly-grammar-tooltip-suggestions">${suggestionsHtml}</div>
  //           </div>
  //         `;
          
  //         document.body.appendChild(tooltip);
          
  //         // Position tooltip above the error span
  //         const tooltipRect = tooltip.getBoundingClientRect();
  //         const tooltipTop = spanRect.top - tooltipRect.height - 8;
  //         const tooltipLeft = spanRect.left + (spanRect.width / 2) - (tooltipRect.width / 2);
          
  //         // Adjust if tooltip goes off screen
  //         const adjustedLeft = Math.max(8, Math.min(tooltipLeft, window.innerWidth - tooltipRect.width - 8));
  //         const adjustedTop = tooltipTop < 8 ? spanRect.bottom + 8 : tooltipTop;
          
  //         tooltip.style.top = `${adjustedTop}px`;
  //         tooltip.style.left = `${adjustedLeft}px`;
          
  //         currentTooltip = tooltip;
          
  //         // Attach mouseleave to tooltip itself
  //         tooltip.addEventListener('mouseleave', () => {
  //           tooltipTimeout = window.setTimeout(() => {
  //             if (currentTooltip === tooltip && !errorSpan.matches(':hover')) {
  //               closeTooltip();
  //             }
  //           }, 100);
  //         });
          
  //         // Attach click handlers to suggestions
  //         const suggestionButtons = tooltip.querySelectorAll('.rewordly-grammar-suggestion');
  //         suggestionButtons.forEach(button => {
  //           button.addEventListener('click', (e) => {
  //             e.stopPropagation();
  //             e.preventDefault();
              
  //             const suggestion = (button as HTMLElement).getAttribute('data-suggestion');
  //             const errorStart = parseInt((button as HTMLElement).getAttribute('data-error-start') || '0');
  //             const errorEnd = parseInt((button as HTMLElement).getAttribute('data-error-end') || '0');
              
  //             if (suggestion) {
  //               // Close tooltip immediately before replacement
  //               closeTooltip();
  //               // Also close all tooltips as a safety measure
  //               this.closeAllGrammarTooltips();
                
  //               // Replace the error
  //               this.replaceGrammarError(element, errorStart, errorEnd, suggestion);
  //             }
  //           });
  //         });
  //       } catch (err) {
  //         console.error('Rewordly: Error parsing error data:', err);
  //       }
  //     });
      
  //     errorSpan.addEventListener('mouseleave', () => {
  //       // Small delay to allow moving to tooltip
  //       tooltipTimeout = window.setTimeout(() => {
  //         if (currentTooltip && !currentTooltip.matches(':hover') && !errorSpan.matches(':hover')) {
  //           closeTooltip();
  //         }
  //       }, 100);
  //     });
  //   });
    
  //   // Also handle overlay mouseleave to close tooltip
  //   overlay.addEventListener('mouseleave', () => {
  //     tooltipTimeout = window.setTimeout(() => {
  //       if (currentTooltip && !currentTooltip.matches(':hover')) {
  //         closeTooltip();
  //       }
  //     }, 200);
  //   });
  // }

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
      console.error('Rewordly: Invalid error provided', targetError);
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
    let currentText = '';
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      currentText = element.value;
    } else if (element.getAttribute('contenteditable') === 'true' || element.isContentEditable) {
      currentText = element.innerText || element.textContent || '';
    }
    
    // Validate positions
    if (actualStart < 0 || actualEnd > currentText.length || actualStart >= actualEnd) {
      // If positions are invalid, try to find the word in current text as fallback
      if (targetError.word) {
        // Try to find the word near the original position (within 50 chars)
        const searchStart = Math.max(0, Math.min(actualStart, currentText.length - 1));
        const wordIndex = currentText.indexOf(targetError.word, Math.max(0, searchStart - 50));
        if (wordIndex !== -1) {
          actualStart = wordIndex;
          actualEnd = wordIndex + targetError.word.length;
          console.warn('Rewordly: Recalculated error positions (original positions were invalid)', {
            errorId,
            oldStart: targetError.start,
            oldEnd: targetError.end,
            newStart: actualStart,
            newEnd: actualEnd,
            word: targetError.word
          });
        } else {
          console.error('Rewordly: Invalid error positions and word not found in text', { 
            actualStart, 
            actualEnd, 
            textLength: currentText.length,
            errorId: targetError.id,
            word: targetError.word
          });
          return;
        }
      } else {
        console.error('Rewordly: Invalid error positions and no word to search for', { 
          actualStart, 
          actualEnd, 
          textLength: currentText.length,
          errorId: targetError.id
        });
        return;
      }
    }
    
    // Update stored errors - remove the replaced error by ID
    const updatedErrors = currentErrors.filter(err => err.id !== errorId);
    this.grammarErrors.set(element, updatedErrors);
    
    // Remove only the replaced error's highlight (not all highlights) - match by ID
    // Do this AFTER updating grammarErrors to ensure consistency
    if (this.highlightsContent) {
      const elementId = this.getElementId(element);
      const highlights = this.highlightsContent.querySelectorAll(`[data-element-id="${elementId}"]`);
      highlights.forEach((highlight) => {
        const highlightErrorId = (highlight as HTMLElement).getAttribute('data-error-id');
        if (highlightErrorId === errorId) {
          highlight.remove();
        }
      });
    }
    
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      // For input/textarea
      // Set flag to prevent blur handler from hiding highlights during replace
      this.isPerformingReplace = true;
      
      const text = element.value;
      const newText = text.substring(0, actualStart) + replacement + text.substring(actualEnd);
      const replacementLength = replacement.length;
      const originalLength = actualEnd - actualStart;
      const lengthDiff = replacementLength - originalLength;
      
      element.value = newText;
      
      // Update error positions for remaining errors (they may have shifted)
      const updatedErrorsAfterReplace = updatedErrors.map(err => {
        // If error is after the replaced text, adjust its position
        if (err.start > actualEnd) {
          return {
            ...err,
            start: err.start + lengthDiff,
            end: err.end + lengthDiff
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
        const highlights = this.highlightsContent.querySelectorAll(`[data-element-id="${elementId}"]`);
        highlights.forEach((highlight) => {
          const highlightErrorId = (highlight as HTMLElement).getAttribute('data-error-id');
          if (!highlightErrorId) return;
          
          // Find the updated error by ID (guaranteed unique match)
          const updatedError = updatedErrorsAfterReplace.find(err => err.id === highlightErrorId);
          
          if (updatedError) {
            // Update data-error attribute with new positions (ID remains the same)
            (highlight as HTMLElement).setAttribute('data-error', JSON.stringify(updatedError));
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
        this.updateHighlightsPosition(element);
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
          this.performGrammarCheck(element).catch(error => {
            console.error('Rewordly: Error performing grammar check after replace:', error);
          });
        }, 150);
        
        // Trigger input event (this will reset timeout but won't clear errors)
        const inputEvent = new Event('input', { bubbles: true });
        // Mark as programmatic to prevent handleInput from processing it
        (inputEvent as any).__rewordlyProgrammatic = true;
        element.dispatchEvent(inputEvent);
      });
    } else if (element.getAttribute('contenteditable') === 'true' || element.isContentEditable) {
      // For contenteditable - check if it's Lexical (Reddit) or Draft.js (Twitter)
      const isLexical = element.getAttribute('data-lexical-editor') === 'true' ||
                        element.closest('[data-lexical-editor="true"]') !== null;
      const isDraftJS = element.classList.contains('public-DraftEditor-content') || 
                        element.closest('.DraftEditor-root') !== null;
      
      if (isLexical) {
        // For Lexical editors (Reddit), use execCommand to maintain editor state
        // This simulates user typing, which Lexical handles correctly
        this.isPerformingReplace = true;
        
        try {
          // Use execCommand('insertText') which is safest for Lexical
          this.replaceTextInContentEditable(element, actualStart, actualEnd, replacement, true);
          
          // Calculate length difference for position adjustment
          const replacementLength = replacement.length;
          const originalLength = actualEnd - actualStart;
          const lengthDiff = replacementLength - originalLength;
          
          // Update stored errors - adjust positions but keep IDs intact
          const updatedErrorsAfterReplace = updatedErrors.map(err => {
            // If error is after the replaced text, adjust its position (keep ID!)
            if (err.start > actualEnd) {
              return {
                ...err,
                start: err.start + lengthDiff,
                end: err.end + lengthDiff
              };
            }
            // If error overlaps with replaced text, it's already removed
            return err;
          });
          this.grammarErrors.set(element, updatedErrorsAfterReplace);
          
          // Update all highlight data-error attributes with new positions - match by ID
          if (this.highlightsContent) {
            const elementId = this.getElementId(element);
            const highlights = this.highlightsContent.querySelectorAll(`[data-element-id="${elementId}"]`);
            highlights.forEach((highlight) => {
              const highlightErrorId = (highlight as HTMLElement).getAttribute('data-error-id');
              if (!highlightErrorId) return;
              
              // Find the updated error by ID
              const updatedError = updatedErrorsAfterReplace.find(err => err.id === highlightErrorId);
              
              if (updatedError) {
                // Update data-error attribute with new positions (ID remains the same)
                (highlight as HTMLElement).setAttribute('data-error', JSON.stringify(updatedError));
              } else {
                // This error was removed
                highlight.remove();
              }
            });
          }
          
          // Wait for Lexical to update its DOM before repositioning highlights
          // Also keep flag true longer to catch any input events triggered by execCommand
          setTimeout(() => {
            this.updateHighlightsPosition(element);
            
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
                this.performGrammarCheck(element).catch(error => {
                  console.error('Rewordly: Error performing grammar check after replace:', error);
                });
              }, 300);
            });
          }, 100);
        } catch (err) {
          console.error('Rewordly: Error replacing text in Lexical:', err);
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
        const originalText = element.innerText || element.textContent || '';
        
        // For Draft.js editors (Twitter), use execCommand-based replacement
        const replaceSuccess = this.replaceTextInDraftJS(element, actualStart, actualEnd, replacement);
        
        if (!replaceSuccess) {
          console.error('Rewordly: Failed to replace text in Draft.js');
          this.isPerformingReplace = false;
          return; // Don't update highlights if replace failed
        }
        
        // Calculate length difference for position adjustment (do this immediately, not in timeout)
        const replacementLength = replacement.length;
        const originalLength = actualEnd - actualStart;
        const lengthDiff = replacementLength - originalLength;
        
        // Update stored errors - adjust positions but keep IDs intact
        const updatedErrorsAfterReplace = updatedErrors.map(err => {
          // If error is after the replaced text, adjust its position (keep ID!)
          if (err.start > actualEnd) {
            return {
              ...err,
              start: err.start + lengthDiff,
              end: err.end + lengthDiff
            };
          }
          // If error overlaps with replaced text, it's already removed
          return err;
        });
        this.grammarErrors.set(element, updatedErrorsAfterReplace);
        
        // Update all highlight data-error attributes with new positions - match by ID
        if (this.highlightsContent) {
          const elementId = this.getElementId(element);
          const highlights = this.highlightsContent.querySelectorAll(`[data-element-id="${elementId}"]`);
          
          highlights.forEach((highlight) => {
            const highlightErrorId = (highlight as HTMLElement).getAttribute('data-error-id');
            if (!highlightErrorId) return;
            
            // Find the updated error by ID
            const updatedError = updatedErrorsAfterReplace.find(err => err.id === highlightErrorId);
            
            if (updatedError) {
              // Update data-error attribute with new positions (ID remains the same)
              (highlight as HTMLElement).setAttribute('data-error', JSON.stringify(updatedError));
            } else {
              // This error was removed - fade out and remove
              (highlight as HTMLElement).style.opacity = '0';
              setTimeout(() => highlight.remove(), 150);
            }
          });
        }
        
        // IMMEDIATELY update highlight positions after replace (no timeout for Twitter)
        // This ensures highlights move instantly to their new positions
        requestAnimationFrame(() => {
          this.updateHighlightsPosition(element);
        });
        
        // Restore focus and cursor position
        requestAnimationFrame(() => {
          element.focus();
          
          // Set cursor position using Selection API
          const selection = window.getSelection();
          if (selection) {
            const newCursorPosition = actualStart + replacement.length;
            
            // Map cursor position to text node
            const cursorMapping = this.mapInnerTextToTextNodes(element, newCursorPosition, newCursorPosition);
            if (cursorMapping && cursorMapping.startNode) {
              try {
                // Check if node is still in document before using range
                if (this.isNodeInDocument(cursorMapping.startNode)) {
                  const cursorRange = document.createRange();
                  const offset = Math.min(cursorMapping.startOffset, cursorMapping.startNode.textContent!.length);
                  cursorRange.setStart(cursorMapping.startNode, offset);
                  cursorRange.collapse(true);
                  selection.removeAllRanges();
                  selection.addRange(cursorRange);
                }
              } catch (e) {
                // Cursor positioning failed - not critical, user can click to reposition
                console.warn('Rewordly: Could not set cursor position after replacement', e);
              }
            }
          }
        });
        
        // For Draft.js, also do a delayed verification to catch any DOM changes that Draft.js makes asynchronously
        // But the immediate update above ensures highlights move instantly
        setTimeout(() => {
          const newText = element.innerText || element.textContent || '';
          
          // Verify replacement was successful - check if text changed
          if (newText === originalText && originalText.length > 0) {
            console.warn('Rewordly: Replacement verification failed - text was not replaced');
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
          this.updateHighlightsPosition(element);
          
          // Keep isPerformingReplace true a bit longer to catch async Draft.js events
          setTimeout(() => {
            this.isPerformingReplace = false;
            // Trigger grammar check after replace is complete
            this.performGrammarCheck(element).catch(error => {
              console.error('Rewordly: Error performing grammar check after replace:', error);
            });
          }, 200);
        }, 200); // Small delay only for verification, not for initial update
      } else {
        // Check if this is Slate.js (Medium)
        const isSlate = element.getAttribute('data-slate-editor') === 'true' ||
                        element.querySelector('[data-slate-editor="true"]') !== null ||
                        element.closest('[data-slate-editor="true"]') !== null;
        
        // Check if this is Notion
        const isNotion = element.getAttribute('data-content-editable-leaf') === 'true' ||
                        element.classList.contains('notion-selectable') ||
                        window.location.hostname.includes('notion.so');
        
        if (isSlate) {
          // For Slate.js editors (Medium), use a special approach that properly updates Slate's internal state
          this.isPerformingReplace = true;
          
          // Use an async IIFE to handle the async operations
          (async () => {
            try {
              // Focus the element first
              element.focus();
              
              // Get current text to validate positions
              const currentText = element.innerText || element.textContent || '';
              if (actualStart < 0 || actualEnd > currentText.length || actualStart >= actualEnd) {
                console.error('Rewordly: Invalid positions for Slate.js replacement', { 
                  start: actualStart, 
                  end: actualEnd, 
                  textLength: currentText.length
                });
                this.isPerformingReplace = false;
                return;
              }
              
              const selection = window.getSelection();
              if (!selection) {
                this.isPerformingReplace = false;
                return;
              }
              
              // Map innerText positions to text node positions
              const mapping = this.mapInnerTextToTextNodes(element, actualStart, actualEnd);
              
              if (!mapping || !mapping.startNode) {
                console.error('Rewordly: Could not map innerText positions to text nodes for Slate.js');
                this.isPerformingReplace = false;
                return;
              }
              
              // Create range for the text to replace
              const range = document.createRange();
              
              // Set range start
              const startNodeLength = mapping.startNode.textContent!.length;
              const startOffset = Math.min(mapping.startOffset, startNodeLength);
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
              await new Promise(resolve => setTimeout(resolve, 20));
              
              // For Slate.js, we need to use beforeinput events properly
              // Slate.js listens to beforeinput events to update its internal state
              // We'll use deleteContent to delete selected text, then insertText to insert replacement
              
              // Step 1: Delete the selected content using deleteContent inputType
              const deleteBeforeInputEvent = new InputEvent('beforeinput', {
                bubbles: true,
                cancelable: true,
                inputType: 'deleteContent',
                isComposing: false
              });
              // Add getTargetRanges method for Slate.js compatibility
              (deleteBeforeInputEvent as any).getTargetRanges = () => [range.cloneRange()];
              (deleteBeforeInputEvent as any).__rewordlyProgrammatic = true;
              
              const deleteCancelled = !element.dispatchEvent(deleteBeforeInputEvent);
              
              if (!deleteCancelled) {
                // Delete the selected content from DOM
                range.deleteContents();
                
                // Trigger input event for deletion
                const deleteInputEvent = new InputEvent('input', {
                  bubbles: true,
                  cancelable: false,
                  inputType: 'deleteContent',
                  isComposing: false
                });
                (deleteInputEvent as any).__rewordlyProgrammatic = true;
                element.dispatchEvent(deleteInputEvent);
              }
              
              // Wait for Slate.js to process the deletion
              await new Promise(resolve => setTimeout(resolve, 20));
              
              // Step 2: Insert the replacement text
              // Get the current selection (should be collapsed at deletion point)
              const currentRange = selection.rangeCount > 0 ? selection.getRangeAt(0) : range;
              
              // Ensure range is collapsed
              if (!currentRange.collapsed) {
                currentRange.collapse(true);
              }
              
              // Trigger beforeinput event for insertion
              const insertBeforeInputEvent = new InputEvent('beforeinput', {
                bubbles: true,
                cancelable: true,
                inputType: 'insertText',
                data: replacement,
                isComposing: false
              });
              // Add getTargetRanges method for Slate.js compatibility
              (insertBeforeInputEvent as any).getTargetRanges = () => [currentRange.cloneRange()];
              (insertBeforeInputEvent as any).__rewordlyProgrammatic = true;
              
              const insertCancelled = !element.dispatchEvent(insertBeforeInputEvent);
              
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
                const insertInputEvent = new InputEvent('input', {
                  bubbles: true,
                  cancelable: false,
                  inputType: 'insertText',
                  data: replacement,
                  isComposing: false
                });
                (insertInputEvent as any).__rewordlyProgrammatic = true;
                element.dispatchEvent(insertInputEvent);
              }
              
              // Also try execCommand as a backup (some Slate.js versions may prefer it)
              // But only if the above didn't work
              try {
                // Re-select the text we just inserted to verify it's there
                const verifyRange = document.createRange();
                const verifyMapping = this.mapInnerTextToTextNodes(element, actualStart, actualStart + replacement.length);
                if (verifyMapping && verifyMapping.startNode) {
                  verifyRange.setStart(verifyMapping.startNode, Math.min(verifyMapping.startOffset, verifyMapping.startNode.textContent!.length));
                  if (verifyMapping.endNode && verifyMapping.endNode !== verifyMapping.startNode) {
                    verifyRange.setEnd(verifyMapping.endNode, Math.min(verifyMapping.endOffset, verifyMapping.endNode.textContent!.length));
                  } else {
                    verifyRange.setEnd(verifyMapping.startNode, Math.min(verifyMapping.endOffset, verifyMapping.startNode.textContent!.length));
                  }
                  selection.removeAllRanges();
                  selection.addRange(verifyRange);
                }
              } catch (e) {
                // Ignore errors in verification
              }
              
              // Wait longer for Slate.js to fully process the changes
              await new Promise(resolve => setTimeout(resolve, 100));
              
              // Verify the replacement was successful by checking the text content
              const newText = element.innerText || element.textContent || '';
              const expectedText = currentText.substring(0, actualStart) + replacement + currentText.substring(actualEnd);
              
              // If replacement didn't work, try one more time with execCommand
              if (newText !== expectedText) {
                console.warn('Rewordly: Slate.js replacement verification failed, trying execCommand fallback', {
                  expected: expectedText.substring(0, 50),
                  actual: newText.substring(0, 50)
                });
                
                // Try execCommand as a last resort
                try {
                  // Re-select the original text range
                  const retryMapping = this.mapInnerTextToTextNodes(element, actualStart, actualEnd);
                  if (retryMapping && retryMapping.startNode) {
                    const retryRange = document.createRange();
                    retryRange.setStart(retryMapping.startNode, Math.min(retryMapping.startOffset, retryMapping.startNode.textContent!.length));
                    if (retryMapping.endNode && retryMapping.endNode !== retryMapping.startNode) {
                      retryRange.setEnd(retryMapping.endNode, Math.min(retryMapping.endOffset, retryMapping.endNode.textContent!.length));
                    } else {
                      retryRange.setEnd(retryMapping.startNode, Math.min(retryMapping.endOffset, retryMapping.startNode.textContent!.length));
                    }
                    
                    selection.removeAllRanges();
                    selection.addRange(retryRange);
                    
                    await new Promise(resolve => setTimeout(resolve, 20));
                    
                    // Try execCommand insertText which should replace selected text
                    const execSuccess = document.execCommand('insertText', false, replacement);
                    if (execSuccess) {
                      await new Promise(resolve => setTimeout(resolve, 50));
                      // Verify again
                      const retryText = element.innerText || element.textContent || '';
                      if (retryText === expectedText) {
                        console.log('Rewordly: execCommand fallback succeeded for Slate.js');
                      }
                    }
                  }
                } catch (e) {
                  console.error('Rewordly: execCommand fallback failed', e);
                }
              }
              
              // Calculate length difference for position adjustment
              const replacementLength = replacement.length;
              const originalLength = actualEnd - actualStart;
              const lengthDiff = replacementLength - originalLength;
              
              // Update stored errors - adjust positions but keep IDs intact
              const updatedErrorsAfterReplace = updatedErrors.map(err => {
                if (err.start > actualEnd) {
                  return {
                    ...err,
                    start: err.start + lengthDiff,
                    end: err.end + lengthDiff
                  };
                }
                return err;
              });
              this.grammarErrors.set(element, updatedErrorsAfterReplace);
              
              // Update highlights
              if (this.highlightsContent) {
                const elementId = this.getElementId(element);
                const highlights = this.highlightsContent.querySelectorAll(`[data-element-id="${elementId}"]`);
                highlights.forEach((highlight) => {
                  const highlightErrorId = (highlight as HTMLElement).getAttribute('data-error-id');
                  if (!highlightErrorId) return;
                  
                  const updatedError = updatedErrorsAfterReplace.find(err => err.id === highlightErrorId);
                  if (updatedError) {
                    (highlight as HTMLElement).setAttribute('data-error', JSON.stringify(updatedError));
                  } else {
                    highlight.remove();
                  }
                });
              }
              
              // Update highlight positions after Slate.js has updated its DOM
              // Use longer delay to ensure Slate.js has fully updated its internal state
              setTimeout(() => {
                // First, update highlight positions with the adjusted error positions
                this.updateHighlightsPosition(element);
                
                // Cancel blur handlers
                const existingBlurTimeout = this.scheduledBlurHandlers.get(element);
                if (existingBlurTimeout) {
                  clearTimeout(existingBlurTimeout);
                  this.scheduledBlurHandlers.delete(element);
                }
                
                // Restore focus and cursor position
                requestAnimationFrame(() => {
                  element.focus();
                  const newCursorPosition = actualStart + replacement.length;
                  const cursorMapping = this.mapInnerTextToTextNodes(element, newCursorPosition, newCursorPosition);
                  if (cursorMapping && cursorMapping.startNode) {
                    const cursorRange = document.createRange();
                    const offset = Math.min(cursorMapping.startOffset, cursorMapping.startNode.textContent!.length);
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
                      this.updateHighlightsPosition(element);
                      
                      // Update again after another delay to catch any late DOM updates
                      setTimeout(() => {
                        this.updateHighlightsPosition(element);
                        
                        // One more update to ensure positions are stable
                        setTimeout(() => {
                          this.updateHighlightsPosition(element);
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
              console.error('Rewordly: Error replacing text in Slate.js:', err);
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
              const currentText = element.innerText || element.textContent || '';
              if (actualStart < 0 || actualEnd > currentText.length || actualStart >= actualEnd) {
                console.error('Rewordly: Invalid positions for Notion replacement', { 
                  start: actualStart, 
                  end: actualEnd, 
                  textLength: currentText.length
                });
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
              const mapping = this.mapInnerTextToTextNodes(element, actualStart, actualEnd);
              
              if (!mapping || !mapping.startNode) {
                console.error('Rewordly: Could not map innerText positions to text nodes for Notion');
                this.isPerformingReplace = false;
                return;
              }
              
              // Set range start
              const startNodeLength = mapping.startNode.textContent!.length;
              const startOffset = Math.min(mapping.startOffset, startNodeLength);
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
              await new Promise(resolve => setTimeout(resolve, 10));
              
              // Try execCommand first (some browsers still support it)
              let success = false;
              try {
                success = document.execCommand('insertText', false, replacement);
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
              const beforeInputEvent = new InputEvent('beforeinput', {
                bubbles: true,
                cancelable: true,
                inputType: 'insertText',
                data: replacement,
                isComposing: false
              });
              (beforeInputEvent as any).__rewordlyProgrammatic = true;
              element.dispatchEvent(beforeInputEvent);
              
              // Trigger input event (Notion uses this to update internal state)
              const inputEvent = new InputEvent('input', {
                bubbles: true,
                cancelable: false,
                inputType: 'insertText',
                data: replacement,
                isComposing: false
              });
              (inputEvent as any).__rewordlyProgrammatic = true;
              element.dispatchEvent(inputEvent);
              
              // Also trigger a composition event (some editors listen to this)
              const compositionStartEvent = new CompositionEvent('compositionstart', {
                bubbles: true,
                cancelable: true,
                data: replacement
              });
              (compositionStartEvent as any).__rewordlyProgrammatic = true;
              element.dispatchEvent(compositionStartEvent);
              
              const compositionEndEvent = new CompositionEvent('compositionend', {
                bubbles: true,
                cancelable: true,
                data: replacement
              });
              (compositionEndEvent as any).__rewordlyProgrammatic = true;
              element.dispatchEvent(compositionEndEvent);
              
              // Calculate length difference for position adjustment
              const replacementLength = replacement.length;
              const originalLength = actualEnd - actualStart;
              const lengthDiff = replacementLength - originalLength;
              
              // Update stored errors - adjust positions but keep IDs intact
              const updatedErrorsAfterReplace = updatedErrors.map(err => {
                if (err.start > actualEnd) {
                  return {
                    ...err,
                    start: err.start + lengthDiff,
                    end: err.end + lengthDiff
                  };
                }
                return err;
              });
              this.grammarErrors.set(element, updatedErrorsAfterReplace);
              
              // Update highlights
              if (this.highlightsContent) {
                const elementId = this.getElementId(element);
                const highlights = this.highlightsContent.querySelectorAll(`[data-element-id="${elementId}"]`);
                highlights.forEach((highlight) => {
                  const highlightErrorId = (highlight as HTMLElement).getAttribute('data-error-id');
                  if (!highlightErrorId) return;
                  
                  const updatedError = updatedErrorsAfterReplace.find(err => err.id === highlightErrorId);
                  if (updatedError) {
                    (highlight as HTMLElement).setAttribute('data-error', JSON.stringify(updatedError));
                  } else {
                    highlight.remove();
                  }
                });
              }
              
              // Update highlight positions
              setTimeout(() => {
                this.updateHighlightsPosition(element);
                
                // Cancel blur handlers
                const existingBlurTimeout = this.scheduledBlurHandlers.get(element);
                if (existingBlurTimeout) {
                  clearTimeout(existingBlurTimeout);
                  this.scheduledBlurHandlers.delete(element);
                }
                
                // Restore focus and cursor position
                requestAnimationFrame(() => {
                  element.focus();
                  const newCursorPosition = actualStart + replacement.length;
                  const cursorMapping = this.mapInnerTextToTextNodes(element, newCursorPosition, newCursorPosition);
                  if (cursorMapping && cursorMapping.startNode) {
                    const cursorRange = document.createRange();
                    const offset = Math.min(cursorMapping.startOffset, cursorMapping.startNode.textContent!.length);
                    cursorRange.setStart(cursorMapping.startNode, offset);
                    cursorRange.collapse(true);
                    selection.removeAllRanges();
                    selection.addRange(cursorRange);
                  }
                  
                  setTimeout(() => {
                    this.isPerformingReplace = false;
                    // Trigger grammar check after replace is complete
                    this.performGrammarCheck(element).catch(error => {
                      console.error('Rewordly: Error performing grammar check after replace:', error);
                    });
                  }, 150);
                });
              }, 100);
              
            } catch (err) {
              console.error('Rewordly: Error replacing text in Notion:', err);
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
          const currentText = element.innerText || element.textContent || '';
          if (actualStart < 0 || actualEnd > currentText.length || actualStart >= actualEnd) {
            console.error('Rewordly: Invalid positions for replacement', { 
              start: actualStart, 
              end: actualEnd, 
              textLength: currentText.length,
              currentErrors: this.grammarErrors.get(element)
            });
            this.isPerformingReplace = false;
            return;
          }
          
          // Map innerText positions to text node positions
          const mapping = this.mapInnerTextToTextNodes(element, actualStart, actualEnd);
          
          if (!mapping || !mapping.startNode) {
            console.error('Rewordly: Could not map innerText positions to text nodes', { 
              start: actualStart, 
              end: actualEnd,
              textLength: currentText.length,
              innerText: currentText.substring(Math.max(0, actualStart - 10), Math.min(currentText.length, actualEnd + 10))
            });
            this.isPerformingReplace = false;
            return;
          }
          
          try {
            const range = document.createRange();
            
            // Validate positions
            const startNodeLength = mapping.startNode.textContent!.length;
            if (mapping.startOffset < 0 || mapping.startOffset > startNodeLength) {
              console.error('Rewordly: Invalid start offset in text node', {
                startOffset: mapping.startOffset,
                nodeLength: startNodeLength,
                globalStart: actualStart
              });
              return;
            }
            
            if (mapping.endNode && mapping.startNode !== mapping.endNode) {
              // Error spans multiple text nodes
              const endNodeLength = mapping.endNode.textContent!.length;
              if (mapping.endOffset < 0 || mapping.endOffset > endNodeLength) {
                console.error('Rewordly: Invalid end offset in text node', {
                  endOffset: mapping.endOffset,
                  nodeLength: endNodeLength,
                  globalEnd: actualEnd
                });
                return;
              }
              
              range.setStart(mapping.startNode, Math.min(mapping.startOffset, startNodeLength));
              range.setEnd(mapping.endNode, Math.min(mapping.endOffset, endNodeLength));
            } else {
              // Error is within a single text node
              const endPos = mapping.endOffset;
              
              if (endPos > startNodeLength) {
                console.error('Rewordly: Invalid end position in text node', {
                  startOffset: mapping.startOffset,
                  endPos,
                  nodeLength: startNodeLength,
                  globalStart: actualStart,
                  globalEnd: actualEnd
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
            const events = ['beforeinput', 'input', 'textInput'];
            events.forEach(eventType => {
              const event = new Event(eventType, { bubbles: true, cancelable: true });
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
          const updatedErrorsAfterReplace = updatedErrors.map(err => {
            // If error is after the replaced text, adjust its position (keep ID!)
            if (err.start > actualEnd) {
              return {
                ...err,
                start: err.start + lengthDiff,
                end: err.end + lengthDiff
              };
            }
            // If error overlaps with replaced text, it's already removed
            return err;
          });
          this.grammarErrors.set(element, updatedErrorsAfterReplace);
          
          // Update all highlight data-error attributes with new positions - match by ID
          if (this.highlightsContent) {
            const elementId = this.getElementId(element);
            const highlights = this.highlightsContent.querySelectorAll(`[data-element-id="${elementId}"]`);
            highlights.forEach((highlight) => {
              const highlightErrorId = (highlight as HTMLElement).getAttribute('data-error-id');
              if (!highlightErrorId) return;
              
              // Find the updated error by ID
              const updatedError = updatedErrorsAfterReplace.find(err => err.id === highlightErrorId);
              
              if (updatedError) {
                // Update data-error attribute with new positions (ID remains the same)
                (highlight as HTMLElement).setAttribute('data-error', JSON.stringify(updatedError));
              } else {
                // This error was removed
                highlight.remove();
              }
            });
          }
          
          // Update highlight positions after DOM has updated (for proper text wrapping calculation)
          // Use requestAnimationFrame to ensure text wrapping is recalculated after replace
          requestAnimationFrame(() => {
            this.updateHighlightsPosition(element);
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
            const cursorMapping = this.mapInnerTextToTextNodes(element, newCursorPosition, newCursorPosition);
            if (cursorMapping && cursorMapping.startNode) {
              const cursorRange = document.createRange();
              const offset = Math.min(cursorMapping.startOffset, cursorMapping.startNode.textContent!.length);
              cursorRange.setStart(cursorMapping.startNode, offset);
              cursorRange.collapse(true);
              selection.removeAllRanges();
              selection.addRange(cursorRange);
            }
            
            // Clear the replace flag after a short delay to ensure focus is stable
            setTimeout(() => {
              this.isPerformingReplace = false;
              // Trigger grammar check after replace is complete
              this.performGrammarCheck(element).catch(error => {
                console.error('Rewordly: Error performing grammar check after replace:', error);
              });
            }, 150);
          });
        } catch (err) {
          console.error('Rewordly: Error replacing text:', err);
          console.error('Rewordly: Error details:', {
            start: actualStart,
            end: actualEnd,
            mapping
          });
          // Clear flag even on error
          this.isPerformingReplace = false;
        }
      }
      }
    }
  }

  /**
   * Check if a node is still in the document
   * Useful for checking if nodes are valid before using them in ranges
   */
  private isNodeInDocument(node: Node): boolean {
    if (!node) return false;
    
    // Check if node has a parent (connected to document)
    // For document nodes, check if they're the document itself
    if (node.nodeType === Node.DOCUMENT_NODE) {
      return node === document;
    }
    
    // For other nodes, check if they have a parent and are connected to document
    let current: Node | null = node;
    while (current && current !== document) {
      if (current.parentNode === null) {
        return false;
      }
      current = current.parentNode;
    }
    
    return current === document;
  }

  /**
   * Replace text in Draft.js editor (Twitter)
   * Uses execCommand for reliable text replacement that Draft.js recognizes
   */
  private replaceTextInDraftJS(element: HTMLElement, start: number, end: number, replacement: string): boolean {
    const selection = window.getSelection();
    if (!selection) {
      console.error('Rewordly: No selection available for Draft.js replacement');
      return false;
    }
    
    // Focus the element first to ensure Draft.js is ready
    element.focus();
    
    // Helper function to attempt replacement with retry
    const attemptReplacement = (retryCount: number = 0): boolean => {
      const maxRetries = 5;
      
      try {
        // Map innerText positions to text node positions
        const mapping = this.mapInnerTextToTextNodes(element, start, end);
        
        if (!mapping || !mapping.startNode) {
          if (retryCount < maxRetries) {
            // Wait a bit and retry - Draft.js DOM might be updating
            setTimeout(() => attemptReplacement(retryCount + 1), 100 * (retryCount + 1));
            return false;
          }
          console.error('Rewordly: Could not map innerText positions to text nodes in Draft.js', { start, end, retryCount });
          return false;
        }
        
        // Validate nodes are in document
        if (!this.isNodeInDocument(mapping.startNode) || 
            (mapping.endNode && !this.isNodeInDocument(mapping.endNode))) {
          if (retryCount < maxRetries) {
            setTimeout(() => attemptReplacement(retryCount + 1), 100 * (retryCount + 1));
            return false;
          }
          console.warn('Rewordly: Text nodes are not in document anymore (Draft.js DOM changed)', { retryCount });
          return false;
        }
        
        // Create range for selection
        const range = document.createRange();
        
        if (mapping.endNode && mapping.startNode !== mapping.endNode) {
          // Error spans multiple text nodes
          const startNodeLength = mapping.startNode.textContent!.length;
          const endNodeLength = mapping.endNode.textContent!.length;
          
          range.setStart(mapping.startNode, Math.min(mapping.startOffset, startNodeLength));
          range.setEnd(mapping.endNode, Math.min(mapping.endOffset, endNodeLength));
        } else {
          // Error is within a single text node
          const startNodeLength = mapping.startNode.textContent!.length;
          const endPos = Math.min(mapping.endOffset, startNodeLength);
          
          range.setStart(mapping.startNode, Math.min(mapping.startOffset, startNodeLength));
          range.setEnd(mapping.startNode, endPos);
        }
        
        // Set selection to the range
        try {
          selection.removeAllRanges();
          selection.addRange(range);
        } catch (e) {
          if (retryCount < maxRetries) {
            setTimeout(() => attemptReplacement(retryCount + 1), 100 * (retryCount + 1));
            return false;
          }
          console.error('Rewordly: Could not set selection in Draft.js', e);
          return false;
        }
        
        // Use execCommand('insertText') - this is the most reliable way for Draft.js
        // Draft.js listens to execCommand and updates its internal state correctly
        const success = document.execCommand('insertText', false, replacement);
        
        if (!success) {
          // Fallback: manual DOM manipulation with proper events
          console.warn('Rewordly: execCommand failed, using fallback method');
          
          // Delete selected content
          try {
            range.deleteContents();
          } catch (e) {
            if (retryCount < maxRetries) {
              setTimeout(() => attemptReplacement(retryCount + 1), 100 * (retryCount + 1));
              return false;
            }
            console.error('Rewordly: Could not delete contents in Draft.js', e);
            return false;
          }
          
          // Insert replacement text
          const textNode = document.createTextNode(replacement);
          try {
            range.insertNode(textNode);
            
            // Move cursor after inserted text
            range.setStartAfter(textNode);
            range.collapse(true);
            selection.removeAllRanges();
            selection.addRange(range);
          } catch (e) {
            console.warn('Rewordly: Could not position cursor after insertion', e);
          }
          
          // Trigger beforeinput event (Draft.js listens to this)
          const beforeInputEvent = new InputEvent('beforeinput', {
            bubbles: true,
            cancelable: true,
            inputType: 'insertText',
            data: replacement
          });
          (beforeInputEvent as any).__rewordlyProgrammatic = true;
          element.dispatchEvent(beforeInputEvent);
          
          // Trigger input event (Draft.js uses this to update state)
          const inputEvent = new InputEvent('input', {
            bubbles: true,
            cancelable: false,
            inputType: 'insertText',
            data: replacement
          });
          (inputEvent as any).__rewordlyProgrammatic = true;
          element.dispatchEvent(inputEvent);
        }
        
        return true; // Success
      } catch (err) {
        if (retryCount < maxRetries) {
          setTimeout(() => attemptReplacement(retryCount + 1), 100 * (retryCount + 1));
          return false;
        }
        console.error('Rewordly: Error replacing text in Draft.js:', err);
        console.error('Rewordly: Error details:', { start, end, retryCount });
        return false;
      }
    };
    
    // Start the replacement attempt
    return attemptReplacement(0);
  }

  /**
   * Replace text in Lexical editor (Reddit)
   * Uses execCommand to ensure Lexical's internal state is properly updated
   */
  private replaceTextInContentEditable(
    element: HTMLElement, 
    start: number, 
    end: number, 
    replacement: string, 
    useExecCommand: boolean = false
  ): void {
    const selection = window.getSelection();
    if (!selection) {
      console.error('Rewordly: No selection available for Lexical replacement');
      return;
    }
    
    // Map innerText positions to text node positions
    const mapping = this.mapInnerTextToTextNodes(element, start, end);
    
    if (!mapping || !mapping.startNode) {
      console.error('Rewordly: Could not map innerText positions to text nodes in Lexical', { start, end });
      return;
    }
    
    try {
      // Focus the element first to ensure Lexical is ready
      element.focus();
      
      // Create range for the text to replace
      const range = document.createRange();
      
      // Validate positions
      const startNodeLength = mapping.startNode.textContent!.length;
      if (mapping.startOffset < 0 || mapping.startOffset > startNodeLength) {
        console.error('Rewordly: Invalid start offset in Lexical text node', {
          startOffset: mapping.startOffset,
          nodeLength: startNodeLength,
          globalStart: start
        });
        return;
      }
      
      if (mapping.endNode && mapping.startNode !== mapping.endNode) {
        // Error spans multiple text nodes
        const endNodeLength = mapping.endNode.textContent!.length;
        if (mapping.endOffset < 0 || mapping.endOffset > endNodeLength) {
          console.error('Rewordly: Invalid end offset in Lexical text node', {
            endOffset: mapping.endOffset,
            nodeLength: endNodeLength,
            globalEnd: end
          });
          return;
        }
        
        range.setStart(mapping.startNode, Math.min(mapping.startOffset, startNodeLength));
        range.setEnd(mapping.endNode, Math.min(mapping.endOffset, endNodeLength));
      } else {
        // Error is within a single text node
        const endPos = mapping.endOffset;
        
        if (endPos > startNodeLength) {
          console.error('Rewordly: Invalid end position in Lexical text node', {
            startOffset: mapping.startOffset,
            endPos,
            nodeLength: startNodeLength,
            globalStart: start,
            globalEnd: end
          });
          return;
        }
        
        range.setStart(mapping.startNode, mapping.startOffset);
        range.setEnd(mapping.startNode, endPos);
      }
      
      // Set selection to the range
      selection.removeAllRanges();
      selection.addRange(range);
      
      if (useExecCommand) {
        // Use execCommand to replace text - this ensures Lexical's internal state is updated correctly
        // Lexical listens to execCommand and updates its internal state accordingly
        const success = document.execCommand('insertText', false, replacement);
        
        if (!success) {
          // Fallback: try using beforeinput/input events
          console.warn('Rewordly: execCommand failed, trying fallback method');
          
          // Delete the selected content first
          range.deleteContents();
          
          // Insert the replacement text
          const textNode = document.createTextNode(replacement);
          range.insertNode(textNode);
          
          // Move cursor after the inserted text
          range.setStartAfter(textNode);
          range.collapse(true);
          selection.removeAllRanges();
          selection.addRange(range);
          
          // Trigger input events to notify editor
          const beforeInputEvent = new InputEvent('beforeinput', {
            bubbles: true,
            cancelable: true,
            inputType: 'insertText',
            data: replacement
          });
          (beforeInputEvent as any).__rewordlyProgrammatic = true;
          element.dispatchEvent(beforeInputEvent);
          
          const inputEvent = new InputEvent('input', {
            bubbles: true,
            cancelable: false,
            inputType: 'insertText',
            data: replacement
          });
          (inputEvent as any).__rewordlyProgrammatic = true;
          element.dispatchEvent(inputEvent);
        }
      } else {
        // Standard replacement for simple contenteditable (Gmail, etc.)
        range.deleteContents();
        range.insertNode(document.createTextNode(replacement));
        
        // Normalize to merge adjacent text nodes
        element.normalize();
        
        // Move cursor to end of replacement
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      
      // Clear selection
      selection.removeAllRanges();
      
    } catch (err) {
      console.error('Rewordly: Error replacing text in Lexical:', err);
      console.error('Rewordly: Error details:', {
        start,
        end,
        mapping
      });
    }
  }

  private setupContentObserver(): void {
    // Create a MutationObserver to watch for dynamically loaded content
    this.observer = new MutationObserver((mutations) => {
      let shouldReattach = false;
      
      mutations.forEach((mutation) => {
        if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
          // Check if new text nodes or elements were added
          mutation.addedNodes.forEach((node) => {
            if (node.nodeType === Node.TEXT_NODE || 
                (node.nodeType === Node.ELEMENT_NODE && 
                 (node as Element).textContent && 
                 (node as Element).textContent!.trim().length > 0)) {
              shouldReattach = true;
            }
          });
        }
      });
      
      // If new content was added, reattach event listeners
      if (shouldReattach) {
        this.setupEventListeners();
      }
    });
    
    // Start observing the document body for changes
    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  private setupMessageListener(): void {
    // Listen for messages from popup/background script
    chrome.runtime.onMessage.addListener((request) => {
      if (request.type === 'SETTINGS_UPDATED') {
        // Reload config when settings are updated
        this.loadConfig().then(() => {
          
          // Hide button if rewrite is disabled
          if (!this.config.rewriteEnabled) {
            this.hideFloatingButton();
          }
          
          // Hide all highlights if highlights are disabled
          if (!this.config.highlightsEnabled) {
            this.hideAllGrammarHighlights();
          }
        });
      } else if (request.type === 'CONTEXT_MENU_CLICKED') {
        // Handle context menu clicks - open modal and process text
        const selectedText = request.selectedText || '';
        
        if (!selectedText || selectedText.trim().length < 3) {
          console.warn('Rewordly: Selected text is too short');
          return;
        }
        
        if (request.action === 'rewrite') {
          this.handleContextMenuRewrite(selectedText);
        } else if (request.action === 'grammar') {
          this.handleContextMenuGrammar(selectedText);
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
    const allHighlights = this.highlightsContent.querySelectorAll('[data-element-id]');
    allHighlights.forEach(highlight => {
      (highlight as HTMLElement).style.display = 'none';
    });
  }

  // Text selection handlers removed - button only shows on editable element focus
  // No longer needed since we only show button for editable elements

  private handleOutsideClick(event: Event): void {
    const target = event.target as HTMLElement;
    
    // Hide floating button if clicking outside
    if (this.floatingButton && !this.floatingButton.contains(target)) {
      this.hideFloatingButton();
    }
    
    // Hide modal if clicking outside or on the backdrop
    if (this.modal && this.isModalOpen) {
      // Check if click is on the modal backdrop (the modal element itself, not its content)
      if (target === this.modal || (!this.modal.contains(target) && !this.floatingButton?.contains(target))) {
        this.hideModal();
      }
    }
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      this.hideModal();
      this.hideFloatingButton();
    }
  }

  private createFloatingButton(): void {
    this.floatingButton = document.createElement('div');
    this.floatingButton.className = 'rewordly-floating-button-container';
    this.floatingButton.innerHTML = `
      <button class="rewordly-ai-btn">
        <svg xmlns="http://www.w3.org/2000/svg" fill="currentColor" viewBox="0 0 56 56" width="16" height="16">
          <path d="M 26.6875 12.6602 C 26.9687 12.6602 27.1094 12.4961 27.1797 12.2383 C 27.9062 8.3242 27.8594 8.2305 31.9375 7.4570 C 32.2187 7.4102 32.3828 7.2461 32.3828 6.9648 C 32.3828 6.6836 32.2187 6.5195 31.9375 6.4726 C 27.8828 5.6524 28.0000 5.5586 27.1797 1.6914 C 27.1094 1.4336 26.9687 1.2695 26.6875 1.2695 C 26.4062 1.2695 26.2656 1.4336 26.1953 1.6914 C 25.3750 5.5586 25.5156 5.6524 21.4375 6.4726 C 21.1797 6.5195 20.9922 6.6836 20.9922 6.9648 C 20.9922 7.2461 21.1797 7.4102 21.4375 7.4570 C 25.5156 8.2774 25.4687 8.3242 26.1953 12.2383 C 26.2656 12.4961 26.4062 12.6602 26.6875 12.6602 Z M 15.3438 28.7852 C 15.7891 28.7852 16.0938 28.5039 16.1406 28.0821 C 16.9844 21.8242 17.1953 21.8242 23.6641 20.5821 C 24.0860 20.5117 24.3906 20.2305 24.3906 19.7852 C 24.3906 19.3633 24.0860 19.0586 23.6641 18.9883 C 17.1953 18.0977 16.9609 17.8867 16.1406 11.5117 C 16.0938 11.0899 15.7891 10.7852 15.3438 10.7852 C 14.9219 10.7852 14.6172 11.0899 14.5703 11.5352 C 13.7969 17.8164 13.4687 17.7930 7.0469 18.9883 C 6.6250 19.0821 6.3203 19.3633 6.3203 19.7852 C 6.3203 20.2539 6.6250 20.5117 7.1406 20.5821 C 13.5156 21.6133 13.7969 21.7774 14.5703 28.0352 C 14.6172 28.5039 14.9219 28.7852 15.3438 28.7852 Z M 31.2344 54.7305 C 31.8438 54.7305 32.2891 54.2852 32.4062 53.6524 C 34.0703 40.8086 35.8750 38.8633 48.5781 37.4570 C 49.2344 37.3867 49.6797 36.8945 49.6797 36.2852 C 49.6797 35.6758 49.2344 35.2070 48.5781 35.1133 C 35.8750 33.7070 34.0703 31.7617 32.4062 18.9180 C 32.2891 18.2852 31.8438 17.8633 31.2344 17.8633 C 30.6250 17.8633 30.1797 18.2852 30.0860 18.9180 C 28.4219 31.7617 26.5938 33.7070 13.9140 35.1133 C 13.2344 35.2070 12.7891 35.6758 12.7891 36.2852 C 12.7891 36.8945 13.2344 37.3867 13.9140 37.4570 C 26.5703 39.1211 28.3281 40.8321 30.0860 53.6524 C 30.1797 54.2852 30.6250 54.7305 31.2344 54.7305 Z"/>
        </svg>
      </button>
    `;
    
    // Create tooltip element
    const tooltip = document.createElement('span');
    tooltip.className = 'rewordly-ai-tooltip';
    tooltip.textContent = 'AI Rewrite';
    document.body.appendChild(tooltip);
    
    const aiBtn = this.floatingButton.querySelector('.rewordly-ai-btn') as HTMLButtonElement;
    
    // Handle click - always trigger rewrite
    // Use mousedown to prevent blur from hiding button before click
    aiBtn.addEventListener('mousedown', (e) => {
      e.preventDefault(); // Prevent blur
      e.stopPropagation();
    });
    
    aiBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.handleRewriteClick();
    });
    
    // Tooltip functionality
    const showTooltip = () => {
      const rect = aiBtn.getBoundingClientRect();
      const tooltipLeft = rect.left + (rect.width / 2);
      const tooltipTop = rect.top - 5;
      tooltip.style.left = `${tooltipLeft}px`;
      tooltip.style.top = `${tooltipTop}px`;
      tooltip.classList.add('show');
    };
    
    const hideTooltip = () => {
      tooltip.classList.remove('show');
    };
    
    aiBtn.addEventListener('mouseenter', showTooltip);
    aiBtn.addEventListener('mouseleave', hideTooltip);
    
    // Update tooltip position on scroll/resize
    const updateTooltipPosition = () => {
      if (tooltip.classList.contains('show')) {
        const rect = aiBtn.getBoundingClientRect();
        const tooltipLeft = rect.left + (rect.width / 2);
        const tooltipTop = rect.top - 5;
        tooltip.style.left = `${tooltipLeft}px`;
        tooltip.style.top = `${tooltipTop}px`;
      }
    };
    
    window.addEventListener('scroll', updateTooltipPosition, true);
    window.addEventListener('resize', updateTooltipPosition);
    
    document.body.appendChild(this.floatingButton);
  }

  private createModal(): void {
    this.modal = document.createElement('div');
    this.modal.className = 'rewordly-modal';
    this.modal.innerHTML = `
      <div class="rewordly-modal-content">
        <div class="rewordly-modal-header">
          <h3 class="rewordly-modal-title">Rewordly</h3>
          <button class="rewordly-close-btn">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none">
              <path d="M7 17L16.8995 7.10051" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>
              <path d="M7 7.00001L16.8995 16.8995" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
        </div>
        <div class="rewordly-modal-body">
          <div class="rewordly-original">
            <h4>Original Text:</h4>
            <p class="rewordly-original-text"></p>
          </div>
          <div class="rewordly-rewritten">
            <h4 class="rewordly-result-title">Rewritten Text:</h4>
            <div class="rewordly-loading" style="display: none;">
              <div class="rewordly-spinner"></div>
              <p class="rewordly-loading-text">Processing...</p>
            </div>
            <p class="rewordly-rewritten-text"></p>
          </div>
        </div>
        <div class="rewordly-modal-footer">
          <button class="rewordly-copy-btn">Copy</button>
          <!-- <button class="rewordly-replace-btn">Replace</button> -->
        </div>
      </div>
    `;
    
    // Add event listeners
    const closeBtn = this.modal.querySelector('.rewordly-close-btn') as HTMLButtonElement;
    const copyBtn = this.modal.querySelector('.rewordly-copy-btn') as HTMLButtonElement;
    
    closeBtn.addEventListener('click', this.hideModal.bind(this));
    copyBtn.addEventListener('click', this.copyRewrittenText.bind(this));
    
    // Add click handler to modal backdrop to close when clicking outside content
    this.modal.addEventListener('click', (event) => {
      // Only close if clicking on the backdrop itself, not on the content
      if (event.target === this.modal) {
        this.hideModal();
      }
    });
    
    document.body.appendChild(this.modal);
  }

  /**
   * Check if element is single-line (approximately)
   * Uses multiple heuristics for reliable detection across different platforms
   */
  private isSingleLineElement(element: HTMLElement): boolean {
    const computedStyle = window.getComputedStyle(element);
    const elementRect = element.getBoundingClientRect();
    
    // Get line-height (can be 'normal', number, or pixel value)
    let lineHeight: number;
    const lineHeightValue = computedStyle.lineHeight;
    
    if (lineHeightValue === 'normal') {
      // Normal line-height is typically 1.2-1.5x font-size
      const fontSize = parseFloat(computedStyle.fontSize) || 16;
      lineHeight = fontSize * 1.2; // Conservative estimate
    } else if (lineHeightValue.includes('px')) {
      lineHeight = parseFloat(lineHeightValue);
    } else {
      // Relative value (e.g., 1.5)
      const fontSize = parseFloat(computedStyle.fontSize) || 16;
      lineHeight = parseFloat(lineHeightValue) * fontSize;
    }
    
    // Get actual content height
    const clientHeight = element.clientHeight;
    const scrollHeight = element.scrollHeight;
    
    // Heuristic 1: If element height is close to line-height (within 1.5x), likely single line
    // Account for padding
    const paddingTop = parseFloat(computedStyle.paddingTop) || 0;
    const paddingBottom = parseFloat(computedStyle.paddingBottom) || 0;
    const contentHeight = clientHeight - paddingTop - paddingBottom;
    
    // Heuristic 2: If scrollHeight equals clientHeight, no vertical scrolling (likely single line)
    const hasNoVerticalScroll = Math.abs(scrollHeight - clientHeight) < 2;
    
    // Heuristic 3: If content height is less than 1.8x line-height, likely single line
    // Using 1.8x to account for various font sizes and padding
    const isHeightCloseToLineHeight = contentHeight <= lineHeight * 1.8;
    
    // Heuristic 4: For very small elements (e.g., input fields), if height < 60px, likely single line
    const isSmallElement = elementRect.height < 60;
    
    // Combine heuristics: element is single-line if:
    // - Height is close to line-height AND no vertical scroll, OR
    // - Very small element with no vertical scroll
    return (isHeightCloseToLineHeight && hasNoVerticalScroll) || (isSmallElement && hasNoVerticalScroll);
  }

  /**
   * Show AI floating button at bottom-right of editable element
   * For single-line elements, positions button at right-center (vertically aligned)
   * For multi-line elements, positions button at bottom-right
   */
  private showAIFloatingButton(element: HTMLElement): void {
    if (!this.floatingButton || !this.config.rewriteEnabled) {
      return;
    }

    // Only show rewrite button on sites where grammar check is enabled
    if (!this.isGrammarCheckAllowedSite() || !this.config.highlightsEnabled) {
      return;
    }

    const hostname = window.location.hostname.toLowerCase();
    const isMedium = hostname.includes('medium.com');
    
    let elementRect: DOMRect;
    
    // Medium-specific positioning: position relative to actual content area
    if (isMedium) {
      // Try to find .section-inner - it could be a parent (closest) or child (querySelector)
      let sectionInner = element.closest('.section-inner') || element.querySelector('.section-inner');
      
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
    const isSingleLine = this.isSingleLineElement(element);
    
    let buttonX: number;
    let buttonY: number;
    
    if (isSingleLine) {
      // For single-line elements: position at right-center (vertically aligned)
      buttonX = elementRect.right - buttonSize - offset;
      // Center vertically within the element
      buttonY = elementRect.top + (elementRect.height / 2) - (buttonSize / 2);
    } else {
      // For multi-line elements: position at bottom-right (existing behavior)
      buttonX = elementRect.right - buttonSize - offset;
      buttonY = elementRect.bottom - buttonSize - offset;
    }
    
    // Keep within viewport bounds
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    
    // Horizontal bounds check
    if (buttonX < 0) {
      buttonX = elementRect.left + offset;
    }
    if (buttonX + buttonSize > viewportWidth) {
      buttonX = viewportWidth - buttonSize - offset;
    }
    
    // Vertical bounds check
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
    
    // Ensure button is visible
    this.floatingButton.style.display = 'flex';
    this.floatingButton.style.visibility = 'visible';
    this.floatingButton.style.opacity = '1';
    this.floatingButton.style.left = `${buttonX}px`;
    this.floatingButton.style.top = `${buttonY}px`;
    this.floatingButton.classList.add('show');
    
    // Cancel any pending button blur timeout to prevent button from hiding
    if (this.buttonBlurTimeout !== null) {
      clearTimeout(this.buttonBlurTimeout);
      this.buttonBlurTimeout = null;
    }
    
    // Store reference to current element for rewrite functionality
    (this.floatingButton as any).__currentElement = element;
  }

  // @ts-ignore - Legacy function, no longer used (only showAIFloatingButton is used)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private showFloatingButton(): void {
    if (!this.floatingButton) {
      return;
    }

    // Special handling for input/textarea elements - window.getSelection/range
    // is unreliable for these, so we use their native selection APIs instead.
    const activeElement = document.activeElement as (HTMLInputElement | HTMLTextAreaElement | null);
    if (
      activeElement &&
      (activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement) &&
      activeElement.selectionStart !== null &&
      activeElement.selectionEnd !== null &&
      activeElement.selectionEnd > activeElement.selectionStart
    ) {
      const caretRect = this.getInputTextareaSelectionRect(activeElement);

      if (!caretRect) {
        return;
      }

      // Get viewport dimensions
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const containerWidth = 120; // Approximate width for single combined button
      const containerHeight = 40;

      // Position button to the right of the caret
      let buttonX = caretRect.right + 10;
      let buttonY = caretRect.top - 10;

      // Keep within viewport bounds (same logic as below)
      if (buttonX + containerWidth > viewportWidth) {
        buttonX = caretRect.left - containerWidth - 10;
      }

      if (buttonX < 0) {
        buttonX = 10;
      }

      if (buttonY < 0) {
        buttonY = caretRect.bottom + 10;
      }

      if (buttonY + containerHeight > viewportHeight) {
        buttonY = caretRect.top - containerHeight - 10;
      }

      buttonX = Math.max(10, Math.min(buttonX, viewportWidth - containerWidth - 10));
      buttonY = Math.max(10, Math.min(buttonY, viewportHeight - containerHeight - 10));

      this.floatingButton.style.left = `${buttonX}px`;
      this.floatingButton.style.top = `${buttonY}px`;
      this.floatingButton.classList.add('show');
      return;
    }

    const selection = window.getSelection();
    
    if (!selection || selection.rangeCount === 0) {
      return;
    }
    
    const range = selection.getRangeAt(0);
    let rect: DOMRect | null = null;
    
    // Method 1: Try getClientRects() - most reliable for multi-line selections
    // Use the last rect which represents the end of the selection
    try {
      const clientRects = range.getClientRects();
      if (clientRects && clientRects.length > 0) {
        // Use the last rect (end of selection)
        const lastRect = clientRects[clientRects.length - 1];
        if (lastRect && lastRect.width > 0 && lastRect.height > 0) {
          rect = lastRect;
        }
      }
    } catch (e) {
    }
    
    // Method 2: Fallback to getBoundingClientRect() on the range
    if (!rect || rect.width === 0 || rect.height === 0) {
      try {
        const rangeRect = range.getBoundingClientRect();
        if (rangeRect && rangeRect.width > 0 && rangeRect.height > 0) {
          rect = rangeRect;
        }
      } catch (e) {
      }
    }
    
    // Method 3: For input/textarea elements, calculate caret position
    if (!rect || rect.width === 0 || rect.height === 0) {
      const focusNode = selection.focusNode;
      if (focusNode) {
        let element: HTMLElement | null = null;
        
        if (focusNode.nodeType === Node.TEXT_NODE) {
          element = focusNode.parentElement;
        } else if (focusNode.nodeType === Node.ELEMENT_NODE) {
          element = focusNode as HTMLElement;
        }
        
        if (element && (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
          try {
            const elementRect = element.getBoundingClientRect();
            const selectionEnd = element.selectionEnd || 0;
            
            if (elementRect && elementRect.width > 0 && elementRect.height > 0 && selectionEnd > 0) {
              const styles = window.getComputedStyle(element);
              const isInput = element instanceof HTMLInputElement;
              
              // Create a mirror div to replicate the element's text rendering
              const div = document.createElement('div');
              const style = div.style;
              
              // Copy all relevant styles
              const properties = [
                'direction', 'boxSizing', 'width', 'height', 'overflowX', 'overflowY',
                'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderStyle',
                'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
                'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize', 'fontSizeAdjust', 'lineHeight', 'fontFamily',
                'textAlign', 'textTransform', 'textIndent', 'textDecoration', 'letterSpacing', 'wordSpacing',
                'tabSize', 'MozTabSize'
              ];
              
              properties.forEach(prop => {
                // @ts-ignore
                style[prop] = styles[prop];
              });
              
              // Specific overrides to ensure correct measurement
              style.whiteSpace = isInput ? 'pre' : 'pre-wrap';
              if (!isInput) {
                style.wordWrap = 'break-word'; 
              }
              
              // Position off-screen but maintain layout context
              style.position = 'absolute';
              style.visibility = 'hidden';
              style.top = '0px';
              style.left = '0px';
              
              // Add the text content up to the cursor
              const textContent = element.value.substring(0, selectionEnd);
              div.textContent = textContent;
              
              // Add a marker span to get the caret position
              const span = document.createElement('span');
              span.textContent = '|';
              div.appendChild(span);
              
              document.body.appendChild(div);
              
              // Calculate position
              // const spanRect = span.getBoundingClientRect();
              // const divRect = div.getBoundingClientRect();
              
              // Caret position relative to the div (which mimics the element)
              // This includes padding/border effects from the mirror div
              const relativeX = span.offsetLeft;
              const relativeY = span.offsetTop;
              
              // Adjust for element's scroll
              const scrollLeft = element.scrollLeft;
              const scrollTop = element.scrollTop;
              
              // Calculate final viewport coordinates
              // We need to add the element's viewport position
              // And subtract the scroll of the element itself
              
              // Note: span.offsetLeft is relative to the div's content edge + padding?
              // Actually, if we copy styling, the div has the same border/padding.
              // The span is appended.
              
              // Let's calculate absolute position
              const caretX = elementRect.left + relativeX - scrollLeft;
              
              // For Y, we align with the line height or span height
              const caretY = elementRect.top + relativeY - scrollTop;
              const lineHeight = span.offsetHeight;
              
              // Final rect
              rect = {
                left: elementRect.left,
                top: caretY,
                right: caretX,
                bottom: caretY + lineHeight,
                width: 0,
                height: lineHeight,
                x: elementRect.left,
                y: caretY,
                toJSON: () => ({})
              } as DOMRect;
              
              document.body.removeChild(div);
            } else {
              rect = elementRect;
            }
          } catch (e) {
          }
        }
      }
    }
    
    // Method 4: Last resort - try to get position from common ancestor
    if (!rect || rect.width === 0 || rect.height === 0) {
      try {
        const commonAncestor = range.commonAncestorContainer;
        let element: HTMLElement | null = null;
        
        if (commonAncestor.nodeType === Node.TEXT_NODE) {
          element = commonAncestor.parentElement;
        } else if (commonAncestor.nodeType === Node.ELEMENT_NODE) {
          element = commonAncestor as HTMLElement;
        }
        
        if (element) {
          const elementRect = element.getBoundingClientRect();
          if (elementRect && elementRect.width > 0 && elementRect.height > 0) {
            rect = elementRect;
          }
        }
      } catch (e) {
      }
    }
    
    // If we still don't have a valid rect, don't show the button
    if (!rect || rect.width === 0 || rect.height === 0) {
      return;
    }
    
    // Get viewport dimensions
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const containerWidth = 120; // Approximate width for single combined button
    const containerHeight = 40;
    
    // Calculate position to the right of the selected text (end of selection)
    let buttonX = rect.right + 10;
    let buttonY = rect.top - 10;
    
    // If container would go off the right edge, position it to the left of the selection
    if (buttonX + containerWidth > viewportWidth) {
      buttonX = rect.left - containerWidth - 10;
    }
    
    // If container would go off the left edge, position it at the left edge
    if (buttonX < 0) {
      buttonX = 10;
    }
    
    // If container would go off the top edge, position it below the selection
    if (buttonY < 0) {
      buttonY = rect.bottom + 10;
    }
    
    // If container would go off the bottom edge, position it above the selection
    if (buttonY + containerHeight > viewportHeight) {
      buttonY = rect.top - containerHeight - 10;
    }
    
    // Ensure button is always visible (final safety check)
    buttonX = Math.max(10, Math.min(buttonX, viewportWidth - containerWidth - 10));
    buttonY = Math.max(10, Math.min(buttonY, viewportHeight - containerHeight - 10));
    
    // Set the container position
    this.floatingButton.style.left = `${buttonX}px`;
    this.floatingButton.style.top = `${buttonY}px`;
    this.floatingButton.classList.add('show');
  }

  /**
   * Hide floating button
   * Only hides if currentFocusedElement is not set or element doesn't have focus
   */
  private hideFloatingButton(): void {
    if (this.floatingButton) {
      // Don't hide button if there's a current focused element that still has focus
      if (this.currentFocusedElement && 
          document.activeElement === this.currentFocusedElement) {
        // Element still has focus, don't hide button
        return;
      }
      
      // Hide button
      this.floatingButton.classList.remove('show');
    }
  }

  private getInputTextareaSelectionRect(
    el: HTMLInputElement | HTMLTextAreaElement
  ): DOMRect | null {
    const end = el.selectionEnd;
    if (end === null) return null;

    const value = el.value.substring(0, end);
    const elRect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);

    // Mirror element
    const div = document.createElement('div');
    const divStyle = div.style;

    // Typography + spacing
    divStyle.position = 'absolute';
    divStyle.visibility = 'hidden';
    divStyle.whiteSpace = el instanceof HTMLInputElement ? 'pre' : 'pre-wrap';
    divStyle.fontFamily = style.fontFamily;
    divStyle.fontSize = style.fontSize;
    divStyle.fontWeight = style.fontWeight;
    divStyle.fontStyle = style.fontStyle;
    divStyle.letterSpacing = style.letterSpacing;
    divStyle.lineHeight = style.lineHeight;
    divStyle.textTransform = style.textTransform;

    // Box model
    divStyle.padding = style.padding;
    divStyle.border = style.border;
    divStyle.boxSizing = style.boxSizing;
    divStyle.width = style.width; // Important for textarea wrapping

    // Copy content
    div.textContent = value;

    // Marker to measure caret
    const span = document.createElement('span');
    span.textContent = '▌';
    div.appendChild(span);

    document.body.appendChild(div);

    // Get positions - use offsetLeft/offsetTop for more accurate measurement
    const spanRect = span.getBoundingClientRect();

    // Caret position relative to the div (which mirrors the element)
    // offsetLeft/offsetTop give position relative to offsetParent
    const relX = span.offsetLeft;
    const relY = span.offsetTop;

    // Account for input/textarea scroll
    const scrollLeft = el.scrollLeft || 0;
    const scrollTop = el.scrollTop || 0;

    // Get padding and border to adjust position correctly
    const paddingLeft = parseFloat(style.paddingLeft) || 0;
    const borderLeft = parseFloat(style.borderLeftWidth) || 0;
    const paddingTop = parseFloat(style.paddingTop) || 0;
    const borderTop = parseFloat(style.borderTopWidth) || 0;

    // Calculate final caret position
    // Element position + padding + border + relative caret position - scroll
    const caretX = elRect.left + paddingLeft + borderLeft + relX - scrollLeft;
    const caretY = elRect.top + paddingTop + borderTop + relY - scrollTop;
    const caretHeight = spanRect.height || parseFloat(style.lineHeight) || elRect.height;

    document.body.removeChild(div);

    return new DOMRect(
      caretX,
      caretY,
      0,              // width doesn't matter, we offset button ourselves
      caretHeight
    );
  }

  private async handleRewriteClick(): Promise<void> {
    if (this.isProcessing) {
      return;
    }

    // Get text from current editable element
    let textToRewrite = '';
    const currentElement = (this.floatingButton as any)?.__currentElement as HTMLElement | undefined;
    
    if (currentElement) {
      if (currentElement instanceof HTMLInputElement || currentElement instanceof HTMLTextAreaElement) {
        textToRewrite = currentElement.value;
      } else if (currentElement.getAttribute('contenteditable') === 'true' || currentElement.isContentEditable) {
        textToRewrite = currentElement.innerText || currentElement.textContent || '';
      }
    } else {
      // Fallback to selectedText if no element
      textToRewrite = this.selectedText;
    }

    if (!textToRewrite || textToRewrite.trim().length < 3) {
      return;
    }

    this.currentOperation = 'rewrite';
    this.selectedText = textToRewrite;
    // Don't hide button immediately - let blur handle it if needed
    this.showModal();
    this.isProcessing = true;

    try {
      const rewrittenText = await this.rewriteText(textToRewrite);
      this.displayRewrittenText(rewrittenText);
    } catch (error) {
      console.error('Rewordly: Error rewriting text:', error);
      this.showError('Failed to rewrite text. Please try again.');
    } finally {
      this.isProcessing = false;
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

    this.currentOperation = 'rewrite';
    this.selectedText = selectedText;
    this.showModal();
    this.isProcessing = true;

    try {
      const rewrittenText = await this.rewriteText(selectedText);
      this.displayRewrittenText(rewrittenText);
    } catch (error) {
      console.error('Rewordly: Error rewriting text:', error);
      this.showError('Failed to rewrite text. Please try again.');
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Handle grammar check action from context menu
   */
  private async handleContextMenuGrammar(selectedText: string): Promise<void> {
    if (!selectedText || selectedText.trim().length < 3) {
      return;
    }

    this.currentOperation = 'grammar';
    this.selectedText = selectedText;
    this.showModal();
    this.isProcessing = true;

    try {
      const correctedText = await this.grammarText(selectedText);
      this.displayRewrittenText(correctedText);
    } catch (error) {
      console.error('Rewordly: Error checking grammar:', error);
      this.showError('Failed to check grammar. Please try again.');
    } finally {
      this.isProcessing = false;
    }
  }

  private async rewriteText(text: string): Promise<string> {
    const response = await fetch('https://rewordly-web.vercel.app/api/rewrite', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text: text
      })
    });

    if (!response.ok) {
      throw new Error(`API request failed: ${response.status}`);
    }

    const data = await response.json();
    return data.rewritten || 'Failed to rewrite text.';
  }

  // @ts-ignore - Kept for compatibility, no longer used
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async grammarText(_text: string): Promise<string> {
    const response = await fetch('https://rewordly-web.vercel.app/api/grammar', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text: _text,
        mode: "ai"
      })
    });

    if (!response.ok) {
      throw new Error(`API request failed: ${response.status}`);
    }

    const data = await response.json();
    return data.corrected || 'Failed to fix grammar.';
  }

  private showModal(): void {
    if (!this.modal) return;

    const originalText = this.modal.querySelector('.rewordly-original-text') as HTMLParagraphElement;
    const rewrittenText = this.modal.querySelector('.rewordly-rewritten-text') as HTMLParagraphElement;
    const loading = this.modal.querySelector('.rewordly-loading') as HTMLDivElement;
    const modalTitle = this.modal.querySelector('.rewordly-modal-title') as HTMLHeadingElement;
    const resultTitle = this.modal.querySelector('.rewordly-result-title') as HTMLHeadingElement;
    const loadingText = this.modal.querySelector('.rewordly-loading-text') as HTMLParagraphElement;

    originalText.textContent = this.selectedText;
    originalText.classList.add('show');
    rewrittenText.textContent = '';
    loading.classList.add('show');
    rewrittenText.classList.remove('show');
    
    // Set titles based on operation
    if (this.currentOperation === 'grammar') {
      modalTitle.textContent = 'Grammar Check';
      resultTitle.textContent = 'Corrected Text:';
      loadingText.textContent = 'Fixing grammar...';
    } else {
      modalTitle.textContent = 'Rewordly';
      resultTitle.textContent = 'Rewritten Text:';
      loadingText.textContent = 'Rewriting...';
    }

    this.modal.classList.add('show');
    this.isModalOpen = true; // Set flag when modal opens
    
    // Hide the floating button when modal is open
    this.hideFloatingButton();
    
    // Hide all grammar error overlays when modal opens
    this.hideAllGrammarOverlays();
  }

  private hideModal(): void {
    if (this.modal) {
      this.modal.classList.remove('show');
      this.isModalOpen = false; // Clear flag when modal closes
      
      // Restore grammar overlays if element still has focus and errors
      this.restoreGrammarOverlays();
    }
  }

  private displayRewrittenText(text: string): void {
    if (!this.modal) return;

    const rewrittenText = this.modal.querySelector('.rewordly-rewritten-text') as HTMLParagraphElement;
    const loading = this.modal.querySelector('.rewordly-loading') as HTMLDivElement;
    const modalTitle = this.modal.querySelector('.rewordly-modal-title') as HTMLHeadingElement;
    const resultTitle = this.modal.querySelector('.rewordly-result-title') as HTMLHeadingElement;
    const loadingText = this.modal.querySelector('.rewordly-loading-text') as HTMLParagraphElement;

    loading.classList.remove('show');
    rewrittenText.textContent = text;
    rewrittenText.classList.add('show');
    
    // Set titles based on operation
    if (this.currentOperation === 'grammar') {
      modalTitle.textContent = 'Grammar Check';
      resultTitle.textContent = 'Corrected Text:';
      loadingText.textContent = 'Fixing grammar...';
    } else {
      modalTitle.textContent = 'Rewordly';
      resultTitle.textContent = 'Rewritten Text:';
      loadingText.textContent = 'Rewriting...';
    }
  }

  private showError(message: string): void {
    if (!this.modal) return;

    const rewrittenText = this.modal.querySelector('.rewordly-rewritten-text') as HTMLParagraphElement;
    const loading = this.modal.querySelector('.rewordly-loading') as HTMLDivElement;
    const modalTitle = this.modal.querySelector('.rewordly-modal-title') as HTMLHeadingElement;
    const resultTitle = this.modal.querySelector('.rewordly-result-title') as HTMLHeadingElement;
    const loadingText = this.modal.querySelector('.rewordly-loading-text') as HTMLParagraphElement;

    loading.classList.remove('show');
    rewrittenText.textContent = `Error: ${message}`;
    rewrittenText.classList.add('show');
    rewrittenText.classList.add('error');
    
    // Set titles based on operation
    if (this.currentOperation === 'grammar') {
      modalTitle.textContent = 'Grammar Check';
      resultTitle.textContent = 'Corrected Text:';
      loadingText.textContent = 'Fixing grammar...';
    } else {
      modalTitle.textContent = 'Rewordly';
      resultTitle.textContent = 'Rewritten Text:';
      loadingText.textContent = 'Rewriting...';
    }
  }

  private copyRewrittenText(): void {
    if (!this.modal) return;

    const rewrittenText = this.modal.querySelector('.rewordly-rewritten-text') as HTMLParagraphElement;
    const text = rewrittenText.textContent;

    if (text && text !== '') {
      // Clean the text by removing quotes from start and end
      const cleanText = text.trim().replace(/^["']|["']$/g, '');
      
      navigator.clipboard.writeText(cleanText).then(() => {
        // Show success feedback
        const copyBtn = this.modal?.querySelector('.rewordly-copy-btn') as HTMLButtonElement;
        if (copyBtn) {
          const originalText = copyBtn.textContent;
          copyBtn.textContent = 'Copied!';
          copyBtn.style.background = '#10b981';
          setTimeout(() => {
            copyBtn.textContent = originalText;
            copyBtn.style.background = '';
          }, 2000);
        }
      }).catch(err => {
        console.error('Failed to copy text:', err);
      });
    }
  }

  // private replaceOriginalText(): void {
  //   if (!this.modal) return;

  //   const rewrittenText = this.modal.querySelector('.rewordly-rewritten-text') as HTMLParagraphElement;
  //   const newText = rewrittenText.textContent;

  //   if (newText && newText !== '' && !newText.startsWith('Error:')) {
  //     // Find the original selection and replace it
  //     const selection = window.getSelection();
  //     if (selection && selection.rangeCount > 0) {
  //       const range = selection.getRangeAt(0);
        
  //       // Create a container for the text and badge
  //       const container = document.createElement('span');
  //       container.style.cssText = `
  //         position: relative;
  //         display: inline-block;
  //         margin: 0 2px;
  //       `;
        
  //       // Create the text node - ensure no quotes
  //       const cleanText = newText.trim().replace(/^["']|["']$/g, ''); // Remove quotes from start/end
  //       const textNode = document.createTextNode(cleanText);
  //       container.appendChild(textNode);
        
  //       // Create a separate badge element
  //       const badge = document.createElement('span');
  //       badge.className = 'rewordly-replace-badge';
  //       badge.textContent = 'Replaced';
  //       badge.style.cssText = `
  //         position: fixed;
  //         top: ${range.getBoundingClientRect().top - 20}px;
  //         left: ${range.getBoundingClientRect().right + 5}px;
  //         background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  //         color: white;
  //         font-size: 10px;
  //         font-weight: 600;
  //         padding: 2px 6px;
  //         border-radius: 10px;
  //         box-shadow: 0 2px 4px rgba(102, 126, 234, 0.3);
  //         opacity: 0;
  //         transform: scale(0.8);
  //         transition: all 0.3s ease;
  //         z-index: 10000;
  //         white-space: nowrap;
  //         pointer-events: none;
  //         user-select: none;
  //         -webkit-user-select: none;
  //         -moz-user-select: none;
  //         -ms-user-select: none;
  //       `;
        
  //       // Add badge to body
  //       document.body.appendChild(badge);
        
  //       // Replace the selected text with the new text and badge
  //       range.deleteContents();
  //       range.insertNode(container);
        
  //       // Clear the selection
  //       selection.removeAllRanges();
        
  //       // Show the badge with animation
  //       setTimeout(() => {
  //         badge.style.opacity = '1';
  //         badge.style.transform = 'scale(1)';
  //       }, 100);
        
  //       // Hide the badge after 2 seconds
  //       setTimeout(() => {
  //         badge.style.opacity = '0';
  //         badge.style.transform = 'scale(0.8)';
  //         setTimeout(() => {
  //           if (badge.parentNode) {
  //             badge.remove();
  //           }
  //         }, 300);
  //       }, 2000);
  //     }
  //   }
    
  //   // Close the modal after replacement
  //   this.hideModal();
  // }
}

// Initialize the content script
new RewordlyContentScript();