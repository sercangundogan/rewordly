/**
 * Highlight Helper
 * Grammar error highlight'larını render etme, güncelleme ve temizleme işlemleri
 * 
 * Bu dosya highlight'ları göstermek, pozisyonlarını güncellemek ve temizlemekle ilgilenir.
 * Basitçe: Highlight göster, pozisyon güncelle, temizle gibi.
 */

import { GrammarError } from '../types';
import { getElementId } from './element-helper';
import { mapInnerTextToTextNodes } from './text-processing-helper';

/**
 * Highlight Container Helper
 * Grammarly-style highlight container yönetimi
 */
export class HighlightContainerHelper {
  private container: HTMLElement | null = null;
  private shadowRoot: ShadowRoot | null = null;
  private content: HTMLElement | null = null;

  /**
   * Highlight container oluştur
   */
  create(): void {
    if (this.container) return;

    // Custom element tanımla (Reddit için)
    if (typeof customElements !== 'undefined' && customElements && !customElements.get('rewordly-highlights')) {
      customElements.define('rewordly-highlights', class extends HTMLElement {
        constructor() {
          super();
        }
      });
    }

    // Container oluştur
    this.container = document.createElement('rewordly-highlights');
    this.container.id = 'rewordly-highlights-container';
    this.container.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 2147483646;
    `;

    // Shadow DOM oluştur (CSS izolasyonu için)
    this.shadowRoot = this.container.attachShadow({ mode: 'open' });
    
    // Shadow DOM içine content ekle
    this.content = document.createElement('div');
    this.content.className = 'rewordly-highlights-content';
    this.shadowRoot.appendChild(this.content);

    // Style ekle
    const style = document.createElement('style');
    style.textContent = `
      .rewordly-highlight {
        position: absolute;
        background: rgba(255, 0, 0, 0.2);
        border-bottom: 2px solid red;
        pointer-events: auto;
        cursor: pointer;
        transition: opacity 0.2s;
      }
      .rewordly-highlight:hover {
        opacity: 0.8;
      }
    `;
    this.shadowRoot.appendChild(style);

    document.body.appendChild(this.container);
  }

  /**
   * Element için highlight'ları render et
   */
  renderHighlights(
    element: HTMLElement,
    errors: GrammarError[],
    getErrorRects: (error: GrammarError) => DOMRect[]
  ): void {
    if (!this.content) {
      this.create();
    }

    if (!this.content) return;

    const elementId = getElementId(element);

    // Önceki highlight'ları temizle
    this.clearElementHighlights(element);

    // Her error için highlight oluştur
    errors.forEach(error => {
      const rects = getErrorRects(error);
      
      rects.forEach((rect, index) => {
        if (rect.width === 0 || rect.height === 0) return;

        const highlight = document.createElement('div');
        highlight.className = 'rewordly-highlight';
        highlight.setAttribute('data-element-id', elementId);
        highlight.setAttribute('data-error-id', error.id);
        highlight.setAttribute('data-line-index', index.toString());
        highlight.setAttribute('data-error', JSON.stringify(error));
        
        highlight.style.cssText = `
          left: ${rect.left}px;
          top: ${rect.top}px;
          width: ${rect.width}px;
          height: ${rect.height}px;
        `;

        this.content!.appendChild(highlight);
      });
    });
  }

  /**
   * Element için highlight pozisyonlarını güncelle
   */
  updatePositions(
    element: HTMLElement,
    errors: GrammarError[],
    getErrorRects: (error: GrammarError) => DOMRect[]
  ): void {
    if (!this.content) return;

    const elementId = getElementId(element);
    const highlights = this.content.querySelectorAll(`[data-element-id="${elementId}"]`);

    // Error'ları ID'ye göre grupla
    const errorsByLine = new Map<string, { error: GrammarError; lineIndex: number }[]>();
    
    highlights.forEach((highlight) => {
      const errorId = highlight.getAttribute('data-error-id');
      const lineIndex = parseInt(highlight.getAttribute('data-line-index') || '0', 10);
      
      if (errorId) {
        const error = errors.find(e => e.id === errorId);
        if (error) {
          if (!errorsByLine.has(errorId)) {
            errorsByLine.set(errorId, []);
          }
          errorsByLine.get(errorId)!.push({ error, lineIndex });
        }
      }
    });

    // Her highlight için pozisyonu güncelle
    highlights.forEach((highlight) => {
      const errorId = highlight.getAttribute('data-error-id');
      const lineIndex = parseInt(highlight.getAttribute('data-line-index') || '0', 10);
      
      if (errorId) {
        const error = errors.find(e => e.id === errorId);
        if (error) {
          const rects = getErrorRects(error);
          if (rects[lineIndex]) {
            const rect = rects[lineIndex];
            (highlight as HTMLElement).style.left = `${rect.left}px`;
            (highlight as HTMLElement).style.top = `${rect.top}px`;
            (highlight as HTMLElement).style.width = `${rect.width}px`;
            (highlight as HTMLElement).style.height = `${rect.height}px`;
          }
        }
      }
    });
  }

  /**
   * Element için highlight'ları temizle
   */
  clearElementHighlights(element: HTMLElement): void {
    if (!this.content) return;

    const elementId = getElementId(element);
    const highlights = this.content.querySelectorAll(`[data-element-id="${elementId}"]`);
    highlights.forEach(highlight => highlight.remove());
  }

  /**
   * Tüm highlight'ları temizle
   */
  clearAll(): void {
    if (this.content) {
      this.content.innerHTML = '';
    }
  }

  /**
   * Container'ı temizle
   */
  cleanup(): void {
    if (this.container && this.container.parentNode) {
      this.container.parentNode.removeChild(this.container);
      this.container = null;
      this.shadowRoot = null;
      this.content = null;
    }
  }
}

/**
 * Error rect'lerini al
 * Contenteditable elementler için
 */
export function getContentEditableErrorRects(
  element: HTMLElement,
  start: number,
  end: number
): DOMRect[] {
  const mapping = mapInnerTextToTextNodes(element, start, end);
  if (!mapping || !mapping.startNode) {
    return [];
  }

  try {
    const range = document.createRange();
    
    if (mapping.endNode && mapping.startNode !== mapping.endNode) {
      // Error birden fazla node'u kapsıyor
      range.setStart(mapping.startNode, Math.min(mapping.startOffset, mapping.startNode.textContent!.length));
      range.setEnd(mapping.endNode, Math.min(mapping.endOffset, mapping.endNode.textContent!.length));
    } else {
      // Error tek node içinde
      range.setStart(mapping.startNode, mapping.startOffset);
      range.setEnd(mapping.startNode, Math.min(mapping.endOffset, mapping.startNode.textContent!.length));
    }
    
    // Tüm client rect'leri al (multi-line için)
    const clientRects = range.getClientRects();
    const rects: DOMRect[] = [];
    
    for (let i = 0; i < clientRects.length; i++) {
      const clientRect = clientRects[i];
      if (clientRect && clientRect.width > 0 && clientRect.height > 0) {
        rects.push(new DOMRect(clientRect.left, clientRect.top, clientRect.width, clientRect.height));
      }
    }
    
    return rects;
  } catch (e) {
    console.error('Rewordly: Error getting contenteditable error rects:', e);
    return [];
  }
}

/**
 * Input/Textarea için error rect'lerini al
 */
export function getInputErrorRects(
  element: HTMLInputElement | HTMLTextAreaElement,
  start: number,
  end: number
): DOMRect[] {
  try {
    const value = element.value;
    if (start < 0 || end > value.length || start >= end) {
      return [];
    }

    // Selection range oluştur
    const range = document.createRange();
    const textNode = element.childNodes[0] as Text;
    
    if (!textNode || textNode.nodeType !== Node.TEXT_NODE) {
      // Text node yoksa, mirror element kullan
      return getInputErrorRectsWithMirror(element, start, end);
    }

    range.setStart(textNode, start);
    range.setEnd(textNode, end);
    
    const clientRects = range.getClientRects();
    const rects: DOMRect[] = [];
    
    for (let i = 0; i < clientRects.length; i++) {
      const clientRect = clientRects[i];
      if (clientRect && clientRect.width > 0 && clientRect.height > 0) {
        rects.push(new DOMRect(clientRect.left, clientRect.top, clientRect.width, clientRect.height));
      }
    }
    
    return rects;
  } catch (e) {
    console.error('Rewordly: Error getting input error rects:', e);
    return [];
  }
}

/**
 * Mirror element kullanarak input/textarea rect'lerini al
 */
function getInputErrorRectsWithMirror(
  element: HTMLInputElement | HTMLTextAreaElement,
  start: number,
  end: number
): DOMRect[] {
  const value = element.value;
  const errorText = value.substring(start, end);
  
  // Mirror element oluştur
  const mirror = document.createElement('div');
  const style = window.getComputedStyle(element);
  
  mirror.style.cssText = `
    position: absolute;
    visibility: hidden;
    white-space: ${element instanceof HTMLInputElement ? 'pre' : 'pre-wrap'};
    font-family: ${style.fontFamily};
    font-size: ${style.fontSize};
    font-weight: ${style.fontWeight};
    padding: ${style.padding};
    border: ${style.border};
    box-sizing: ${style.boxSizing};
    width: ${style.width};
  `;

  // Text'i ekle
  const beforeText = value.substring(0, start);
  const errorSpan = document.createElement('span');
  errorSpan.textContent = errorText;
  errorSpan.style.background = 'rgba(255, 0, 0, 0.2)';
  
  mirror.textContent = beforeText;
  mirror.appendChild(errorSpan);
  document.body.appendChild(mirror);

  const rect = errorSpan.getBoundingClientRect();
  document.body.removeChild(mirror);

  if (rect.width > 0 && rect.height > 0) {
    return [new DOMRect(rect.left, rect.top, rect.width, rect.height)];
  }

  return [];
}

