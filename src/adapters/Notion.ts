/**
 * Notion Platform Adapter
 * Notion için özel implementasyon
 */

import { BaseAdapter } from './BaseAdapter';
import { Platform, GrammarError } from '../types';

export class NotionAdapter extends BaseAdapter {
  override readonly platform: Platform = 'notion';
  
  private editableElements: Set<HTMLElement> = new Set();
  private observer: MutationObserver | null = null;

  constructor(onGrammarCheck?: (text: string) => Promise<GrammarError[]>) {
    super(onGrammarCheck);
  }

  override isGrammarCheckEnabled(): boolean {
    return this.isHostname('notion.so');
  }

  initialize(): void {
    if (!this.isGrammarCheckEnabled()) {
      return;
    }

    console.log('Rewordly: Notion adapter initializing...');

    // Notion editable elementleri bul
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
    // Notion'un contenteditable elementleri
    const selectors = [
      '[contenteditable="true"]',
      '.notion-page-content [contenteditable]',
      '.notion-selectable [contenteditable]'
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
      '[contenteditable="true"]',
      '.notion-page-content [contenteditable]'
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

    // Notion'un kendi UI elementlerini filtrele
    if (element.closest('.notion-sidebar') || 
        element.closest('.notion-topbar') ||
        element.closest('[role="dialog"]')) {
      return;
    }

    this.editableElements.add(element);
    console.log('Rewordly: Notion adapter attached to element', element);
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
    // Notion için highlight rendering
    // Bu metod generic adapter tarafından handle edilebilir
    // Veya burada Notion'a özel implementasyon yapılabilir
  }

  clearHighlights(element: HTMLElement): void {
    // Notion için highlight temizleme
    const overlays = element.querySelectorAll('.rewordly-grammar-overlay');
    overlays.forEach(overlay => overlay.remove());
  }
}

