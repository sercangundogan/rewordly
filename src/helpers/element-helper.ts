/**
 * Element Helper
 * Editable element bulma, kontrol etme ve yönetme işlemleri
 *
 * Bu dosya sayfadaki editable elementleri bulmak ve yönetmekle ilgilenir.
 * Basitçe: Element bul, kontrol et, ignore et gibi işlemler.
 */

/**
 * Element editable mi kontrol et
 */
export function isEditableElement(element: HTMLElement): boolean {
  if (!element) return false;

  // Input elementleri
  if (element instanceof HTMLInputElement) {
    const type = element.type.toLowerCase();
    return (
      type === "text" ||
      type === "email" ||
      type === "search" ||
      type === "" ||
      type === "url"
    );
  }

  // Textarea
  if (element instanceof HTMLTextAreaElement) {
    return true;
  }

  // Contenteditable
  const contentEditable = element.getAttribute("contenteditable");
  if (
    contentEditable === "true" ||
    contentEditable === "" ||
    (contentEditable !== null && contentEditable !== "false")
  ) {
    return true;
  }

  return false;
}

/**
 * Element'ten text çıkar
 */
export function extractTextFromElement(element: HTMLElement): string {
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement
  ) {
    return element.value || "";
  }

  if (isEditableElement(element)) {
    return element.textContent || element.innerText || "";
  }

  return "";
}

/**
 * Element görünür mü kontrol et
 */
export function isElementVisible(element: HTMLElement): boolean {
  if (!element) return false;

  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);

  // Gizli mi?
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.opacity === "0"
  ) {
    return false;
  }

  // Boyut var mı?
  if (rect.width === 0 && rect.height === 0) {
    return false;
  }

  // Viewport içinde mi?
  const isInViewport =
    rect.top < window.innerHeight &&
    rect.bottom > 0 &&
    rect.left < window.innerWidth &&
    rect.right > 0;

  return isInViewport;
}

/**
 * Element ID oluştur (benzersiz)
 */
export function getElementId(element: HTMLElement): string {
  if (!element) return "";

  // Zaten ID varsa kullan
  if ((element as any).__rewordlyId) {
    return (element as any).__rewordlyId;
  }

  // Yeni ID oluştur
  const id = `rewordly-${Date.now()}-${Math.random()
    .toString(36)
    .substr(2, 9)}`;
  (element as any).__rewordlyId = id;
  return id;
}

/**
 * Tüm editable elementleri bul
 */
export function findAllEditableElements(
  root: HTMLElement = document.body
): HTMLElement[] {
  const elements: HTMLElement[] = [];

  // Normal selector ile bul
  const inputs = root.querySelectorAll(`
    input[type="text"], 
    input[type="email"], 
    input[type="search"], 
    input:not([type]), 
    input[type="url"],
    textarea, 
    [contenteditable="true"],
    [contenteditable=""],
    [contenteditable]
  `);

  inputs.forEach((el) => {
    if (isEditableElement(el as HTMLElement)) {
      elements.push(el as HTMLElement);
    }
  });

  // Tüm elementleri kontrol et (dinamik contenteditable için)
  const allElements = root.querySelectorAll("*");
  allElements.forEach((el) => {
    const htmlEl = el as HTMLElement;
    if (
      htmlEl.isContentEditable ||
      htmlEl.getAttribute("contenteditable") === "true" ||
      htmlEl.getAttribute("contenteditable") === ""
    ) {
      if (!elements.includes(htmlEl)) {
        elements.push(htmlEl);
      }
    }
  });

  return elements;
}

/**
 * Element içindeki editable elementleri bul
 */
export function findEditableInElement(element: HTMLElement): HTMLElement[] {
  const elements: HTMLElement[] = [];

  // Normal querySelector
  const editableChildren = element.querySelectorAll(`
    input[type="text"], 
    input[type="email"], 
    input[type="search"], 
    input:not([type]), 
    input[type="url"],
    textarea, 
    [contenteditable="true"],
    [contenteditable=""],
    [contenteditable]
  `);

  editableChildren.forEach((child) => {
    if (isEditableElement(child as HTMLElement)) {
      elements.push(child as HTMLElement);
    }
  });

  // Shadow DOM kontrolü
  if (element.shadowRoot) {
    const shadowEditable = element.shadowRoot.querySelectorAll(`
      input[type="text"], 
      input[type="email"], 
      input[type="search"], 
      input:not([type]), 
      input[type="url"],
      textarea, 
      [contenteditable="true"],
      [contenteditable=""],
      [contenteditable]
    `);

    shadowEditable.forEach((child) => {
      if (isEditableElement(child as HTMLElement)) {
        elements.push(child as HTMLElement);
      }
    });
  }

  return elements;
}

