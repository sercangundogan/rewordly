/**
 * Highlight Helper
 * Grammar error highlight'larını render etme, güncelleme ve temizleme işlemleri
 *
 * Bu dosya highlight'ları göstermek, pozisyonlarını güncellemek ve temizlemekle ilgilenir.
 * Basitçe: Highlight göster, pozisyon güncelle, temizle gibi.
 */

import { GrammarError } from "../types";
import { getElementId } from "./element-helper";
import { generateErrorId } from "./config-helper";
import { getDismissKey } from "./grammar-check-helper";
import {
  extractTextExcludingSignature,
  adjustErrorPositionsForMultiWord,
  escapeHtml,
  formatSuggestionForDisplay,
  mapInnerTextToTextNodes,
} from "./text-processing-helper";

/**
 * Highlight Container Helper
 * Grammarly-style highlight container yönetimi
 */
export class HighlightContainerHelper {
  private container: HTMLElement | null = null;
  private shadowRoot: ShadowRoot | null = null;
  private content: HTMLElement | null = null;

  /**
   * Get container element
   */
  getContainer(): HTMLElement | null {
    return this.container;
  }

  /**
   * Get shadow root
   */
  getShadowRoot(): ShadowRoot | null {
    return this.shadowRoot;
  }

  /**
   * Get content element
   */
  getContent(): HTMLElement | null {
    return this.content;
  }

