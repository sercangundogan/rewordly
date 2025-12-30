/**
 * Base Platform Adapter
 * Tüm platform adapters için temel sınıf
 */

import { IPlatformAdapter, Platform, GrammarError } from '../types';

/**
 * Base adapter sınıfı
 * Tüm platform adapters bu sınıftan türetilir
 */
export abstract class BaseAdapter implements IPlatformAdapter {
  /**
   * Platform adı
   */
  abstract readonly platform: Platform;

  /**
   * Grammar check callback fonksiyonu
   */
  protected onGrammarCheck: ((text: string) => Promise<GrammarError[]>) | undefined;

  /**
   * Constructor
   */
  constructor(onGrammarCheck?: (text: string) => Promise<GrammarError[]>) {
    this.onGrammarCheck = onGrammarCheck;
  }

  /**
   * Bu platform için grammar check aktif mi?
   * Varsayılan olarak true döner, alt sınıflar override edebilir
   */
  isGrammarCheckEnabled(): boolean {
    return true;
  }

  /**
   * Platform'a özel başlatma
   * Alt sınıflar bu metodu override etmeli
   */
  abstract initialize(): void;

  /**
   * Platform'a özel temizleme
   * Alt sınıflar bu metodu override etmeli
   */
  abstract cleanup(): void;

  /**
   * Platform'a özel editable element bulma
   * Alt sınıflar bu metodu override etmeli
   */
  abstract findEditableElements(): HTMLElement[];

  /**
   * Platform'a özel text extraction
   * Alt sınıflar bu metodu override etmeli
   */
  abstract extractText(element: HTMLElement): string;

  /**
   * Platform'a özel highlight rendering
   * Alt sınıflar bu metodu override etmeli
   */
  abstract renderHighlights(element: HTMLElement, errors: GrammarError[]): void;

  /**
   * Platform'a özel highlight temizleme
   * Alt sınıflar bu metodu override etmeli
   */
  abstract clearHighlights(element: HTMLElement): void;

  /**
   * Yardımcı: Element'in editable olup olmadığını kontrol et
   */
  protected isEditableElement(element: HTMLElement): boolean {
    if (!element) return false;

    // Input elementleri
    if (element.tagName === 'INPUT') {
      const input = element as HTMLInputElement;
      const type = input.type?.toLowerCase();
      return ['text', 'email', 'search', 'url'].includes(type) || !type;
    }

    // Textarea
    if (element.tagName === 'TEXTAREA') {
      return true;
    }

    // Contenteditable
    const contentEditable = element.getAttribute('contenteditable');
    return contentEditable === 'true' || contentEditable === '';
  }

  /**
   * Yardımcı: Element'ten text çıkar (genel yöntem)
   */
  protected extractTextFromElement(element: HTMLElement): string {
    if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
      return (element as HTMLInputElement | HTMLTextAreaElement).value || '';
    }

    if (this.isEditableElement(element)) {
      return element.textContent || element.innerText || '';
    }

    return '';
  }

  /**
   * Yardımcı: Hostname kontrolü
   */
  protected isHostname(hostname: string): boolean {
    return window.location.hostname.toLowerCase().includes(hostname.toLowerCase());
  }
}

