/**
 * UI Helper
 * Rewrite button, modal ve tooltip işlemleri için yardımcı fonksiyonlar
 *
 * Bu dosya tüm UI elementlerinin oluşturulması, gösterilmesi ve gizlenmesi ile ilgilenir.
 * En basit developer bile anlayabilir: Button göster, modal aç, tooltip göster gibi.
 */

import { GrammarError } from "../types";
import { isSingleLineElement, findScrollableContainers } from "./element-helper";

/**
 * Rewrite Button Helper
 * Sayfada rewrite buton işlemleri
 */
export class RewriteButtonHelper {
  private button: HTMLDivElement | null = null;

  /**
   * Rewrite button oluştur
   */
  create(): HTMLDivElement {
    if (this.button) {
      return this.button;
    }

    const button = document.createElement("div");
    button.id = "rewordly-rewrite-button";
    button.className = "rewordly-rewrite-button";
    button.innerHTML = `
      <button class="rewordly-rewrite-btn" title="Rewrite with AI">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 20h9"></path>
          <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
        </svg>
        <span>AI</span>
      </button>
    `;

    button.style.cssText = `
      position: fixed;
      z-index: 2147483647;
      display: none;
      pointer-events: auto;
    `;

    document.body.appendChild(button);
    this.button = button;
    return button;
  }

  /**
   * Rewrite button'u göster
   * Element'in yanında konumlandırır
   */
  show(element: HTMLElement, rect: DOMRect): void {
    if (!this.button) {
      this.create();
    }

    if (!this.button) return;

    (this.button as any).__currentElement = element;

    // Viewport boyutları
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const buttonWidth = 120;
    const buttonHeight = 40;

    // Pozisyon hesapla - seçimin sağında
    let x = rect.right + 10;
    let y = rect.top - 10;

    // Sağa taşarsa sola koy
    if (x + buttonWidth > viewportWidth) {
      x = rect.left - buttonWidth - 10;
    }

    // Sola taşarsa sol kenara koy
    if (x < 0) {
      x = 10;
    }

    // Yukarı taşarsa aşağı koy
    if (y < 0) {
      y = rect.bottom + 10;
    }

    // Aşağı taşarsa yukarı koy
    if (y + buttonHeight > viewportHeight) {
      y = rect.top - buttonHeight - 10;
    }

    // Son kontrol - her zaman görünür olmalı
    x = Math.max(10, Math.min(x, viewportWidth - buttonWidth - 10));
    y = Math.max(10, Math.min(y, viewportHeight - buttonHeight - 10));

    this.button.style.left = `${x}px`;
    this.button.style.top = `${y}px`;
    this.button.classList.add("show");
  }

  /**
   * Rewrite button'u gizle
   */
  hide(): void {
    if (this.button) {
      this.button.classList.remove("show");
    }
  }

  /**
   * Button'a click event listener ekle
   */
  onClick(callback: () => void): void {
    if (!this.button) {
      this.create();
    }

    if (this.button) {
      const btn = this.button.querySelector(".rewordly-rewrite-btn");
      if (btn) {
        btn.addEventListener("click", callback);
      }
    }
  }

  /**
   * Button'u temizle
   */
  cleanup(): void {
    if (this.button && this.button.parentNode) {
      this.button.parentNode.removeChild(this.button);
      this.button = null;
    }
  }

