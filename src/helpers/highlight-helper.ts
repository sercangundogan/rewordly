/**
 * Highlight Helper
 * Grammar error highlight'larını render etme, güncelleme ve temizleme işlemleri
 *
 * Bu dosya highlight'ları göstermek, pozisyonlarını güncellemek ve temizlemekle ilgilenir.
 * Basitçe: Highlight göster, pozisyon güncelle, temizle gibi.
 */

import { GrammarError } from "../types";
import { getElementId } from "./element-helper";
import { mapInnerTextToTextNodes } from "./text-processing-helper";

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

    // Container oluştur
    this.container = document.createElement("rewordly-highlights");
    this.container.id = "rewordly-highlights-container";
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
    this.shadowRoot = this.container.attachShadow({ mode: "open" });

    // Shadow DOM içine content ekle
    this.content = document.createElement("div");
    this.content.className = "rewordly-highlights-content";
    this.shadowRoot.appendChild(this.content);

    // Style ekle
    const style = document.createElement("style");
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
