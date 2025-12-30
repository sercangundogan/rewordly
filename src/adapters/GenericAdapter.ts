/**
 * Generic Platform Adapter
 * Twitter, Gmail, Medium ve diğer genel platformlar için
 */

import { BaseAdapter } from './BaseAdapter';
import { Platform, GrammarError } from '../types';

export class GenericAdapter extends BaseAdapter {
  override readonly platform: Platform = 'generic';
  
  private editableElements: Set<HTMLElement> = new Set();
  private observer: MutationObserver | null = null;
  private platformName: string;

  constructor(
    platformName: string,
    onGrammarCheck?: (text: string) => Promise<GrammarError[]>
  ) {
    super(onGrammarCheck);
    this.platformName = platformName;
  }

  override isGrammarCheckEnabled(): boolean {
    const hostname = window.location.hostname.toLowerCase();
    
    // Twitter
    if (hostname.includes('twitter.com') || hostname.includes('x.com')) {
      return true;
    }
    
    // Medium
    if (hostname.includes('medium.com')) {
      return true;
    }
    
    return false;
  }

  initialize(): void {
    if (!this.isGrammarCheckEnabled()) {
      return;
    }

    console.log(`Rewordly: Generic adapter (${this.platformName}) initializing...`);

    // Editable elementleri bul
    this.findAndAttachToEditableElements();

    // Yeni elementler için observer
    this.observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const element = node as HTMLElement;
            this.attachToEditableElement(element);
            this.findEditableInElement(element);
          }
        });
      });
    });

    if (document.body) {
      this.observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['contenteditable']
      });
    }
  }

  private findAndAttachToEditableElements(): void {
    const selectors = [
      'input[type="text"]',
      'input[type="email"]',
      'input[type="search"]',
      'input:not([type])',
      'input[type="url"]',
      'textarea',
      '[contenteditable="true"]',
      '[contenteditable=""]',
      '[contenteditable]'
    ];

    selectors.forEach(selector => {
      const elements = document.querySelectorAll(selector);
      elements.forEach((el) => {
        this.attachToEditableElement(el as HTMLElement);
      });
    });
  }

  private findEditableInElement(element: HTMLElement): void {
    const selectors = [
      'input[type="text"]',
      'input[type="email"]',
      'textarea',
      '[contenteditable="true"]'
    ];

    selectors.forEach(selector => {
      const children = element.querySelectorAll(selector);
      children.forEach((child) => {
        this.attachToEditableElement(child as HTMLElement);
      });
    });

    // Shadow DOM kontrolü
    if (element.shadowRoot) {
      const shadowEditable = element.shadowRoot.querySelectorAll(
        'input[type="text"], textarea, [contenteditable="true"]'
      );
      shadowEditable.forEach((child) => {
        this.attachToEditableElement(child as HTMLElement);
      });
    }
  }

  private attachToEditableElement(element: HTMLElement): void {
    if (!this.isEditableElement(element) || this.editableElements.has(element)) {
      return;
    }

    this.editableElements.add(element);
    console.log(`Rewordly: Generic adapter attached to element`, element);
  }

  cleanup(): void {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }

    this.editableElements.clear();
  }

  findEditableElements(): HTMLElement[] {
    return Array.from(this.editableElements);
  }

  extractText(element: HTMLElement): string {
    return this.extractTextFromElement(element);
  }

  renderHighlights(_element: HTMLElement, _errors: GrammarError[]): void {
    // Generic highlight rendering
    // Bu metod ana content script tarafından handle edilebilir
  }

  clearHighlights(element: HTMLElement): void {
    // Generic highlight temizleme
    const overlays = element.querySelectorAll('.rewordly-grammar-overlay');
    overlays.forEach(overlay => overlay.remove());
  }
}

