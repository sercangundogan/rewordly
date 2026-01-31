/**
 * Rewordly Content Script
 * Handles text selection, rewrite button UI, and displaying rewritten text
 */

interface RewordlyConfig {
  rewriteEnabled: boolean;
}

class RewordlyContentScript {
  private config: RewordlyConfig = {
    rewriteEnabled: true
  };
  
  private rewriteButton: HTMLDivElement | null = null;
  private modal: HTMLDivElement | null = null;
  private selectedText: string = '';
  private isProcessing: boolean = false;
  private isModalOpen: boolean = false;
  private currentOperation: 'rewrite' | 'grammar' = 'rewrite';

  /** Delay (ms) before showing the rewrite button after selection is made */
  private static readonly SHOW_BUTTON_DELAY_MS = 150;
  private showButtonTimeoutId: ReturnType<typeof setTimeout> | null = null;

  // Store bound event handlers to allow proper removal
  private boundHandleOutsideClick = this.handleOutsideClick.bind(this);
  private boundHandleKeyDown = this.handleKeyDown.bind(this);

  constructor() {
    this.init();
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
    // Load configuration from storage
    await this.loadConfig();
    
    // Set up event listeners
    this.setupEventListeners();
    
    // Show rewrite button only when user selects text (selectionchange)
    this.setupRewriteButtonListeners();
    
    // Create rewrite button (initially hidden)
    this.createRewriteButton();
    
    // Create modal (initially hidden)
    this.createModal();
    
    // Listen for settings updates from popup and context menu actions
    this.setupMessageListener();
  }

  private setupMessageListener(): void {
    chrome.runtime.onMessage.addListener((message: { type: string; action?: string; selectedText?: string }) => {
      if (message.type === 'SETTINGS_UPDATED') {
        this.loadConfig();
      } else if (message.type === 'CONTEXT_MENU_CLICKED' && message.selectedText) {
        if (message.action === 'rewrite') {
          this.handleContextMenuRewrite(message.selectedText);
        } else if (message.action === 'grammar') {
          this.handleContextMenuGrammar(message.selectedText);
        }
      }
    });
  }

