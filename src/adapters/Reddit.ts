/**
 * Reddit Platform Adapter
 * Reddit için özel implementasyon
 */

import { BaseAdapter } from './BaseAdapter';
import { Platform, GrammarError } from '../types';

export class RedditAdapter extends BaseAdapter {
  override readonly platform: Platform = 'reddit';
  
  private editableElements: Set<HTMLElement> = new Set();
  private observer: MutationObserver | null = null;

  constructor(onGrammarCheck?: (text: string) => Promise<GrammarError[]>) {
    super(onGrammarCheck);
  }

  override isGrammarCheckEnabled(): boolean {
    return this.isHostname('reddit.com');
  }

  initialize(): void {
    if (!this.isGrammarCheckEnabled()) {
      return;
    }

    console.log('Rewordly: Reddit adapter initializing...');

    // Reddit için özel stil ekle (custom element için)
    this.setupRedditStyles();

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

  private setupRedditStyles(): void {
    // Reddit custom element CSS override
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

    // Custom element tanımla
    if (typeof customElements !== 'undefined' && customElements && !customElements.get('rewordly-highlights')) {
      customElements.define('rewordly-highlights', class extends HTMLElement {
        constructor() {
          super();
        }
      });
    }
  }

  private findAndAttachToEditableElements(): void {
    const selectors = [
      'textarea[placeholder*="What are your thoughts"]', // Post editor
      'textarea[placeholder*="Add a comment"]', // Comment editor
      '[contenteditable="true"]',
      'textarea'
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
      'textarea',
      '[contenteditable="true"]'
    ];

    selectors.forEach(selector => {
      const children = element.querySelectorAll(selector);
      children.forEach((child) => {
        this.attachToEditableElement(child as HTMLElement);
      });
    });
  }

  private attachToEditableElement(element: HTMLElement): void {
    if (!this.isEditableElement(element) || this.editableElements.has(element)) {
      return;
    }

    this.editableElements.add(element);
    console.log('Rewordly: Reddit adapter attached to element', element);
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
    // Reddit için highlight rendering
    // Bu metod generic adapter tarafından handle edilebilir
    // Veya burada Reddit'e özel implementasyon yapılabilir
  }

  clearHighlights(element: HTMLElement): void {
    // Reddit için highlight temizleme
    const overlays = element.querySelectorAll('.rewordly-grammar-overlay');
    overlays.forEach(overlay => overlay.remove());
  }
}

