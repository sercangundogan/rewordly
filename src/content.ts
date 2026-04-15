/**
 * Rewordly Content Script
 * Handles text selection, rewrite button UI, and displaying rewritten text
 */

import { API_BASE } from './config';
import { getApiHeaders, setSession } from './auth';

// Auto-connect / logout: website sends token or logout via postMessage (dashboard page)
(function setupConnectAndLogoutListener() {
  try {
    if (typeof window === 'undefined') return;
    window.addEventListener('message', (event) => {
      if (event.source !== window || !event.data?.type) return;
      const type = event.data.type as string;

      if (type === 'REWORDLY_CONNECT') {
        const code = String(event.data?.token ?? '').trim().toUpperCase().slice(0, 6);
        if (code.length !== 6) return;
        fetch(`${API_BASE}/api/auth/exchange-connection-code`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code }),
        })
          .then((r) => r.json())
          .then(async (data) => {
            const accessToken = data?.access_token;
            if (accessToken) await setSession({ access_token: accessToken });
          })
          .catch(() => {});
        return;
      }

      if (type === 'REWORDLY_LOGOUT') {
        setSession(null).catch(() => {});
      }
    });
  } catch {
    // ignore
  }
})();

interface RewordlyConfig {
  rewriteEnabled: boolean;
  rewriteTone: 'standard' | 'formal' | 'casual' | 'concise' | 'elaborate';
}

class RewordlyContentScript {
  private config: RewordlyConfig = {
    rewriteEnabled: true
    ,rewriteTone: 'standard'
  };
  
  private rewriteButton: HTMLDivElement | null = null;
  private modal: HTMLDivElement | null = null;
  private selectedText: string = '';
  private isProcessing: boolean = false;
  private isModalOpen: boolean = false;
  private currentOperation: 'rewrite' | 'grammar' = 'rewrite';

  // Tone selector for rewrite operations (persisted in sync storage)
  private currentTone: RewordlyConfig['rewriteTone'] = 'standard';

  // Source element tracking for "Apply" (direct replacement in editable fields)
  private sourceElement: HTMLInputElement | HTMLTextAreaElement | Element | null = null;
  private sourceSelectionStart: number = 0;
  private sourceSelectionEnd: number = 0;
  private savedRange: Range | null = null;
  private isEditableSource: boolean = false;

  /** Delay (ms) before showing the rewrite button after selection is made */
  private static readonly SHOW_BUTTON_DELAY_MS = 150;
  private showButtonTimeoutId: ReturnType<typeof setTimeout> | null = null;

  // Store bound event handlers to allow proper removal
  private boundHandleOutsideClick = this.handleOutsideClick.bind(this);
  private boundHandleKeyDown = this.handleKeyDown.bind(this);

  // Scroll lock while modal open
  private prevBodyOverflow: string = '';
  private prevHtmlOverflow: string = '';

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
    // Always set up message listener first so context menu (Rewrite/Grammar) works even on disabled pages
    this.setupMessageListener();

