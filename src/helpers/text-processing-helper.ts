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

  // Use text extraction that excludes signature to match error positions
  const { text: extractedText } = extractTextExcludingSignature(element);
  const innerText = extractedText;
  
  if (start >= innerText.length || end > innerText.length) {
    return null;
  }

  // Find text nodes and map their positions to innerText
  const walker = document.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT,
    null
  );

  const textNodes: Array<{ node: Text; innerTextStart: number; innerTextEnd: number }> = [];
  let searchStart = 0;

  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    if (!node || !node.textContent) continue;
    
    const parent = node.parentElement;
    if (!parent) continue;
    
    // Skip signature elements (Gmail and other email clients)
    // Check if this node is inside a signature block
    const isInSignature = parent.closest('.gmail_signature, [class*="signature"], [id*="signature"]') !== null;
    if (isInSignature) {
      continue; // Skip signature text nodes
    }
    
    // Check visibility
    const style = window.getComputedStyle(parent);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    
    const nodeText = node.textContent;
    
    // Find where this node's text appears in innerText
    let foundIndex = -1;
    let searchPos = searchStart;
    
    while (searchPos < innerText.length) {
      // Skip \n characters in innerText
      while (searchPos < innerText.length && innerText[searchPos] === '\n') {
        searchPos++;
      }
      
      if (searchPos >= innerText.length) break;
      
      // Try to match node text
      let match = true;
      let innerPos = searchPos;
      let nodePos = 0;
      
      while (nodePos < nodeText.length && innerPos < innerText.length) {
        const nodeChar = nodeText[nodePos];
        const innerChar = innerText[innerPos];
        
        if (nodeChar === innerChar) {
          innerPos++;
          nodePos++;
        } else if (innerChar === '\n') {
          innerPos++;
        } else if (nodeChar === '\r' || nodeChar === '\n') {
          nodePos++;
        } else {
          match = false;
          break;
        }
      }
      
      if (match && nodePos === nodeText.length) {
        foundIndex = searchPos;
        break;
      }
      
      searchPos++;
    }
    
    if (foundIndex !== -1) {
      // Calculate end position
      let innerTextEnd = foundIndex;
      let nodePos = 0;
      
      while (nodePos < nodeText.length && innerTextEnd < innerText.length) {
        const nodeChar = nodeText[nodePos];
        const innerChar = innerText[innerTextEnd];
        
        if (nodeChar === innerChar) {
          innerTextEnd++;
          nodePos++;
        } else if (innerChar === '\n') {
          innerTextEnd++;
        } else if (nodeChar === '\r' || nodeChar === '\n') {
          nodePos++;
        } else {
          break;
        }
      }
      
      textNodes.push({
        node,
        innerTextStart: foundIndex,
        innerTextEnd: innerTextEnd
      });
      
      searchStart = innerTextEnd;
    }
  }

  // Find the node(s) containing the error
  const startNodeInfo = textNodes.find(tn => start >= tn.innerTextStart && start < tn.innerTextEnd);
  const endNodeInfo = textNodes.find(tn => end > tn.innerTextStart && end <= tn.innerTextEnd);

  if (!startNodeInfo) {
    return null;
  }

  // Calculate local positions within the text nodes (skipping \n characters)
  let startNodeLocalPos = 0;
  let endNodeLocalPos = 0;
  
  // For start position: count characters from innerTextStart to start, skipping \n
  let pos = startNodeInfo.innerTextStart;
  while (pos < start && pos < innerText.length) {
    if (innerText[pos] !== '\n') {
      startNodeLocalPos++;
    }
    pos++;
  }
  
  if (endNodeInfo && endNodeInfo.node !== startNodeInfo.node) {
    // Error spans multiple nodes
    pos = endNodeInfo.innerTextStart;
    while (pos < end && pos < innerText.length) {
      if (innerText[pos] !== '\n') {
        endNodeLocalPos++;
      }
      pos++;
    }
    
    return {
      startNode: startNodeInfo.node,
      startOffset: startNodeLocalPos,
      endNode: endNodeInfo.node,
      endOffset: endNodeLocalPos
    };
  } else {
    // Error is within a single node
    pos = startNodeInfo.innerTextStart;
    while (pos < end && pos < innerText.length) {
      if (innerText[pos] !== '\n') {
        endNodeLocalPos++;
      }
      pos++;
    }
    
    return {
      startNode: startNodeInfo.node,
      startOffset: startNodeLocalPos,
      endNode: startNodeInfo.node,
      endOffset: endNodeLocalPos
    };
  }
}