  /**
   * Highlight container oluştur
   * Content.ts versiyonu ile uyumlu - Reddit için özel z-index desteği
   */
  create(): void {
    // Remove existing container if any
    if (this.container) {
      this.container.remove();
      this.container = null;
      this.shadowRoot = null;
      this.content = null;
    }

    // Custom element tanımla (Reddit için)
    if (
      typeof customElements !== "undefined" &&
      customElements &&
      !customElements.get("rewordly-highlights")
    ) {
      customElements.define(
        "rewordly-highlights",
        class extends HTMLElement {
          constructor() {
            super();
          }
        }
      );
    }

    // Create container element (like <grammarly-highlights>)
    this.container = document.createElement("rewordly-highlights");
    this.container.setAttribute("data-rewordly-shadow-root", "true");

    // Use maximum z-index for Reddit (Reddit has high z-index modals)
    const isReddit = window.location.hostname.includes("reddit.com");
    const zIndex = isReddit ? "2147483647" : "2147483645";

    this.container.style.cssText = `
      position: fixed !important;
      top: 0 !important;
      left: 0 !important;
      width: 0 !important;
      height: 0 !important;
      pointer-events: none !important;
      z-index: ${zIndex} !important;
      overflow: visible !important;
      visibility: visible !important;
    `;

    // Create Shadow DOM
    this.shadowRoot = this.container.attachShadow({
      mode: "open",
    });

    // Create content div inside Shadow DOM
    this.content = document.createElement("div");
    this.content.setAttribute("data-rewordly-part", "highlights");
    this.content.style.cssText = `
      position: absolute !important;
      top: 0 !important;
      left: 0 !important;
      width: 100vw !important;
      height: 100vh !important;
      pointer-events: none !important;
      overflow: visible !important;
    `;

    // Add styles to Shadow DOM
    const style = document.createElement("style");
    // Use the same isReddit variable defined above
    style.textContent = `
      .rewordly-highlight {
        position: absolute !important;
        pointer-events: auto !important;
        cursor: pointer !important;
        border-bottom: 2px solid #ef4444 !important;
        box-sizing: content-box !important;
        z-index: ${isReddit ? "2147483647" : "1"} !important;
        /* No transition for position updates - only animate on initial creation */
        transition: none !important;
        transform-origin: left center !important;
        ${isReddit ? "background: rgba(239, 68, 68, 0.05) !important;" : ""}
      }
      .rewordly-highlight:hover {
        background: rgba(239, 68, 68, 0.1) !important;
      }
      .rewordly-highlight.rewordly-highlight-enter {
        overflow: hidden !important;
      }
      .rewordly-highlight.rewordly-no-transition {
        transition: none !important;
        will-change: auto !important;
      }
    `;

    this.shadowRoot.appendChild(style);
    this.shadowRoot.appendChild(this.content);

    // Append to document body (at the end, like Grammarly)
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
    errors.forEach((error) => {
      const rects = getErrorRects(error);

      rects.forEach((rect, index) => {
        if (rect.width === 0 || rect.height === 0) return;

        const highlight = document.createElement("div");
        highlight.className = "rewordly-highlight";
        highlight.setAttribute("data-element-id", elementId);
        highlight.setAttribute("data-error-id", error.id);
        highlight.setAttribute("data-line-index", index.toString());
        highlight.setAttribute("data-error", JSON.stringify(error));

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
    const highlights = this.content.querySelectorAll(
      `[data-element-id="${elementId}"]`
    );

    // Error'ları ID'ye göre grupla
    const errorsByLine = new Map<
      string,
      { error: GrammarError; lineIndex: number }[]
    >();

    highlights.forEach((highlight) => {
      const errorId = highlight.getAttribute("data-error-id");
      const lineIndex = parseInt(
        highlight.getAttribute("data-line-index") || "0",
        10
      );

      if (errorId) {
        const error = errors.find((e) => e.id === errorId);
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
      const errorId = highlight.getAttribute("data-error-id");
      const lineIndex = parseInt(
        highlight.getAttribute("data-line-index") || "0",
        10
      );

      if (errorId) {
        const error = errors.find((e) => e.id === errorId);
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
    const highlights = this.content.querySelectorAll(
      `[data-element-id="${elementId}"]`
    );
    highlights.forEach((highlight) => highlight.remove());
  }

  /**
   * Tüm highlight'ları temizle
   */
  clearAll(): void {
    if (this.content) {
      this.content.innerHTML = "";
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
      range.setStart(
        mapping.startNode,
        Math.min(mapping.startOffset, mapping.startNode.textContent!.length)
      );
      range.setEnd(
        mapping.endNode,
        Math.min(mapping.endOffset, mapping.endNode.textContent!.length)
      );
    } else {
      // Error tek node içinde
      range.setStart(mapping.startNode, mapping.startOffset);
      range.setEnd(
        mapping.startNode,
        Math.min(mapping.endOffset, mapping.startNode.textContent!.length)
      );
    }

    // Tüm client rect'leri al (multi-line için)
    const clientRects = range.getClientRects();
    const rects: DOMRect[] = [];

    for (let i = 0; i < clientRects.length; i++) {
      const clientRect = clientRects[i];
      if (clientRect && clientRect.width > 0 && clientRect.height > 0) {
        rects.push(
          new DOMRect(
            clientRect.left,
            clientRect.top,
            clientRect.width,
            clientRect.height
          )
        );
      }
    }

    return rects;
  } catch (e) {
    console.error("Rewordly: Error getting contenteditable error rects:", e);
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
        rects.push(
          new DOMRect(
            clientRect.left,
            clientRect.top,
            clientRect.width,
            clientRect.height
          )
        );
      }
    }

    return rects;
  } catch (e) {
    console.error("Rewordly: Error getting input error rects:", e);
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
  const mirror = document.createElement("div");
  const style = window.getComputedStyle(element);

  mirror.style.cssText = `
    position: absolute;
    visibility: hidden;
    white-space: ${element instanceof HTMLInputElement ? "pre" : "pre-wrap"};
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
  const errorSpan = document.createElement("span");
  errorSpan.textContent = errorText;
  errorSpan.style.background = "rgba(255, 0, 0, 0.2)";

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

/**
 * Get all rects for error text (supports multi-line highlights)
 * Returns an array of DOMRects, one for each line the error spans
 */
export function getErrorTextRects(
  element: HTMLElement,
  start: number,
  end: number
): DOMRect[] {
  // Special handling for Google Docs virtual elements
  if (
    (element as any).__rewordlyIsGoogleDocs &&
    (element as any).__rewordlyGoogleDocsContainer
  ) {
    return getGoogleDocsErrorRects(element, start, end);
  }

  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement
  ) {
    return getInputTextareaErrorRects(element, start, end);
  } else if (
    element.getAttribute("contenteditable") === "true" ||
    element.isContentEditable
  ) {
    return getContentEditableErrorRects(element, start, end);
  }
  return [];
}

/**
 * Get error rects for input/textarea elements (supports multi-line)
 */
export function getInputTextareaErrorRects(
  element: HTMLInputElement | HTMLTextAreaElement,
  start: number,
  end: number
): DOMRect[] {
  const text = element.value;
  if (start >= text.length || end > text.length) {
    return [];
  }

  const elementRect = element.getBoundingClientRect();
  const styles = window.getComputedStyle(element);

  // Get padding and border for accurate width calculation
  const paddingLeft = parseFloat(styles.paddingLeft) || 0;
  const paddingRight = parseFloat(styles.paddingRight) || 0;
  const borderLeft = parseFloat(styles.borderLeftWidth) || 0;
  const borderRight = parseFloat(styles.borderRightWidth) || 0;
  const paddingTop = parseFloat(styles.paddingTop) || 0;
  const borderTop = parseFloat(styles.borderTopWidth) || 0;

  // Calculate content width (element width minus padding and borders)
  const contentWidth =
    elementRect.width - paddingLeft - paddingRight - borderLeft - borderRight;

  // Create a mirror div to measure text position
  const div = document.createElement("div");
  const divStyle = div.style;

  // Copy all relevant styles
  const properties = [
    "direction",
    "boxSizing",
    "overflowX",
    "overflowY",
    "borderTopWidth",
    "borderRightWidth",
    "borderBottomWidth",
    "borderLeftWidth",
    "borderStyle",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "fontStyle",
    "fontVariant",
    "fontWeight",
    "fontStretch",
    "fontSize",
    "fontSizeAdjust",
    "lineHeight",
    "fontFamily",
    "textAlign",
    "textTransform",
    "textIndent",
    "textDecoration",
    "letterSpacing",
    "wordSpacing",
    "tabSize",
    "MozTabSize",
    "whiteSpace",
  ];

  properties.forEach((prop) => {
    // @ts-ignore
    divStyle[prop] = styles[prop];
  });

  // Set exact content width to ensure proper text wrapping
  divStyle.width = `${contentWidth}px`;
  divStyle.position = "absolute";
  divStyle.visibility = "hidden";
  divStyle.top = "-9999px";
  divStyle.left = "-9999px";
  divStyle.whiteSpace =
    element instanceof HTMLInputElement ? "pre" : "pre-wrap";
  if (!(element instanceof HTMLInputElement)) {
    divStyle.wordWrap = "break-word";
  }

  // Build the complete text structure for accurate measurement
  div.textContent = text;

  document.body.appendChild(div);

  // Force layout calculation
  void div.offsetHeight;

  // Use Range API to measure the exact position of the error text
  const range = document.createRange();
  const textNode = div.firstChild;

  if (!textNode || textNode.nodeType !== Node.TEXT_NODE) {
    document.body.removeChild(div);
    return [];
  }

  // Set range to cover the error text
  const startOffset = Math.min(start, textNode.textContent!.length);
  const endOffset = Math.min(end, textNode.textContent!.length);

  range.setStart(textNode, startOffset);
  range.setEnd(textNode, endOffset);

  // Get all client rects (one for each line the error spans)
  const clientRects = range.getClientRects();
  const divRect = div.getBoundingClientRect();

  // Account for scroll
  const scrollLeft = element.scrollLeft || 0;
  const scrollTop = element.scrollTop || 0;

  // For Reddit, measure the actual text start position to account for container offsets
  // This fixes the issue where highlights appear offset to the right
  const isReddit = window.location.hostname.includes("reddit.com");
  let textStartOffset = 0;

  if (isReddit && text.length > 0) {
    // Measure the first character's position in the mirror div
    // The mirror div should have the same text layout as the textarea
    const firstCharRange = document.createRange();
    const firstCharTextNode = div.firstChild;
    if (
      firstCharTextNode &&
      firstCharTextNode.nodeType === Node.TEXT_NODE &&
      firstCharTextNode.textContent!.length > 0
    ) {
      firstCharRange.setStart(firstCharTextNode, 0);
      firstCharRange.setEnd(firstCharTextNode, 1);
      const firstCharRect = firstCharRange.getBoundingClientRect();

      // The first character in the mirror div should start at divRect.left (accounting for padding)
      // But in Reddit's textarea, there might be an additional offset
      // We calculate where the first char actually is relative to the div
      const firstCharRelativeLeft = firstCharRect.left - divRect.left;

      // The expected position should be 0 (or very close) since we copied all styles
      // If there's a difference, it means Reddit has additional container offsets
      // We'll use this to adjust the highlight positions
      if (firstCharRelativeLeft > 0.1) {
        // Only apply if there's a noticeable offset (>0.1px)
        textStartOffset = firstCharRelativeLeft;
      }
    }
  }

  // Convert each client rect to viewport coordinates
  const rects: DOMRect[] = [];
  for (let i = 0; i < clientRects.length; i++) {
    const clientRect = clientRects[i];
    if (!clientRect) continue;

    // Calculate left position: element position + padding/border + relative position in mirror div - scroll - text start offset
    // The textStartOffset corrects for Reddit's container-specific positioning
    const left =
      elementRect.left +
      paddingLeft +
      borderLeft +
      (clientRect.left - divRect.left) -
      scrollLeft -
      textStartOffset;
    const top =
      elementRect.top +
      paddingTop +
      borderTop +
      (clientRect.top - divRect.top) -
      scrollTop;
    const width = clientRect.width;
    const height =
      clientRect.height ||
      parseFloat(styles.lineHeight) ||
      parseFloat(styles.fontSize) * 1.2;

    rects.push(new DOMRect(left, top, width, height));
  }

  document.body.removeChild(div);

  return rects;
}

/**
 * Get error rects for Google Docs virtual elements
 * Google Docs uses canvas for rendering, but has an accessibility layer with text nodes.
 * Enhanced with canvas overlay support and better text node mapping.
 */
export function getGoogleDocsErrorRects(
  element: HTMLElement,
  start: number,
  end: number
): DOMRect[] {
  // Get the text from the virtual element (this is the extracted text from DOCS_modelChunk)
  const extractedText = element.textContent || element.innerText || "";
  if (start >= extractedText.length || end > extractedText.length) {
    return [];
  }

  // Extract the error word/phrase
  const errorText = extractedText.substring(start, end).trim();
  if (!errorText) {
    return [];
  }

  try {
    // Get the Google Docs container
    const container = (element as any)
      .__rewordlyGoogleDocsContainer as HTMLElement;
    if (!container) {
      console.warn("Rewordly: Google Docs container not found");
      return [];
    }

    // Find the editor area
    const editorArea =
      container.querySelector(".kix-appview-editor") ||
      container.querySelector(".kix-scrollareadocumentplugin") ||
      container.querySelector("#kix-appview") ||
      container;

    if (!editorArea) {
      console.warn("Rewordly: Google Docs editor area not found");
      return [];
    }

    // Get canvas elements for overlay positioning
    const canvases = Array.from(
      editorArea.querySelectorAll("canvas.kix-canvas-tile-content")
    ) as HTMLCanvasElement[];
    const canvasRects = canvases.map((c) => c.getBoundingClientRect());

    // Get scroll position for accurate positioning
    const scrollContainer =
      editorArea.closest(".kix-scrollareadocumentplugin") || editorArea;
    const scrollTop = scrollContainer.scrollTop || 0;
    const scrollLeft = scrollContainer.scrollLeft || 0;

    // Method 0: Use window.find() to programmatically select text and get position
    // This works with Google Docs because it uses the browser's find functionality
    // which works with the accessibility layer
    const selection = window.getSelection();
    if (selection) {
      // Save current selection
      const savedRanges: Range[] = [];
      if (selection.rangeCount > 0) {
        for (let i = 0; i < selection.rangeCount; i++) {
          savedRanges.push(selection.getRangeAt(i).cloneRange());
        }
      }

      try {
        // Clear current selection
        selection.removeAllRanges();

        // Reset to start of document
        if (document.body) {
          const range = document.createRange();
          range.selectNodeContents(document.body);
          range.collapse(true); // Collapse to start
          selection.addRange(range);
          selection.removeAllRanges();
        }

        // Try to find the error text using window.find()
        // window.find() searches in the accessibility layer which Google Docs maintains
        let found = false;
        let foundRange: Range | null = null;

        // Strategy 1: Try exact match (case-sensitive)
        found = (window as any).find(errorText, false, false, false);
        if (found && selection.rangeCount > 0) {
          foundRange = selection.getRangeAt(0);
        }

        // Strategy 2: If not found, try case-insensitive
        if (!found) {
          // Reset selection
          selection.removeAllRanges();
          if (document.body) {
            const range = document.createRange();
            range.selectNodeContents(document.body);
            range.collapse(true);
            selection.addRange(range);
            selection.removeAllRanges();
          }

          const errorTextLower = errorText.toLowerCase().trim();
          found = (window as any).find(errorTextLower, false, false, false);
          if (found && selection.rangeCount > 0) {
            foundRange = selection.getRangeAt(0);
          }
        }

        // Strategy 3: If still not found, try finding just the first word (for multi-word errors)
        if (!found && errorText.includes(" ")) {
          const firstWord = errorText.trim().split(/\s+/)[0];
          if (firstWord && firstWord.length > 2) {
            selection.removeAllRanges();
            if (document.body) {
              const range = document.createRange();
              range.selectNodeContents(document.body);
              range.collapse(true);
              selection.addRange(range);
              selection.removeAllRanges();
            }

            found = (window as any).find(firstWord, false, false, false);
            if (found && selection.rangeCount > 0) {
              foundRange = selection.getRangeAt(0);
              // If we found the first word, try to extend the range to include the full error text
              try {
                const range = foundRange.cloneRange();
                const rangeText = range.toString().toLowerCase();
                const errorTextLower = errorText.toLowerCase().trim();

                // Check if the found text matches or contains the error text
                if (rangeText.includes(errorTextLower)) {
                  // Try to extend range to match full error text
                  const startOffset = rangeText.indexOf(errorTextLower);
                  if (startOffset >= 0) {
                    range.setStart(
                      range.startContainer,
                      range.startOffset + startOffset
                    );
                    range.setEnd(
                      range.startContainer,
                      range.startOffset + startOffset + errorTextLower.length
                    );
                    foundRange = range;
                  }
                }
              } catch (e) {
                // If extension fails, use the first word range
                console.warn(
                  "Rewordly: Could not extend range for multi-word error",
                  e
                );
              }
            }
          }
        }

        if (found && foundRange) {
          const clientRects = foundRange.getClientRects();
          const rects: DOMRect[] = [];

          for (let i = 0; i < clientRects.length; i++) {
            const clientRect = clientRects[i];
            if (clientRect && clientRect.width > 0 && clientRect.height > 0) {
              // Adjust for scroll position and verify visibility
              const adjustedRect = new DOMRect(
                clientRect.left,
                clientRect.top,
                clientRect.width,
                clientRect.height
              );

              // Verify rect is within visible canvas area (more lenient check)
              const isVisible =
                canvasRects.length === 0 ||
                canvasRects.some((canvasRect) => {
                  return (
                    adjustedRect.left >= canvasRect.left - 100 &&
                    adjustedRect.left <= canvasRect.right + 100 &&
                    adjustedRect.top >= canvasRect.top - 100 &&
                    adjustedRect.top <= canvasRect.bottom + 100
                  );
                });

              if (isVisible || canvasRects.length === 0) {
                rects.push(adjustedRect);
              }
            }
          }

          if (rects.length > 0 && rects[0]) {
            console.log(
              "Rewordly: Google Docs highlight found via window.find()",
              {
                rects: rects.length,
                firstRect: {
                  left: rects[0].left,
                  top: rects[0].top,
                  width: rects[0].width,
                  height: rects[0].height,
                },
                errorText: errorText.substring(0, 30),
                scrollTop,
                scrollLeft,
                canvasCount: canvases.length,
                foundText: foundRange.toString().substring(0, 30),
              }
            );

            // Restore original selection
            selection.removeAllRanges();
            savedRanges.forEach((r) => {
              try {
                selection.addRange(r);
              } catch (e) {
                // Ignore errors
              }
            });

            return rects;
          }
        }

        // Restore original selection
        selection.removeAllRanges();
        savedRanges.forEach((r) => {
          try {
            selection.addRange(r);
          } catch (e) {
            // Ignore errors
          }
        });
      } catch (e) {
        console.warn("Rewordly: window.find() method failed", e);
        // Restore selection on error
        if (selection) {
          selection.removeAllRanges();
          savedRanges.forEach((r) => {
            try {
              selection.addRange(r);
            } catch (e) {
              // Ignore errors
            }
          });
        }
      }
    }

    // Method 1: Walk through text nodes and match by text content (more reliable than position)
    // This is the most reliable method for Google Docs
    const textNodes: Array<{ node: Text; element: HTMLElement; text: string }> =
      [];

    console.log("Rewordly: getGoogleDocsErrorRects called", {
      errorText: errorText.substring(0, 50),
      start,
      end,
      extractedTextLength: extractedText.length,
      container: container ? container.className : "null",
    });

    // First, try to find contenteditable element directly (most reliable)
    const contentEditableElement = editorArea.querySelector(
      '[contenteditable="true"]'
    ) as HTMLElement;
    let searchRoot = contentEditableElement || editorArea;

    // Create a tree walker to find all text nodes - use more permissive filter
    const walker = document.createTreeWalker(searchRoot, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;

        // Skip UI elements
        const isUIElement =
          parent.closest(
            '[role="button"], [role="menu"], [role="toolbar"], [role="dialog"], [role="textbox"]'
          ) !== null;
        // But allow textbox if it's the main editor
        if (isUIElement && parent.getAttribute("role") !== "textbox") {
          return NodeFilter.FILTER_REJECT;
        }

        // Skip hidden elements
        const style = window.getComputedStyle(parent);
        if (style.display === "none" || style.visibility === "hidden") {
          return NodeFilter.FILTER_REJECT;
        }

        // More permissive: accept if in any document structure OR if parent is contenteditable
        const isInDocumentStructure =
          parent.closest(
            '.kix-paragraphrenderer, .kix-lineview, .kix-page-content, .kix-lineview-text-block, [contenteditable="true"]'
          ) !== null;
        if (!isInDocumentStructure) {
          // Also check if parent itself is contenteditable
          if (parent.getAttribute("contenteditable") !== "true") {
            return NodeFilter.FILTER_REJECT;
          }
        }

        return NodeFilter.FILTER_ACCEPT;
      },
    });

    let node: Node | null;
    let nodeCount = 0;
    while ((node = walker.nextNode())) {
      if (node.nodeType === Node.TEXT_NODE) {
        const textNode = node as Text;
        const nodeText = textNode.textContent || "";

        if (nodeText.trim().length > 0) {
          nodeCount++;

          // Find the parent element for this text node (for positioning)
          const parentElement = textNode.parentElement;
          if (parentElement) {
            textNodes.push({
              node: textNode,
              element: parentElement,
              text: nodeText,
            });
          }
        }
      }
    }

    console.log("Rewordly: Text nodes collected for Google Docs", {
      nodeCount,
      textNodesCount: textNodes.length,
      extractedTextLength: extractedText.length,
      errorText: errorText.substring(0, 30),
      searchRoot: searchRoot.tagName,
      hasContentEditable: !!contentEditableElement,
    });

    // Method 1a: Try to find error text directly in text nodes (most reliable)
    // Build full DOM text for matching
    const fullDOMText = textNodes.map((n) => n.text || "").join("");
    const errorTextLower = errorText.toLowerCase().trim();
    const domTextLower = fullDOMText.toLowerCase();

    // Try to find error text in DOM text
    let foundIndex = domTextLower.indexOf(errorTextLower);

    // If exact match fails, try word-by-word matching
    if (foundIndex === -1) {
      const errorWords = errorTextLower
        .split(/\s+/)
        .filter((w) => w.length > 0);
      if (errorWords.length > 0 && errorWords[0]) {
        const firstWord = errorWords[0];
        const firstWordIndex = domTextLower.indexOf(firstWord);
        if (firstWordIndex !== -1) {
          // Check if subsequent words match
          let allMatch = true;
          let currentIndex = firstWordIndex + firstWord.length;

          for (let i = 1; i < errorWords.length; i++) {
            const word = errorWords[i];
            if (!word) {
              allMatch = false;
              break;
            }

            while (
              currentIndex < domTextLower.length &&
              /\s/.test(domTextLower[currentIndex] || "")
            ) {
              currentIndex++;
            }

            if (
              domTextLower.substring(
                currentIndex,
                currentIndex + word.length
              ) !== word
            ) {
              allMatch = false;
              break;
            }

            currentIndex += word.length;
          }

          if (allMatch) {
            foundIndex = firstWordIndex;
          }
        }
      }
    }

    // Now find the text nodes that contain our error
    let startNode: Text | null = null;
    let startOffset = 0;
    let endNode: Text | null = null;
    let endOffset = 0;

    if (foundIndex !== -1) {
      // Found the error text, now map back to text nodes
      let domCumulativePos = 0;

      for (const nodeInfo of textNodes) {
        const nodeText = nodeInfo.node.textContent || "";
        const nodeStart = domCumulativePos;
        const nodeEnd = domCumulativePos + nodeText.length;

        if (foundIndex >= nodeStart && foundIndex < nodeEnd && !startNode) {
          startNode = nodeInfo.node;
          startOffset = foundIndex - nodeStart;
          console.log("Rewordly: Found start node by text matching", {
            foundIndex,
            nodeStart,
            nodeEnd,
            startOffset,
            nodeText: nodeText.substring(0, 50),
          });
        }

        const errorEndIndex = foundIndex + errorText.length;
        if (errorEndIndex > nodeStart && errorEndIndex <= nodeEnd && !endNode) {
          endNode = nodeInfo.node;
          endOffset = errorEndIndex - nodeStart;
          console.log("Rewordly: Found end node by text matching", {
            errorEndIndex,
            nodeStart,
            nodeEnd,
            endOffset,
            nodeText: nodeText.substring(0, 50),
          });
          break;
        }

        domCumulativePos = nodeEnd;
      }
    } else {
      console.warn("Rewordly: Could not find error text in DOM", {
        errorText: errorText.substring(0, 30),
        errorTextLower,
        domTextLength: domTextLower.length,
        domTextPreview: domTextLower.substring(0, 100),
        textNodesCount: textNodes.length,
      });
    }

    if (startNode) {
      try {
        const range = document.createRange();

        // Ensure offsets are within node bounds
        const startNodeText = startNode.textContent || "";
        const safeStartOffset = Math.min(startOffset, startNodeText.length);

        if (endNode && endNode !== startNode) {
          const endNodeText = endNode.textContent || "";
          const safeEndOffset = Math.min(endOffset, endNodeText.length);
          range.setStart(startNode, safeStartOffset);
          range.setEnd(endNode, safeEndOffset);
        } else {
          // Error is within a single node
          const safeEndOffset = Math.min(
            endOffset || startOffset + errorText.length,
            startNodeText.length
          );
          range.setStart(startNode, safeStartOffset);
          range.setEnd(startNode, safeEndOffset);
        }

        const clientRects = range.getClientRects();
        const rects: DOMRect[] = [];

        for (let i = 0; i < clientRects.length; i++) {
          const clientRect = clientRects[i];
          if (clientRect && clientRect.width > 0 && clientRect.height > 0) {
            // Adjust for scroll position
            const adjustedRect = new DOMRect(
              clientRect.left,
              clientRect.top,
              clientRect.width,
              clientRect.height
            );

            // Verify rect is within visible canvas area
            const isVisible =
              canvasRects.length === 0 ||
              canvasRects.some((canvasRect) => {
                return (
                  adjustedRect.left >= canvasRect.left - 50 &&
                  adjustedRect.left <= canvasRect.right + 50 &&
                  adjustedRect.top >= canvasRect.top - 50 &&
                  adjustedRect.top <= canvasRect.bottom + 50
                );
              });

            if (isVisible || canvasRects.length === 0) {
              rects.push(adjustedRect);
            }
          }
        }

        if (rects.length > 0 && rects[0]) {
          console.log(
            "Rewordly: Google Docs highlight found via text node matching",
            {
              rects: rects.length,
              firstRect: {
                left: rects[0].left,
                top: rects[0].top,
                width: rects[0].width,
                height: rects[0].height,
              },
              errorText: errorText.substring(0, 30),
              start,
              end,
              scrollTop,
              scrollLeft,
              canvasCount: canvases.length,
            }
          );
          return rects;
        }
      } catch (e) {
        console.warn("Rewordly: Range creation failed", e);
      }
    }

    // Method 2: Fallback - try to find text by searching in contenteditable
    // This is less reliable but can work as a fallback
    const contentEditableFallback = editorArea.querySelector(
      '[contenteditable="true"]'
    ) as HTMLElement;
    if (contentEditableFallback) {
      const editableText =
        contentEditableFallback.textContent ||
        contentEditableFallback.innerText ||
        "";

      // Try to find the error text by matching context around the position
      // Since extracted text might differ slightly, we try to find a match near the expected position
      const searchStart = Math.max(0, Math.floor(start * 0.9)); // Search slightly before
      const searchEnd = Math.min(editableText.length, Math.ceil(end * 1.1)); // Search slightly after
      const searchText = editableText.substring(searchStart, searchEnd);

      // Try exact match first
      let errorIndex = searchText.indexOf(errorText);
      if (errorIndex === -1) {
        // Try case-insensitive match
        const lowerSearchText = searchText.toLowerCase();
        const lowerErrorText = errorText.toLowerCase();
        errorIndex = lowerSearchText.indexOf(lowerErrorText);
      }

      if (errorIndex !== -1) {
        const actualIndex = searchStart + errorIndex;
        try {
          const fallbackWalker = document.createTreeWalker(
            contentEditableFallback,
            NodeFilter.SHOW_TEXT,
            null
          );

          let cumulativePos = 0;
          let startNode: Text | null = null;
          let startOffset = 0;
          let endNode: Text | null = null;
          let endOffset = 0;

          let node: Node | null;
          while ((node = fallbackWalker.nextNode())) {
            if (node.nodeType === Node.TEXT_NODE) {
              const textNode = node as Text;
              const nodeText = textNode.textContent || "";
              const nodeStart = cumulativePos;
              const nodeEnd = cumulativePos + nodeText.length;

              if (
                !startNode &&
                nodeStart <= actualIndex &&
                actualIndex < nodeEnd
              ) {
                startNode = textNode;
                startOffset = actualIndex - nodeStart;
              }

              if (
                startNode &&
                nodeStart < actualIndex + errorText.length &&
                actualIndex + errorText.length <= nodeEnd
              ) {
                endNode = textNode;
                endOffset = actualIndex + errorText.length - nodeStart;
                break;
              }

              cumulativePos += nodeText.length;
            }
          }

          if (startNode && endNode) {
            const range = document.createRange();
            range.setStart(startNode, startOffset);
            range.setEnd(endNode, endOffset);

            const clientRects = range.getClientRects();
            const rects: DOMRect[] = [];

            for (let i = 0; i < clientRects.length; i++) {
              const clientRect = clientRects[i];
              if (clientRect && clientRect.width > 0 && clientRect.height > 0) {
                // Adjust for scroll position and verify visibility
                const adjustedRect = new DOMRect(
                  clientRect.left,
                  clientRect.top,
                  clientRect.width,
                  clientRect.height
                );

                // Verify rect is within visible canvas area
                const isVisible =
                  canvasRects.length === 0 ||
                  canvasRects.some((canvasRect) => {
                    return (
                      adjustedRect.left >= canvasRect.left - 50 &&
                      adjustedRect.left <= canvasRect.right + 50 &&
                      adjustedRect.top >= canvasRect.top - 50 &&
                      adjustedRect.top <= canvasRect.bottom + 50
                    );
                  });

                if (isVisible || canvasRects.length === 0) {
                  rects.push(adjustedRect);
                }
              }
            }

            if (rects.length > 0) {
              console.log(
                "Rewordly: Google Docs highlight found via contenteditable fallback",
                {
                  rects: rects.length,
                  errorText: errorText.substring(0, 30),
                  scrollTop,
                  scrollLeft,
                  canvasCount: canvases.length,
                }
              );
              return rects;
            }
          }
        } catch (e) {
          console.warn("Rewordly: Contenteditable fallback failed", e);
        }
      }
    }

    console.warn("Rewordly: Could not find error text in Google Docs", {
      errorText: errorText.substring(0, 30),
      textLength: extractedText.length,
      start,
      end,
      textNodesFound: textNodes.length,
      extractedTextPreview: extractedText.substring(
        Math.max(0, start - 20),
        Math.min(extractedText.length, end + 20)
      ),
      hasContentEditable: !!contentEditableElement,
      editorAreaRect: editorArea ? editorArea.getBoundingClientRect() : null,
    });

    // Return empty array if all methods fail
    return [];
  } catch (e) {
    console.error("Rewordly: Error getting Google Docs error rects:", e);
    return [];
  }
}

/**
 * Close all grammar tooltips
 */
export function closeAllGrammarTooltips(): void {
  const allTooltips = document.querySelectorAll(".rewordly-grammar-tooltip");
  allTooltips.forEach((tooltip) => {
    tooltip.remove();
  });
}

/**
 * Validate and remove invalid highlights immediately when text changes
 */
export function validateAndRemoveInvalidHighlights(
  element: HTMLElement,
  highlightsContent: HTMLElement | null,
  grammarErrors: Map<HTMLElement, GrammarError[]>,
  extractTextExcludingSignature: (element: HTMLElement) => {
    text: string;
    textSource: "value" | "textContent" | "innerText";
  },
  getElementId: (element: HTMLElement) => string,
  isPerformingReplace: boolean
): void {
  // Don't validate during replace operations - positions are being updated
  if (isPerformingReplace) {
    return;
  }

  const currentErrors = grammarErrors.get(element);
  if (!currentErrors || currentErrors.length === 0) {
    return;
  }

  // Get current text (excluding signature to match error positions)
  const { text } = extractTextExcludingSignature(element);

  if (!highlightsContent) {
    return;
  }

  const elementId = getElementId(element);
  const highlights = highlightsContent.querySelectorAll(
    `[data-element-id="${elementId}"]`
  );

  highlights.forEach((highlight) => {
    const errorData = (highlight as HTMLElement).getAttribute("data-error");
    if (!errorData) {
      highlight.remove();
      return;
    }

    try {
      const error: GrammarError = JSON.parse(errorData);

      // Check if error position is still valid
      if (
        error.start < 0 ||
        error.end > text.length ||
        error.start >= error.end
      ) {
        // Position out of bounds, remove highlight
        highlight.remove();
        return;
      }

      // Check if the error word still matches at that position
      const errorWord = text.substring(error.start, error.end);
      // Strict matching: word must match exactly (case-insensitive, whitespace variations allowed)
      // If the word at that position has changed (e.g., "asd" -> "asdf"), highlight should be removed
      const isStillValid =
        errorWord.toLowerCase().trim() === error.word.toLowerCase().trim();

      if (!isStillValid) {
        // Word changed or deleted, remove highlight immediately
        highlight.remove();
      }
    } catch (e) {
      // Error parsing, remove highlight
      highlight.remove();
    }
  });

  // Update stored errors - remove invalid ones
  const validErrors = currentErrors.filter((error) => {
    if (
      error.start < 0 ||
      error.end > text.length ||
      error.start >= error.end
    ) {
      return false;
    }
    const errorWord = text.substring(error.start, error.end);
    // Strict matching: word must match exactly (case-insensitive, whitespace variations allowed)
    return errorWord.toLowerCase().trim() === error.word.toLowerCase().trim();
  });

  grammarErrors.set(element, validErrors);
}

/**
 * Create a single highlight for an error
 * @param animate - Whether to animate the highlight (default: true)
 */
export function createHighlight(
  element: HTMLElement,
  error: GrammarError,
  index: number,
  highlightsContent: HTMLElement | null,
  getErrorTextRects: (
    element: HTMLElement,
    start: number,
    end: number
  ) => DOMRect[],
  extractTextExcludingSignature: (element: HTMLElement) => {
    text: string;
    textSource: "value" | "textContent" | "innerText";
  },
  adjustErrorPositionsForMultiWord: (
    text: string,
    error: GrammarError
  ) => { start: number; end: number },
  getElementId: (element: HTMLElement) => string,
  isErrorDismissed: (element: HTMLElement, error: GrammarError) => boolean,
  attachHighlightHoverListener: (
    highlight: HTMLElement,
    error: GrammarError,
    element: HTMLElement
  ) => void,
  animate: boolean = true
): void {
  if (!highlightsContent) {
    return;
  }

  // Don't create highlight if error is dismissed
  if (isErrorDismissed(element, error)) {
    return;
  }

  // Get text from element (excluding signature)
  const { text } = extractTextExcludingSignature(element);

  if (!text || error.start >= text.length || error.end > text.length) {
    return;
  }

  // Adjust positions for multi-word grammar errors to highlight only problematic word(s)
  const adjustedPositions = adjustErrorPositionsForMultiWord(text, error);
  const highlightStart = adjustedPositions.start;
  const highlightEnd = adjustedPositions.end;

  // Get all rects for multi-line support (one rect per line)
  const highlightRects = getErrorTextRects(
    element,
    highlightStart,
    highlightEnd
  );
  if (highlightRects.length === 0) {
    const isGoogleDocs = (element as any).__rewordlyIsGoogleDocs === true;
    console.warn("Rewordly: No highlight rects found", {
      error,
      highlightStart,
      highlightEnd,
      textLength: text.length,
      elementType:
        element instanceof HTMLInputElement
          ? "input"
          : element instanceof HTMLTextAreaElement
          ? "textarea"
          : "contenteditable",
      isGoogleDocs,
      errorText: text.substring(
        Math.max(0, highlightStart - 10),
        Math.min(text.length, highlightEnd + 10)
      ),
      elementTextPreview: (
        element.textContent ||
        element.innerText ||
        ""
      ).substring(0, 100),
    });
    return;
  }

  console.log("Rewordly: Creating highlight", {
    error,
    highlightRects: highlightRects.length,
    highlightStart,
    highlightEnd,
    firstRect: highlightRects[0]
      ? {
          left: highlightRects[0].left,
          top: highlightRects[0].top,
          width: highlightRects[0].width,
          height: highlightRects[0].height,
        }
      : null,
    isGoogleDocs: (element as any).__rewordlyIsGoogleDocs === true,
  });

  // Create a highlight element for each rect (each line)
  highlightRects.forEach((highlightRect, lineIndex) => {
    // Create highlight element
    const highlight = document.createElement("div");
    highlight.className = "rewordly-highlight";
    highlight.setAttribute("data-rewordly-part", "highlight");
    highlight.setAttribute("data-highlight-format", "underline");
    highlight.setAttribute("data-highlight-color-name", "red");
    highlight.setAttribute("data-element-id", getElementId(element));
    highlight.setAttribute("data-error-index", index.toString());
    highlight.setAttribute("data-error-id", error.id); // Store error ID for quick lookup
    highlight.setAttribute("data-line-index", lineIndex.toString()); // Track which line this highlight is for
    highlight.setAttribute("data-error", JSON.stringify(error));

    // Set position and size
    highlight.style.top = `${highlightRect.top}px`;
    highlight.style.left = `${highlightRect.left}px`;
    highlight.style.height = `${highlightRect.height}px`;

    // Store target width for animation
    const targetWidth = highlightRect.width;

    // Add hover listeners to all lines - tooltip will be shared by error ID
    attachHighlightHoverListener(highlight, error, element);

    // Append to highlights content
    if (!highlightsContent) return;
    highlightsContent.appendChild(highlight);

    if (animate) {
      // Initially set width to 0 for animation
      highlight.style.width = "0px";
      highlight.style.overflow = "hidden";
      highlight.style.opacity = "0";

      // Add animation class
      highlight.classList.add("rewordly-highlight-enter");

      // Force reflow to ensure animation starts
      void highlight.offsetWidth;

      // Animate width using requestAnimationFrame for smooth animation
      const startTime = performance.now();
      const duration = 300; // 300ms
      const startWidth = 0;
      const startOpacity = 0;
      const endOpacity = 1;

      const animateFn = (currentTime: number) => {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);

        // Ease-in-out function
        const easeInOut =
          progress < 0.5
            ? 2 * progress * progress
            : 1 - Math.pow(-2 * progress + 2, 2) / 2;

        const currentWidth =
          startWidth + (targetWidth - startWidth) * easeInOut;
        const currentOpacity =
          startOpacity + (endOpacity - startOpacity) * easeInOut;

        highlight.style.width = `${currentWidth}px`;
        highlight.style.opacity = `${currentOpacity}`;

        if (progress < 1) {
          requestAnimationFrame(animateFn);
        } else {
          // Animation complete
          highlight.style.width = `${targetWidth}px`;
          highlight.style.opacity = "1";
          highlight.style.overflow = "visible";
          highlight.classList.remove("rewordly-highlight-enter");
        }
      };

      requestAnimationFrame(animateFn);
    } else {
      // No animation - set final values immediately
      highlight.style.width = `${targetWidth}px`;
      highlight.style.opacity = "1";
      highlight.style.overflow = "visible";
    }
  });
}

/**
 * Display grammar errors on an element using Grammarly-style highlights
 */
export function displayGrammarErrors(
  element: HTMLElement,
  errors: GrammarError[],
  options: {
    grammarErrors: Map<HTMLElement, GrammarError[]>;
    highlightHelper: HighlightContainerHelper;
    dismissedErrors: Map<string, boolean>;
    isErrorDismissed: (element: HTMLElement, error: GrammarError) => boolean;
    createHighlight: (
      element: HTMLElement,
      error: GrammarError,
      index: number,
      animate: boolean
    ) => void;
    attachHighlightHoverListener: (
      highlight: HTMLElement,
      error: GrammarError,
      element: HTMLElement
    ) => void;
    highlightsContent: HTMLElement | null; // Legacy reference
  }
): void {
  const {
    grammarErrors,
    highlightHelper,
    dismissedErrors,
    isErrorDismissed,
    createHighlight,
    attachHighlightHoverListener,
    highlightsContent,
  } = options;

  const isGoogleDocsElement = (element as any).__rewordlyIsGoogleDocs === true;
  console.log("Rewordly: displayGrammarErrors called", {
    errorsCount: errors.length,
    errors: errors,
    element: element.tagName,
    elementId: getElementId(element),
    isGoogleDocs: isGoogleDocsElement,
    hasContainer: !!(element as any).__rewordlyGoogleDocsContainer,
    elementTextPreview: (
      element.textContent ||
      element.innerText ||
      ""
    ).substring(0, 100),
  });

  // Ensure all errors have unique IDs (assign if missing from API response)
  const errorsWithIds = errors.map((error) => {
    if (!error.id) {
      return { ...error, id: generateErrorId() };
    }
    return error;
  });

  // Store errors (empty array if no errors)
  grammarErrors.set(element, errorsWithIds);

  // Ensure highlights container exists
  if (
    !highlightHelper.getContainer() ||
    !highlightHelper.getShadowRoot() ||
    !highlightHelper.getContent()
  ) {
    highlightHelper.create();
    if (
      !highlightHelper.getContainer() ||
      !highlightHelper.getShadowRoot() ||
      !highlightHelper.getContent()
    ) {
      console.error("Rewordly: Failed to create highlights container");
      return;
    }
  }

  // Get existing highlights to compare by error ID and position/word (for matching after replace)
  const elementId = getElementId(element);
  const highlightsContentElement = highlightHelper.getContent();
  if (!highlightsContentElement) return;
  const existingHighlights = highlightsContentElement.querySelectorAll(
    `[data-element-id="${elementId}"]`
  );
  const existingErrorMap = new Map<string, HTMLElement>(); // Key: error ID
  const existingErrorByPositionMap = new Map<string, HTMLElement>(); // Key: "start-end-word" for position-based matching

  existingHighlights.forEach((highlight) => {
    const errorData = (highlight as HTMLElement).getAttribute("data-error");
    if (errorData) {
      try {
        const error: GrammarError = JSON.parse(errorData);
        if (error.id) {
          existingErrorMap.set(error.id, highlight as HTMLElement);
        }
        // Also create position-based key for matching after replace (when IDs might differ)
        if (
          error.start !== undefined &&
          error.end !== undefined &&
          error.word
        ) {
          const positionKey = `${error.start}-${error.end}-${error.word
            .toLowerCase()
            .trim()}`;
          // Only set if not already set (prefer first highlight found for this position)
          if (!existingErrorByPositionMap.has(positionKey)) {
            existingErrorByPositionMap.set(
              positionKey,
              highlight as HTMLElement
            );
          }
        }
      } catch (e) {
        // Error parsing, skip
      }
    }
  });

  // If no errors, remove all highlights for this element
  if (errorsWithIds.length === 0) {
    existingErrorMap.forEach((highlight) => {
      highlight.remove();
    });
    return;
  }

  // Validate error positions against current text (excluding signature)
  // Use the same text extraction method as grammar check to ensure positions match
  const { text } = extractTextExcludingSignature(element);

  // Filter out errors that are no longer valid (text changed, error position out of bounds)
  const validErrors = errorsWithIds.filter((error) => {
    if (
      error.start < 0 ||
      error.end > text.length ||
      error.start >= error.end
    ) {
      console.warn("Rewordly: Error position out of bounds", {
        error,
        textLength: text.length,
        start: error.start,
        end: error.end,
      });
      return false;
    }
    // Check if the error word still matches at that position
    const errorWord = text.substring(error.start, error.end);
    // Strict matching: word must match exactly (case-insensitive, whitespace variations allowed)
    // If the word at that position has changed (e.g., "asd" -> "asdf"), highlight should be removed
    const isValid =
      errorWord.toLowerCase().trim() === error.word.toLowerCase().trim();

    if (!isValid) {
      console.warn("Rewordly: Error word mismatch", {
        error,
        errorWord,
        expectedWord: error.word,
        text: text.substring(
          Math.max(0, error.start - 5),
          Math.min(text.length, error.end + 5)
        ),
      });
      // Word changed, remove from dismissed list if it was dismissed
      const dismissKey = getDismissKey(elementId, error, text);
      dismissedErrors.delete(dismissKey);
      return false;
    }

    // Check if this error was dismissed
    if (isErrorDismissed(element, error)) {
      // Error is dismissed, filter it out
      return false;
    }

    return isValid;
  });

  console.log("Rewordly: displayGrammarErrors", {
    totalErrors: errorsWithIds.length,
    validErrors: validErrors.length,
    textLength: text.length,
    text: text.substring(0, 50) + "...",
  });

  // Update stored errors with only valid ones
  grammarErrors.set(element, validErrors);

  // Update or create highlights for each valid error
  validErrors.forEach((error, index) => {
    // First try to match by error ID
    let existingHighlight = existingErrorMap.get(error.id);

    // If not found by ID, try to match by position and word (for cases where API returns new IDs after replace)
    if (
      !existingHighlight &&
      error.start !== undefined &&
      error.end !== undefined &&
      error.word
    ) {
      const positionKey = `${error.start}-${error.end}-${error.word
        .toLowerCase()
        .trim()}`;
      existingHighlight = existingErrorByPositionMap.get(positionKey);

      // If found by position, update the error ID in the highlight to match the new error
      if (existingHighlight) {
        // Update error ID in all highlights for this position
        const highlightsContentForUpdate = highlightHelper.getContent();
        if (highlightsContentForUpdate) {
          const allHighlightsForPosition = Array.from(
            highlightsContentForUpdate.querySelectorAll(
              `[data-element-id="${elementId}"][data-error-id="${existingHighlight.getAttribute(
                "data-error-id"
              )}"]`
            )
          ) as HTMLElement[];
          allHighlightsForPosition.forEach((h) => {
            h.setAttribute("data-error-id", error.id);
            h.setAttribute("data-error", JSON.stringify(error));
          });
        }
        // Update the map to reflect the new ID
        existingErrorMap.set(error.id, existingHighlight);
      }
    }

    if (existingHighlight) {
      // Check if this error is dismissed - if so, remove the highlight
      if (isErrorDismissed(element, error)) {
        // Remove all highlights for this dismissed error
        const highlightsContentForDismiss = highlightHelper.getContent();
        if (!highlightsContentForDismiss) return;
        const errorHighlights = Array.from(
          highlightsContentForDismiss.querySelectorAll(
            `[data-element-id="${getElementId(element)}"][data-error-id="${
              error.id
            }"]`
          )
        ) as HTMLElement[];
        errorHighlights.forEach((h) => h.remove());
        return;
      }

      // Same error position, just update position (text might have changed)
      // Get text to adjust positions for multi-word errors
      let textForAdjustment = "";
      if (
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement
      ) {
        textForAdjustment = element.value;
      } else if (
        element.getAttribute("contenteditable") === "true" ||
        element.isContentEditable
      ) {
        textForAdjustment = element.innerText || element.textContent || "";
      }

      // Adjust positions for multi-word grammar errors
      const adjustedPositions = textForAdjustment
        ? adjustErrorPositionsForMultiWord(textForAdjustment, error)
        : { start: error.start, end: error.end };
      const highlightRects = getErrorTextRects(
        element,
        adjustedPositions.start,
        adjustedPositions.end
      );

      // Get all existing highlights for this error
      const highlightsContentForUpdate = highlightHelper.getContent();
      if (!highlightsContentForUpdate) return;
      const errorHighlights = Array.from(
        highlightsContentForUpdate.querySelectorAll(
          `[data-element-id="${getElementId(element)}"][data-error-id="${
            error.id
          }"]`
        )
      ) as HTMLElement[];

      if (highlightRects.length > 0) {
        // Update or create highlights for each line
        highlightRects.forEach((highlightRect, lineIndex) => {
          let highlight = errorHighlights.find(
            (h) => h.getAttribute("data-line-index") === lineIndex.toString()
          );

          if (!highlight) {
            // Create new highlight for this line (no animation - this is an existing error, just new line)
            highlight = document.createElement("div");
            highlight.className = "rewordly-highlight";
            highlight.setAttribute("data-rewordly-part", "highlight");
            highlight.setAttribute("data-highlight-format", "underline");
            highlight.setAttribute("data-highlight-color-name", "red");
            highlight.setAttribute("data-element-id", getElementId(element));
            highlight.setAttribute("data-error-index", index.toString());
            highlight.setAttribute("data-error-id", error.id);
            highlight.setAttribute("data-line-index", lineIndex.toString());

            // Add hover listeners to all lines
            attachHighlightHoverListener(highlight, error, element);

            // Set position and size immediately (no animation for existing error's new line)
            highlight.style.top = `${highlightRect.top}px`;
            highlight.style.left = `${highlightRect.left}px`;
            highlight.style.width = `${highlightRect.width}px`;
            highlight.style.height = `${highlightRect.height}px`;
            highlight.style.opacity = "1";
            highlight.style.overflow = "visible";

            const highlightsContentForAppend = highlightHelper.getContent();
            if (highlightsContentForAppend) {
              highlightsContentForAppend.appendChild(highlight);
            }
          }

          // Update position and size
          highlight.style.top = `${highlightRect.top}px`;
          highlight.style.left = `${highlightRect.left}px`;
          highlight.style.width = `${highlightRect.width}px`;
          highlight.style.height = `${highlightRect.height}px`;
          highlight.setAttribute("data-error", JSON.stringify(error));
          highlight.setAttribute("data-error-index", index.toString());
        });

        // Remove extra highlights if rect count decreased
        errorHighlights.forEach((highlight) => {
          const lineIndex = parseInt(
            highlight.getAttribute("data-line-index") || "0",
            10
          );
          if (lineIndex >= highlightRects.length) {
            highlight.remove();
          }
        });
      } else {
        // Position calculation failed - for Draft.js (Twitter), keep the highlight
        // It will be updated on the next position update after DOM settles
        console.warn(
          "Rewordly: Could not calculate position for existing error:",
          error.id
        );
        // Update error data anyway
        existingHighlight.setAttribute("data-error", JSON.stringify(error));
        existingHighlight.setAttribute("data-error-index", index.toString());
      }

      // If element has text, ensure highlight is visible (even if not focused)
      let hasText = false;
      if (
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement
      ) {
        hasText = element.value.trim().length > 0;
      } else if (
        element.getAttribute("contenteditable") === "true" ||
        element.isContentEditable
      ) {
        hasText =
          (element.innerText || element.textContent || "").trim().length > 0;
      }

      if (hasText) {
        // Make sure highlight is visible
        existingHighlight.style.display = "";
        existingHighlight.removeAttribute("data-hidden-by-blur");
      }
    } else {
      // New error or error position changed, create new highlight with animation
      createHighlight(element, error, index, true);
    }
  });

  // Remove highlights that no longer exist (errors that were fixed or removed)
  const currentErrorIds = new Set(validErrors.map((err) => err.id));
  existingErrorMap.forEach((highlight, errorId) => {
    if (!currentErrorIds.has(errorId)) {
      // Remove all highlights for this error (multi-line support)
      if (highlightsContent) {
        const allErrorHighlights = highlightsContent.querySelectorAll(
          `[data-element-id="${elementId}"][data-error-id="${errorId}"]`
        );
        allErrorHighlights.forEach((h) => h.remove());
      } else {
        highlight.remove();
      }
    } else {
      // Also check if this error is dismissed (double-check to be safe)
      const errorData = highlight.getAttribute("data-error");
      if (errorData) {
        try {
          const error: GrammarError = JSON.parse(errorData);
          if (isErrorDismissed(element, error)) {
            // Remove all highlights for this dismissed error (multi-line support)
            if (highlightsContent) {
              const allErrorHighlights = highlightsContent.querySelectorAll(
                `[data-element-id="${elementId}"][data-error-id="${errorId}"]`
              );
              allErrorHighlights.forEach((h) => h.remove());
            } else {
              highlight.remove();
            }
          }
        } catch (e) {
          // Error parsing, skip
        }
      }
    }
  });

  // If element has text, ensure all highlights are visible (even if not focused)
  // For Google Docs, always show highlights
  const isGoogleDocs = (element as any).__rewordlyIsGoogleDocs === true;
  let hasText = false;
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement
  ) {
    hasText = element.value.trim().length > 0;
  } else if (
    element.getAttribute("contenteditable") === "true" ||
    element.isContentEditable
  ) {
    hasText =
      (element.innerText || element.textContent || "").trim().length > 0;
  }

  if ((isGoogleDocs || hasText) && highlightsContent) {
    const elementIdForVisibility = getElementId(element);
    const allHighlights = highlightsContent.querySelectorAll(
      `[data-element-id="${elementIdForVisibility}"]`
    );
    allHighlights.forEach((highlight) => {
      (highlight as HTMLElement).style.display = "";
      (highlight as HTMLElement).style.opacity = "1";
      (highlight as HTMLElement).removeAttribute("data-hidden-by-blur");
      (highlight as HTMLElement).removeAttribute("data-hidden-by-modal");
      (highlight as HTMLElement).removeAttribute("data-hidden-by-scroll");
    });
  }

  // Update highlights on scroll/resize
  highlightHelper.updatePositions(element, errors, (error: GrammarError) =>
    getErrorTextRects(element, error.start, error.end)
  );
}