/**
 * Shadow DOM içinde editable elementleri bul
 */
export function findEditableInShadowDOM(root: Node): HTMLElement[] {
  const elements: HTMLElement[] = [];

  if (!root) return elements;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let node: Node | null;

  while ((node = walker.nextNode())) {
    const element = node as HTMLElement;

    // Element kendisi editable mi?
    if (isEditableElement(element)) {
      elements.push(element);
    }

    // Shadow DOM var mı?
    if (element.shadowRoot) {
      elements.push(...findEditableInShadowDOM(element.shadowRoot));
    }
  }

  return elements;
}

/**
 * Element ignore edilmeli mi?
 * Gmail "To" field gibi özel durumlar için
 */
export function shouldIgnoreElement(element: HTMLElement): boolean {
  if (!element) return true;

  // Gmail "To" field kontrolü
  const gmailToContainer = element.closest(".aoD.hl");
  if (gmailToContainer) {
    const hasToName = element.closest('[name="to"]') !== null;
    const hasToClasses =
      element.classList.contains("oL") &&
      element.classList.contains("aDm") &&
      element.classList.contains("az9");
    const hasToSpan =
      element.querySelector(".aQ2") !== null ||
      element.closest(".aQ2") !== null;

    if (hasToName || hasToClasses || hasToSpan) {
      return true;
    }
  }

  // Gmail "To" field içinde mi?
  if (element.closest('[name="to"]') !== null) {
    return true;
  }

  // Gmail "To" field kendisi mi?
  if (
    element.getAttribute("name") === "to" ||
    (element instanceof HTMLInputElement && element.name === "to")
  ) {
    return true;
  }

  // Gmail "To" field span'ı mı?
  if (
    element.classList.contains("aQ2") ||
    element.closest(".aQ2") !== null ||
    element.querySelector(".aQ2") !== null
  ) {
    return true;
  }

  return false;
}

/**
 * Node document içinde mi kontrol et
 */
export function isNodeInDocument(node: Node): boolean {
  if (!node) return false;

  // Document node mu?
  if (node.nodeType === Node.DOCUMENT_NODE) {
    return node === document;
  }

  // Document'e bağlı mı?
  let current: Node | null = node;
  while (current && current !== document) {
    if (current.parentNode === null) {
      return false;
    }
    current = current.parentNode;
  }

  return current === document;
}

/**
 * Find all scrollable parent containers for an element
 * Also checks if the element itself is scrollable (e.g., textarea)
 */
export function findScrollableContainers(
  element: HTMLElement
): Set<HTMLElement> {
  const scrollableContainers = new Set<HTMLElement>();

  // Check if element itself is scrollable (e.g., textarea, contenteditable div)
  const elementStyle = window.getComputedStyle(element);
  const elementOverflowY = elementStyle.overflowY;
  const elementOverflowX = elementStyle.overflowX;
  const elementOverflow = elementStyle.overflow;

  const isElementScrollable =
    (elementOverflowY === "auto" ||
      elementOverflowY === "scroll" ||
      elementOverflow === "auto" ||
      elementOverflow === "scroll") &&
    element.scrollHeight > element.clientHeight;

  const isElementScrollableX =
    (elementOverflowX === "auto" ||
      elementOverflowX === "scroll" ||
      elementOverflow === "auto" ||
      elementOverflow === "scroll") &&
    element.scrollWidth > element.clientWidth;

  if (isElementScrollable || isElementScrollableX) {
    scrollableContainers.add(element);
  }

  // Check parent containers
  let current: HTMLElement | null = element.parentElement;

  while (
    current &&
    current !== document.body &&
    current !== document.documentElement
  ) {
    const style = window.getComputedStyle(current);
    const overflowY = style.overflowY;
    const overflowX = style.overflowX;
    const overflow = style.overflow;

    // Check if element is scrollable
    const isScrollable =
      (overflowY === "auto" ||
        overflowY === "scroll" ||
        overflow === "auto" ||
        overflow === "scroll") &&
      current.scrollHeight > current.clientHeight;

    // Also check for overflow-x scrollable containers
    const isScrollableX =
      (overflowX === "auto" ||
        overflowX === "scroll" ||
        overflow === "auto" ||
        overflow === "scroll") &&
      current.scrollWidth > current.clientWidth;

    if (isScrollable || isScrollableX) {
      scrollableContainers.add(current);
    }

    current = current.parentElement;
  }

  return scrollableContainers;
}

