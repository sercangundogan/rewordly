/**
 * Rewordly Content Script
 * Handles text selection, floating button UI, and displaying rewritten text
 */

interface RewordlyConfig {
  enabled: boolean;
  apiKey: string;
  model: string;
}

class RewordlyContentScript {
  private config: RewordlyConfig = {
    enabled: true,
    apiKey: '',
    model: 'gpt-3.5-turbo'
  };
  
  private floatingButton: HTMLButtonElement | null = null;
  private modal: HTMLDivElement | null = null;
  private selectedText: string = '';
  private isProcessing: boolean = false;
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
  }

  private async loadConfig(): Promise<void> {
    try {
      const result = await chrome.storage.sync.get(['rewordlyEnabled', 'rewordlyApiKey', 'rewordlyModel']);
      // Use environment variables as defaults if not set in storage
      this.config.enabled = result['rewordlyEnabled'] !== false;
      this.config.apiKey = result['rewordlyApiKey'] || process.env['OPENAI_API_KEY'] || '';
      this.config.model = result['rewordlyModel'] || process.env['DEFAULT_MODEL'] || 'gpt-3.5-turbo';
      
      console.log('Rewordly: Config loaded - API Key available:', !!this.config.apiKey);
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
    
    // Hide modal if clicking outside
    if (this.modal && !this.modal.contains(target) && !this.floatingButton?.contains(target)) {
      this.hideModal();
    }
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      this.hideModal();
      this.hideFloatingButton();
    }
  }

  private createFloatingButton(): void {
    this.floatingButton = document.createElement('button');
    this.floatingButton.className = 'rewordly-floating-button';
    this.floatingButton.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
        <polyline points="14,2 14,8 20,8"></polyline>
        <line x1="16" y1="13" x2="8" y2="13"></line>
        <line x1="16" y1="17" x2="8" y2="17"></line>
        <polyline points="10,9 9,9 8,9"></polyline>
      </svg>
      Rewrite
    `;
    this.floatingButton.addEventListener('click', this.handleRewriteClick.bind(this));
    document.body.appendChild(this.floatingButton);
  }

  private createModal(): void {
    this.modal = document.createElement('div');
    this.modal.className = 'rewordly-modal';
    this.modal.innerHTML = `
      <div class="rewordly-modal-content">
        <div class="rewordly-modal-header">
          <h3>Rewordly</h3>
          <button class="rewordly-close-btn">&times;</button>
        </div>
        <div class="rewordly-modal-body">
          <div class="rewordly-original">
            <h4>Original Text:</h4>
            <p class="rewordly-original-text"></p>
          </div>
          <div class="rewordly-rewritten">
            <h4>Rewritten Text:</h4>
            <div class="rewordly-loading" style="display: none;">
              <div class="rewordly-spinner"></div>
              <p>Rewriting...</p>
            </div>
            <p class="rewordly-rewritten-text"></p>
          </div>
        </div>
        <div class="rewordly-modal-footer">
          <button class="rewordly-copy-btn">Copy</button>
          <button class="rewordly-replace-btn">Replace</button>
        </div>
      </div>
    `;
    
    // Add event listeners
    const closeBtn = this.modal.querySelector('.rewordly-close-btn') as HTMLButtonElement;
    const copyBtn = this.modal.querySelector('.rewordly-copy-btn') as HTMLButtonElement;
    const replaceBtn = this.modal.querySelector('.rewordly-replace-btn') as HTMLButtonElement;
    
    closeBtn.addEventListener('click', this.hideModal.bind(this));
    copyBtn.addEventListener('click', this.copyRewrittenText.bind(this));
    replaceBtn.addEventListener('click', this.replaceOriginalText.bind(this));
    
    document.body.appendChild(this.modal);
  }

  private showFloatingButton(): void {
    if (!this.floatingButton) {
      return;
    }

    const selection = window.getSelection();
    
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      const rects = range.getBoundingClientRect();
      
      // Get viewport dimensions
      const viewportWidth = window.innerWidth;
      const buttonWidth = 120;
      const buttonHeight = 40;
      
      // Calculate position to the right of the selected text
      let buttonX = rects.right + 10;
      let buttonY = rects.top - 10;
      
      // If button would go off the right edge, position it to the left of the selection
      if (buttonX + buttonWidth > viewportWidth) {
        buttonX = rects.left - buttonWidth - 10;
      }
      
      // If button would go off the left edge, position it at the left edge
      if (buttonX < 0) {
        buttonX = 10;
      }
      
      // If button would go off the top edge, position it below the selection
      if (buttonY < 0) {
        buttonY = rects.bottom + 10;
      }
      
      // If button would go off the bottom edge, position it above the selection
      if (buttonY + buttonHeight > window.innerHeight) {
        buttonY = rects.top - buttonHeight - 10;
      }
      
      // Set the button position
      this.floatingButton.style.left = `${buttonX}px`;
      this.floatingButton.style.top = `${buttonY}px`;
      this.floatingButton.style.display = 'flex';
    }
  }

  private hideFloatingButton(): void {
    if (this.floatingButton) {
      this.floatingButton.style.display = 'none';
    }
  }

  private async handleRewriteClick(): Promise<void> {
    console.log('Rewordly: Rewrite button clicked');
    console.log('Rewordly: API Key available:', !!this.config.apiKey);
    console.log('Rewordly: Selected text:', this.selectedText);
    
    if (!this.config.apiKey) {
      console.log('Rewordly: No API key found');
      this.showError('Please set your OpenAI API key in the extension popup.');
      return;
    }

    if (this.isProcessing) {
      console.log('Rewordly: Already processing');
      return;
    }

    console.log('Rewordly: Starting rewrite process');
    this.hideFloatingButton();
    this.showModal();
    this.isProcessing = true;

    try {
      console.log('Rewordly: Calling OpenAI API');
      const rewrittenText = await this.rewriteText(this.selectedText);
      console.log('Rewordly: API response received:', rewrittenText);
      this.displayRewrittenText(rewrittenText);
    } catch (error) {
      console.error('Rewordly: Error rewriting text:', error);
      this.showError('Failed to rewrite text. Please check your API key and try again.');
    } finally {
      this.isProcessing = false;
    }
  }

  private async rewriteText(text: string): Promise<string> {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: [
          {
            role: 'system',
            content: 'You are a helpful assistant that rewrites text to improve grammar, clarity, and fluency while preserving the original meaning. Provide only the rewritten text without any explanations or additional formatting.'
          },
          {
            role: 'user',
            content: `Please rewrite the following text to improve its grammar, clarity, and fluency while preserving the original meaning: "${text}"`
          }
        ],
        max_tokens: 500,
        temperature: 0.7
      })
    });

    if (!response.ok) {
      throw new Error(`API request failed: ${response.status}`);
    }

    const data = await response.json();
    return data.choices[0]?.message?.content?.trim() || 'Failed to rewrite text.';
  }

  private showModal(): void {
    if (!this.modal) return;

    const originalText = this.modal.querySelector('.rewordly-original-text') as HTMLParagraphElement;
    const rewrittenText = this.modal.querySelector('.rewordly-rewritten-text') as HTMLParagraphElement;
    const loading = this.modal.querySelector('.rewordly-loading') as HTMLDivElement;

    originalText.textContent = this.selectedText;
    rewrittenText.textContent = '';
    loading.style.display = 'flex';
    rewrittenText.style.display = 'none';

    this.modal.style.display = 'flex';
    
    // Trigger animation
    setTimeout(() => {
      this.modal?.classList.add('show');
    }, 10);
  }

  private hideModal(): void {
    if (this.modal) {
      this.modal.classList.remove('show');
      setTimeout(() => {
        this.modal!.style.display = 'none';
      }, 300);
    }
  }

  private displayRewrittenText(text: string): void {
    if (!this.modal) return;

    const rewrittenText = this.modal.querySelector('.rewordly-rewritten-text') as HTMLParagraphElement;
    const loading = this.modal.querySelector('.rewordly-loading') as HTMLDivElement;

    loading.style.display = 'none';
    rewrittenText.textContent = text;
    rewrittenText.style.display = 'block';
    
    // Trigger animation
    setTimeout(() => {
      rewrittenText.classList.add('show');
    }, 10);
  }

  private showError(message: string): void {
    if (!this.modal) return;

    const rewrittenText = this.modal.querySelector('.rewordly-rewritten-text') as HTMLParagraphElement;
    const loading = this.modal.querySelector('.rewordly-loading') as HTMLDivElement;

    loading.style.display = 'none';
    rewrittenText.textContent = `Error: ${message}`;
    rewrittenText.style.display = 'block';
    rewrittenText.style.color = '#e74c3c';
  }

  private copyRewrittenText(): void {
    const rewrittenText = this.modal?.querySelector('.rewordly-rewritten-text') as HTMLParagraphElement;
    if (rewrittenText && rewrittenText.textContent) {
      navigator.clipboard.writeText(rewrittenText.textContent).then(() => {
        const copyBtn = this.modal?.querySelector('.rewordly-copy-btn') as HTMLButtonElement;
        if (copyBtn) {
          const originalText = copyBtn.textContent;
          copyBtn.textContent = 'Copied!';
          setTimeout(() => {
            copyBtn.textContent = originalText;
          }, 2000);
        }
      });
    }
  }

  private replaceOriginalText(): void {
    const selection = window.getSelection();
    const rewrittenText = this.modal?.querySelector('.rewordly-rewritten-text') as HTMLParagraphElement;
    
    if (selection && selection.rangeCount > 0 && rewrittenText?.textContent) {
      const range = selection.getRangeAt(0);
      range.deleteContents();
      range.insertNode(document.createTextNode(rewrittenText.textContent));
      this.hideModal();
    }
  }
}

// Initialize the content script
new RewordlyContentScript(); 