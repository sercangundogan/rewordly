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
  
  // Grammarly-style highlights container
  private highlightsContainer: HTMLElement | null = null;
  private highlightsShadowRoot: ShadowRoot | null = null;
  private highlightsContent: HTMLElement | null = null;

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
    
    // Create Grammarly-style highlights container
    this.createHighlightsContainer();
    
    // Set up scroll/resize listeners for highlights
    this.setupHighlightsUpdateListeners();
    
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

    // Immediately validate and remove invalid highlights (when user deletes characters)
    this.validateAndRemoveInvalidHighlights(element);

    // Don't clear existing errors - keep overlays visible while user is typing
    // Only hide spinner if it was showing
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
    let textSource: 'value' | 'textContent' | 'innerText' = 'textContent';
    
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      text = element.value;
      textSource = 'value';
    } else if (element.getAttribute('contenteditable') === 'true' || element.isContentEditable) {
      // For contenteditable, prefer innerText as it's more accurate for formatted text
      text = element.innerText || element.textContent || '';
      textSource = element.innerText ? 'innerText' : 'textContent';
    }

    // Skip if text is too short
    if (text.trim().length < 3) {
      return;
    }

    // Store text source for overlay creation
    (element as any).__rewordlyTextSource = textSource;
    (element as any).__rewordlyText = text;

    // Show spinner
    this.showGrammarSpinner(element);

    try {
      // Call real API
      const response = await this.checkGrammarAPI(text);
      console.log('Rewordly: Grammar check - Found', response.errors.length, 'error(s)');
      
      // Hide spinner
      this.hideGrammarSpinner();
      
      // Display errors (or clear if no errors)
      this.displayGrammarErrors(element, response.errors);
    } catch (error) {
      console.error('Rewordly: Grammar check error:', error);
      this.hideGrammarSpinner();
      // Fallback to mock if API fails (for development)
      try {
        const mockResponse = this.mockGrammarCheck(text);
        this.displayGrammarErrors(element, mockResponse.errors);
      } catch (mockError) {
        console.error('Rewordly: Mock grammar check also failed:', mockError);
        // Clear all highlights if both API and mock fail
        this.displayGrammarErrors(element, []);
      }
    }
  }

  /**
   * Check grammar using API
   */
  private async checkGrammarAPI(text: string): Promise<GrammarCheckResponse> {
    const apiUrl = 'http://localhost:3000/api/grammar';
    
    try {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text }),
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      
      // Validate response structure
      if (!data || typeof data !== 'object') {
        throw new Error('Invalid API response format');
      }

      // Ensure errors array exists
      const errors = Array.isArray(data.errors) ? data.errors : [];
      
      return {
        errors: errors,
        corrected: data.corrected || text,
      };
    } catch (error) {
      console.error('Rewordly: API request failed:', error);
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
    const currentErrors = this.grammarErrors.get(element);
    if (!currentErrors || currentErrors.length === 0) {
      return;
    }

    // Get current text
    let text = '';
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      text = element.value;
    } else if (element.getAttribute('contenteditable') === 'true' || element.isContentEditable) {
      text = element.innerText || element.textContent || '';
    }

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
        const isStillValid = errorWord.toLowerCase().trim() === error.word.toLowerCase().trim() ||
                            errorWord.toLowerCase().includes(error.word.toLowerCase()) ||
                            error.word.toLowerCase().includes(errorWord.toLowerCase());

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
      return errorWord.toLowerCase().trim() === error.word.toLowerCase().trim() ||
             errorWord.toLowerCase().includes(error.word.toLowerCase()) ||
             error.word.toLowerCase().includes(errorWord.toLowerCase());
    });

    this.grammarErrors.set(element, validErrors);
  }

  /**
   * Display grammar errors on an element using Grammarly-style highlights
   */
  private displayGrammarErrors(element: HTMLElement, errors: GrammarError[]): void {
    // Store errors (empty array if no errors)
    this.grammarErrors.set(element, errors);

    // Ensure highlights container exists
    if (!this.highlightsContainer || !this.highlightsShadowRoot || !this.highlightsContent) {
      this.createHighlightsContainer();
      if (!this.highlightsContainer || !this.highlightsShadowRoot || !this.highlightsContent) {
        console.error('Rewordly: Failed to create highlights container');
        return;
      }
    }

    // Get existing highlights to compare by error position (not index)
    const elementId = this.getElementId(element);
    const existingHighlights = this.highlightsContent.querySelectorAll(`[data-element-id="${elementId}"]`);
    const existingErrorMap = new Map<string, HTMLElement>(); // Key: "start-end"
    
    existingHighlights.forEach((highlight) => {
      const errorData = (highlight as HTMLElement).getAttribute('data-error');
      if (errorData) {
        try {
          const error: GrammarError = JSON.parse(errorData);
          const errorKey = `${error.start}-${error.end}`;
          existingErrorMap.set(errorKey, highlight as HTMLElement);
        } catch (e) {
          // Error parsing, skip
        }
      }
    });

    // If no errors, remove all highlights for this element
    if (errors.length === 0) {
      existingErrorMap.forEach((highlight) => {
        highlight.remove();
      });
      return;
    }

    // Validate error positions against current text
    let text = '';
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      text = element.value;
    } else if (element.getAttribute('contenteditable') === 'true' || element.isContentEditable) {
      text = element.innerText || element.textContent || '';
    }

    // Filter out errors that are no longer valid (text changed, error position out of bounds)
    const validErrors = errors.filter(error => {
      if (error.start < 0 || error.end > text.length || error.start >= error.end) {
        return false;
      }
      // Check if the error word still matches at that position
      const errorWord = text.substring(error.start, error.end);
      // Allow some flexibility (case-insensitive, whitespace variations)
      return errorWord.toLowerCase().trim() === error.word.toLowerCase().trim() ||
             errorWord.toLowerCase().includes(error.word.toLowerCase()) ||
             error.word.toLowerCase().includes(errorWord.toLowerCase());
    });

    // Update stored errors with only valid ones
    this.grammarErrors.set(element, validErrors);

    // Update or create highlights for each valid error
    validErrors.forEach((error, index) => {
      const errorKey = `${error.start}-${error.end}`;
      const existingHighlight = existingErrorMap.get(errorKey);
      
      if (existingHighlight) {
        // Same error position, just update position (text might have changed)
        const highlightRect = this.getErrorTextRect(element, error.start, error.end);
        if (highlightRect) {
          existingHighlight.style.top = `${highlightRect.top}px`;
          existingHighlight.style.left = `${highlightRect.left}px`;
          existingHighlight.style.width = `${highlightRect.width}px`;
          existingHighlight.style.height = `${highlightRect.height}px`;
          // Update error data in case suggestions changed
          existingHighlight.setAttribute('data-error', JSON.stringify(error));
          existingHighlight.setAttribute('data-error-index', index.toString());
        } else {
          // Position calculation failed, remove highlight
          existingHighlight.remove();
        }
      } else {
        // New error or error position changed, create new highlight
        this.createHighlight(element, error, index);
      }
    });

    // Remove highlights that no longer exist (errors that were fixed or removed)
    const currentErrorKeys = new Set(validErrors.map(err => `${err.start}-${err.end}`));
    existingErrorMap.forEach((highlight, errorKey) => {
      if (!currentErrorKeys.has(errorKey)) {
        highlight.remove();
      }
    });

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
    
  //   console.log('Rewordly: Overlay text length:', text.length, 'Text:', text.substring(0, 50));

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
    
  //   console.log('Rewordly: Creating overlay with', sortedErrors.length, 'errors');
  //   console.log('Rewordly: Text for overlay:', text);
  //   console.log('Rewordly: Errors:', sortedErrors);
    
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
    
  //   console.log('Rewordly: Overlay HTML length:', overlay.innerHTML.length);
    
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
  //   console.log('Rewordly: Overlay created - Position:', {
  //     top: overlayRect.top,
  //     left: overlayRect.left,
  //     width: overlayRect.width,
  //     height: overlayRect.height,
  //     zIndex: computedStyle.zIndex,
  //     display: computedStyle.display,
  //     visibility: computedStyle.visibility,
  //     opacity: computedStyle.opacity,
  //     position: computedStyle.position
  //   });
    
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
   * Hide grammar highlights for an element (but keep errors stored)
   */
  private hideGrammarOverlay(element: HTMLElement): void {
    if (!this.highlightsContent) return;
    
    const elementId = this.getElementId(element);
    const highlights = this.highlightsContent.querySelectorAll(`[data-element-id="${elementId}"]`);
    highlights.forEach(highlight => {
      (highlight as HTMLElement).style.display = 'none';
      (highlight as HTMLElement).setAttribute('data-hidden-by-blur', 'true');
    });
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
    const highlights = this.highlightsContent.querySelectorAll(`[data-element-id="${elementId}"]`);
    
    if (highlights.length === 0) {
      // Recreate if doesn't exist
      const errors = this.grammarErrors.get(element);
      if (errors) {
        this.displayGrammarErrors(element, errors);
      }
    } else {
      // Show existing highlights
      highlights.forEach(highlight => {
        (highlight as HTMLElement).style.display = '';
        (highlight as HTMLElement).removeAttribute('data-hidden-by-blur');
        (highlight as HTMLElement).removeAttribute('data-hidden-by-modal');
      });
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
    this.highlightsContainer.style.cssText = `
      position: fixed !important;
      top: 0 !important;
      left: 0 !important;
      width: 0 !important;
      height: 0 !important;
      pointer-events: none !important;
      z-index: 2147483645 !important;
      overflow: visible !important;
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
    style.textContent = `
      .rewordly-highlight {
        position: absolute !important;
        pointer-events: auto !important;
        cursor: pointer !important;
        border-bottom: 2px solid #ef4444 !important;
        box-sizing: content-box !important;
        z-index: 1 !important;
        transition: top 0.2s ease-in-out, left 0.2s ease-in-out !important;
        transform-origin: left center !important;
      }
      .rewordly-highlight:hover {
        background: rgba(239, 68, 68, 0.1) !important;
      }
      .rewordly-highlight.rewordly-highlight-enter {
        animation: rewordly-highlight-grow 0.3s ease-in-out forwards !important;
      }
      @keyframes rewordly-highlight-grow {
        from {
          width: 0 !important;
          opacity: 0 !important;
        }
        to {
          width: var(--rewordly-target-width) !important;
          opacity: 1 !important;
        }
      }
    `;
    
    this.highlightsShadowRoot.appendChild(style);
    this.highlightsShadowRoot.appendChild(this.highlightsContent);
    
    // Append to document body (at the end, like Grammarly)
    document.body.appendChild(this.highlightsContainer);
  }

  /**
   * Create a single highlight for an error
   */
  private createHighlight(element: HTMLElement, error: GrammarError, index: number): void {
    if (!this.highlightsContent) return;

    // Get text from element
    let text = '';
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      text = element.value;
    } else if (element.getAttribute('contenteditable') === 'true' || element.isContentEditable) {
      text = element.innerText || element.textContent || '';
    }

    if (!text || error.start >= text.length || error.end > text.length) {
      return;
    }

    // Calculate the position of the error text in viewport coordinates
    const highlightRect = this.getErrorTextRect(element, error.start, error.end);
    if (!highlightRect) {
      return;
    }

    // Create highlight element
    const highlight = document.createElement('div');
    highlight.className = 'rewordly-highlight';
    highlight.setAttribute('data-rewordly-part', 'highlight');
    highlight.setAttribute('data-highlight-format', 'underline');
    highlight.setAttribute('data-highlight-color-name', 'red');
    highlight.setAttribute('data-element-id', this.getElementId(element));
    highlight.setAttribute('data-error-index', index.toString());
    highlight.setAttribute('data-error', JSON.stringify(error));
    
    // Set position and size
    highlight.style.top = `${highlightRect.top}px`;
    highlight.style.left = `${highlightRect.left}px`;
    highlight.style.height = `${highlightRect.height}px`;
    
    // Store target width for animation
    highlight.style.setProperty('--rewordly-target-width', `${highlightRect.width}px`);
    
    // Initially set width to 0 for animation
    highlight.style.width = '0px';
    
    // Add animation class
    highlight.classList.add('rewordly-highlight-enter');

    // Add hover listeners
    this.attachHighlightHoverListener(highlight, error, element);

    // Append to highlights content
    this.highlightsContent.appendChild(highlight);
    
    // Remove animation class after animation completes
    setTimeout(() => {
      highlight.classList.remove('rewordly-highlight-enter');
      // Set final width after animation
      highlight.style.width = `${highlightRect.width}px`;
    }, 300);
  }

  /**
   * Get the bounding rect of error text in viewport coordinates
   */
  private getErrorTextRect(element: HTMLElement, start: number, end: number): DOMRect | null {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      return this.getInputTextareaErrorRect(element, start, end);
    } else if (element.getAttribute('contenteditable') === 'true' || element.isContentEditable) {
      return this.getContentEditableErrorRect(element, start, end);
    }
    return null;
  }

  /**
   * Get error rect for input/textarea elements
   */
  private getInputTextareaErrorRect(element: HTMLInputElement | HTMLTextAreaElement, start: number, end: number): DOMRect | null {
    const text = element.value;
    if (start >= text.length || end > text.length) {
      return null;
    }

    const elementRect = element.getBoundingClientRect();
    const styles = window.getComputedStyle(element);
    
    // Create a mirror div to measure text position
    const div = document.createElement('div');
    const divStyle = div.style;
    
    // Copy all relevant styles
    const properties = [
      'direction', 'boxSizing', 'width', 'height', 'overflowX', 'overflowY',
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
    
    divStyle.position = 'absolute';
    divStyle.visibility = 'hidden';
    divStyle.whiteSpace = element instanceof HTMLInputElement ? 'pre' : 'pre-wrap';
    if (!(element instanceof HTMLInputElement)) {
      divStyle.wordWrap = 'break-word';
    }
    
    // Add text before error
    div.textContent = text.substring(0, start);
    
    // Add marker for start position
    const startMarker = document.createElement('span');
    startMarker.textContent = '|';
    div.appendChild(startMarker);
    
    // Add error text
    const errorText = text.substring(start, end);
    const errorSpan = document.createElement('span');
    errorSpan.textContent = errorText;
    div.appendChild(errorSpan);
    
    // Add marker for end position
    const endMarker = document.createElement('span');
    endMarker.textContent = '|';
    div.appendChild(endMarker);
    
    document.body.appendChild(div);
    
    // Get positions
    const startRect = startMarker.getBoundingClientRect();
    const errorRect = errorSpan.getBoundingClientRect();
    
    // Account for scroll
    const scrollLeft = element.scrollLeft || 0;
    const scrollTop = element.scrollTop || 0;
    
    // Get padding and border
    const paddingLeft = parseFloat(styles.paddingLeft) || 0;
    const borderLeft = parseFloat(styles.borderLeftWidth) || 0;
    const paddingTop = parseFloat(styles.paddingTop) || 0;
    const borderTop = parseFloat(styles.borderTopWidth) || 0;
    
    // Calculate viewport coordinates
    const left = elementRect.left + paddingLeft + borderLeft + (startRect.left - div.getBoundingClientRect().left) - scrollLeft;
    const top = elementRect.top + paddingTop + borderTop + (startRect.top - div.getBoundingClientRect().top) - scrollTop;
    const width = errorRect.width;
    const height = errorRect.height || parseFloat(styles.lineHeight) || elementRect.height;
    
    document.body.removeChild(div);
    
    return new DOMRect(left, top, width, height);
  }

  /**
   * Get error rect for contenteditable elements
   */
  private getContentEditableErrorRect(element: HTMLElement, start: number, end: number): DOMRect | null {
    const text = element.innerText || element.textContent || '';
    if (start >= text.length || end > text.length) {
      return null;
    }

    // Find text nodes and their positions
    const walker = document.createTreeWalker(
      element,
      NodeFilter.SHOW_TEXT,
      null
    );

    const textNodes: { node: Text; startIndex: number; endIndex: number }[] = [];
    let textIndex = 0;

    let node: Text | null;
    while ((node = walker.nextNode() as Text | null)) {
      if (node && node.textContent) {
        const nodeLength = node.textContent.length;
        textNodes.push({
          node,
          startIndex: textIndex,
          endIndex: textIndex + nodeLength
        });
        textIndex += nodeLength;
      }
    }

    // Find nodes containing the error
    const startNodeInfo = textNodes.find(tn => start >= tn.startIndex && start < tn.endIndex);
    const endNodeInfo = textNodes.find(tn => end > tn.startIndex && end <= tn.endIndex);

    if (!startNodeInfo) {
      return null;
    }

    try {
      const range = document.createRange();
      
      if (startNodeInfo && endNodeInfo && startNodeInfo.node !== endNodeInfo.node) {
        // Error spans multiple nodes
        const startNodeLocalPos = start - startNodeInfo.startIndex;
        const endNodeLocalPos = end - endNodeInfo.startIndex;
        range.setStart(startNodeInfo.node, Math.min(startNodeLocalPos, startNodeInfo.node.textContent!.length));
        range.setEnd(endNodeInfo.node, Math.min(endNodeLocalPos, endNodeInfo.node.textContent!.length));
      } else {
        // Error is within a single node
        const startNodeLocalPos = start - startNodeInfo.startIndex;
        const endPos = startNodeLocalPos + (end - start);
        range.setStart(startNodeInfo.node, startNodeLocalPos);
        range.setEnd(startNodeInfo.node, Math.min(endPos, startNodeInfo.node.textContent!.length));
      }

      const rect = range.getBoundingClientRect();
      if (rect && rect.width > 0 && rect.height > 0) {
        return rect;
      }
    } catch (e) {
      console.error('Rewordly: Error getting contenteditable error rect:', e);
    }

    return null;
  }

  /**
   * Clear highlights for a specific element
   */
  private clearElementHighlights(element: HTMLElement): void {
    if (!this.highlightsContent) return;
    
    const elementId = this.getElementId(element);
    const highlights = this.highlightsContent.querySelectorAll(`[data-element-id="${elementId}"]`);
    highlights.forEach(highlight => highlight.remove());
  }

  /**
   * Update highlights position on scroll/resize
   */
  private updateHighlightsPosition(element: HTMLElement): void {
    if (!this.highlightsContent) return;

    const elementId = this.getElementId(element);
    const errors = this.grammarErrors.get(element);
    if (!errors) return;

    const highlights = this.highlightsContent.querySelectorAll(`[data-element-id="${elementId}"]`);
    highlights.forEach((highlight, index) => {
      const error = errors[index];
      if (!error) return;

      const highlightRect = this.getErrorTextRect(element, error.start, error.end);
      if (highlightRect) {
        (highlight as HTMLElement).style.top = `${highlightRect.top}px`;
        (highlight as HTMLElement).style.left = `${highlightRect.left}px`;
        (highlight as HTMLElement).style.width = `${highlightRect.width}px`;
        (highlight as HTMLElement).style.height = `${highlightRect.height}px`;
      }
    });
  }

  /**
   * Attach hover listener to highlight
   */
  private attachHighlightHoverListener(highlight: HTMLElement, error: GrammarError, element: HTMLElement): void {
    let currentTooltip: HTMLElement | null = null;
    let tooltipTimeout: number | null = null;

    const closeTooltip = () => {
      if (tooltipTimeout !== null) {
        clearTimeout(tooltipTimeout);
        tooltipTimeout = null;
      }
      if (currentTooltip) {
        currentTooltip.remove();
        currentTooltip = null;
      }
    };

    highlight.addEventListener('mouseenter', () => {
      closeTooltip();

      // Create tooltip
      const tooltip = document.createElement('div');
      tooltip.className = 'rewordly-grammar-tooltip';

      const suggestionsHtml = error.suggestions && error.suggestions.length > 0
        ? error.suggestions.map((suggestion) => 
            `<button class="rewordly-grammar-suggestion" data-suggestion="${this.escapeHtml(suggestion)}" data-error-start="${error.start}" data-error-end="${error.end}">${this.escapeHtml(suggestion)}</button>`
          ).join('')
        : '<div class="rewordly-grammar-no-suggestions">No suggestions available</div>';

      tooltip.innerHTML = `
        <div class="rewordly-grammar-tooltip-content">
          <div class="rewordly-grammar-tooltip-word">${this.escapeHtml(error.word)}</div>
          <div class="rewordly-grammar-tooltip-suggestions">${suggestionsHtml}</div>
        </div>
      `;

      document.body.appendChild(tooltip);

      // Position tooltip
      const highlightRect = highlight.getBoundingClientRect();
      const tooltipRect = tooltip.getBoundingClientRect();
      const tooltipTop = highlightRect.top - tooltipRect.height - 8;
      const tooltipLeft = highlightRect.left + (highlightRect.width / 2) - (tooltipRect.width / 2);

      const adjustedLeft = Math.max(8, Math.min(tooltipLeft, window.innerWidth - tooltipRect.width - 8));
      const adjustedTop = tooltipTop < 8 ? highlightRect.bottom + 8 : tooltipTop;

      tooltip.style.top = `${adjustedTop}px`;
      tooltip.style.left = `${adjustedLeft}px`;

      currentTooltip = tooltip;

      // Attach click handlers
      const suggestionButtons = tooltip.querySelectorAll('.rewordly-grammar-suggestion');
      suggestionButtons.forEach(button => {
        button.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();

          const suggestion = (button as HTMLElement).getAttribute('data-suggestion');
          const errorStart = parseInt((button as HTMLElement).getAttribute('data-error-start') || '0');
          const errorEnd = parseInt((button as HTMLElement).getAttribute('data-error-end') || '0');

          if (suggestion) {
            closeTooltip();
            this.closeAllGrammarTooltips();
            this.replaceGrammarError(element, errorStart, errorEnd, suggestion);
          }
        });
      });

      tooltip.addEventListener('mouseleave', () => {
        tooltipTimeout = window.setTimeout(() => {
          if (currentTooltip === tooltip && !highlight.matches(':hover')) {
            closeTooltip();
          }
        }, 100);
      });
    });

    highlight.addEventListener('mouseleave', () => {
      tooltipTimeout = window.setTimeout(() => {
        if (currentTooltip && !currentTooltip.matches(':hover') && !highlight.matches(':hover')) {
          closeTooltip();
        }
      }, 100);
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

  /**
   * Set up scroll/resize listeners for highlights
   */
  private setupHighlightsUpdateListeners(): void {
    const updateAllHighlights = () => {
      // Update highlights for all elements with errors
      this.grammarErrors.forEach((_errors, element) => {
        this.updateHighlightsPosition(element);
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
   * Replace grammar error with suggestion
   */
  private replaceGrammarError(element: HTMLElement, start: number, end: number, replacement: string): void {
    // Close all tooltips before replacement
    this.closeAllGrammarTooltips();
    
    // Remove only the replaced error's highlight (not all highlights)
    if (this.highlightsContent) {
      const elementId = this.getElementId(element);
      const highlights = this.highlightsContent.querySelectorAll(`[data-element-id="${elementId}"]`);
      highlights.forEach((highlight) => {
        const errorData = (highlight as HTMLElement).getAttribute('data-error');
        if (errorData) {
          try {
            const error: GrammarError = JSON.parse(errorData);
            if (error.start === start && error.end === end) {
              highlight.remove();
            }
          } catch (e) {
            // Error parsing, skip
          }
        }
      });
    }
    
    // Update stored errors - remove the replaced error
    const currentErrors = this.grammarErrors.get(element) || [];
    const updatedErrors = currentErrors.filter(err => !(err.start === start && err.end === end));
    this.grammarErrors.set(element, updatedErrors);
    
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      // For input/textarea
      const text = element.value;
      const newText = text.substring(0, start) + replacement + text.substring(end);
      const replacementLength = replacement.length;
      const originalLength = end - start;
      const lengthDiff = replacementLength - originalLength;
      
      element.value = newText;
      
      // Update error positions for remaining errors (they may have shifted)
      const currentErrors = this.grammarErrors.get(element) || [];
      const updatedErrors = currentErrors
        .filter(err => !(err.start === start && err.end === end))
        .map(err => {
          // If error is after the replaced text, adjust its position
          if (err.start > end) {
            return {
              ...err,
              start: err.start + lengthDiff,
              end: err.end + lengthDiff
            };
          }
          // If error overlaps with replaced text, it's already removed
          return err;
        });
      this.grammarErrors.set(element, updatedErrors);
      
      // Immediately update highlight positions (no delay)
      this.updateHighlightsPosition(element);
      
      // Trigger input event (this will reset timeout but won't clear errors)
      const inputEvent = new Event('input', { bubbles: true });
      element.dispatchEvent(inputEvent);
      
      // Recheck grammar after a short delay to update remaining errors
      setTimeout(() => {
        this.performGrammarCheck(element);
      }, 500);
    } else if (element.getAttribute('contenteditable') === 'true' || element.isContentEditable) {
      // For contenteditable - check if it's Draft.js (Twitter)
      const isDraftJS = element.classList.contains('public-DraftEditor-content') || 
                        element.closest('.DraftEditor-root') !== null;
      
      if (isDraftJS) {
        // For Draft.js editors (Twitter), use a different approach
        // We need to simulate user typing to trigger Draft.js onChange
        this.replaceTextInDraftJS(element, start, end, replacement);
        
        // Remove only the replaced error's highlight (not all highlights)
        if (this.highlightsContent) {
          const elementId = this.getElementId(element);
          const highlights = this.highlightsContent.querySelectorAll(`[data-element-id="${elementId}"]`);
          highlights.forEach((highlight) => {
            const errorData = (highlight as HTMLElement).getAttribute('data-error');
            if (errorData) {
              try {
                const error: GrammarError = JSON.parse(errorData);
                if (error.start === start && error.end === end) {
                  highlight.remove();
                }
              } catch (e) {
                // Error parsing, skip
              }
            }
          });
        }
        
        // Calculate length difference for position adjustment
        const replacementLength = replacement.length;
        const originalLength = end - start;
        const lengthDiff = replacementLength - originalLength;
        
        // Update stored errors - remove the replaced error and adjust positions
        const currentErrors = this.grammarErrors.get(element) || [];
        const updatedErrors = currentErrors
          .filter(err => !(err.start === start && err.end === end))
          .map(err => {
            // If error is after the replaced text, adjust its position
            if (err.start > end) {
              return {
                ...err,
                start: err.start + lengthDiff,
                end: err.end + lengthDiff
              };
            }
            // If error overlaps with replaced text, it's already removed
            return err;
          });
        this.grammarErrors.set(element, updatedErrors);
        
        // Immediately update highlight positions (no delay)
        this.updateHighlightsPosition(element);
      } else {
        // For regular contenteditable
        const selection = window.getSelection();
        if (!selection) return;
        
        // Find all text nodes and their positions
        const walker = document.createTreeWalker(
          element,
          NodeFilter.SHOW_TEXT,
          null
        );
        
        const textNodes: { node: Text; startIndex: number; endIndex: number }[] = [];
        let textIndex = 0;
        
        let node: Text | null;
        while ((node = walker.nextNode() as Text | null)) {
          if (node && node.textContent) {
            const nodeLength = node.textContent.length;
            textNodes.push({
              node,
              startIndex: textIndex,
              endIndex: textIndex + nodeLength
            });
            textIndex += nodeLength;
          }
        }
        
        // Find the text nodes that contain the error
        const startNodeInfo = textNodes.find(tn => start >= tn.startIndex && start < tn.endIndex);
        const endNodeInfo = textNodes.find(tn => end > tn.startIndex && end <= tn.endIndex);
        
        if (startNodeInfo) {
          const range = document.createRange();
          const errorLength = end - start;
          
          try {
            // Calculate local positions within text nodes
            const startNodeLocalPos = start - startNodeInfo.startIndex;
            const startNodeLength = startNodeInfo.node.textContent!.length;
            
            // Check if error spans multiple nodes
            if (endNodeInfo && startNodeInfo.node !== endNodeInfo.node) {
              // Error spans multiple text nodes - need to handle differently
              const endNodeLocalPos = end - endNodeInfo.startIndex;
              
              // Set range from start node to end node
              range.setStart(startNodeInfo.node, Math.min(startNodeLocalPos, startNodeLength));
              range.setEnd(endNodeInfo.node, Math.min(endNodeLocalPos, endNodeInfo.node.textContent!.length));
            } else {
              // Error is within a single text node
              const endPos = startNodeLocalPos + errorLength;
              
              // Validate positions
              if (startNodeLocalPos < 0 || endPos > startNodeLength) {
                console.error('Rewordly: Invalid error position in text node', {
                  startNodeLocalPos,
                  endPos,
                  nodeLength: startNodeLength,
                  globalStart: start,
                  globalEnd: end
                });
                return;
              }
              
              range.setStart(startNodeInfo.node, startNodeLocalPos);
              range.setEnd(startNodeInfo.node, endPos);
            }
            
            selection.removeAllRanges();
            selection.addRange(range);
            
            // Replace selected text
            range.deleteContents();
            const textNode = document.createTextNode(replacement);
            range.insertNode(textNode);
            
            // Clear selection
            selection.removeAllRanges();
            
            // Trigger multiple events to ensure Draft.js picks it up
            const events = ['beforeinput', 'input', 'textInput'];
            events.forEach(eventType => {
              const event = new Event(eventType, { bubbles: true, cancelable: true });
              (event as any).data = replacement;
              element.dispatchEvent(event);
            });
            
            // Calculate length difference for position adjustment
            const replacementLength = replacement.length;
            const originalLength = end - start;
            const lengthDiff = replacementLength - originalLength;
            
            // Update stored errors - remove the replaced error and adjust positions
            const currentErrors = this.grammarErrors.get(element) || [];
            const updatedErrors = currentErrors
              .filter(err => !(err.start === start && err.end === end))
              .map(err => {
                // If error is after the replaced text, adjust its position
                if (err.start > end) {
                  return {
                    ...err,
                    start: err.start + lengthDiff,
                    end: err.end + lengthDiff
                  };
                }
                // If error overlaps with replaced text, it's already removed
                return err;
              });
            this.grammarErrors.set(element, updatedErrors);
            
            // Immediately update highlight positions (no delay)
            this.updateHighlightsPosition(element);
            
            // Recheck grammar after a short delay to update remaining errors
            // (Don't clear all errors - just update them)
            setTimeout(() => {
              this.performGrammarCheck(element);
            }, 500);
          } catch (err) {
            console.error('Rewordly: Error replacing text:', err);
            console.error('Rewordly: Error details:', {
              start,
              end,
              errorLength,
              startNodeInfo,
              endNodeInfo,
              textNodes: textNodes.map(tn => ({
                start: tn.startIndex,
                end: tn.endIndex,
                length: tn.node.textContent?.length
              }))
            });
          }
        } else {
          console.error('Rewordly: Could not find text node for error position', {
            start,
            end,
            textNodes: textNodes.map(tn => ({
              start: tn.startIndex,
              end: tn.endIndex,
              length: tn.node.textContent?.length
            }))
          });
        }
      }
    }
  }

  /**
   * Replace text in Draft.js editor (Twitter)
   */
  private replaceTextInDraftJS(element: HTMLElement, start: number, end: number, replacement: string): void {
    const selection = window.getSelection();
    if (!selection) return;
    
    // Find the text node at the error position
    const walker = document.createTreeWalker(
      element,
      NodeFilter.SHOW_TEXT,
      null
    );
    
    let textIndex = 0;
    let targetNode: Text | null = null;
    let targetStart = 0;
    
    let node: Text | null;
    while ((node = walker.nextNode() as Text | null)) {
      if (node && node.textContent) {
        const nodeLength = node.textContent.length;
        if (start >= textIndex && start < textIndex + nodeLength) {
          targetNode = node;
          targetStart = start - textIndex;
          break;
        }
        textIndex += nodeLength;
      }
    }
    
    if (targetNode) {
      const range = document.createRange();
      const errorLength = end - start;
      
      try {
        // Set range to the error word
        range.setStart(targetNode, targetStart);
        range.setEnd(targetNode, targetStart + errorLength);
        selection.removeAllRanges();
        selection.addRange(range);
        
        // For Draft.js, we need to simulate user input more carefully
        // Delete the old text first
        range.deleteContents();
        
        // Insert the new text
        const textNode = document.createTextNode(replacement);
        range.insertNode(textNode);
        
        // Move cursor after inserted text
        range.setStartAfter(textNode);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        
        // Trigger multiple events to ensure Draft.js picks it up
        // Use InputEvent for better compatibility
        const inputEvent = new InputEvent('input', {
          bubbles: true,
          cancelable: true,
          inputType: 'insertText',
          data: replacement
        });
        element.dispatchEvent(inputEvent);
        
        // Also trigger beforeinput
        const beforeInputEvent = new InputEvent('beforeinput', {
          bubbles: true,
          cancelable: true,
          inputType: 'insertText',
          data: replacement
        });
        element.dispatchEvent(beforeInputEvent);
        
        // Clear selection
        selection.removeAllRanges();
        
        // Force focus to ensure Draft.js updates
        element.focus();
        
        // Calculate length difference for position adjustment
        const replacementLength = replacement.length;
        const originalLength = end - start;
        const lengthDiff = replacementLength - originalLength;
        
        // Update stored errors - remove the replaced error and adjust positions
        const currentErrors = this.grammarErrors.get(element) || [];
        const updatedErrors = currentErrors
          .filter(err => !(err.start === start && err.end === end))
          .map(err => {
            // If error is after the replaced text, adjust its position
            if (err.start > end) {
              return {
                ...err,
                start: err.start + lengthDiff,
                end: err.end + lengthDiff
              };
            }
            // If error overlaps with replaced text, it's already removed
            return err;
          });
        this.grammarErrors.set(element, updatedErrors);
        
        // Immediately update highlight positions (no delay)
        this.updateHighlightsPosition(element);
        
        // Recheck grammar after a short delay to update remaining errors
        // (Don't clear all errors - just update them)
        setTimeout(() => {
          this.performGrammarCheck(element);
        }, 500);
      } catch (err) {
        console.error('Rewordly: Error replacing text in Draft.js:', err);
      }
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