/**
 * Check if element is single-line (approximately)
 * Uses multiple heuristics for reliable detection across different platforms
 */
export function isSingleLineElement(element: HTMLElement): boolean {
  const computedStyle = window.getComputedStyle(element);
  const elementRect = element.getBoundingClientRect();

  // Get line-height (can be 'normal', number, or pixel value)
  let lineHeight: number;
  const lineHeightValue = computedStyle.lineHeight;

  if (lineHeightValue === "normal") {
    // Normal line-height is typically 1.2-1.5x font-size
    const fontSize = parseFloat(computedStyle.fontSize) || 16;
    lineHeight = fontSize * 1.2; // Conservative estimate
  } else if (lineHeightValue.includes("px")) {
    lineHeight = parseFloat(lineHeightValue);
  } else {
    // Relative value (e.g., 1.5)
    const fontSize = parseFloat(computedStyle.fontSize) || 16;
    lineHeight = parseFloat(lineHeightValue) * fontSize;
  }

  // Get actual content height
  const clientHeight = element.clientHeight;
  const scrollHeight = element.scrollHeight;

  // Heuristic 1: If element height is close to line-height (within 1.5x), likely single line
  // Account for padding
  const paddingTop = parseFloat(computedStyle.paddingTop) || 0;
  const paddingBottom = parseFloat(computedStyle.paddingBottom) || 0;
  const contentHeight = clientHeight - paddingTop - paddingBottom;

  // Heuristic 2: If scrollHeight equals clientHeight, no vertical scrolling (likely single line)
  const hasNoVerticalScroll = Math.abs(scrollHeight - clientHeight) < 2;

  // Heuristic 3: If content height is less than 1.8x line-height, likely single line
  // Using 1.8x to account for various font sizes and padding
  const isHeightCloseToLineHeight = contentHeight <= lineHeight * 1.8;

  // Heuristic 4: For very small elements (e.g., input fields), if height < 60px, likely single line
  const isSmallElement = elementRect.height < 60;

  // Combine heuristics: element is single-line if:
  // - Height is close to line-height AND no vertical scroll, OR
  // - Very small element with no vertical scroll
  return (
    (isHeightCloseToLineHeight && hasNoVerticalScroll) ||
    (isSmallElement && hasNoVerticalScroll)
  );
}

/**
 * Get selection rect for input/textarea elements
 */
export function getInputTextareaSelectionRect(
  el: HTMLInputElement | HTMLTextAreaElement
): DOMRect | null {
  const end = el.selectionEnd;
  if (end === null) return null;

  const value = el.value.substring(0, end);
  const elRect = el.getBoundingClientRect();
  const style = window.getComputedStyle(el);

  // Mirror element
  const div = document.createElement("div");
  const divStyle = div.style;

  // Typography + spacing
  divStyle.position = "absolute";
  divStyle.visibility = "hidden";
  divStyle.whiteSpace = el instanceof HTMLInputElement ? "pre" : "pre-wrap";
  divStyle.fontFamily = style.fontFamily;
  divStyle.fontSize = style.fontSize;
  divStyle.fontWeight = style.fontWeight;
  divStyle.fontStyle = style.fontStyle;
  divStyle.letterSpacing = style.letterSpacing;
  divStyle.lineHeight = style.lineHeight;
  divStyle.textTransform = style.textTransform;

  // Box model
  divStyle.padding = style.padding;
  divStyle.border = style.border;
  divStyle.boxSizing = style.boxSizing;
  divStyle.width = style.width; // Important for textarea wrapping

  // Copy content
  div.textContent = value;

  // Marker to measure caret
  const span = document.createElement("span");
  span.textContent = "▌";
  div.appendChild(span);

  document.body.appendChild(div);

  // Get positions - use offsetLeft/offsetTop for more accurate measurement
  const spanRect = span.getBoundingClientRect();

  // Caret position relative to the div (which mirrors the element)
  // offsetLeft/offsetTop give position relative to offsetParent
  const relX = span.offsetLeft;
  const relY = span.offsetTop;

  // Account for input/textarea scroll
  const scrollLeft = el.scrollLeft || 0;
  const scrollTop = el.scrollTop || 0;

  // Get padding and border to adjust position correctly
  const paddingLeft = parseFloat(style.paddingLeft) || 0;
  const borderLeft = parseFloat(style.borderLeftWidth) || 0;
  const paddingTop = parseFloat(style.paddingTop) || 0;
  const borderTop = parseFloat(style.borderTopWidth) || 0;

  // Calculate final caret position
  // Element position + padding + border + relative caret position - scroll
  const caretX = elRect.left + paddingLeft + borderLeft + relX - scrollLeft;
  const caretY = elRect.top + paddingTop + borderTop + relY - scrollTop;
  const caretHeight =
    spanRect.height || parseFloat(style.lineHeight) || elRect.height;

  document.body.removeChild(div);

  return new DOMRect(
    caretX,
    caretY,
    0, // width doesn't matter, we offset button ourselves
    caretHeight
  );
}