  /**
   * Update AI rewrite button position
   * This is called both on initial show and on scroll/resize events
   */
  updateAIRewriteButtonPosition(
    element: HTMLElement,
    options: {
      rewriteEnabled: boolean;
      highlightsEnabled: boolean;
      isGrammarCheckAllowedSite: () => boolean;
    }
  ): void {
    if (!this.button || !options.rewriteEnabled) {
      return;
    }

    // Only show rewrite button on sites where grammar check is enabled
    if (!options.isGrammarCheckAllowedSite() || !options.highlightsEnabled) {
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
    this.button.style.left = `${buttonX}px`;
    this.button.style.top = `${buttonY}px`;
  }

  /**
   * Show AI rewrite button at bottom-right of editable element
   * For single-line elements, positions button at right-center (vertically aligned)
   * For multi-line elements, positions button at bottom-right
   */
  showAIRewriteButton(
    element: HTMLElement,
    options: {
      rewriteEnabled: boolean;
      highlightsEnabled: boolean;
      isGrammarCheckAllowedSite: () => boolean;
      buttonBlurTimeout: { value: number | null; set: (value: number | null) => void };
      addAIButtonScrollListener: (element: HTMLElement) => void;
      removeAIButtonScrollListener: () => void;
    }
  ): void {
    if (!this.button || !options.rewriteEnabled) {
      return;
    }

    // Only show rewrite button on sites where grammar check is enabled
    if (!options.isGrammarCheckAllowedSite() || !options.highlightsEnabled) {
      return;
    }

    // Remove existing scroll listener if any
    options.removeAIButtonScrollListener();

    // Update button position
    this.updateAIRewriteButtonPosition(element, {
      rewriteEnabled: options.rewriteEnabled,
      highlightsEnabled: options.highlightsEnabled,
      isGrammarCheckAllowedSite: options.isGrammarCheckAllowedSite,
    });

    // Ensure button is visible
    this.button.style.display = "flex";
    this.button.style.visibility = "visible";
    this.button.style.opacity = "1";
    this.button.classList.add("show");

    // Cancel any pending button blur timeout to prevent button from hiding
    if (options.buttonBlurTimeout.value !== null) {
      clearTimeout(options.buttonBlurTimeout.value);
      options.buttonBlurTimeout.set(null);
    }

    // Store reference to current element for rewrite functionality
    (this.button as any).__currentElement = element;

    // Add scroll listener to update button position on scroll
    options.addAIButtonScrollListener(element);
  }

  /**
   * Hide rewrite button
   * Only hides if currentFocusedElement is not set or element doesn't have focus
   */
  hideRewriteButton(options: {
    currentFocusedElement: HTMLElement | null;
    removeAIButtonScrollListener: () => void;
  }): void {
    if (this.button) {
      // Don't hide button if there's a current focused element that still has focus
      if (
        options.currentFocusedElement &&
        document.activeElement === options.currentFocusedElement
      ) {
        // Element still has focus, don't hide button
        return;
      }

      // Hide button
      this.button.classList.remove("show");

      // Remove scroll listener when button is hidden
      options.removeAIButtonScrollListener();
    }
  }

  /**
   * Add scroll listener to update AI button position
   */
  addAIButtonScrollListener(
    element: HTMLElement,
    options: {
      updateAIRewriteButtonPosition: (element: HTMLElement) => void;
      removeAIButtonScrollListener: () => void;
      aiButtonScrollListener: { value: (() => void) | null; set: (value: (() => void) | null) => void };
    }
  ): void {
    // Remove existing listener if any
    options.removeAIButtonScrollListener();

    // Create throttled update function for better performance
    let rafId: number | null = null;
    const updatePosition = () => {
      if (rafId !== null) {
        return; // Already scheduled
      }
      rafId = requestAnimationFrame(() => {
        rafId = null;
        // Check if button is still visible and element still exists
        if (
          this.button &&
          this.button.classList.contains("show") &&
          document.body.contains(element)
        ) {
          options.updateAIRewriteButtonPosition(element);
        }
      });
    };

    // Store the bound function
    options.aiButtonScrollListener.set(updatePosition);

    // Add listeners to window and document for comprehensive scroll detection
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    document.addEventListener("scroll", updatePosition, true);

    // Also listen to scrollable parent containers (important for Medium and other sites with nested scroll containers)
    const scrollableContainers = findScrollableContainers(element);
    scrollableContainers.forEach((container) => {
      container.addEventListener("scroll", updatePosition, {
        passive: true,
        capture: true,
      });
    });

    // Store containers for cleanup
    (this.button as any).__scrollContainers = scrollableContainers;
  }

  /**
   * Remove scroll listener for AI button
   */
  removeAIButtonScrollListener(options: {
    aiButtonScrollListener: { value: (() => void) | null; set: (value: (() => void) | null) => void };
  }): void {
    const updatePosition = options.aiButtonScrollListener.value;

    if (updatePosition) {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
      document.removeEventListener("scroll", updatePosition, true);
      options.aiButtonScrollListener.set(null);
    }

    // Remove scroll listeners from scrollable containers
    if (
      this.button &&
      (this.button as any).__scrollContainers &&
      updatePosition
    ) {
      const containers = (this.button as any)
        .__scrollContainers as Set<HTMLElement>;
      containers.forEach((container) => {
        try {
          container.removeEventListener("scroll", updatePosition, {
            capture: true,
          } as any);
        } catch (e) {
          // Fallback if capture option causes issues
          container.removeEventListener("scroll", updatePosition, true);
        }
      });
      delete (this.button as any).__scrollContainers;
    }
  }
}

/**
 * Modal Helper
 * Modal dialog işlemleri
 */
export class ModalHelper {
  private modal: HTMLDivElement | null = null;

