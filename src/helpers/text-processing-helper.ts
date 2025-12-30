/**
 * Text Processing Helper
 * Text extraction, mapping ve position işlemleri
 * 
 * Bu dosya text çıkarmak, text node'lara map etmek ve pozisyon hesaplamakla ilgilenir.
 * Basitçe: Text çıkar, pozisyon bul, map et gibi.
 */

import { GrammarError } from '../types';

/**
 * InnerText pozisyonlarını text node pozisyonlarına map et
 * Contenteditable elementler için kritik
 */
export interface TextNodeMapping {
  startNode: Text | null;
  startOffset: number;
  endNode: Text | null;
  endOffset: number;
}

export function mapInnerTextToTextNodes(
  element: HTMLElement,
  start: number,
  end: number
): TextNodeMapping | null {
  if (!element) return null;

  // Element'in innerText'ini al
  const innerText = element.innerText || element.textContent || '';
  
  if (start < 0 || end > innerText.length || start >= end) {
    return null;
  }

  // Text node'ları bul
  const walker = document.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT,
    null
  );

  let currentPos = 0;
  let startNode: Text | null = null;
  let startOffset = 0;
  let endNode: Text | null = null;
  let endOffset = 0;

  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node.nodeType !== Node.TEXT_NODE) continue;

    const textNode = node as Text;
    const nodeText = textNode.textContent || '';
    const nodeLength = nodeText.length;

    // Start pozisyonu bu node'da mı?
    if (!startNode && currentPos + nodeLength >= start) {
      startNode = textNode;
      startOffset = start - currentPos;
    }

    // End pozisyonu bu node'da mı?
    if (!endNode && currentPos + nodeLength >= end) {
      endNode = textNode;
      endOffset = end - currentPos;
      break; // Her ikisini de bulduk
    }

    currentPos += nodeLength;
  }

  if (!startNode) {
    return null;
  }

  // End node bulunamadıysa start node'u kullan
  if (!endNode) {
    endNode = startNode;
    endOffset = startOffset + (end - start);
  }

  return {
    startNode,
    startOffset: Math.max(0, Math.min(startOffset, startNode.textContent?.length || 0)),
    endNode,
    endOffset: Math.max(0, Math.min(endOffset, endNode.textContent?.length || 0))
  };
}

/**
 * Text'i signature hariç çıkar
 * Gmail gibi platformlarda signature'ı hariç tutmak için
 */
export function extractTextExcludingSignature(element: HTMLElement): {
  text: string;
  signatureStart: number;
} {
  let text = '';
  let signatureStart = -1;

  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    text = element.value || '';
  } else if (element.getAttribute('contenteditable') === 'true' || element.isContentEditable) {
    text = element.innerText || element.textContent || '';
  }

  // Gmail signature pattern'leri
  const signaturePatterns = [
    /^--\s*$/m,  // "--" ile başlayan satır
    /^Sent from .*$/m,  // "Sent from ..." ile başlayan satır
    /^On .* wrote:$/m,  // "On ... wrote:" ile başlayan satır
  ];

  // Signature başlangıcını bul
  for (const pattern of signaturePatterns) {
    const match = text.match(pattern);
    if (match && match.index !== undefined) {
      signatureStart = match.index;
      break;
    }
  }

  // Signature varsa text'i kırp
  if (signatureStart > 0) {
    text = text.substring(0, signatureStart).trim();
  }

  return { text, signatureStart };
}

/**
 * Text'ten error pozisyonlarını güncelle
 * Text değiştiğinde error pozisyonlarını güncellemek için
 */
export function updateErrorPositions(
  errors: GrammarError[],
  _oldText: string,
  newText: string
): GrammarError[] {
  // Basit implementasyon - gerçekte daha karmaşık olabilir
  // Text değişikliği sonrası error pozisyonlarını güncelle
  return errors.map(error => {
    // Eğer error hala geçerliyse pozisyonu koru
    // Değilse -1 yap (invalid)
    if (error.start >= 0 && error.end <= newText.length) {
      const errorText = newText.substring(error.start, error.end);
      if (errorText.toLowerCase().trim() === error.word.toLowerCase().trim()) {
        return error; // Pozisyon hala geçerli
      }
    }
    
    // Pozisyon geçersiz
    return { ...error, start: -1, end: -1 };
  }).filter(error => error.start >= 0); // Sadece geçerli error'ları döndür
}

