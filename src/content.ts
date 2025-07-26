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
  
  private floatingButton: HTMLButtonElement | null = null;
  private modal: HTMLDivElement | null = null;
  private selectedText: string = '';
  private isProcessing: boolean = false;
  private isModalOpen: boolean = false; // Add flag to track modal state
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
          <!-- <button class="rewordly-replace-btn">Replace</button> -->
        </div>
      </div>
    `;
    
    // Add event listeners
    const closeBtn = this.modal.querySelector('.rewordly-close-btn') as HTMLButtonElement;
    const copyBtn = this.modal.querySelector('.rewordly-copy-btn') as HTMLButtonElement;
    
    closeBtn.addEventListener('click', this.hideModal.bind(this));
    copyBtn.addEventListener('click', this.copyRewrittenText.bind(this));
    
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
      this.floatingButton.classList.add('show');
    }
  }

  private hideFloatingButton(): void {
    if (this.floatingButton) {
      this.floatingButton.classList.remove('show');
    }
  }

  private async handleRewriteClick(): Promise<void> {
    console.log('Rewordly: Rewrite button clicked');
    console.log('Rewordly: Selected text:', this.selectedText);
    
    if (this.isProcessing) {
      console.log('Rewordly: Already processing');
      return;
    }

    console.log('Rewordly: Starting rewrite process');
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

  private showModal(): void {
    if (!this.modal) return;

    const originalText = this.modal.querySelector('.rewordly-original-text') as HTMLParagraphElement;
    const rewrittenText = this.modal.querySelector('.rewordly-rewritten-text') as HTMLParagraphElement;
    const loading = this.modal.querySelector('.rewordly-loading') as HTMLDivElement;

    originalText.textContent = this.selectedText;
    originalText.classList.add('show');
    rewrittenText.textContent = '';
    loading.classList.add('show');
    rewrittenText.classList.remove('show');

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

    loading.classList.remove('show');
    rewrittenText.textContent = text;
    rewrittenText.classList.add('show');
  }

  private showError(message: string): void {
    if (!this.modal) return;

    const rewrittenText = this.modal.querySelector('.rewordly-rewritten-text') as HTMLParagraphElement;
    const loading = this.modal.querySelector('.rewordly-loading') as HTMLDivElement;

    loading.classList.remove('show');
    rewrittenText.textContent = `Error: ${message}`;
    rewrittenText.classList.add('show');
    rewrittenText.classList.add('error');
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