/**
 * Text'i signature hariç çıkar
 * Gmail gibi platformlarda signature'ı hariç tutmak için
 * Content.ts'deki versiyonla uyumlu - textSource döndürür
 */
export function extractTextExcludingSignature(element: HTMLElement): {
  text: string;
  textSource: "value" | "textContent" | "innerText";
} {
  // Check if this is a Google Docs virtual element
  if (
    (element as any).__rewordlyIsGoogleDocs &&
    (element as any).__rewordlyGoogleDocsContainer
  ) {
    // For Google Docs, use the textContent that was set on the virtual element
    // This text was already filtered by getGoogleDocsText() function
    const text = element.textContent || element.innerText || "";
    return {
      text: text,
      textSource: "textContent",
    };
  }

  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement
  ) {
    return {
      text: element.value,
      textSource: "value",
    };
  } else if (
    element.getAttribute("contenteditable") === "true" ||
    element.isContentEditable
  ) {
    // Temporarily hide signature elements to exclude them from innerText
    // This preserves line breaks and formatting while excluding signature
    const signatureElements = element.querySelectorAll(
      '.gmail_signature, [class*="signature"], [id*="signature"]'
    );
    const signaturePrefix = element.querySelector(".gmail_signature_prefix");

    const hiddenElements: Array<{
      el: HTMLElement;
      originalDisplay: string;
    }> = [];

    // Hide signature elements
    signatureElements.forEach((sigEl) => {
      const htmlEl = sigEl as HTMLElement;
      const originalDisplay = htmlEl.style.display;
      htmlEl.style.display = "none";
      hiddenElements.push({ el: htmlEl, originalDisplay });
    });

    // Hide signature prefix
    if (signaturePrefix) {
      const htmlEl = signaturePrefix as HTMLElement;
      const originalDisplay = htmlEl.style.display;
      htmlEl.style.display = "none";
      hiddenElements.push({ el: htmlEl, originalDisplay });
    }

    // Get text with innerText (preserves line breaks from <br> and block elements)
    let text = element.innerText || element.textContent || "";

    // Restore original display styles
    hiddenElements.forEach(({ el, originalDisplay }) => {
      if (originalDisplay) {
        el.style.display = originalDisplay;
      } else {
        el.style.removeProperty("display");
      }
    });

    // Don't trim trailing whitespace - it's needed to maintain correct error positions
    // Signature exclusion is already handled by hiding signature elements above

    const textSource = "innerText";

    return { text, textSource };
  }

  // Fallback for other element types
  return {
    text: element.textContent || "",
    textSource: "textContent",
  };
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

/**
 * Adjust error positions for multi-word grammar errors to highlight only problematic word(s)
 * For errors like "an important meetings", we should highlight only "meetings" (the noun)
 */
export function adjustErrorPositionsForMultiWord(_text: string, error: GrammarError): { start: number; end: number } {
  // Always return original positions to highlight the entire error phrase
  // This ensures multi-word grammar errors like "an important meetings" 
  // are fully highlighted, not just the last word
  return { start: error.start, end: error.end };
}

/**
 * Escape HTML to prevent XSS
 */
export function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Format suggestion for display - makes whitespace-only suggestions visible
 */
export function formatSuggestionForDisplay(suggestion: string, errorWord: string): string {
  // If suggestion is only whitespace, provide a descriptive message
  if (/^\s+$/.test(suggestion)) {
    const suggestionSpaceCount = suggestion.length;
    
    // If error word is also whitespace and has more spaces than suggestion
    if (/^\s+$/.test(errorWord) && errorWord.length > suggestionSpaceCount) {
      if (suggestionSpaceCount === 1) {
        return 'Remove extra space';
      } else {
        return `Remove extra spaces (keep ${suggestionSpaceCount})`;
      }
    }
    
    // If suggestion is a single space
    if (suggestionSpaceCount === 1) {
      return 'Use single space';
    } else {
      return `Use ${suggestionSpaceCount} spaces`;
    }
  }
  return suggestion;
}