    const pageDisabled = await this.isPageDisabled();
    if (pageDisabled) {
      // On disabled pages: only support context menu actions (right-click → Rewrite/Grammar)
      await this.loadConfig();
      this.setupEventListeners();
      this.createModal();
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
      } else if (message.type === 'SHORTCUT_TRIGGERED' && (message.action === 'rewrite' || message.action === 'grammar')) {
        const selectedText = window.getSelection()?.toString()?.trim() ?? '';
        if (!selectedText || selectedText.length < 3) {
          this.showShortcutHint();
          return;
        }
        if (message.action === 'rewrite') {
          this.handleContextMenuRewrite(selectedText);
        } else {
          this.handleContextMenuGrammar(selectedText);
        }
      }
    });
  }

  /** Show a brief hint when shortcut is used but no valid selection exists */
  private showShortcutHint(): void {
    const hint = document.createElement('div');
    hint.className = 'rewordly-shortcut-hint';
    hint.textContent = 'Select at least 3 characters of text first';
    hint.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1f2937;color:#fff;padding:10px 16px;border-radius:8px;font-size:13px;z-index:2147483647;box-shadow:0 4px 12px rgba(0,0,0,0.3);font-family:system-ui,sans-serif;';
    document.body.appendChild(hint);
    setTimeout(() => hint.remove(), 2500);
  }

  private async loadConfig(): Promise<void> {
    try {
      const result = await chrome.storage.sync.get(['rewordlyRewriteEnabled', 'rewordlyRewriteTone']);
      this.config.rewriteEnabled = result['rewordlyRewriteEnabled'] !== false;
      const storedTone = result['rewordlyRewriteTone'];
      const validTones: RewordlyConfig['rewriteTone'][] = ['standard', 'formal', 'casual', 'concise', 'elaborate'];
      this.config.rewriteTone = validTones.includes(storedTone) ? storedTone : 'standard';
      this.currentTone = this.config.rewriteTone;
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
    // isContentEditable covers nested nodes inside a contenteditable root and
    // supports non-standard values (e.g. plaintext-only).
    return element.isContentEditable;
  }

  /**
   * Snapshot the current selection source so the Apply button can later
   * replace the selected text directly in the originating editable element.
   * Must be called before the modal opens (while focus / selection is intact).
   */
  private captureSelectionSource(): void {
    this.sourceElement = null;
    this.sourceSelectionStart = 0;
    this.sourceSelectionEnd = 0;
    this.savedRange = null;
    this.isEditableSource = false;

    // input / textarea — read selectionStart/End directly
    const activeEl = document.activeElement;
    if (activeEl instanceof HTMLInputElement || activeEl instanceof HTMLTextAreaElement) {
      const start = activeEl.selectionStart ?? 0;
      const end = activeEl.selectionEnd ?? 0;
      if (end > start) {
        this.sourceElement = activeEl;
        this.sourceSelectionStart = start;
        this.sourceSelectionEnd = end;
        this.isEditableSource = true;
        return;
      }
    }

    // contenteditable — clone the current Range
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;

    const focusNode = selection.focusNode;
    if (!focusNode) return;

    const el =
      focusNode.nodeType === Node.TEXT_NODE
        ? focusNode.parentElement
        : (focusNode as HTMLElement);

    if (el) {
      // Prefer the nearest contenteditable root (many editors have nested spans)
      const root =
        (el.closest('[contenteditable]:not([contenteditable="false"])') as HTMLElement | null) || null;
      const candidate = root || el;
      if (!this.isEditableElement(candidate)) return;

      this.sourceElement = candidate;
      try {
        this.savedRange = selection.getRangeAt(0).cloneRange();
      } catch {
        // ignore
      }
      this.isEditableSource = true;
    }
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
    // Shortcuts only active while the modal is open
    if (!this.isModalOpen) {
      if (event.key === 'Escape') {
        this.hideRewriteButton();
      }
      return;
    }

    // Esc — close modal
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.hideModal();
      this.hideRewriteButton();
      return;
    }

    // Cmd/Ctrl + C — copy result (only when result is visible and not loading)
    if (event.key === 'c' && (event.metaKey || event.ctrlKey)) {
      const rewrittenEl = this.modal?.querySelector('.rewordly-rewritten-text') as HTMLParagraphElement | null;
      if (rewrittenEl?.classList.contains('show') && rewrittenEl.textContent) {
        event.preventDefault();
        event.stopPropagation();
        this.copyRewrittenText();
      }
      return;
    }

    // Tab — cycle between Rewrite and Grammar buttons in the floating button bar,
    //        or re-run the operation with the other type when modal is already showing a result
    if (event.key === 'Tab' && !event.altKey && !event.metaKey && !event.ctrlKey) {
      const rewrittenEl = this.modal?.querySelector('.rewordly-rewritten-text') as HTMLParagraphElement | null;
      const hasResult = rewrittenEl?.classList.contains('show') && !this.isProcessing;
      if (!hasResult) return; // Don't interrupt while loading

      event.preventDefault();
      event.stopPropagation();

      const next = this.currentOperation === 'rewrite' ? 'grammar' : 'rewrite';
      this.currentOperation = next;

      // Update modal title so the user sees which operation is active
      const modalTitle = this.modal?.querySelector('.rewordly-modal-title') as HTMLHeadingElement | null;
      const resultTitle = this.modal?.querySelector('.rewordly-result-title') as HTMLHeadingElement | null;
      if (modalTitle) modalTitle.textContent = next === 'grammar' ? 'Grammar Check' : 'Rewordly';
      if (resultTitle) resultTitle.textContent = next === 'grammar' ? 'Corrected Text:' : 'Rewritten Text:';

      // Show/hide tone selector
      const toneSelector = this.modal?.querySelector('.rewordly-tone-selector') as HTMLDivElement | null;
      if (toneSelector) toneSelector.style.display = next === 'rewrite' ? '' : 'none';

      // Re-run with the switched operation
      this.showModal();
      this.isProcessing = true;
      const text = this.selectedText?.trim() ?? '';
      const run = next === 'rewrite'
        ? this.rewriteText(text)
        : this.grammarText(text);

      run.then((result) => this.displayRewrittenText(result))
        .catch((error) => {
          const err = error as Error & { code?: string; requireLogin?: boolean; requirePayment?: boolean };
          if (err.code === 'LIMIT_REACHED') {
            this.showLimitNotice(err.requireLogin ?? true, err.requirePayment ?? false, err.message);
          } else {
            this.showError(`Failed to ${next === 'rewrite' ? 'rewrite' : 'check grammar'}. Please try again.`);
          }
        })
        .finally(() => { this.isProcessing = false; });
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
            <div class="rewordly-tone-selector" style="display: none;">
              <button type="button" class="rewordly-tone-pill rewordly-tone-active" data-tone="standard">Standard</button>
              <button type="button" class="rewordly-tone-pill" data-tone="formal">Formal</button>
              <button type="button" class="rewordly-tone-pill" data-tone="casual">Casual</button>
              <button type="button" class="rewordly-tone-pill" data-tone="concise">Concise</button>
              <button type="button" class="rewordly-tone-pill" data-tone="elaborate">Elaborate</button>
            </div>
            <div class="rewordly-loading" style="display: none;">
              <div class="rewordly-spinner"></div>
              <p class="rewordly-loading-text">Processing...</p>
            </div>
            <p class="rewordly-rewritten-text"></p>
            <div class="rewordly-limit-notice" style="display: none;">
              <p class="rewordly-limit-message"></p>
              <div class="rewordly-limit-actions">
                <button type="button" class="rewordly-limit-btn rewordly-login-btn">Log in</button>
                <button type="button" class="rewordly-limit-btn rewordly-upgrade-btn">Email for free limits</button>
              </div>
            </div>
          </div>
        </div>
        <div class="rewordly-modal-footer">
          <button class="rewordly-copy-btn">Copy</button>
          <button class="rewordly-apply-btn" style="display: none;">Apply</button>
        </div>
      </div>
    `;
    
    // Add event listeners
    const closeBtn = this.modal.querySelector('.rewordly-close-btn') as HTMLButtonElement;
    const copyBtn = this.modal.querySelector('.rewordly-copy-btn') as HTMLButtonElement;
    const applyBtn = this.modal.querySelector('.rewordly-apply-btn') as HTMLButtonElement;

    closeBtn.addEventListener('click', this.hideModal.bind(this));
    copyBtn.addEventListener('click', this.copyRewrittenText.bind(this));
    applyBtn.addEventListener('click', this.applyRewrittenText.bind(this));

    // Tone pill clicks — persist + re-run rewrite with selected tone
    const tonePills = this.modal.querySelectorAll('.rewordly-tone-pill');
    tonePills.forEach((pill) => {
      pill.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (this.isProcessing) return;
        const tone = (pill as HTMLElement).dataset['tone'] ?? 'standard';
        if (tone === this.currentTone) return;
        this.currentTone = tone as any;
        chrome.storage.sync.set({ rewordlyRewriteTone: this.currentTone }).catch(() => {});
        // Update active pill
        tonePills.forEach((p) => p.classList.remove('rewordly-tone-active'));
        pill.classList.add('rewordly-tone-active');
        // Re-run rewrite with new tone
        this.rerunRewriteWithTone();
      });
    });

    const loginBtn = this.modal.querySelector('.rewordly-login-btn') as HTMLButtonElement;
    const upgradeBtn = this.modal.querySelector('.rewordly-upgrade-btn') as HTMLButtonElement;
    const loginUrl = `${API_BASE}/login`;
    const freeLimitsEmail = 'mailto:sercangundogan35@gmail.com?subject=Rewordly%20Free%20Limits';
    if (loginBtn) {
      loginBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'OPEN_TAB', url: loginUrl });
      });
    }
    if (upgradeBtn) {
      upgradeBtn.addEventListener('click', () => {
        window.open(freeLimitsEmail, '_blank');
      });
    }

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

    this.captureSelectionSource();
    this.currentOperation = 'rewrite';
    // Don't hide button immediately - let blur handle it if needed
    this.showModal();
    this.isProcessing = true;

    try {
      const rewrittenText = await this.rewriteText(textToRewrite);
      this.displayRewrittenText(rewrittenText);
    } catch (error) {
      const err = error as Error & { code?: string; requireLogin?: boolean; requirePayment?: boolean };
      if (err.code === 'LIMIT_REACHED') {
        this.showLimitNotice(err.requireLogin ?? true, err.requirePayment ?? false, err.message);
      } else {
        console.error('Rewordly: Error rewriting text:', error);
        this.showError('Failed to rewrite text. Please try again.');
      }
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

    this.captureSelectionSource();
    this.currentOperation = 'grammar';
    this.showModal();
    this.isProcessing = true;

    try {
      const correctedText = await this.grammarText(textToCheck);
      this.displayRewrittenText(correctedText);
    } catch (error) {
      const err = error as Error & { code?: string; requireLogin?: boolean; requirePayment?: boolean };
      if (err.code === 'LIMIT_REACHED') {
        this.showLimitNotice(err.requireLogin ?? true, err.requirePayment ?? false, err.message);
      } else {
        console.error('Rewordly: Error checking grammar:', error);
        this.showError('Failed to check grammar. Please try again.');
      }
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

    this.captureSelectionSource();
    this.currentOperation = 'rewrite';
    this.selectedText = selectedText;
    this.showModal();
    this.isProcessing = true;

    try {
      const rewrittenText = await this.rewriteText(selectedText);
      this.displayRewrittenText(rewrittenText);
    } catch (error) {
      const err = error as Error & { code?: string; requireLogin?: boolean; requirePayment?: boolean };
      if (err.code === 'LIMIT_REACHED') {
        this.showLimitNotice(err.requireLogin ?? true, err.requirePayment ?? false, err.message);
      } else {
        console.error('Rewordly: Error rewriting text:', error);
        this.showError('Failed to rewrite text. Please try again.');
      }
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

    this.captureSelectionSource();
    this.currentOperation = 'grammar';
    this.selectedText = selectedText;
    this.showModal();
    this.isProcessing = true;

    try {
      const correctedText = await this.grammarText(selectedText);
      this.displayRewrittenText(correctedText);
    } catch (error) {
      const err = error as Error & { code?: string; requireLogin?: boolean; requirePayment?: boolean };
      if (err.code === 'LIMIT_REACHED') {
        this.showLimitNotice(err.requireLogin ?? true, err.requirePayment ?? false, err.message);
      } else {
        console.error('Rewordly: Error checking grammar:', error);
        this.showError('Failed to check grammar. Please try again.');
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /** Re-run the rewrite on already-fetched selectedText with the newly selected tone */
  private async rerunRewriteWithTone(): Promise<void> {
    const text = this.selectedText?.trim() ?? '';
    if (!text || text.length < 3 || !this.modal) return;

    // Show loading state without re-opening modal (it's already open)
    const rewrittenText = this.modal.querySelector('.rewordly-rewritten-text') as HTMLParagraphElement;
    const loading = this.modal.querySelector('.rewordly-loading') as HTMLDivElement;
    const loadingText = this.modal.querySelector('.rewordly-loading-text') as HTMLParagraphElement;
    const applyBtn = this.modal.querySelector('.rewordly-apply-btn') as HTMLButtonElement;
    const copyBtn = this.modal.querySelector('.rewordly-copy-btn') as HTMLButtonElement;

    rewrittenText.classList.remove('show', 'error');
    rewrittenText.textContent = '';
    loading.classList.add('show');
    if (loadingText) loadingText.textContent = 'Rewriting...';
    if (applyBtn) applyBtn.style.display = 'none';
    if (copyBtn) copyBtn.disabled = true;

    this.isProcessing = true;
    try {
      const result = await this.rewriteText(text);
      this.displayRewrittenText(result);
    } catch (error) {
      const err = error as Error & { code?: string; requireLogin?: boolean; requirePayment?: boolean };
      if (err.code === 'LIMIT_REACHED') {
        this.showLimitNotice(err.requireLogin ?? true, err.requirePayment ?? false, err.message);
      } else {
        this.showError('Failed to rewrite text. Please try again.');
      }
    } finally {
      this.isProcessing = false;
      if (copyBtn) copyBtn.disabled = false;
    }
  }

  private async rewriteText(text: string): Promise<string> {
    const headers = await getApiHeaders();
    const response = await fetch(`${API_BASE}/api/rewrite`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text, tone: this.currentTone }),
    });

    const data = await response.json().catch(() => ({}));
    if (response.status === 402 && (data.code === 'LIMIT_REACHED' || data.requireLogin !== undefined)) {
      const err = new Error(data.message || 'Daily limit reached.') as Error & {
        code?: string;
        requireLogin?: boolean;
        requirePayment?: boolean;
      };
      err.code = 'LIMIT_REACHED';
      err.requireLogin = data.requireLogin;
      err.requirePayment = data.requirePayment;
      throw err;
    }
    if (!response.ok) {
      throw new Error((data.message as string) || `API request failed: ${response.status}`);
    }
    return (data.rewritten as string) || 'Failed to rewrite text.';
  }

  private async grammarText(text: string): Promise<string> {
    const headers = await getApiHeaders();
    const response = await fetch(`${API_BASE}/api/grammar`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text, mode: 'ai' }),
    });

    const data = await response.json().catch(() => ({}));
    if (response.status === 402 && (data.code === 'LIMIT_REACHED' || data.requireLogin !== undefined)) {
      const err = new Error(data.message || 'Daily limit reached.') as Error & {
        code?: string;
        requireLogin?: boolean;
        requirePayment?: boolean;
      };
      err.code = 'LIMIT_REACHED';
      err.requireLogin = data.requireLogin;
      err.requirePayment = data.requirePayment;
      throw err;
    }
    if (!response.ok) {
      throw new Error((data.message as string) || `API request failed: ${response.status}`);
    }
    return (data.corrected as string) || 'Failed to fix grammar.';
  }

  private showModal(): void {
    if (!this.modal) return;

    const originalText = this.modal.querySelector('.rewordly-original-text') as HTMLParagraphElement;
    const rewrittenText = this.modal.querySelector('.rewordly-rewritten-text') as HTMLParagraphElement;
    const loading = this.modal.querySelector('.rewordly-loading') as HTMLDivElement;
    const modalTitle = this.modal.querySelector('.rewordly-modal-title') as HTMLHeadingElement;
    const resultTitle = this.modal.querySelector('.rewordly-result-title') as HTMLHeadingElement;
    const loadingText = this.modal.querySelector('.rewordly-loading-text') as HTMLParagraphElement;
    const limitNotice = this.modal.querySelector('.rewordly-limit-notice') as HTMLDivElement;
    const limitMessage = this.modal.querySelector('.rewordly-limit-message') as HTMLParagraphElement;

    originalText.textContent = this.selectedText;
    originalText.classList.add('show');
    rewrittenText.textContent = '';
    rewrittenText.style.removeProperty('display');
    rewrittenText.classList.remove('show', 'error');
    loading.classList.add('show');
    if (resultTitle) resultTitle.style.removeProperty('display');
    if (limitNotice) limitNotice.style.display = 'none';
    if (limitMessage) limitMessage.textContent = '';
    
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

    // Reset + hide Apply button while loading — shown in displayRewrittenText when ready
    const applyBtn = this.modal.querySelector('.rewordly-apply-btn') as HTMLButtonElement;
    if (applyBtn) {
      applyBtn.style.display = 'none';
      applyBtn.textContent = 'Apply';
      applyBtn.style.background = '';
    }

    // Show tone selector only for rewrite; keep user's persisted tone
    const toneSelector = this.modal.querySelector('.rewordly-tone-selector') as HTMLDivElement;
    if (toneSelector) {
      if (this.currentOperation === 'rewrite') {
        toneSelector.style.display = '';
        toneSelector.querySelectorAll('.rewordly-tone-pill').forEach((p) => {
          p.classList.remove('rewordly-tone-active');
          if ((p as HTMLElement).dataset['tone'] === this.currentTone) {
            p.classList.add('rewordly-tone-active');
          }
        });
      } else {
        toneSelector.style.display = 'none';
      }
    }

    this.modal.classList.add('show');
    this.isModalOpen = true; // Set flag when modal opens

    // Lock background scroll while modal is open
    try {
      const body = document.body;
      const html = document.documentElement;
      body.classList.add('rewordly-modal-open');
      html.classList.add('rewordly-modal-open');
      this.prevBodyOverflow = body.style.overflow;
      this.prevHtmlOverflow = html.style.overflow;
      body.style.overflow = 'hidden';
      html.style.overflow = 'hidden';
    } catch {
      // ignore
    }
    
    // Hide the rewrite button when modal is open
    this.hideRewriteButton();
  }

  private hideModal(): void {
    if (this.modal) {
      this.modal.classList.remove('show');
      this.isModalOpen = false;
      // Reset Apply button state so it never "sticks" across opens
      const applyBtn = this.modal.querySelector('.rewordly-apply-btn') as HTMLButtonElement | null;
      if (applyBtn) {
        applyBtn.textContent = 'Apply';
        applyBtn.style.background = '';
        applyBtn.style.display = 'none';
      }
      // Hide tone selector (tone is persisted; do not reset)
      const toneSelector = this.modal.querySelector('.rewordly-tone-selector') as HTMLDivElement | null;
      if (toneSelector) toneSelector.style.display = 'none';

      // Unlock background scroll
      try {
        const body = document.body;
        const html = document.documentElement;
        body.classList.remove('rewordly-modal-open');
        html.classList.remove('rewordly-modal-open');
        body.style.overflow = this.prevBodyOverflow;
        html.style.overflow = this.prevHtmlOverflow;
      } catch {
        // ignore
      }
    }
  }

  private displayRewrittenText(text: string): void {
    if (!this.modal) return;

    const rewrittenText = this.modal.querySelector('.rewordly-rewritten-text') as HTMLParagraphElement;
    const resultTitle = this.modal.querySelector('.rewordly-result-title') as HTMLHeadingElement;
    const loading = this.modal.querySelector('.rewordly-loading') as HTMLDivElement;
    const limitNotice = this.modal.querySelector('.rewordly-limit-notice') as HTMLDivElement;
    const modalTitle = this.modal.querySelector('.rewordly-modal-title') as HTMLHeadingElement;
    const loadingText = this.modal.querySelector('.rewordly-loading-text') as HTMLParagraphElement;
    const applyBtn = this.modal.querySelector('.rewordly-apply-btn') as HTMLButtonElement;

    loading.classList.remove('show');
    if (limitNotice) limitNotice.style.display = 'none';
    if (resultTitle) resultTitle.style.removeProperty('display');
    rewrittenText.style.removeProperty('display');
    rewrittenText.textContent = text;
    rewrittenText.classList.add('show');

    // Show Apply button only when the source was an editable element
    if (applyBtn) {
      applyBtn.style.display = this.isEditableSource ? '' : 'none';
      applyBtn.textContent = 'Apply';
      applyBtn.style.background = '';
    }
    
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
    const resultTitle = this.modal.querySelector('.rewordly-result-title') as HTMLHeadingElement;
    const loading = this.modal.querySelector('.rewordly-loading') as HTMLDivElement;
    const limitNotice = this.modal.querySelector('.rewordly-limit-notice') as HTMLDivElement;
    const modalTitle = this.modal.querySelector('.rewordly-modal-title') as HTMLHeadingElement;
    const loadingText = this.modal.querySelector('.rewordly-loading-text') as HTMLParagraphElement;

    loading.classList.remove('show');
    if (limitNotice) limitNotice.style.display = 'none';
    if (resultTitle) resultTitle.style.removeProperty('display');
    rewrittenText.style.removeProperty('display');
    rewrittenText.textContent = `Error: ${message}`;
    rewrittenText.classList.add('show');
    rewrittenText.classList.add('error');
    
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

  private showLimitNotice(requireLogin: boolean, requirePayment: boolean, message: string): void {
    if (!this.modal) return;

    const rewrittenText = this.modal.querySelector('.rewordly-rewritten-text') as HTMLParagraphElement;
    const resultTitle = this.modal.querySelector('.rewordly-result-title') as HTMLHeadingElement;
    const loading = this.modal.querySelector('.rewordly-loading') as HTMLDivElement;
    const limitNotice = this.modal.querySelector('.rewordly-limit-notice') as HTMLDivElement;
    const limitMessage = this.modal.querySelector('.rewordly-limit-message') as HTMLParagraphElement;
    const loginBtn = this.modal.querySelector('.rewordly-login-btn') as HTMLButtonElement;
    const upgradeBtn = this.modal.querySelector('.rewordly-upgrade-btn') as HTMLButtonElement;

    loading.classList.remove('show');
    rewrittenText.textContent = '';
    rewrittenText.classList.remove('show', 'error');
    rewrittenText.style.setProperty('display', 'none', 'important');
    if (resultTitle) resultTitle.style.setProperty('display', 'none', 'important');
    if (limitMessage) limitMessage.textContent = message;
    if (loginBtn) loginBtn.style.display = requireLogin ? '' : 'none';
    if (upgradeBtn) upgradeBtn.style.display = requirePayment ? '' : 'none';
    if (limitNotice) limitNotice.style.display = 'block';
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

  private applyRewrittenText(): void {
    if (!this.modal || !this.sourceElement) return;

    const rewrittenText = this.modal.querySelector('.rewordly-rewritten-text') as HTMLParagraphElement;
    const rawText = rewrittenText.textContent;
    if (!rawText) return;

    const cleanText = rawText.trim().replace(/^["']|["']$/g, '');

    // input / textarea: replace the original selection range in .value
    if (
      this.sourceElement instanceof HTMLInputElement ||
      this.sourceElement instanceof HTMLTextAreaElement
    ) {
      const el = this.sourceElement;
      el.value =
        el.value.substring(0, this.sourceSelectionStart) +
        cleanText +
        el.value.substring(this.sourceSelectionEnd);

      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));

      el.focus();
      const newCaret = this.sourceSelectionStart + cleanText.length;
      el.setSelectionRange(newCaret, newCaret);

      this.showApplySuccess();
      return;
    }

    // contenteditable: restore the saved Range and replace its content
    if (this.savedRange) {
      try {
        const selection = window.getSelection();
        if (selection) {
          selection.removeAllRanges();
          selection.addRange(this.savedRange);
        }

        this.savedRange.deleteContents();
        const textNode = document.createTextNode(cleanText);
        this.savedRange.insertNode(textNode);

        // Collapse cursor to end of inserted text
        const newRange = document.createRange();
        newRange.setStartAfter(textNode);
        newRange.collapse(true);
        if (selection) {
          selection.removeAllRanges();
          selection.addRange(newRange);
        }

        // Notify frameworks (React, Vue, etc.) of the change
        const editableEl = this.sourceElement as HTMLElement;
        editableEl.dispatchEvent(
          new InputEvent('input', { bubbles: true, inputType: 'insertText', data: cleanText })
        );

        this.showApplySuccess();
      } catch {
        // Range restore failed (e.g. DOM changed) — fall back to clipboard
        navigator.clipboard.writeText(cleanText).catch(() => {});
        this.showApplySuccess();
      }
    }
  }

  private showApplySuccess(): void {
    const applyBtn = this.modal?.querySelector('.rewordly-apply-btn') as HTMLButtonElement | null;
    if (applyBtn) {
      applyBtn.textContent = 'Applied ✓';
      applyBtn.style.background = '#10b981';
    }
    setTimeout(() => {
      // Hide modal (also resets button)
      this.hideModal();
    }, 700);
  }
}

// Initialize the content script
new RewordlyContentScript();