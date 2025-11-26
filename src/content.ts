/**
 * Rewordly Content Script
 * Handles text selection, floating button UI, and displaying rewritten text
 */

interface RewordlyConfig {
  enabled: boolean;
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

  // Store bound event handlers to allow proper removal
  private boundHandleTextSelection = this.handleTextSelection.bind(this);
  private boundHandleOutsideClick = this.handleOutsideClick.bind(this);
  private boundHandleKeyDown = this.handleKeyDown.bind(this);
  private boundHandleScroll = this.handleScroll.bind(this);

  constructor() {
    this.init();
  }

  private async init(): Promise<void> {
    // Load configuration from storage
    await this.loadConfig();
    
    // Set up event listeners
    this.setupEventListeners();
    
    // Create floating button (initially hidden)
    this.createFloatingButton();
    
    // Create modal (initially hidden)
    this.createModal();
    
    // Set up observer for dynamically loaded content
    this.setupContentObserver();
    
    // Listen for settings updates from popup
    this.setupMessageListener();
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
      console.log('Rewordly: No text selected');
      this.hideFloatingButton();
      return;
    }

    const selectedText = selection.toString().trim();
    console.log('Rewordly: Selected text length:', selectedText.length);
    
    if (selectedText.length < 3) {
      console.log('Rewordly: Text too short, not showing button');
      this.hideFloatingButton();
      return;
    }

    console.log('Rewordly: Showing floating button for text:', selectedText.substring(0, 50) + '...');
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
    console.log('Rewordly: Rewrite button clicked');
    console.log('Rewordly: Selected text:', this.selectedText);
    
    if (this.isProcessing) {
      console.log('Rewordly: Already processing');
      return;
    }

    console.log('Rewordly: Starting rewrite process');
    this.currentOperation = 'rewrite';
    this.hideFloatingButton();
    this.showModal();
    this.isProcessing = true;

    try {
      console.log('Rewordly: Calling Rewordly API');
      const rewrittenText = await this.rewriteText(this.selectedText);
      console.log('Rewordly: API response received:', rewrittenText);
      this.displayRewrittenText(rewrittenText);
    } catch (error) {
      console.error('Rewordly: Error rewriting text:', error);
      this.showError('Failed to rewrite text. Please try again.');
    } finally {
      this.isProcessing = false;
    }
  }

  private async handleGrammarClick(): Promise<void> {
    console.log('Rewordly: Grammar button clicked');
    console.log('Rewordly: Selected text:', this.selectedText);
    
    if (this.isProcessing) {
      console.log('Rewordly: Already processing');
      return;
    }

    console.log('Rewordly: Starting grammar correction process');
    this.currentOperation = 'grammar';
    this.hideFloatingButton();
    this.showModal();
    this.isProcessing = true;

    try {
      console.log('Rewordly: Calling Rewordly Grammar API');
      const correctedText = await this.grammarText(this.selectedText);
      console.log('Rewordly: Grammar API response received:', correctedText);
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
  }

  private hideModal(): void {
    if (this.modal) {
      this.modal.classList.remove('show');
      this.isModalOpen = false; // Clear flag when modal closes
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