  /**
   * Modal oluştur
   */
  create(): HTMLDivElement {
    if (this.modal) {
      return this.modal;
    }

    const modal = document.createElement("div");
    modal.id = "rewordly-modal";
    modal.className = "rewordly-modal";
    modal.innerHTML = `
      <div class="rewordly-modal-content">
        <div class="rewordly-modal-header">
          <h2 class="rewordly-modal-title">Rewordly</h2>
          <button class="rewordly-modal-close">&times;</button>
        </div>
        <div class="rewordly-modal-body">
          <div class="rewordly-original-text"></div>
          <div class="rewordly-loading">
            <div class="rewordly-spinner"></div>
            <p class="rewordly-loading-text">Rewriting...</p>
          </div>
          <div class="rewordly-result">
            <h3 class="rewordly-result-title">Rewritten Text:</h3>
            <p class="rewordly-rewritten-text"></p>
          </div>
        </div>
        <div class="rewordly-modal-footer">
          <button class="rewordly-copy-btn">Copy</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    this.modal = modal;
    return modal;
  }

  /**
   * Modal'ı göster
   */
  show(
    originalText: string,
    operation: "rewrite" | "grammar" = "rewrite"
  ): void {
    if (!this.modal) {
      this.create();
    }

    if (!this.modal) return;

    const originalTextEl = this.modal.querySelector(
      ".rewordly-original-text"
    ) as HTMLParagraphElement;
    const rewrittenTextEl = this.modal.querySelector(
      ".rewordly-rewritten-text"
    ) as HTMLParagraphElement;
    const loadingEl = this.modal.querySelector(
      ".rewordly-loading"
    ) as HTMLDivElement;
    const modalTitle = this.modal.querySelector(
      ".rewordly-modal-title"
    ) as HTMLHeadingElement;
    const resultTitle = this.modal.querySelector(
      ".rewordly-result-title"
    ) as HTMLHeadingElement;
    const loadingText = this.modal.querySelector(
      ".rewordly-loading-text"
    ) as HTMLParagraphElement;

    if (originalTextEl) originalTextEl.textContent = originalText;
    if (rewrittenTextEl) rewrittenTextEl.textContent = "";
    if (loadingEl) loadingEl.classList.add("show");
    if (rewrittenTextEl) rewrittenTextEl.classList.remove("show");

    // Operation'a göre başlıkları ayarla
    if (operation === "grammar") {
      if (modalTitle) modalTitle.textContent = "Grammar Check";
      if (resultTitle) resultTitle.textContent = "Corrected Text:";
      if (loadingText) loadingText.textContent = "Fixing grammar...";
    } else {
      if (modalTitle) modalTitle.textContent = "Rewordly";
      if (resultTitle) resultTitle.textContent = "Rewritten Text:";
      if (loadingText) loadingText.textContent = "Rewriting...";
    }

    this.modal.classList.add("show");
  }

  /**
   * Modal'ı gizle
   */
  hide(): void {
    if (this.modal) {
      this.modal.classList.remove("show");
    }
  }

  /**
   * Rewritten text'i göster
   */
  displayResult(text: string): void {
    if (!this.modal) return;

    const rewrittenText = this.modal.querySelector(
      ".rewordly-rewritten-text"
    ) as HTMLParagraphElement;
    const loading = this.modal.querySelector(
      ".rewordly-loading"
    ) as HTMLDivElement;

    if (loading) loading.classList.remove("show");
    if (rewrittenText) {
      rewrittenText.textContent = text;
      rewrittenText.classList.add("show");
    }
  }

  /**
   * Hata mesajı göster
   */
  showError(message: string): void {
    if (!this.modal) return;

    const rewrittenText = this.modal.querySelector(
      ".rewordly-rewritten-text"
    ) as HTMLParagraphElement;
    const loading = this.modal.querySelector(
      ".rewordly-loading"
    ) as HTMLDivElement;

    if (loading) loading.classList.remove("show");
    if (rewrittenText) {
      rewrittenText.textContent = `Error: ${message}`;
      rewrittenText.classList.add("show");
      rewrittenText.classList.add("error");
    }
  }

  /**
   * Copy butonuna click listener ekle
   */
  onCopyClick(callback: () => void): void {
    if (!this.modal) {
      this.create();
    }

    if (this.modal) {
      const copyBtn = this.modal.querySelector(".rewordly-copy-btn");
      const closeBtn = this.modal.querySelector(".rewordly-modal-close");

      if (copyBtn) {
        copyBtn.addEventListener("click", callback);
      }

      if (closeBtn) {
        closeBtn.addEventListener("click", () => this.hide());
      }
    }
  }

  /**
   * Modal'ı temizle
   */
  cleanup(): void {
    if (this.modal && this.modal.parentNode) {
      this.modal.parentNode.removeChild(this.modal);
      this.modal = null;
    }
  }

  /**
   * Modal açık mı?
   */
  isOpen(): boolean {
    return this.modal?.classList.contains("show") || false;
  }
}

/**
 * Tooltip Helper
 * Grammar error tooltip'leri için
 */
export class TooltipHelper {
  private activeTooltips: Map<string, HTMLElement> = new Map();

  /**
   * Tooltip oluştur ve göster
   */
  show(
    error: GrammarError,
    position: { x: number; y: number },
    onReplace: (suggestion: string) => void,
    onDismiss: () => void
  ): void {
    // Önceki tooltip'i kapat
    this.hide(error.id);

    const tooltip = document.createElement("div");
    tooltip.className = "rewordly-tooltip";
    tooltip.setAttribute("data-error-id", error.id);
    tooltip.style.cssText = `
      position: fixed;
      left: ${position.x}px;
      top: ${position.y}px;
      z-index: 2147483647;
      background: white;
      border: 1px solid #ccc;
      border-radius: 4px;
      padding: 8px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.2);
      max-width: 300px;
    `;

    // Error mesajı
    const errorText = document.createElement("div");
    errorText.textContent = error.word;
    errorText.style.fontWeight = "bold";
    tooltip.appendChild(errorText);

    // Öneriler
    if (error.suggestions && error.suggestions.length > 0) {
      const suggestionsDiv = document.createElement("div");
      suggestionsDiv.style.marginTop = "8px";

      error.suggestions.slice(0, 3).forEach((suggestion) => {
        const suggestionBtn = document.createElement("button");
        suggestionBtn.textContent = suggestion;
        suggestionBtn.style.cssText = `
          display: block;
          width: 100%;
          padding: 4px 8px;
          margin: 4px 0;
          text-align: left;
          background: #f0f0f0;
          border: none;
          border-radius: 2px;
          cursor: pointer;
        `;
        suggestionBtn.addEventListener("click", () => {
          onReplace(suggestion);
          this.hide(error.id);
        });
        suggestionsDiv.appendChild(suggestionBtn);
      });

      tooltip.appendChild(suggestionsDiv);
    }

    // Dismiss butonu
    const dismissBtn = document.createElement("button");
    dismissBtn.textContent = "Dismiss";
    dismissBtn.style.cssText = `
      margin-top: 8px;
      padding: 4px 8px;
      background: #ff4444;
      color: white;
      border: none;
      border-radius: 2px;
      cursor: pointer;
    `;
    dismissBtn.addEventListener("click", () => {
      onDismiss();
      this.hide(error.id);
    });
    tooltip.appendChild(dismissBtn);

    document.body.appendChild(tooltip);
    this.activeTooltips.set(error.id, tooltip);
  }

  /**
   * Tooltip'i gizle
   */
  hide(errorId: string): void {
    const tooltip = this.activeTooltips.get(errorId);
    if (tooltip && tooltip.parentNode) {
      tooltip.parentNode.removeChild(tooltip);
      this.activeTooltips.delete(errorId);
    }
  }

  /**
   * Tüm tooltip'leri gizle
   */
  hideAll(): void {
    this.activeTooltips.forEach((tooltip) => {
      if (tooltip.parentNode) {
        tooltip.parentNode.removeChild(tooltip);
      }
    });
    this.activeTooltips.clear();
  }

  /**
   * Tooltip'leri temizle
   */
  cleanup(): void {
    this.hideAll();
  }
}