/**
 * Set up scroll listeners for a specific editable element
 * Updates highlight positions when scrollable containers are scrolled
 */
export function setupElementScrollListeners(
  element: HTMLElement,
  options: {
    scrollableContainers: Map<HTMLElement, Set<HTMLElement>>;
    scrollListeners: Map<HTMLElement, () => void>;
    grammarErrors: Map<HTMLElement, any[]>;
    highlightHelper: {
      updatePositions: (
        element: HTMLElement,
        errors: any[],
        getRects: (error: any) => DOMRect[]
      ) => void;
    };
    getErrorTextRects: (
      element: HTMLElement,
      start: number,
      end: number
    ) => DOMRect[];
    removeElementScrollListeners: (
      element: HTMLElement,
      options: {
        scrollableContainers: Map<HTMLElement, Set<HTMLElement>>;
        scrollListeners: Map<HTMLElement, () => void>;
      }
    ) => void;
  }
): void {
  const {
    scrollableContainers,
    scrollListeners,
    grammarErrors,
    highlightHelper,
    getErrorTextRects,
    removeElementScrollListeners,
  } = options;

  // Remove existing listeners for this element
  removeElementScrollListeners(element, {
    scrollableContainers,
    scrollListeners,
  });

  // Find scrollable containers
  const containers = findScrollableContainers(element);
  scrollableContainers.set(element, containers);

  // Add scroll listeners to each scrollable container
  containers.forEach((container) => {
    // Check if we already have a listener for this container
    if (!scrollListeners.has(container)) {
      const updateAllForContainer = () => {
        // Update highlights for all elements that have this container as a scrollable parent
        scrollableContainers.forEach((containers, el) => {
          if (containers.has(container) && grammarErrors.has(el)) {
            highlightHelper.updatePositions(
              el,
              grammarErrors.get(el) || [],
              (error: any) => getErrorTextRects(el, error.start, error.end)
            );
          }
        });
      };

      container.addEventListener("scroll", updateAllForContainer, {
        passive: true,
      });
      scrollListeners.set(container, updateAllForContainer);
    }
  });
}

/**
 * Remove scroll listeners for a specific editable element
 */
export function removeElementScrollListeners(
  element: HTMLElement,
  options: {
    scrollableContainers: Map<HTMLElement, Set<HTMLElement>>;
    scrollListeners: Map<HTMLElement, () => void>;
  }
): void {
  const { scrollableContainers, scrollListeners } = options;
  const containers = scrollableContainers.get(element);
  if (!containers) return;

  // Check if any other elements use these containers
  containers.forEach((container) => {
    let isUsedByOthers = false;
    scrollableContainers.forEach((otherContainers, otherElement) => {
      if (otherElement !== element && otherContainers.has(container)) {
        isUsedByOthers = true;
      }
    });

    // If no other elements use this container, remove the listener
    if (!isUsedByOthers) {
      const listener = scrollListeners.get(container);
      if (listener) {
        container.removeEventListener("scroll", listener);
        scrollListeners.delete(container);
      }
    }
  });

  scrollableContainers.delete(element);
}
