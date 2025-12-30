/**
 * Gmail Platform Adapter
 * Gmail için özel implementasyon
 */

import { BaseAdapter } from './BaseAdapter';
import { Platform, GrammarError } from '../types';

export class GmailAdapter extends BaseAdapter {
  override readonly platform: Platform = 'gmail';
  
  private editableElements: Set<HTMLElement> = new Set();
  private observer: MutationObserver | null = null;
  private gmailObservers: Map<HTMLElement, MutationObserver> = new Map();

  constructor(onGrammarCheck?: (text: string) => Promise<GrammarError[]>) {
    super(onGrammarCheck);
  }

  override isGrammarCheckEnabled(): boolean {
    return this.isHostname('mail.google.com') || this.isHostname('gmail.com');
  }

  initialize(): void {
    if (!this.isGrammarCheckEnabled()) {
      return;
    }

    console.log('Rewordly: Gmail adapter initializing...');

    // Gmail editable elementleri bul
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
    // Gmail'in contenteditable elementleri
    const selectors = [
      'div[contenteditable="true"]',
      'div[contenteditable=""]',
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
      'div[contenteditable="true"]',
      '[contenteditable="true"]',
      'textarea'
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

    // Gmail'in "To" field'ını ignore et
    if (this.shouldIgnoreGmailElement(element)) {
      return;
    }

    this.editableElements.add(element);
    
    // Gmail spell check observer'ını kur
    this.setupGmailSpellCheckObserver(element);
    
    console.log('Rewordly: Gmail adapter attached to element', element);
  }

  /**
   * Gmail'in "To" field gibi elementlerini ignore et
   */
  private shouldIgnoreGmailElement(element: HTMLElement): boolean {
    // Gmail's "To" field has specific structure:
    // - Container with class "aoD hl" (the main container)
    // - Input with name="to" attribute
    // - Contenteditable div with class "oL aDm az9" containing span with class "aQ2"
    
    // Check for Gmail's "To" field container
    const gmailToContainer = element.closest('.aoD.hl');
    if (gmailToContainer) {
      // Check if this is the actual input/editable element within the "To" field
      const hasToName = element.closest('[name="to"]') !== null;
      const hasToClasses = element.classList.contains('oL') && 
                          element.classList.contains('aDm') && 
                          element.classList.contains('az9');
      const hasToSpan = element.querySelector('.aQ2') !== null || 
                       element.closest('.aQ2') !== null ||
                       (element.parentElement && element.parentElement.querySelector('.aQ2') !== null);
      
      if (hasToName || hasToClasses || hasToSpan) {
        return true;
      }
    }
    
    // Check if element is inside a Gmail "To" field input
    if (element.closest('[name="to"]') !== null) {
      return true;
    }
    
    // Check if element is the Gmail "To" field input itself
    if (element.getAttribute('name') === 'to' || 
        (element instanceof HTMLInputElement && element.name === 'to')) {
      return true;
    }
    
    // Check if element contains or is inside the Gmail "To" field span
    if (element.classList.contains('aQ2') || 
        element.closest('.aQ2') !== null ||
        element.querySelector('.aQ2') !== null) {
      return true;
    }
    
    return false;
  }

  /**
   * Gmail'in spell check marker'larını kaldır
   */
  private removeGmailSpellCheckMarkers(element: HTMLElement): void {
    const spellCheckSpans = element.querySelectorAll('span[aria-invalid]');
    spellCheckSpans.forEach((span) => {
      const parent = span.parentNode;
      if (parent) {
        const textNode = document.createTextNode(span.textContent || '');
        parent.replaceChild(textNode, span);
        parent.normalize();
      }
    });
  }

  /**
   * Gmail'in spell check marker'larını izlemek için observer kur
   */
  private setupGmailSpellCheckObserver(element: HTMLElement): void {
    // Only set up observer once per element
    if (this.gmailObservers.has(element)) {
      return;
    }

    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const el = node as HTMLElement;
            // Check if it's a spell check span
            if (el.tagName === 'SPAN' && el.hasAttribute('aria-invalid')) {
              // Remove the spell check marker
              const parent = el.parentNode;
              if (parent) {
                const textNode = document.createTextNode(el.textContent || '');
                parent.replaceChild(textNode, el);
                parent.normalize();
              }
            }
            // Also check children
            const spellCheckSpans = el.querySelectorAll('span[aria-invalid]');
            spellCheckSpans.forEach((span) => {
              const parent = span.parentNode;
              if (parent) {
                const textNode = document.createTextNode(span.textContent || '');
                parent.replaceChild(textNode, span);
                parent.normalize();
              }
            });
          }
        });
      });
    });

    observer.observe(element, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-invalid', 'class']
    });

    // Store observer reference for cleanup
    this.gmailObservers.set(element, observer);
  }

  cleanup(): void {
    // Clean up main observer
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }

    // Clean up Gmail spell check observers
    this.gmailObservers.forEach((observer, element) => {
      observer.disconnect();
      (element as any).__rewordlyGmailObserver = undefined;
    });
    this.gmailObservers.clear();

    this.editableElements.clear();
  }

  findEditableElements(): HTMLElement[] {
    return Array.from(this.editableElements);
  }

  extractText(element: HTMLElement): string {
    return this.extractTextFromElement(element);
  }

  renderHighlights(_element: HTMLElement, _errors: GrammarError[]): void {
    // Gmail için highlight rendering
    // Bu metod ana content script tarafından handle edilebilir
    // Veya burada Gmail'e özel implementasyon yapılabilir
  }

  clearHighlights(element: HTMLElement): void {
    // Gmail için highlight temizleme
    const overlays = element.querySelectorAll('.rewordly-grammar-overlay');
    overlays.forEach(overlay => overlay.remove());
    
    // Ayrıca Gmail spell check marker'larını da temizle
    this.removeGmailSpellCheckMarkers(element);
  }
}