/**
 * Attach hover listener to highlight
 */
export function attachHighlightHoverListener(
  highlight: HTMLElement,
  error: GrammarError,
  element: HTMLElement,
  options: {
    grammarErrors: Map<HTMLElement, GrammarError[]>;
    dismissedErrors: Map<string, boolean>;
    highlightsContent: HTMLElement | null;
    replaceGrammarError: (
      element: HTMLElement,
      targetError: GrammarError,
      replacement: string
    ) => void;
    closeAllGrammarTooltips: () => void;
    scheduledBlurHandlers: Map<HTMLElement, number>;
    isPerformingDismiss: { value: boolean };
    getElementId: (element: HTMLElement) => string;
  }
): void {
  const {
    grammarErrors,
    dismissedErrors,
    highlightsContent,
    replaceGrammarError,
    closeAllGrammarTooltips,
    scheduledBlurHandlers,
    isPerformingDismiss,
    getElementId,
  } = options;

  let tooltipTimeout: number | null = null;

  const closeTooltip = () => {
    if (tooltipTimeout !== null) {
      clearTimeout(tooltipTimeout);
      tooltipTimeout = null;
    }
  };

  highlight.addEventListener("mouseenter", () => {
    // Close any existing tooltip for this error ID
    closeTooltip();

    // Close all other tooltips when opening a new one
    closeAllGrammarTooltips();

    // Get current errors
    const currentErrors = grammarErrors.get(element) || [];

    console.log("Current errors", currentErrors);

    // Find the current error by ID (guaranteed to find the exact error)
    let currentError = currentErrors.find((err) => err.id === error.id);

    // If error not found (shouldn't happen), use the stored error as fallback
    if (!currentError) {
      currentError = error;
    }

    // Create tooltip
    const tooltip = document.createElement("div");
    tooltip.className = "rewordly-grammar-tooltip";

    // Limit initial suggestions display (show first 5, rest with "see more")
    const INITIAL_SUGGESTIONS_LIMIT = 5;
    const allSuggestions = currentError.suggestions || [];
    const hasMoreSuggestions =
      allSuggestions.length > INITIAL_SUGGESTIONS_LIMIT;
    const initialSuggestions = hasMoreSuggestions
      ? allSuggestions.slice(0, INITIAL_SUGGESTIONS_LIMIT)
      : allSuggestions;
    const remainingSuggestions = hasMoreSuggestions
      ? allSuggestions.slice(INITIAL_SUGGESTIONS_LIMIT)
      : [];

    const initialSuggestionsHtml =
      initialSuggestions.length > 0
        ? initialSuggestions
            .map((suggestion, index) => {
              // Format suggestion for display - make whitespace visible
              const displayText = formatSuggestionForDisplay(
                suggestion,
                currentError.word
              );
              return `<button class="rewordly-grammar-suggestion" data-suggestion="${escapeHtml(
                suggestion
              )}" data-error-start="${currentError.start}" data-error-end="${
                currentError.end
              }" data-suggestion-index="${index}">${escapeHtml(
                displayText
              )}</button>`;
            })
            .join("")
        : '<div class="rewordly-grammar-no-suggestions">No suggestions available</div>';

    const remainingSuggestionsHtml =
      remainingSuggestions.length > 0
        ? remainingSuggestions
            .map((suggestion, index) => {
              const displayText = formatSuggestionForDisplay(
                suggestion,
                currentError.word
              );
              return `<button class="rewordly-grammar-suggestion rewordly-grammar-suggestion-hidden" data-suggestion="${escapeHtml(
                suggestion
              )}" data-error-start="${currentError.start}" data-error-end="${
                currentError.end
              }" data-suggestion-index="${
                initialSuggestions.length + index
              }">${escapeHtml(displayText)}</button>`;
            })
            .join("")
        : "";

    const seeMoreButtonHtml = hasMoreSuggestions
      ? `<button class="rewordly-grammar-see-more" data-error-id="${currentError.id}">See more (${remainingSuggestions.length})</button>`
      : "";

    tooltip.innerHTML = `
      <div class="rewordly-grammar-tooltip-content">
        <div class="rewordly-grammar-tooltip-word">${escapeHtml(
          currentError.word
        )}</div>
        <div class="rewordly-grammar-tooltip-suggestions">
          ${initialSuggestionsHtml}
          ${remainingSuggestionsHtml}
        </div>
        ${seeMoreButtonHtml}
        <button class="rewordly-grammar-dismiss" data-error-id="${
          currentError.id
        }">Dismiss</button>
      </div>
    `;

    document.body.appendChild(tooltip);

    // Calculate available screen space for max-height
    const highlightRect = highlight.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;

    // Calculate space above and below the highlight
    const spaceAbove = highlightRect.top;
    const spaceBelow = viewportHeight - highlightRect.bottom;

    // Use the larger space, but leave some margin (at least 16px from edges)
    const maxAvailableHeight = Math.max(spaceAbove, spaceBelow) - 32; // 16px margin top + 16px margin bottom

    // Set a reasonable minimum and maximum
    const MIN_TOOLTIP_HEIGHT = 100;
    const MAX_TOOLTIP_HEIGHT = 400;
    const calculatedMaxHeight = Math.max(
      MIN_TOOLTIP_HEIGHT,
      Math.min(MAX_TOOLTIP_HEIGHT, maxAvailableHeight)
    );

    // Apply max-height to suggestions container
    const suggestionsContainer = tooltip.querySelector(
      ".rewordly-grammar-tooltip-suggestions"
    ) as HTMLElement;
    if (suggestionsContainer) {
      suggestionsContainer.style.maxHeight = `${calculatedMaxHeight}px`;
      suggestionsContainer.style.overflowY = "auto";
      suggestionsContainer.style.overflowX = "hidden";
    }

    // Position tooltip
    const tooltipRect = tooltip.getBoundingClientRect();
    const tooltipTop = highlightRect.top - tooltipRect.height - 8;
    const tooltipLeft =
      highlightRect.left + highlightRect.width / 2 - tooltipRect.width / 2;

    // Ensure tooltip doesn't go outside screen bounds horizontally
    const adjustedLeft = Math.max(
      8,
      Math.min(tooltipLeft, viewportWidth - tooltipRect.width - 8)
    );

    // Ensure tooltip doesn't go outside screen bounds vertically
    let adjustedTop = tooltipTop;
    if (tooltipTop < 8) {
      // Not enough space above, try below
      adjustedTop = highlightRect.bottom + 8;
      // If still doesn't fit below, adjust to fit within viewport
      if (adjustedTop + tooltipRect.height > viewportHeight - 8) {
        adjustedTop = Math.max(8, viewportHeight - tooltipRect.height - 8);
      }
    } else if (adjustedTop + tooltipRect.height > viewportHeight - 8) {
      // Doesn't fit below, adjust to fit within viewport
      adjustedTop = Math.max(8, viewportHeight - tooltipRect.height - 8);
    }

    tooltip.style.top = `${adjustedTop}px`;
    tooltip.style.left = `${adjustedLeft}px`;

    // Attach click handlers
    const suggestionButtons = tooltip.querySelectorAll(
      ".rewordly-grammar-suggestion"
    );
    suggestionButtons.forEach((button) => {
      button.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();

        const suggestion = (button as HTMLElement).getAttribute(
          "data-suggestion"
        );
        if (!suggestion) return;

        // Get error data directly from highlight - this is the most reliable source
        const errorData = highlight.getAttribute("data-error");
        const errorId = highlight.getAttribute("data-error-id");

        if (!errorId || !errorData) {
          console.error("Rewordly: No error data found on highlight", {
            errorId,
            hasErrorData: !!errorData,
          });
          return;
        }

        let targetError: GrammarError;
        try {
          targetError = JSON.parse(errorData);
        } catch (e) {
          console.error(
            "Rewordly: Failed to parse error data from highlight",
            e
          );
          return;
        }

        closeTooltip();
        closeAllGrammarTooltips();

        // Use the error directly from highlight - no need to search in maps
        replaceGrammarError(element, targetError, suggestion);
      });
    });

    // Attach "see more" button handler
    const seeMoreButton = tooltip.querySelector(".rewordly-grammar-see-more");
    if (seeMoreButton) {
      seeMoreButton.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();

        // Show all hidden suggestions
        const hiddenSuggestions = tooltip.querySelectorAll(
          ".rewordly-grammar-suggestion-hidden"
        );
        hiddenSuggestions.forEach((suggestion) => {
          suggestion.classList.remove("rewordly-grammar-suggestion-hidden");
        });

        // Hide the "see more" button
        seeMoreButton.remove();

        // Recalculate tooltip position after showing all suggestions
        const updatedTooltipRect = tooltip.getBoundingClientRect();
        const updatedHighlightRect = highlight.getBoundingClientRect();
        const updatedTooltipTop =
          updatedHighlightRect.top - updatedTooltipRect.height - 8;
        const updatedTooltipLeft =
          updatedHighlightRect.left +
          updatedHighlightRect.width / 2 -
          updatedTooltipRect.width / 2;

        const updatedAdjustedLeft = Math.max(
          8,
          Math.min(
            updatedTooltipLeft,
            window.innerWidth - updatedTooltipRect.width - 8
          )
        );
        let updatedAdjustedTop = updatedTooltipTop;

        if (updatedTooltipTop < 8) {
          updatedAdjustedTop = updatedHighlightRect.bottom + 8;
          if (
            updatedAdjustedTop + updatedTooltipRect.height >
            window.innerHeight - 8
          ) {
            updatedAdjustedTop = Math.max(
              8,
              window.innerHeight - updatedTooltipRect.height - 8
            );
          }
        } else if (
          updatedAdjustedTop + updatedTooltipRect.height >
          window.innerHeight - 8
        ) {
          updatedAdjustedTop = Math.max(
            8,
            window.innerHeight - updatedTooltipRect.height - 8
          );
        }

        tooltip.style.top = `${updatedAdjustedTop}px`;
        tooltip.style.left = `${updatedAdjustedLeft}px`;
      });
    }

    // Attach dismiss button handler
    const dismissButton = tooltip.querySelector(".rewordly-grammar-dismiss");
    if (dismissButton) {
      dismissButton.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();

        // Get error ID from the highlight
        const errorId = highlight.getAttribute("data-error-id");
        if (!errorId) {
          console.error("Rewordly: No error ID found on highlight");
          return;
        }

        // Find the error in the stored errors
        const errors = grammarErrors.get(element) || [];
        const error = errors.find((err) => err.id === errorId);

        if (error) {
          // Add to dismissed list
          // Dismiss based on word + context (handles position changes)
          const elementId = getElementId(element);

          // Get current text to generate context-based key
          let text = "";
          if (
            element instanceof HTMLInputElement ||
            element instanceof HTMLTextAreaElement
          ) {
            text = element.value;
          } else if (
            element.getAttribute("contenteditable") === "true" ||
            element.isContentEditable
          ) {
            text = element.innerText || element.textContent || "";
          }

          const dismissKey = getDismissKey(elementId, error, text);
          dismissedErrors.set(dismissKey, true);

          // Remove error from grammarErrors map to prevent it from reappearing
          const currentErrors = grammarErrors.get(element) || [];
          const updatedErrors = currentErrors.filter(
            (err) => err.id !== error.id
          );
          grammarErrors.set(element, updatedErrors);

          // Remove all highlights for this error (multi-line support)
          if (highlightsContent) {
            const allErrorHighlights = highlightsContent.querySelectorAll(
              `[data-element-id="${elementId}"][data-error-id="${error.id}"]`
            );
            allErrorHighlights.forEach((h) => h.remove());
          } else {
            highlight.remove();
          }

          // Close tooltip
          closeTooltip();
          closeAllGrammarTooltips();

          // Restore focus after dismiss (similar to replace)
          // Cancel any scheduled blur handlers for this element
          const existingBlurTimeout = scheduledBlurHandlers.get(element);
          if (existingBlurTimeout) {
            clearTimeout(existingBlurTimeout);
            scheduledBlurHandlers.delete(element);
          }

          // Use requestAnimationFrame to ensure DOM is ready before focusing
          requestAnimationFrame(() => {
            // Keep flag true during focus restore to prevent blur handler from hiding highlights
            isPerformingDismiss.value = true;

            element.focus();

            // Set cursor position to the end of the dismissed error
            if (error) {
              const cursorPosition = error.end;

              if (
                element instanceof HTMLInputElement ||
                element instanceof HTMLTextAreaElement
              ) {
                // For input/textarea, use setSelectionRange
                element.setSelectionRange(cursorPosition, cursorPosition);
              } else if (
                element.getAttribute("contenteditable") === "true" ||
                element.isContentEditable
              ) {
                // For contenteditable, use Range API
                const selection = window.getSelection();
                if (selection) {
                  const cursorMapping = mapInnerTextToTextNodes(
                    element,
                    cursorPosition,
                    cursorPosition
                  );
                  if (cursorMapping && cursorMapping.startNode) {
                    const cursorRange = document.createRange();
                    const offset = Math.min(
                      cursorMapping.startOffset,
                      cursorMapping.startNode.textContent!.length
                    );
                    cursorRange.setStart(cursorMapping.startNode, offset);
                    cursorRange.collapse(true);
                    selection.removeAllRanges();
                    selection.addRange(cursorRange);
                  }
                }
              }
            }

            // Clear the dismiss flag after a short delay to ensure focus is stable
            setTimeout(() => {
              isPerformingDismiss.value = false;
            }, 150);
          });
        }
      });
    }

    tooltip.addEventListener("mouseleave", () => {
      console.log("Rewordly: Mouse left tooltip");
      tooltipTimeout = window.setTimeout(() => {
        // Check if any highlight for this error is still hovered
        const allHighlightsForError =
          highlightsContent?.querySelectorAll(
            `[data-error-id="${error.id}"]`
          ) || [];
        const isAnyHighlightHovered = Array.from(allHighlightsForError).some(
          (h) => (h as HTMLElement).matches(":hover")
        );

        if (!isAnyHighlightHovered && !tooltip.matches(":hover")) {
          console.log("Girdi");
          closeTooltip();
        }
      }, 100);
    });
  });
}