  private async loadConfig(): Promise<void> {
    try {
      const result = await chrome.storage.sync.get(['rewordlyRewriteEnabled']);
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
    
    // selectionchange is in setupRewriteButtonListeners - button only shows when user selects text
  }

  /**
   * Set up selection listeners: show rewrite button only when user releases the mouse (mouseup).
   * Not while the button is still held, so no timer on selectionchange, only on mouseup.
   */
  private setupRewriteButtonListeners(): void {
    document.addEventListener('selectionchange', () => {
      if (!this.config.rewriteEnabled || !this.rewriteButton) {
        return;
      }
      const { length } = this.getSelectedTextAndLength();
      if (length < 3) {
        this.clearShowButtonTimeout();
        this.hideRewriteButton();
      }
    }, true);

    document.addEventListener('mouseup', () => {
      if (!this.config.rewriteEnabled || !this.rewriteButton) {
        return;
      }
      const { text, length } = this.getSelectedTextAndLength();
      if (!text || length < 3) {
        return;
      }
      this.clearShowButtonTimeout();
      this.showButtonTimeoutId = setTimeout(() => {
        this.showButtonTimeoutId = null;
        this.showRewriteButtonForSelection();
      }, RewordlyContentScript.SHOW_BUTTON_DELAY_MS);
    }, true);
  }

  private clearShowButtonTimeout(): void {
    if (this.showButtonTimeoutId !== null) {
      clearTimeout(this.showButtonTimeoutId);
      this.showButtonTimeoutId = null;
    }
  }

  /**
   * Returns currently selected text and its length. Handles input/textarea and contenteditable/document.
   */
  private getSelectedTextAndLength(): { text: string; length: number } {
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement) {
      const start = activeElement.selectionStart ?? 0;
      const end = activeElement.selectionEnd ?? 0;
      if (end <= start) {
        return { text: '', length: 0 };
      }
      const text = activeElement.value.substring(start, end).trim();
      return { text, length: text.length };
    }
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return { text: '', length: 0 };
    }
    const text = selection.toString().trim();
    return { text, length: text.length };
  }

  private isEditableElement(element: HTMLElement): boolean {
    if (element instanceof HTMLInputElement) {
      const type = element.type.toLowerCase();
      return type === 'text' || type === 'email' || type === 'search' || type === '' || type === 'url';
    }
    if (element instanceof HTMLTextAreaElement) {
      return true;
    }
    const contentEditable = element.getAttribute('contenteditable');
    return contentEditable === 'true' || contentEditable === '' || (contentEditable !== null && contentEditable !== 'false');
  }

  private handleOutsideClick(event: Event): void {
    const target = event.target as HTMLElement;
    
    // Hide rewrite button if clicking outside (unless this click is the mouseup that just completed a selection)
    if (this.rewriteButton && !this.rewriteButton.contains(target)) {
      const { length } = this.getSelectedTextAndLength();
      if (event.type === 'click' && length >= 3) {
        return; // selection still active; likely mouseup from selection. Let the delayed show handle it
      }
      this.hideRewriteButton();
    }
    
    // Hide modal if clicking outside or on the backdrop
    if (this.modal && this.isModalOpen) {
      // Check if click is on the modal backdrop (the modal element itself, not its content)
      if (target === this.modal || (!this.modal.contains(target) && !this.rewriteButton?.contains(target))) {
        this.hideModal();
      }
    }
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      this.hideModal();
      this.hideRewriteButton();
    }
  }

  private createRewriteButton(): void {
    this.rewriteButton = document.createElement('div');
    this.rewriteButton.className = 'rewordly-rewrite-button-container';
    this.rewriteButton.innerHTML = `
      <div class="rewordly-combined-rewrite-btn">
        <button type="button" class="rewordly-rewrite-part" aria-label="Rewrite">
          <svg xmlns="http://www.w3.org/2000/svg" fill="currentColor" viewBox="0 0 56 56" width="16" height="16">
            <path d="M 26.6875 12.6602 C 26.9687 12.6602 27.1094 12.4961 27.1797 12.2383 C 27.9062 8.3242 27.8594 8.2305 31.9375 7.4570 C 32.2187 7.4102 32.3828 7.2461 32.3828 6.9648 C 32.3828 6.6836 32.2187 6.5195 31.9375 6.4726 C 27.8828 5.6524 28.0000 5.5586 27.1797 1.6914 C 27.1094 1.4336 26.9687 1.2695 26.6875 1.2695 C 26.4062 1.2695 26.2656 1.4336 26.1953 1.6914 C 25.3750 5.5586 25.5156 5.6524 21.4375 6.4726 C 21.1797 6.5195 20.9922 6.6836 20.9922 6.9648 C 20.9922 7.2461 21.1797 7.4102 21.4375 7.4570 C 25.5156 8.2774 25.4687 8.3242 26.1953 12.2383 C 26.2656 12.4961 26.4062 12.6602 26.6875 12.6602 Z M 15.3438 28.7852 C 15.7891 28.7852 16.0938 28.5039 16.1406 28.0821 C 16.9844 21.8242 17.1953 21.8242 23.6641 20.5821 C 24.0860 20.5117 24.3906 20.2305 24.3906 19.7852 C 24.3906 19.3633 24.0860 19.0586 23.6641 18.9883 C 17.1953 18.0977 16.9609 17.8867 16.1406 11.5117 C 16.0938 11.0899 15.7891 10.7852 15.3438 10.7852 C 14.9219 10.7852 14.6172 11.0899 14.5703 11.5352 C 13.7969 17.8164 13.4687 17.7930 7.0469 18.9883 C 6.6250 19.0821 6.3203 19.3633 6.3203 19.7852 C 6.3203 20.2539 6.6250 20.5117 7.1406 20.5821 C 13.5156 21.6133 13.7969 21.7774 14.5703 28.0352 C 14.6172 28.5039 14.9219 28.7852 15.3438 28.7852 Z M 31.2344 54.7305 C 31.8438 54.7305 32.2891 54.2852 32.4062 53.6524 C 34.0703 40.8086 35.8750 38.8633 48.5781 37.4570 C 49.2344 37.3867 49.6797 36.8945 49.6797 36.2852 C 49.6797 35.6758 49.2344 35.2070 48.5781 35.1133 C 35.8750 33.7070 34.0703 31.7617 32.4062 18.9180 C 32.2891 18.2852 31.8438 17.8633 31.2344 17.8633 C 30.6250 17.8633 30.1797 18.2852 30.0860 18.9180 C 28.4219 31.7617 26.5938 33.7070 13.9140 35.1133 C 13.2344 35.2070 12.7891 35.6758 12.7891 36.2852 C 12.7891 36.8945 13.2344 37.3867 13.9140 37.4570 C 26.5703 39.1211 28.3281 40.8321 30.0860 53.6524 C 30.1797 54.2852 30.6250 54.7305 31.2344 54.7305 Z"/>
          </svg>
        </button>
        <button type="button" class="rewordly-grammar-part" aria-label="Check Grammar">
          <svg xmlns="http://www.w3.org/2000/svg" fill="currentColor" viewBox="0 0 24 24" width="14" height="14">
            <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/>
          </svg>
        </button>
      </div>
    `;

    // Tooltips for both parts
    const tooltipRewrite = document.createElement('span');
    tooltipRewrite.className = 'rewordly-ai-tooltip';
    tooltipRewrite.textContent = 'Rewrite';
    document.body.appendChild(tooltipRewrite);

    const tooltipGrammar = document.createElement('span');
    tooltipGrammar.className = 'rewordly-ai-tooltip';
    tooltipGrammar.textContent = 'Check Grammar';
    document.body.appendChild(tooltipGrammar);

    const combinedBtn = this.rewriteButton.querySelector('.rewordly-combined-rewrite-btn') as HTMLDivElement;
    const rewritePart = this.rewriteButton.querySelector('.rewordly-rewrite-part') as HTMLButtonElement;
    const grammarPart = this.rewriteButton.querySelector('.rewordly-grammar-part') as HTMLButtonElement;

    // Prevent blur when clicking any part of the button
    combinedBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    rewritePart.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.handleRewriteClick();
    });

    grammarPart.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.handleGrammarClick();
    });

    // Tooltip for rewrite part
    const showRewriteTooltip = () => {
      const rect = rewritePart.getBoundingClientRect();
      tooltipRewrite.style.left = `${rect.left + rect.width / 2}px`;
      tooltipRewrite.style.top = `${rect.top - 5}px`;
      tooltipRewrite.classList.add('show');
    };
    const hideRewriteTooltip = () => tooltipRewrite.classList.remove('show');
    rewritePart.addEventListener('mouseenter', showRewriteTooltip);
    rewritePart.addEventListener('mouseleave', hideRewriteTooltip);

    // Tooltip for grammar part
    const showGrammarTooltip = () => {
      const rect = grammarPart.getBoundingClientRect();
      tooltipGrammar.style.left = `${rect.left + rect.width / 2}px`;
      tooltipGrammar.style.top = `${rect.top - 5}px`;
      tooltipGrammar.classList.add('show');
    };
    const hideGrammarTooltip = () => tooltipGrammar.classList.remove('show');
    grammarPart.addEventListener('mouseenter', showGrammarTooltip);
    grammarPart.addEventListener('mouseleave', hideGrammarTooltip);

    const updateTooltipPositions = () => {
      if (tooltipRewrite.classList.contains('show')) {
        const rect = rewritePart.getBoundingClientRect();
        tooltipRewrite.style.left = `${rect.left + rect.width / 2}px`;
        tooltipRewrite.style.top = `${rect.top - 5}px`;
      }
      if (tooltipGrammar.classList.contains('show')) {
        const rect = grammarPart.getBoundingClientRect();
        tooltipGrammar.style.left = `${rect.left + rect.width / 2}px`;
        tooltipGrammar.style.top = `${rect.top - 5}px`;
      }
    };

    window.addEventListener('scroll', updateTooltipPositions, true);
    window.addEventListener('resize', updateTooltipPositions);

    document.body.appendChild(this.rewriteButton);
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
   * Show rewrite button at an appropriate position near the user's text selection.
   * Only called when there is a selection of 3+ characters (enforced in selectionchange).
   */
  private showRewriteButtonForSelection(): void {
    if (!this.rewriteButton || !this.config.rewriteEnabled) {
      return;
    }

    const { text } = this.getSelectedTextAndLength();
    if (!text || text.length < 3) {
      return;
    }
    this.selectedText = text;

    const buttonWidth = 56;
    const buttonHeight = 32;
    const offset = 8;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    // --- Input/textarea: use selection end position ---
    const activeElement = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
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
      (this.rewriteButton as any).__currentElement = activeElement;

      let buttonX = caretRect.right + offset;
      let buttonY = caretRect.top - offset;
      if (buttonX + buttonWidth > viewportWidth) {
        buttonX = caretRect.left - buttonWidth - offset;
      }
      if (buttonX < 0) buttonX = offset;
      if (buttonY < 0) buttonY = caretRect.bottom + offset;
      if (buttonY + buttonHeight > viewportHeight) {
        buttonY = caretRect.top - buttonHeight - offset;
      }
      buttonX = Math.max(offset, Math.min(buttonX, viewportWidth - buttonWidth - offset));
      buttonY = Math.max(offset, Math.min(buttonY, viewportHeight - buttonHeight - offset));

      this.rewriteButton.style.display = 'flex';
      this.rewriteButton.style.visibility = 'visible';
      this.rewriteButton.style.opacity = '1';
      this.rewriteButton.style.left = `${buttonX}px`;
      this.rewriteButton.style.top = `${buttonY}px`;
      this.rewriteButton.classList.add('show');
      return;
    }

    // --- Contenteditable / document selection: use range rects ---
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return;
    }
    const range = selection.getRangeAt(0);
    let rect: DOMRect | null = null;

    try {
      const clientRects = range.getClientRects();
      if (clientRects && clientRects.length > 0) {
        const lastRect = clientRects[clientRects.length - 1];
        if (lastRect && lastRect.width > 0 && lastRect.height > 0) {
          rect = lastRect;
        }
      }
    } catch {
      // ignore
    }
    if (!rect || rect.width === 0 || rect.height === 0) {
      try {
        const rangeRect = range.getBoundingClientRect();
        if (rangeRect && rangeRect.width > 0 && rangeRect.height > 0) {
          rect = rangeRect;
        }
      } catch {
        // ignore
      }
    }
    if (!rect || rect.width === 0 || rect.height === 0) {
      try {
        const commonAncestor = range.commonAncestorContainer;
        let element: HTMLElement | null =
          commonAncestor.nodeType === Node.TEXT_NODE
            ? commonAncestor.parentElement
            : (commonAncestor as HTMLElement);
        if (element) {
          const elementRect = element.getBoundingClientRect();
          if (elementRect && elementRect.width > 0 && elementRect.height > 0) {
            rect = elementRect;
          }
        }
      } catch {
        // ignore
      }
    }
    if (!rect || rect.width === 0 || rect.height === 0) {
      return;
    }

    const focusNode = selection.focusNode;
    let anchorElement: HTMLElement | null = null;
    if (focusNode) {
      anchorElement =
        focusNode.nodeType === Node.TEXT_NODE
          ? focusNode.parentElement
          : (focusNode as HTMLElement);
      if (anchorElement && this.isEditableElement(anchorElement)) {
        anchorElement = anchorElement.closest('[contenteditable="true"]') || anchorElement;
      }
    }
    (this.rewriteButton as any).__currentElement = anchorElement || undefined;

    let buttonX = rect.right + offset;
    let buttonY = rect.top - offset;
    if (buttonX + buttonWidth > viewportWidth) {
      buttonX = rect.left - buttonWidth - offset;
    }
    if (buttonX < 0) buttonX = offset;
    if (buttonY < 0) buttonY = rect.bottom + offset;
    if (buttonY + buttonHeight > viewportHeight) {
      buttonY = rect.top - buttonHeight - offset;
    }
    buttonX = Math.max(offset, Math.min(buttonX, viewportWidth - buttonWidth - offset));
    buttonY = Math.max(offset, Math.min(buttonY, viewportHeight - buttonHeight - offset));

    this.rewriteButton.style.display = 'flex';
    this.rewriteButton.style.visibility = 'visible';
    this.rewriteButton.style.opacity = '1';
    this.rewriteButton.style.left = `${buttonX}px`;
    this.rewriteButton.style.top = `${buttonY}px`;
    this.rewriteButton.classList.add('show');
  }

  private hideRewriteButton(): void {
    if (this.rewriteButton) {
      this.rewriteButton.classList.remove('show');
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

    // Button only appears when user selected text; we store it in this.selectedText
    const textToRewrite = this.selectedText?.trim() ?? '';
    if (!textToRewrite || textToRewrite.length < 3) {
      return;
    }

    this.currentOperation = 'rewrite';
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

  private async handleGrammarClick(): Promise<void> {
    if (this.isProcessing) {
      return;
    }

    // Button only appears when user selected text; we store it in this.selectedText
    const textToCheck = this.selectedText?.trim() ?? '';
    if (!textToCheck || textToCheck.length < 3) {
      return;
    }

    this.currentOperation = 'grammar';
    this.showModal();
    this.isProcessing = true;

    try {
      const correctedText = await this.grammarText(textToCheck);
      this.displayRewrittenText(correctedText);
    } catch (error) {
      console.error('Rewordly: Error checking grammar:', error);
      this.showError('Failed to check grammar. Please try again.');
    } finally {
      this.isProcessing = false;
    }
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
    const response = await fetch('https://rewordly.store/api/rewrite', {
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
    const response = await fetch('https://rewordly.store/api/grammar', {
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
    
    // Hide the rewrite button when modal is open
    this.hideRewriteButton();
  }

  private hideModal(): void {
    if (this.modal) {
      this.modal.classList.remove('show');
      this.isModalOpen = false;
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
}

// Initialize the content script
new RewordlyContentScript();