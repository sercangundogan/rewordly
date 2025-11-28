/**
 * Rewordly Content Script
 * Handles text selection, floating button UI, and displaying rewritten text
 * Now includes real-time grammar checking for editable elements
 */

interface RewordlyConfig {
  enabled: boolean;
}

interface GrammarError {
  start: number;
  end: number;
  word: string;
  suggestions: string[];
  type: 'grammar' | 'spelling';
}

interface GrammarCheckResponse {
  errors: GrammarError[];
  corrected: string;
}

class RewordlyContentScript {
  private config: RewordlyConfig = {
    enabled: true
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
  private grammarErrors: Map<HTMLElement, GrammarError[]> = new Map();
  private grammarSpinner: HTMLDivElement | null = null;
  private editableElements: Set<HTMLElement> = new Set();

  // Store bound event handlers to allow proper removal
  private boundHandleTextSelection = this.handleTextSelection.bind(this);
  private boundHandleOutsideClick = this.handleOutsideClick.bind(this);
  private boundHandleKeyDown = this.handleKeyDown.bind(this);
  private boundHandleScroll = this.handleScroll.bind(this);
  private boundHandleInput = this.handleInput.bind(this);
  private boundHandleFocus = this.handleFocus.bind(this);
  private boundHandleBlur = this.handleBlur.bind(this);

  constructor() {
    this.init();
  }

  private async init(): Promise<void> {
    console.log('Rewordly: Initializing content script');
    
    // Load configuration from storage
    await this.loadConfig();
    
    // Set up event listeners
    this.setupEventListeners();
    
    // Set up real-time grammar checking for editable elements
    console.log('Rewordly: Setting up real-time grammar check');
    this.setupRealtimeGrammarCheck();
    
    // Create floating button (initially hidden)
    this.createFloatingButton();
    
    // Create modal (initially hidden)
    this.createModal();
    
    // Create grammar spinner
    this.createGrammarSpinner();
    
    // Set up observer for dynamically loaded content
    this.setupContentObserver();
    
    // Listen for settings updates from popup
    this.setupMessageListener();
    
    console.log('Rewordly: Content script initialized');
  }

  private async loadConfig(): Promise<void> {
    try {
      const result = await chrome.storage.sync.get(['rewordlyEnabled']);
      console.log('Rewordly: Raw storage result:', result);
      
      // Use environment variables as defaults if not set in storage
      this.config.enabled = result['rewordlyEnabled'] !== false;
      
      console.log('Rewordly: Config loaded - Extension enabled:', this.config.enabled);
    } catch (error) {
      console.error('Failed to load Rewordly config:', error);
    }
  }

  private setupEventListeners(): void {
    // Remove existing listeners to prevent duplicates
    document.removeEventListener('mouseup', this.boundHandleTextSelection);
    document.removeEventListener('keyup', this.boundHandleTextSelection);
    document.removeEventListener('click', this.boundHandleOutsideClick);
    document.removeEventListener('keydown', this.boundHandleKeyDown);
    window.removeEventListener('scroll', this.boundHandleScroll);
    
    // Listen for text selection completion (mouseup) and keyboard selection
    document.addEventListener('mouseup', this.boundHandleTextSelection, true);
    document.addEventListener('keyup', this.boundHandleTextSelection, true);
    
    // Listen for clicks outside to hide button/modal
    document.addEventListener('click', this.boundHandleOutsideClick, true);
    
    // Listen for escape key to close modal
    document.addEventListener('keydown', this.boundHandleKeyDown, true);
    
    // Listen for scroll events to reposition button if needed
    window.addEventListener('scroll', this.boundHandleScroll, true);
  }

  /**
   * Set up real-time grammar checking for editable elements
   */
  private setupRealtimeGrammarCheck(): void {
    console.log('Rewordly: setupRealtimeGrammarCheck called');
    
    // Use event delegation at document level to catch all input events
    // This works even for dynamically added elements and Shadow DOM
    this.setupEventDelegation();
    
    // Wait for DOM to be ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        console.log('Rewordly: DOMContentLoaded fired, finding editable elements');
        this.findAndAttachToEditableElements();
      });
    } else {
      console.log('Rewordly: DOM already ready, finding editable elements');
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
      });
      
      // Periodically clean up overlays for removed elements
      this.clearAllGrammarErrors();
    });
    
    if (document.body) {
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['contenteditable']
      });
      console.log('Rewordly: MutationObserver started');
    } else {
      console.log('Rewordly: document.body not ready, waiting...');
      const bodyObserver = new MutationObserver(() => {
        if (document.body) {
          observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['contenteditable']
          });
          console.log('Rewordly: MutationObserver started (after body ready)');
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
    console.log('Rewordly: Setting up event delegation');
    
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
    
    console.log('Rewordly: Event delegation set up');
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
      console.log('Rewordly: Found new editable element via delegation:', element.tagName);
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
    
    console.log(`Rewordly: Found ${allEditable.size} editable elements (${inputs.length} via selector, ${contentEditableElements.length} via contentEditable check)`);
    
    allEditable.forEach((element) => {
      const el = element as HTMLElement;
      this.attachToEditableElement(el);
    });
    
    // Check Shadow DOM
    this.findEditableInShadowDOM(document.body);
    
    console.log(`Rewordly: Total tracked elements: ${this.editableElements.size}`);
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
    const elementType = element instanceof HTMLInputElement ? (element as HTMLInputElement).type : 
                        element instanceof HTMLTextAreaElement ? 'textarea' : 'contenteditable';
    console.log('Rewordly: Attaching listeners to:', element.tagName, elementType, element);
    
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
    
    console.log('Rewordly: Listeners attached successfully to', element);
  }

  /**
   * Handle input events on editable elements
   */
  private handleInput(event: Event): void {
    console.log('Rewordly: Input event triggered!', event);
    
    if (!this.config.enabled) {
      console.log('Rewordly: Extension disabled, skipping');
      return;
    }

    const element = event.target as HTMLElement;
    console.log('Rewordly: Input on element:', element.tagName, element);
    console.log('Rewordly: Element in editableElements set?', this.editableElements.has(element));
    
    if (!this.isEditableElement(element)) {
      console.log('Rewordly: Element not editable, skipping');
      return;
    }

    console.log('Rewordly: Processing input event');

    // Clear previous timeout
    if (this.grammarCheckTimeout !== null) {
      clearTimeout(this.grammarCheckTimeout);
    }

    // Clear existing errors
    this.clearGrammarErrors(element);

    // Hide spinner if it was showing
    this.hideGrammarSpinner();

    // Set new timeout for grammar check (1 second after typing stops)
    console.log('Rewordly: Setting timeout for grammar check');
    this.grammarCheckTimeout = window.setTimeout(() => {
      console.log('Rewordly: Timeout fired, performing grammar check');
      this.performGrammarCheck(element);
    }, 1000);
  }

  /**
   * Handle focus events on editable elements
   */
  private handleFocus(event: Event): void {
    const element = event.target as HTMLElement;
    
    if (!element || !this.isEditableElement(element)) {
      return;
    }
    
    // If element has grammar errors, show the overlay again
    if (this.grammarErrors.has(element)) {
      this.showGrammarOverlay(element);
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
    
    // Hide spinner
    this.hideGrammarSpinner();
    
    // Hide grammar errors/overlay when focus is lost (but don't delete)
    if (element && this.isEditableElement(element)) {
      // Small delay to allow for focus transfer (e.g., clicking on overlay)
      setTimeout(() => {
        // Check if element still doesn't have focus
        if (document.activeElement !== element) {
          this.hideGrammarOverlay(element);
        }
      }, 100);
    }
  }

  /**
   * Perform grammar check on an element
   */
  private async performGrammarCheck(element: HTMLElement): Promise<void> {
    let text = '';
    
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      text = element.value;
    } else if (element.getAttribute('contenteditable') === 'true') {
      text = element.textContent || element.innerText || '';
    }

    // Skip if text is too short
    if (text.trim().length < 3) {
      return;
    }

    // Show spinner
    this.showGrammarSpinner(element);

    try {
      // Mock API call - simulate delay
      await new Promise(resolve => setTimeout(resolve, 500));
      
      const response = this.mockGrammarCheck(text);
      console.log('Rewordly: Grammar check - Found', response.errors.length, 'error(s)');
      
      // Hide spinner
      this.hideGrammarSpinner();
      
      // Display errors
      if (response.errors.length > 0) {
        this.displayGrammarErrors(element, response.errors);
      }
    } catch (error) {
      console.error('Rewordly: Grammar check error:', error);
      this.hideGrammarSpinner();
    }
  }

  /**
   * Mock grammar check API - returns grammar errors with positions
   */
  private mockGrammarCheck(text: string): GrammarCheckResponse {
    // Example sentence with grammar errors: "I goes to the store yesterday"
    // This is a mock - in real implementation, this would call the API
    
    const errors: GrammarError[] = [];
    const lowerText = text.toLowerCase();
    
    // Check for common grammar errors
    // "goes" should be "went" (past tense)
    const goesIndex = lowerText.indexOf(' goes ');
    if (goesIndex !== -1) {
      const start = text.indexOf(' goes ', goesIndex);
      if (start !== -1) {
        errors.push({
          start: start + 1,
          end: start + 5,
          word: 'goes',
          suggestions: ['went', 'go'],
          type: 'grammar'
        });
      }
    }
    
    // "buyed" should be "bought"
    const buyedIndex = lowerText.indexOf('buyed');
    if (buyedIndex !== -1) {
      const start = text.toLowerCase().indexOf('buyed', buyedIndex);
      if (start !== -1) {
        errors.push({
          start: start,
          end: start + 5,
          word: 'buyed',
          suggestions: ['bought', 'buy'],
          type: 'grammar'
        });
      }
    }
    
    // "have" with singular subject (e.g., "sentence have")
    const haveIndex = lowerText.indexOf(' have ');
    if (haveIndex !== -1 && haveIndex > 0) {
      const beforeHave = text.substring(Math.max(0, haveIndex - 20), haveIndex).trim();
      // Simple check: if word before "have" doesn't end with 's' or is singular
      const wordsBefore = beforeHave.split(/\s+/);
      const lastWord = wordsBefore[wordsBefore.length - 1];
      if (lastWord && !lastWord.toLowerCase().endsWith('s') && lastWord.toLowerCase() !== 'they' && lastWord.toLowerCase() !== 'we' && lastWord.toLowerCase() !== 'you') {
        const start = text.indexOf(' have ', haveIndex);
        if (start !== -1) {
          errors.push({
            start: start + 1,
            end: start + 5,
            word: 'have',
            suggestions: ['has', 'have'],
            type: 'grammar'
          });
        }
      }
    }
    
    // "was" with plural subject (e.g., "they was")
    const wasIndex = lowerText.indexOf(' was ');
    if (wasIndex !== -1 && wasIndex > 0) {
      const beforeWas = text.substring(Math.max(0, wasIndex - 10), wasIndex).trim();
      const wordsBefore = beforeWas.split(/\s+/);
      const lastWord = wordsBefore[wordsBefore.length - 1];
      if (lastWord && (lastWord.toLowerCase() === 'they' || lastWord.toLowerCase() === 'we' || lastWord.toLowerCase() === 'you')) {
        const start = text.indexOf(' was ', wasIndex);
        if (start !== -1) {
          errors.push({
            start: start + 1,
            end: start + 4,
            word: 'was',
            suggestions: ['were', 'was'],
            type: 'grammar'
          });
        }
      }
    }

    // Generate corrected text
    let corrected = text;
    // Sort errors by position (reverse order to maintain indices)
    const sortedErrors = [...errors].sort((a, b) => b.start - a.start);
    for (const error of sortedErrors) {
      if (error.suggestions.length > 0) {
        const before = corrected.substring(0, error.start);
        const after = corrected.substring(error.end);
        corrected = before + error.suggestions[0] + after;
      }
    }

    return {
      errors,
      corrected
    };
  }

  /**
   * Display grammar errors on an element
   */
  private displayGrammarErrors(element: HTMLElement, errors: GrammarError[]): void {
    // Store errors
    this.grammarErrors.set(element, errors);

    // Use overlay for all editable elements to avoid DOM manipulation issues
    // This prevents text loss in contenteditable elements
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      // For input/textarea, create overlay
      this.createErrorOverlay(element, errors);
    } else if (element.getAttribute('contenteditable') === 'true' || element.isContentEditable) {
      // For contenteditable, also use overlay instead of DOM manipulation
      this.createErrorOverlayForContentEditable(element, errors);
    }
  }

  /**
   * Create error overlay for input/textarea elements
   */
  private createErrorOverlay(element: HTMLInputElement | HTMLTextAreaElement, errors: GrammarError[]): void {
    // Remove existing overlay
    const existingOverlay = document.querySelector(`.rewordly-grammar-overlay[data-element-id="${this.getElementId(element)}"]`);
    if (existingOverlay) {
      existingOverlay.remove();
    }

    // Create overlay
    const overlay = document.createElement('div');
    overlay.className = 'rewordly-grammar-overlay';
    overlay.setAttribute('data-element-id', this.getElementId(element));
    
    // Copy all relevant styles from the element
    const styles = window.getComputedStyle(element);
    overlay.style.cssText = `
      position: fixed;
      pointer-events: none;
      z-index: 2147483645;
      font-family: ${styles.fontFamily};
      font-size: ${styles.fontSize};
      font-weight: ${styles.fontWeight};
      font-style: ${styles.fontStyle};
      line-height: ${styles.lineHeight};
      letter-spacing: ${styles.letterSpacing};
      word-spacing: ${styles.wordSpacing};
      text-transform: ${styles.textTransform};
      color: transparent;
      white-space: ${element instanceof HTMLInputElement ? 'pre' : 'pre-wrap'};
      word-wrap: break-word;
      overflow: hidden;
      box-sizing: ${styles.boxSizing};
      padding: ${styles.padding};
      border: ${styles.border};
      border-color: transparent;
      background: transparent;
    `;

    // Position overlay exactly over the element
    const rect = element.getBoundingClientRect();
    overlay.style.top = `${rect.top + window.scrollY}px`;
    overlay.style.left = `${rect.left + window.scrollX}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
    overlay.style.minHeight = `${rect.height}px`;

    // Create text with error highlights
    const text = element.value;
    const errorSpans: string[] = [];
    
    // Sort errors by position
    const sortedErrors = [...errors].sort((a, b) => a.start - b.start);
    
    let lastIndex = 0;
    for (const error of sortedErrors) {
      // Add text before error
      errorSpans.push(this.escapeHtml(text.substring(lastIndex, error.start)));
      
      // Add error word with underline
      const errorWord = text.substring(error.start, error.end);
      errorSpans.push(`<span class="rewordly-grammar-error" style="border-bottom: 2px solid #ef4444; cursor: pointer; background: rgba(239, 68, 68, 0.1);" data-error="${this.escapeHtml(JSON.stringify(error))}">${this.escapeHtml(errorWord)}</span>`);
      
      lastIndex = error.end;
    }
    
    // Add remaining text
    errorSpans.push(this.escapeHtml(text.substring(lastIndex)));
    
    overlay.innerHTML = errorSpans.join('');
    
    document.body.appendChild(overlay);
    
    // Update overlay position on scroll/resize
    const updatePosition = () => {
      const newRect = element.getBoundingClientRect();
      overlay.style.top = `${newRect.top + window.scrollY}px`;
      overlay.style.left = `${newRect.left + window.scrollX}px`;
      overlay.style.width = `${newRect.width}px`;
      overlay.style.height = `${newRect.height}px`;
    };
    
    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('resize', updatePosition);
    
    // Store cleanup function
    (overlay as any).__cleanup = () => {
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
    };
  }

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
   * Create error overlay for contenteditable elements
   * This avoids DOM manipulation which can cause text loss
   */
  private createErrorOverlayForContentEditable(element: HTMLElement, errors: GrammarError[]): void {
    // Remove existing overlay
    const existingOverlay = document.querySelector(`.rewordly-grammar-overlay[data-element-id="${this.getElementId(element)}"]`);
    if (existingOverlay) {
      existingOverlay.remove();
    }

    // Get text content
    const text = element.textContent || element.innerText || '';
    if (!text) return;

    // Create overlay
    const overlay = document.createElement('div');
    overlay.className = 'rewordly-grammar-overlay';
    overlay.setAttribute('data-element-id', this.getElementId(element));
    
    // Copy all relevant styles from the element
    const styles = window.getComputedStyle(element);
    overlay.style.cssText = `
      position: fixed;
      pointer-events: none;
      z-index: 2147483645;
      font-family: ${styles.fontFamily};
      font-size: ${styles.fontSize};
      font-weight: ${styles.fontWeight};
      font-style: ${styles.fontStyle};
      line-height: ${styles.lineHeight};
      letter-spacing: ${styles.letterSpacing};
      word-spacing: ${styles.wordSpacing};
      text-transform: ${styles.textTransform};
      color: transparent;
      white-space: pre-wrap;
      word-wrap: break-word;
      overflow: hidden;
      box-sizing: ${styles.boxSizing};
      padding: ${styles.padding};
      border: ${styles.border};
      border-color: transparent;
      background: transparent;
    `;

    // Position overlay exactly over the element
    const rect = element.getBoundingClientRect();
    overlay.style.top = `${rect.top + window.scrollY}px`;
    overlay.style.left = `${rect.left + window.scrollX}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
    overlay.style.minHeight = `${rect.height}px`;

    // Create text with error highlights
    const errorSpans: string[] = [];
    
    // Sort errors by position
    const sortedErrors = [...errors].sort((a, b) => a.start - b.start);
    
    let lastIndex = 0;
    for (const error of sortedErrors) {
      // Add text before error
      errorSpans.push(this.escapeHtml(text.substring(lastIndex, error.start)));
      
      // Add error word with underline
      const errorWord = text.substring(error.start, error.end);
      errorSpans.push(`<span class="rewordly-grammar-error" style="border-bottom: 2px solid #ef4444; cursor: pointer; background: rgba(239, 68, 68, 0.1);" data-error="${this.escapeHtml(JSON.stringify(error))}">${this.escapeHtml(errorWord)}</span>`);
      
      lastIndex = error.end;
    }
    
    // Add remaining text
    errorSpans.push(this.escapeHtml(text.substring(lastIndex)));
    
    overlay.innerHTML = errorSpans.join('');
    
    document.body.appendChild(overlay);
    
    // Update overlay position on scroll/resize
    const updatePosition = () => {
      const newRect = element.getBoundingClientRect();
      overlay.style.top = `${newRect.top + window.scrollY}px`;
      overlay.style.left = `${newRect.left + window.scrollX}px`;
      overlay.style.width = `${newRect.width}px`;
      overlay.style.height = `${newRect.height}px`;
    };
    
    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('resize', updatePosition);
    
    // Store cleanup function
    (overlay as any).__cleanup = () => {
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
    };
  }

  /**
   * Hide grammar overlay for an element (but keep errors stored)
   */
  private hideGrammarOverlay(element: HTMLElement): void {
    const overlay = document.querySelector(`.rewordly-grammar-overlay[data-element-id="${this.getElementId(element)}"]`) as HTMLElement;
    if (overlay) {
      overlay.style.display = 'none';
      overlay.setAttribute('data-hidden-by-blur', 'true');
    }
  }

  /**
   * Show grammar overlay for an element (if errors exist)
   */
  private showGrammarOverlay(element: HTMLElement): void {
    if (!this.grammarErrors.has(element)) {
      return;
    }
    
    const overlay = document.querySelector(`.rewordly-grammar-overlay[data-element-id="${this.getElementId(element)}"]`) as HTMLElement;
    if (overlay) {
      overlay.style.display = '';
      overlay.removeAttribute('data-hidden-by-blur');
      this.updateOverlayPosition(element, overlay);
    } else {
      // Recreate if doesn't exist
      const errors = this.grammarErrors.get(element);
      if (errors) {
        this.displayGrammarErrors(element, errors);
      }
    }
  }

  /**
   * Update overlay position
   */
  private updateOverlayPosition(element: HTMLElement, overlay: HTMLElement): void {
    const rect = element.getBoundingClientRect();
    overlay.style.top = `${rect.top + window.scrollY}px`;
    overlay.style.left = `${rect.left + window.scrollX}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
  }

  /**
   * Clear grammar errors from an element (permanently remove)
   */
  private clearGrammarErrors(element: HTMLElement): void {
    // Remove overlay if exists (works for both input/textarea and contenteditable)
    const overlay = document.querySelector(`.rewordly-grammar-overlay[data-element-id="${this.getElementId(element)}"]`);
    if (overlay) {
      // Clean up event listeners
      if ((overlay as any).__cleanup) {
        (overlay as any).__cleanup();
      }
      overlay.remove();
    }
    
    // Clear stored errors
    this.grammarErrors.delete(element);
  }

  /**
   * Hide all grammar error overlays
   */
  private hideAllGrammarOverlays(): void {
    const allOverlays = document.querySelectorAll('.rewordly-grammar-overlay');
    allOverlays.forEach((overlay) => {
      (overlay as HTMLElement).style.display = 'none';
      (overlay as HTMLElement).setAttribute('data-hidden-by-modal', 'true');
    });
  }

  /**
   * Restore grammar overlays that were hidden by modal
   */
  private restoreGrammarOverlays(): void {
    const hiddenOverlays = document.querySelectorAll('.rewordly-grammar-overlay[data-hidden-by-modal="true"]');
    hiddenOverlays.forEach((overlay) => {
      const htmlOverlay = overlay as HTMLElement;
      htmlOverlay.style.display = '';
      htmlOverlay.removeAttribute('data-hidden-by-modal');
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
   * Create grammar spinner
   */
  private createGrammarSpinner(): void {
    this.grammarSpinner = document.createElement('div');
    this.grammarSpinner.className = 'rewordly-grammar-spinner';
    this.grammarSpinner.innerHTML = `
      <div class="rewordly-grammar-spinner-icon"></div>
      <span class="rewordly-grammar-spinner-text">Checking grammar...</span>
    `;
    this.grammarSpinner.style.cssText = `
      position: fixed !important;
      display: none !important;
      align-items: center !important;
      gap: 8px !important;
      background: white !important;
      padding: 8px 12px !important;
      border-radius: 6px !important;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15) !important;
      z-index: 2147483646 !important;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
      font-size: 12px !important;
      color: #374151 !important;
      visibility: hidden !important;
      opacity: 0 !important;
      pointer-events: none !important;
    `;
    document.body.appendChild(this.grammarSpinner);
  }

  /**
   * Show grammar spinner near the cursor position
   */
  private showGrammarSpinner(element: HTMLElement): void {
    if (!this.grammarSpinner) {
      console.log('Rewordly: Grammar spinner not found');
      return;
    }
    
    let caretRect: DOMRect | null = null;
    
    // Get cursor position based on element type
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      caretRect = this.getInputTextareaSelectionRect(element);
      console.log('Rewordly: Got caret rect for input/textarea:', caretRect);
    } else if (element.getAttribute('contenteditable') === 'true' || element.isContentEditable) {
      caretRect = this.getContentEditableCaretRect(element);
      console.log('Rewordly: Got caret rect for contenteditable:', caretRect);
    }
    
    // Fallback to element position if caret position not available
    if (!caretRect || caretRect.width === 0 && caretRect.height === 0) {
      console.log('Rewordly: Using fallback element position');
      const rect = element.getBoundingClientRect();
      caretRect = new DOMRect(
        rect.left,
        rect.top,
        0,
        rect.height
      );
    }
    
    // Position spinner at bottom-right of cursor
    // Note: getBoundingClientRect() returns viewport coordinates, no need to add scroll offset for fixed positioning
    const spinnerWidth = 150; // Approximate spinner width
    const spinnerHeight = 40; // Approximate spinner height
    const offsetX = 10; // Offset from cursor
    const offsetY = 5; // Offset from cursor
    
    // Use viewport coordinates directly (getBoundingClientRect already gives viewport coords)
    let left = caretRect.right + offsetX;
    let top = caretRect.bottom + offsetY;
    
    console.log('Rewordly: Initial spinner position (viewport):', left, top);
    
    // Check if spinner would go off screen, adjust if needed
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    
    // If spinner would go off right edge, position to left of cursor
    if (left + spinnerWidth > viewportWidth) {
      left = caretRect.left - spinnerWidth - offsetX;
      console.log('Rewordly: Adjusted left (off right edge):', left);
    }
    
    // If spinner would go off bottom edge, position above cursor
    if (top + spinnerHeight > viewportHeight) {
      top = caretRect.top - spinnerHeight - offsetY;
      console.log('Rewordly: Adjusted top (off bottom edge):', top);
    }
    
    // Ensure spinner is always visible within viewport
    left = Math.max(10, Math.min(left, viewportWidth - spinnerWidth - 10));
    top = Math.max(10, Math.min(top, viewportHeight - spinnerHeight - 10));
    
    console.log('Rewordly: Final spinner position (viewport):', left, top);
    
    // Set position using fixed positioning (no scroll offset needed)
    this.grammarSpinner.style.setProperty('position', 'fixed', 'important');
    this.grammarSpinner.style.setProperty('top', `${top}px`, 'important');
    this.grammarSpinner.style.setProperty('left', `${left}px`, 'important');
    this.grammarSpinner.style.setProperty('display', 'flex', 'important');
    this.grammarSpinner.style.setProperty('visibility', 'visible', 'important');
    this.grammarSpinner.style.setProperty('opacity', '1', 'important');
    this.grammarSpinner.style.setProperty('pointer-events', 'none', 'important');
    this.grammarSpinner.style.setProperty('z-index', '2147483646', 'important');
    
    // Force a reflow to ensure styles are applied
    void this.grammarSpinner.offsetHeight;
    
    // Verify spinner is actually visible
    const computedStyle = window.getComputedStyle(this.grammarSpinner);
    const spinnerRect = this.grammarSpinner.getBoundingClientRect();
    console.log('Rewordly: Spinner computed display:', computedStyle.display);
    console.log('Rewordly: Spinner computed visibility:', computedStyle.visibility);
    console.log('Rewordly: Spinner computed opacity:', computedStyle.opacity);
    console.log('Rewordly: Spinner computed position:', computedStyle.position);
    console.log('Rewordly: Spinner computed z-index:', computedStyle.zIndex);
    console.log('Rewordly: Spinner in DOM:', document.body.contains(this.grammarSpinner));
    console.log('Rewordly: Spinner bounding rect:', spinnerRect);
    console.log('Rewordly: Spinner offsetParent:', this.grammarSpinner.offsetParent);
  }

  /**
   * Get caret position for contenteditable elements
   */
  private getContentEditableCaretRect(element: HTMLElement): DOMRect | null {
    try {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) {
        console.log('Rewordly: No selection found for contenteditable');
        return null;
      }
      
      const range = selection.getRangeAt(0);
      
      // Check if range is within our element
      if (!element.contains(range.commonAncestorContainer)) {
        console.log('Rewordly: Selection is not within element');
        return null;
      }
      
      // If range is collapsed (cursor position), use it directly
      if (range.collapsed) {
        // Try multiple methods to get caret position
        
        // Method 1: Use getClientRects() for collapsed range
        const clientRects = range.getClientRects();
        if (clientRects && clientRects.length > 0) {
          const rect = clientRects[0];
          if (rect && (rect.width > 0 || rect.height > 0)) {
            return new DOMRect(
              rect.left,
              rect.top,
              0,
              rect.height || 20
            );
          }
        }
        
        // Method 2: Create a temporary span to get exact caret position
        const span = document.createElement('span');
        span.style.cssText = 'position: absolute; visibility: hidden; white-space: pre; pointer-events: none;';
        span.textContent = '\u200b'; // Zero-width space
        
        try {
          // Clone range to avoid modifying the original
          const clonedRange = range.cloneRange();
          clonedRange.insertNode(span);
          
          const spanRect = span.getBoundingClientRect();
          
          // Calculate caret position relative to viewport
          const caretX = spanRect.left;
          const caretY = spanRect.top;
          const caretHeight = spanRect.height || parseFloat(window.getComputedStyle(element).lineHeight) || 20;
          
          // Remove the temporary span
          span.remove();
          
          // If we got valid coordinates
          if (caretX > 0 && caretY > 0) {
            return new DOMRect(
              caretX,
              caretY,
              0,
              caretHeight
            );
          }
        } catch (e) {
          console.log('Rewordly: insertNode failed, trying alternative method:', e);
        }
        
        // Method 3: Use getBoundingClientRect on range
        try {
          const rangeRect = range.getBoundingClientRect();
          if (rangeRect && (rangeRect.width > 0 || rangeRect.height > 0)) {
            return new DOMRect(
              rangeRect.left,
              rangeRect.top,
              0,
              rangeRect.height || 20
            );
          }
        } catch (e) {
          console.log('Rewordly: getBoundingClientRect failed:', e);
        }
        
        // Method 4: Fallback - use focus node position
        const focusNode = selection.focusNode;
        if (focusNode) {
          let node: Node = focusNode;
          if (node.nodeType === Node.TEXT_NODE && node.parentElement) {
            node = node.parentElement;
          }
          
          if (node.nodeType === Node.ELEMENT_NODE) {
            const nodeRect = (node as Element).getBoundingClientRect();
            return new DOMRect(
              nodeRect.left,
              nodeRect.top,
              0,
              nodeRect.height || 20
            );
          }
        }
        
        // Final fallback - use element position
        const elementRect = element.getBoundingClientRect();
        return new DOMRect(
          elementRect.left,
          elementRect.top,
          0,
          elementRect.height || 20
        );
      } else {
        // If there's a selection, use the end of selection
        const endRange = range.cloneRange();
        endRange.collapse(false); // Collapse to end
        
        const endRects = endRange.getClientRects();
        if (endRects && endRects.length > 0) {
          const endRect = endRects[endRects.length - 1];
          if (endRect) {
            return new DOMRect(
              endRect.right,
              endRect.top,
              0,
              endRect.height || 20
            );
          }
        }
        
        const endRect = endRange.getBoundingClientRect();
        if (endRect) {
          return new DOMRect(
            endRect.right,
            endRect.top,
            0,
            endRect.height || 20
          );
        }
        
        // Final fallback for selection - use element position
        const elementRect = element.getBoundingClientRect();
        return new DOMRect(
          elementRect.right,
          elementRect.top,
          0,
          elementRect.height || 20
        );
      }
    } catch (e) {
      console.error('Rewordly: Error getting contenteditable caret position:', e);
      // Fallback to element position
      const elementRect = element.getBoundingClientRect();
      return new DOMRect(
        elementRect.left,
        elementRect.top,
        0,
        elementRect.height || 20
      );
    }
  }

  /**
   * Hide grammar spinner
   */
  private hideGrammarSpinner(): void {
    if (this.grammarSpinner) {
      this.grammarSpinner.style.setProperty('display', 'none', 'important');
      this.grammarSpinner.style.setProperty('visibility', 'hidden', 'important');
      this.grammarSpinner.style.setProperty('opacity', '0', 'important');
    }
  }

  /**
   * Escape HTML to prevent XSS
   */
  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
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
          console.log('Rewordly: Settings updated - Extension enabled:', this.config.enabled);
          
          // Hide button if extension is disabled
          if (!this.config.enabled) {
            this.hideFloatingButton();
          }
        });
      }
    });
  }

  private handleScroll(): void {
    // Hide the button when scrolling
    this.hideFloatingButton();
  }

  private handleTextSelection(event: Event): void {
    if (!this.config.enabled) {
      return;
    }

    // For mouseup events, check if there's actually a selection
    if (event.type === 'mouseup') {
      // Small delay to ensure selection is complete after mouse release
      setTimeout(() => {
        this.checkAndShowButton();
      }, 50);
    } else {
      // For keyboard events, check immediately
      this.checkAndShowButton();
    }
  }

  private checkAndShowButton(): void {
    // Don't show button if modal is open
    if (this.isModalOpen) {
      console.log('Rewordly: Modal is open, not showing button');
      return;
    }

    // Check if extension is enabled
    if (!this.config.enabled) {
      console.log('Rewordly: Extension is disabled, not showing button');
      return;
    }

    const selection = window.getSelection();
    if (!selection || selection.toString().trim() === '') {
      this.hideFloatingButton();
      return;
    }

    const selectedText = selection.toString().trim();
    
    if (selectedText.length < 3) {
      this.hideFloatingButton();
      return;
    }

    this.selectedText = selectedText;
    this.showFloatingButton();
  }

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
      <button class="rewordly-combined-btn">
        <span class="rewordly-btn-text">Rewrite</span>
        <span class="rewordly-btn-grammar-indicator">
          <svg class="rewordly-grammar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <path d="M20 6L9 17l-5-5"/>
          </svg>
        </span>
      </button>
    `;
    
    // Create tooltip element outside the button
    const tooltip = document.createElement('span');
    tooltip.className = 'rewordly-tooltip';
    tooltip.textContent = 'Click to rewrite. Right-click or click the green area for grammar only.';
    document.body.appendChild(tooltip);
    
    const combinedBtn = this.floatingButton.querySelector('.rewordly-combined-btn') as HTMLButtonElement;
    
    // Handle click position to determine rewrite vs grammar
    combinedBtn.addEventListener('click', (event) => {
      const rect = combinedBtn.getBoundingClientRect();
      const clickX = event.clientX - rect.left;
      const buttonWidth = rect.width;
      const rightQuarterStart = buttonWidth * 0.75;
      
      // If click is in the right 25% (green area), trigger grammar
      if (clickX >= rightQuarterStart) {
        this.handleGrammarClick();
      } else {
        // Otherwise, trigger rewrite
        this.handleRewriteClick();
      }
    });
    
    // Handle right-click for grammar
    combinedBtn.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      this.handleGrammarClick();
    });
    
    // Tooltip functionality
    const showTooltip = () => {
      const rect = combinedBtn.getBoundingClientRect();
      const tooltipLeft = rect.left + (rect.width / 2);
      const tooltipTop = rect.top - 5;
      tooltip.style.left = `${tooltipLeft}px`;
      tooltip.style.top = `${tooltipTop}px`;
      tooltip.classList.add('show');
    };
    
    const hideTooltip = () => {
      tooltip.classList.remove('show');
    };
    
    combinedBtn.addEventListener('mouseenter', showTooltip);
    combinedBtn.addEventListener('mouseleave', hideTooltip);
    
    // Update tooltip position on scroll/resize
    const updateTooltipPosition = () => {
      if (tooltip.classList.contains('show')) {
        const rect = combinedBtn.getBoundingClientRect();
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
          <button class="rewordly-close-btn">&times;</button>
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
      console.log('Rewordly: getClientRects failed');
    }
    
    // Method 2: Fallback to getBoundingClientRect() on the range
    if (!rect || rect.width === 0 || rect.height === 0) {
      try {
        const rangeRect = range.getBoundingClientRect();
        if (rangeRect && rangeRect.width > 0 && rangeRect.height > 0) {
          rect = rangeRect;
        }
      } catch (e) {
        console.log('Rewordly: getBoundingClientRect failed on range');
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
            console.log('Rewordly: Input/textarea position calculation failed', e);
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
        console.log('Rewordly: Failed to get position from common ancestor');
      }
    }
    
    // If we still don't have a valid rect, don't show the button
    if (!rect || rect.width === 0 || rect.height === 0) {
      console.log('Rewordly: Could not determine selection position');
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

  private hideFloatingButton(): void {
    if (this.floatingButton) {
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

    this.currentOperation = 'rewrite';
    this.hideFloatingButton();
    this.showModal();
    this.isProcessing = true;

    try {
      const rewrittenText = await this.rewriteText(this.selectedText);
      this.displayRewrittenText(rewrittenText);
    } catch (error) {
      console.error('Rewordly: Error rewriting text:', error);
      this.showError('Failed to rewrite text. Please try again.');
    } finally {
      this.isProcessing = false;
    }
  }

  private async handleGrammarClick(): Promise<void> {
    if (this.isProcessing) {
      return;
    }

    this.currentOperation = 'grammar';
    this.hideFloatingButton();
    this.showModal();
    this.isProcessing = true;

    try {
      const correctedText = await this.grammarText(this.selectedText);
      this.displayRewrittenText(correctedText);
    } catch (error) {
      console.error('Rewordly: Error correcting grammar:', error);
      this.showError('Failed to correct grammar. Please try again.');
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

  private async grammarText(text: string): Promise<string> {
    const response = await fetch('https://rewordly-web.vercel.app/api/grammar', {
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