/**
 * Show grammar highlights for an element (if errors exist)
 */
export function showGrammarOverlay(
  element: HTMLElement,
  options: {
    grammarErrors: Map<HTMLElement, GrammarError[]>;
    highlightHelper: HighlightContainerHelper;
    displayGrammarErrors: (
      element: HTMLElement,
      errors: GrammarError[],
      options: any
    ) => void;
    isErrorDismissed: (element: HTMLElement, error: GrammarError) => boolean;
    getElementId: (element: HTMLElement) => string;
  }
): void {
  const {
    grammarErrors,
    highlightHelper,
    displayGrammarErrors,
    isErrorDismissed,
    getElementId,
  } = options;

  if (!grammarErrors.has(element)) {
    return;
  }

  const highlightsContent = highlightHelper.getContent();
  if (!highlightsContent) {
    // Recreate if doesn't exist
    const errors = grammarErrors.get(element);
    if (errors) {
      displayGrammarErrors(element, errors, {
        grammarErrors,
        highlightHelper,
        dismissedErrors: new Map(),
        isErrorDismissed,
        createHighlight: () => {},
        attachHighlightHoverListener: () => {},
        highlightsContent: null,
      });
    }
    return;
  }

  const elementId = getElementId(element);
  const highlights = highlightsContent.querySelectorAll(
    `[data-element-id="${elementId}"]`
  );

  if (highlights.length === 0) {
    // Recreate if doesn't exist
    const errors = grammarErrors.get(element);
    if (errors) {
      displayGrammarErrors(element, errors, {
        grammarErrors,
        highlightHelper,
        dismissedErrors: new Map(),
        isErrorDismissed,
        createHighlight: () => {},
        attachHighlightHoverListener: () => {},
        highlightsContent,
      });
    }
  } else {
    // Show existing highlights, but skip dismissed ones
    const errors = grammarErrors.get(element) || [];
    const errorIdToError = new Map<string, GrammarError>();
    errors.forEach((err) => {
      if (err.id) {
        errorIdToError.set(err.id, err);
      }
    });

    const dismissedErrorIds = new Set<string>();

    highlights.forEach((highlight) => {
      const htmlHighlight = highlight as HTMLElement;
      const errorId = htmlHighlight.getAttribute("data-error-id");

      if (errorId) {
        const error = errorIdToError.get(errorId);
        if (error && isErrorDismissed(element, error)) {
          // Mark this error as dismissed - we'll remove all highlights for it
          dismissedErrorIds.add(errorId);
          return;
        }
      }

      // Not dismissed, show it
      htmlHighlight.style.display = "";
      htmlHighlight.removeAttribute("data-hidden-by-blur");
      htmlHighlight.removeAttribute("data-hidden-by-modal");
    });

    // Remove all highlights for dismissed errors (multi-line support)
    if (dismissedErrorIds.size > 0 && highlightsContent) {
      dismissedErrorIds.forEach((errorId) => {
        const allErrorHighlights = highlightsContent.querySelectorAll(
          `[data-element-id="${elementId}"][data-error-id="${errorId}"]`
        );
        allErrorHighlights.forEach((h: Element) => h.remove());
      });
    }
  }
}

