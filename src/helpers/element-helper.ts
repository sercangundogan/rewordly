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
    return type === 'text' || type === 'email' || type === 'search' || type === '' || type === 'url';
  }

  // Textarea
  if (element instanceof HTMLTextAreaElement) {
    return true;
  }

  // Contenteditable
  const contentEditable = element.getAttribute('contenteditable');
  if (contentEditable === 'true' || contentEditable === '' || 
      (contentEditable !== null && contentEditable !== 'false')) {
    return true;
  }

  return false;
}

/**
 * Element'ten text çıkar
 */
export function extractTextFromElement(element: HTMLElement): string {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return element.value || '';
  }

  if (isEditableElement(element)) {
    return element.textContent || element.innerText || '';
  }

  return '';
}

/**
 * Element görünür mü kontrol et
 */
export function isElementVisible(element: HTMLElement): boolean {
  if (!element) return false;

  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);

  // Gizli mi?
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
    return false;
  }

  // Boyut var mı?
  if (rect.width === 0 && rect.height === 0) {
    return false;
  }

  // Viewport içinde mi?
  const isInViewport = rect.top < window.innerHeight && rect.bottom > 0 && 
                       rect.left < window.innerWidth && rect.right > 0;

  return isInViewport;
}

/**
 * Element ID oluştur (benzersiz)
 */
export function getElementId(element: HTMLElement): string {
  if (!element) return '';

  // Zaten ID varsa kullan
  if ((element as any).__rewordlyId) {
    return (element as any).__rewordlyId;
  }

  // Yeni ID oluştur
  const id = `rewordly-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  (element as any).__rewordlyId = id;
  return id;
}

/**
 * Tüm editable elementleri bul
 */
export function findAllEditableElements(root: HTMLElement = document.body): HTMLElement[] {
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
  const allElements = root.querySelectorAll('*');
  allElements.forEach((el) => {
    const htmlEl = el as HTMLElement;
    if (htmlEl.isContentEditable || 
        htmlEl.getAttribute('contenteditable') === 'true' || 
        htmlEl.getAttribute('contenteditable') === '') {
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
  const gmailToContainer = element.closest('.aoD.hl');
  if (gmailToContainer) {
    const hasToName = element.closest('[name="to"]') !== null;
    const hasToClasses = element.classList.contains('oL') && 
                        element.classList.contains('aDm') && 
                        element.classList.contains('az9');
    const hasToSpan = element.querySelector('.aQ2') !== null || 
                     element.closest('.aQ2') !== null;

    if (hasToName || hasToClasses || hasToSpan) {
      return true;
    }
  }

  // Gmail "To" field içinde mi?
  if (element.closest('[name="to"]') !== null) {
    return true;
  }

  // Gmail "To" field kendisi mi?
  if (element.getAttribute('name') === 'to' || 
      (element instanceof HTMLInputElement && element.name === 'to')) {
    return true;
  }

  // Gmail "To" field span'ı mı?
  if (element.classList.contains('aQ2') || 
      element.closest('.aQ2') !== null ||
      element.querySelector('.aQ2') !== null) {
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