/**
 * Clear grammar errors from an element (permanently remove)
 */
export function clearGrammarErrors(
  element: HTMLElement,
  options: {
    grammarErrors: Map<HTMLElement, GrammarError[]>;
    clearElementHighlights: (element: HTMLElement) => void;
  }
): void {
  const { grammarErrors, clearElementHighlights } = options;

  // Remove highlights for this element
  clearElementHighlights(element);

  // Clear stored errors
  grammarErrors.delete(element);
}

/**
 * Clear all grammar errors (cleanup function)
 */
export function clearAllGrammarErrors(options: {
  grammarErrors: Map<HTMLElement, GrammarError[]>;
  clearGrammarErrors: (element: HTMLElement) => void;
}): void {
  const { grammarErrors, clearGrammarErrors } = options;

  // Get all elements with errors
  const elementsWithErrors = Array.from(grammarErrors.keys());

  elementsWithErrors.forEach((element) => {
    // Check if element still exists in DOM
    if (!document.contains(element) && !element.isConnected) {
      clearGrammarErrors(element);
    }
  });
}

/**
 * Hide all grammar highlights across all elements
 */
export function hideAllGrammarHighlights(options: {
  highlightHelper: HighlightContainerHelper;
}): void {
  const { highlightHelper } = options;
  const highlightsContent = highlightHelper.getContent();
  if (!highlightsContent) return;

  // Hide all highlights by setting display to none
  const allHighlights = highlightsContent.querySelectorAll("[data-element-id]");
  allHighlights.forEach((highlight) => {
    (highlight as HTMLElement).style.display = "none";
  });
}
