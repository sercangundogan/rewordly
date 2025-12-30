/**
 * Google Docs Integration - Robust Pipeline
 * 
 * Architecture:
 * - DocsChangeDetector: Reliable event handling and state management
 * - DocsTextExtractor: Text extraction with proper scope management
 * - IssueAnchor: Fingerprint-based anchoring system
 * - HighlightEngine: Stable overlay rendering with correct coordinate space
 * - DocsAdapter: Orchestrates all components
 * - DebugMode: Comprehensive debugging and diagnostics
 */

interface GrammarError {
  id: string;
  start: number;
  end: number;
  word: string;
  suggestions: string[];
  type: 'grammar' | 'spelling';
}

interface ExtractedText {
  text: string;
  source: string;
  scope: 'viewport' | 'paragraph' | 'full';
  metadata?: {
    paragraphBoundaries?: number[];
    contextWindows?: Array<{ start: number; end: number }>;
  };
}

interface EventLog {
  type: string;
  timestamp: number;
  isComposing: boolean;
  data?: any;
}

interface DebugInfo {
  events: EventLog[];
  lastGrammarCheck: {
    timestamp: number;
    reason: string;
    textLength: number;
  } | null;
  extractedText: {
    preview: string;
    length: number;
    scope: string;
    source: string;
  } | null;
  scroller: {
    selector: string;
    scrollTop: number;
    scrollLeft: number;
  } | null;
  scale: {
    browserZoom: number;
    docsZoom: number;
    devicePixelRatio: number;
  } | null;
  issues: {
    count: number;
    rectsCount: number;
  } | null;
}

/**
 * DocsChangeDetector: Reliable change detection with proper state management
 */
class DocsChangeDetector {
  private isComposing = false;
  private lastInputAt = 0;
  private lastTextHash = '';
  private lastCaretContext = '';
  private textCheckTimeout: number | null = null;
  private compositionTimeout: number | null = null;
  private eventLogs: EventLog[] = [];
  private maxEventLogs = 50;
  private onCheckTriggered: (reason: string) => void;
  private debugMode = false;

  constructor(onCheckTriggered: (reason: string) => void) {
    this.onCheckTriggered = onCheckTriggered;
  }

  attach(container: HTMLElement): void {
    console.log('Rewordly: DocsChangeDetector.attach called', { container: container.className });
    // beforeinput - fires before input is inserted
    document.addEventListener('beforeinput', (e: Event) => {
      const inputEvent = e as InputEvent;
      this.logEvent('beforeinput', { inputType: inputEvent.inputType, data: inputEvent.data });
      this.handleInput();
    }, true);

    // input - fires after input is inserted
    document.addEventListener('input', (e: Event) => {
      const inputEvent = e as InputEvent;
      this.logEvent('input', { inputType: inputEvent.inputType, data: inputEvent.data });
      this.handleInput();
    }, true);

    // keydown - for navigation keys and special keys
    document.addEventListener('keydown', (e) => {
      // Only trigger on text input keys (not navigation/function keys)
      if (e.key.length === 1 || ['Backspace', 'Delete', 'Enter'].includes(e.key)) {
        this.logEvent('keydown', { key: e.key });
        this.handleInput();
      }
    }, true);

    // paste/cut
    document.addEventListener('paste', () => {
      this.logEvent('paste', {});
      this.handleInput('paste');
    }, true);

    document.addEventListener('cut', () => {
      this.logEvent('cut', {});
      this.handleInput('cut');
    }, true);

    // IME composition events
    document.addEventListener('compositionstart', () => {
      this.logEvent('compositionstart', {});
      this.isComposing = true;
      if (this.compositionTimeout !== null) {
        clearTimeout(this.compositionTimeout);
        this.compositionTimeout = null;
      }
    }, true);

    document.addEventListener('compositionupdate', () => {
      this.logEvent('compositionupdate', {});
      // Keep composition flag active - DO NOT trigger grammar check
      this.isComposing = true;
    }, true);

    document.addEventListener('compositionend', () => {
      this.logEvent('compositionend', {});
      this.isComposing = false;
      // Trigger grammar check after composition ends with debounce
      if (this.compositionTimeout !== null) {
        clearTimeout(this.compositionTimeout);
      }
      this.compositionTimeout = window.setTimeout(() => {
        this.handleInput('compositionend');
      }, 300);
    }, true);

    // selectionchange - for undo/redo detection (when selection changes without input)
    document.addEventListener('selectionchange', () => {
      // Only trigger if we haven't had input recently (might be undo/redo)
      const timeSinceLastInput = Date.now() - this.lastInputAt;
      if (timeSinceLastInput > 100 && timeSinceLastInput < 1000) {
        this.logEvent('selectionchange', { timeSinceLastInput });
        this.handleInput('selectionchange');
      }
    }, true);
  }

  private handleInput(reason: string = 'input'): void {
    // Never run grammar check during composition
    if (this.isComposing && reason !== 'compositionend') {
      return;
    }

    this.lastInputAt = Date.now();

    // Clear previous timeout
    if (this.textCheckTimeout !== null) {
      clearTimeout(this.textCheckTimeout);
    }

    // Different debounce times based on reason
    let debounceTime = 500; // Default
    if (reason === 'paste' || reason === 'cut') {
      debounceTime = 300; // Shorter for paste/cut
    } else if (reason === 'compositionend') {
      debounceTime = 300; // Shorter after composition
    } else if (reason === 'selectionchange') {
      debounceTime = 200; // Shortest for undo/redo
    }

    // Debounce text checking
    this.textCheckTimeout = window.setTimeout(() => {
      this.onCheckTriggered(reason);
    }, debounceTime);
  }

  private logEvent(type: string, data?: any): void {
    if (!this.debugMode) return;
    
    this.eventLogs.push({
      type,
      timestamp: Date.now(),
      isComposing: this.isComposing,
      data
    });

    // Keep only last N events
    if (this.eventLogs.length > this.maxEventLogs) {
      this.eventLogs.shift();
    }
  }

  getState() {
    return {
      isComposing: this.isComposing,
      lastInputAt: this.lastInputAt,
      lastTextHash: this.lastTextHash,
      lastCaretContext: this.lastCaretContext
    };
  }

  updateTextHash(hash: string): void {
    this.lastTextHash = hash;
  }

  setDebugMode(enabled: boolean): void {
    this.debugMode = enabled;
  }

  getEventLogs(): EventLog[] {
    return [...this.eventLogs];
  }

  cleanup(): void {
    if (this.textCheckTimeout !== null) {
      clearTimeout(this.textCheckTimeout);
      this.textCheckTimeout = null;
    }
    if (this.compositionTimeout !== null) {
      clearTimeout(this.compositionTimeout);
      this.compositionTimeout = null;
    }
  }
}

/**
 * DocsTextExtractor: Reliable text extraction with proper scope management
 */
class DocsTextExtractor {
  private container: HTMLElement;
//   private debugMode = false;

  constructor(container: HTMLElement) {
    this.container = container;
    // Container is stored for use in extraction methods
  }

  extract(scope: 'viewport' | 'paragraph' | 'full' = 'viewport'): ExtractedText {
    try {
      // Method 1: Try accessibility/ARIA layer (most reliable for canvas-based rendering)
      const accessibilityResult = this.extractFromAccessibilityLayer(scope);
      if (accessibilityResult && accessibilityResult.text.trim().length > 0) {
        return accessibilityResult;
      }

      // Method 2: Try DOCS_modelChunk (works for all scopes, but gives full document)
      const modelChunkResult = this.extractFromModelChunk();
      if (modelChunkResult && modelChunkResult.text.trim().length > 0) {
        console.log('Rewordly: Using DOCS_modelChunk result', { length: modelChunkResult.text.length });
        return modelChunkResult;
      }

      // Method 3: Try visible paragraphs/viewport
      const viewportResult = this.extractFromViewport();
      if (viewportResult && viewportResult.text.trim().length > 0) {
        return viewportResult;
      }

      // Method 4: Fallback to page-based extraction
      const pageResult = this.extractFromPages();
      if (pageResult && pageResult.text.trim().length > 0) {
        return pageResult;
      }

      // Method 5: Try selection-based extraction (if user has selected text)
      const selectionResult = this.extractFromSelection();
      if (selectionResult && selectionResult.text.trim().length > 0) {
        return selectionResult;
      }

      // Method 6: Try to get text from all text nodes in the editor area
      const textNodesResult = this.extractFromAllTextNodes();
      if (textNodesResult && textNodesResult.text.trim().length > 0) {
        return textNodesResult;
      }

      // Method 7: Try to get text by selecting all content (if possible)
      const selectAllResult = this.extractBySelectAll();
      if (selectAllResult && selectAllResult.text.trim().length > 0) {
        return selectAllResult;
      }

      // Method 8: Try to find text anywhere in the document body (last resort)
      const bodyTextResult = this.extractFromDocumentBody();
      if (bodyTextResult && bodyTextResult.text.trim().length > 0) {
        return bodyTextResult;
      }

      console.warn('Rewordly: All extraction methods failed');
      return { text: '', source: 'none', scope };
    } catch (error) {
      console.error('Rewordly: Error extracting text:', error);
      return { text: '', source: 'error', scope };
    }
  }

  private extractFromAccessibilityLayer(scope: 'viewport' | 'paragraph' | 'full'): ExtractedText | null {
    try {
      const editorArea = this.findEditorArea();
      if (!editorArea) {
        console.log('Rewordly: extractFromAccessibilityLayer - no editor area found');
        return null;
      }

      // Try multiple selectors for the accessibility layer
      let contentEditableElement = editorArea.querySelector('[contenteditable="true"]');
      
      // Fallback: try to find any element with text content in the editor
      if (!contentEditableElement) {
        // Google Docs might use different structures - try finding text nodes directly
        const textNodes = this.findTextNodesInEditor(editorArea);
        if (textNodes.length > 0) {
          const text = textNodes.map(n => n.textContent || '').join(' ').trim();
          if (text.length > 0) {
            console.log('Rewordly: extractFromAccessibilityLayer - found text via text nodes', { length: text.length });
            return { text, source: 'accessibility_textnodes', scope };
          }
        }
        console.log('Rewordly: extractFromAccessibilityLayer - no contenteditable element found');
        return null;
      }
      
      const contentEditable = contentEditableElement as HTMLElement;

      let text = '';

      if (scope === 'paragraph') {
        // Get paragraph containing caret
        const selection = window.getSelection();
        if (selection && selection.rangeCount > 0) {
          const range = selection.getRangeAt(0);
          const paragraph = range.commonAncestorContainer.nodeType === Node.TEXT_NODE
            ? range.commonAncestorContainer.parentElement?.closest('.kix-paragraphrenderer, .kix-lineview')
            : (range.commonAncestorContainer as Element)?.closest('.kix-paragraphrenderer, .kix-lineview');
          
          if (paragraph) {
            text = paragraph.textContent || '';
          }
        }
      } else if (scope === 'viewport') {
        // Get visible paragraphs in viewport
        const viewport = editorArea.getBoundingClientRect();
        const paragraphs = Array.from(editorArea.querySelectorAll('.kix-paragraphrenderer, .kix-lineview'));
        const visibleParagraphs = paragraphs.filter(p => {
          const rect = p.getBoundingClientRect();
          return rect.top < viewport.bottom && rect.bottom > viewport.top;
        });

        if (visibleParagraphs.length > 0) {
          text = visibleParagraphs.map(p => p.textContent || '').join('\n');
        }
      } else {
        // Full document
        text = contentEditable.textContent || contentEditable.innerText || '';
      }

      if (text.trim().length > 0) {
        return { text: text.trim(), source: 'accessibility', scope };
      }
    } catch (e) {
      console.warn('Rewordly: Accessibility layer extraction failed', e);
    }
    return null;
  }

  private extractFromModelChunk(): ExtractedText | null {
    try {
      console.log('Rewordly: extractFromModelChunk - searching for DOCS_modelChunk');
      // Search in entire document, not just container
      const scriptTags = document.querySelectorAll('script[nonce]');
      // Also try script tags without nonce attribute
      const allScriptTags = document.querySelectorAll('script');
      console.log('Rewordly: extractFromModelChunk - found script tags', { 
        withNonce: scriptTags.length,
        all: allScriptTags.length 
      });
      
      // Combine both sets
      const scriptsToCheck = new Set<HTMLScriptElement>();
      scriptTags.forEach(s => scriptsToCheck.add(s as HTMLScriptElement));
      allScriptTags.forEach(s => scriptsToCheck.add(s as HTMLScriptElement));

      const textParts: string[] = [];
      const seenTexts = new Set<string>();

      for (const scriptTag of scriptsToCheck) {
        const scriptContent = scriptTag.textContent || '';
        if (scriptContent.includes('DOCS_modelChunk')) {
          console.log('Rewordly: extractFromModelChunk - found DOCS_modelChunk script', { 
            scriptLength: scriptContent.length,
            preview: scriptContent.substring(0, 200)
          });
          try {
            // Try multiple regex patterns to extract the data
            let match = scriptContent.match(/DOCS_modelChunk\s*=\s*({.+?});/s);
            if (!match) {
              match = scriptContent.match(/DOCS_modelChunk\s*=\s*({[\s\S]+?});/);
            }
            if (!match) {
              // Try to find it without semicolon
              match = scriptContent.match(/DOCS_modelChunk\s*=\s*({[\s\S]+?})(?:\s*;|\s*$)/);
            }
            if (!match) {
              // Try even more flexible pattern
              match = scriptContent.match(/DOCS_modelChunk\s*=\s*({[^}]+})/);
            }
            
            if (match && match[1]) {
              const chunkData = JSON.parse(match[1]);
              console.log('Rewordly: extractFromModelChunk - parsed chunk data', { 
                hasChunk: !!chunkData.chunk,
                chunkIsArray: Array.isArray(chunkData.chunk),
                chunkLength: Array.isArray(chunkData.chunk) ? chunkData.chunk.length : 0
              });
              
              if (chunkData.chunk && Array.isArray(chunkData.chunk)) {
                chunkData.chunk.forEach((chunk: any) => {
                  if (chunk.s && typeof chunk.s === 'string') {
                    const text = chunk.s.trim();
                    // Filter out very short text and disclaimers
                    if (text.length > 10 && !this.isDisclaimer(text) && !seenTexts.has(text)) {
                      seenTexts.add(text);
                      textParts.push(text);
                    }
                  }
                });
              }
            } else {
              console.log('Rewordly: extractFromModelChunk - no match found in script content');
            }
          } catch (e) {
            console.warn('Rewordly: DOCS_modelChunk JSON parsing failed', e);
          }
        }
      }

      if (textParts.length > 0) {
        const uniqueTexts = Array.from(new Set(textParts));
        const fullText = uniqueTexts.join('\n\n');
        console.log('Rewordly: extractFromModelChunk - extracted text', { 
          length: fullText.length, 
          parts: textParts.length,
          unique: uniqueTexts.length,
          preview: fullText.substring(0, 100)
        });
        return { text: fullText, source: 'docs_modelchunk', scope: 'full' };
      } else {
        console.log('Rewordly: extractFromModelChunk - no text parts found');
      }
    } catch (e) {
      console.warn('Rewordly: DOCS_modelChunk extraction failed', e);
    }
    return null;
  }

  private isDisclaimer(text: string): boolean {
    const disclaimerPatterns = [
      /bu notlar.*gemini.*oluşturulmuştur/i,
      /this note.*created.*gemini/i,
      /created.*gemini/i,
      /gemini.*created/i,
      /otomatik.*oluşturuldu/i,
      /auto.*generated/i,
      /draft.*created/i
    ];
    return disclaimerPatterns.some(pattern => pattern.test(text));
  }

  private extractFromViewport(): ExtractedText | null {
    try {
      const editorArea = this.findEditorArea();
      if (!editorArea) {
        console.log('Rewordly: extractFromViewport - no editor area found');
        return null;
      }

      // Try multiple selectors
      const selectors = ['.kix-paragraphrenderer', '.kix-lineview', '.kix-lineview-text-block'];
      let paragraphs: NodeListOf<Element> | null = null;
      
      for (const selector of selectors) {
        paragraphs = editorArea.querySelectorAll(selector);
        if (paragraphs.length > 0) {
          console.log('Rewordly: extractFromViewport - found elements with selector', { selector, count: paragraphs.length });
          break;
        }
      }
      
      if (!paragraphs || paragraphs.length === 0) {
        console.log('Rewordly: extractFromViewport - no paragraphs found');
        // Fallback: try to get text from text nodes
        const textNodes = this.findTextNodesInEditor(editorArea);
        if (textNodes.length > 0) {
          const text = textNodes.map(n => n.textContent || '').join(' ').trim();
          if (text.length > 0) {
            console.log('Rewordly: extractFromViewport - found text via text nodes', { length: text.length });
            return { text, source: 'viewport_textnodes', scope: 'viewport' };
          }
        }
        return null;
      }

      const paragraphTexts: string[] = [];
      paragraphs.forEach((para) => {
        const text = para.textContent || '';
        const trimmedText = text.trim();
        if (trimmedText.length > 5) {
          paragraphTexts.push(trimmedText);
        }
      });

      if (paragraphTexts.length > 0) {
        const fullText = paragraphTexts.join('\n');
        console.log('Rewordly: extractFromViewport - extracted text', { length: fullText.length, paragraphs: paragraphTexts.length });
        return { text: fullText, source: 'paragraphs', scope: 'viewport' };
      }
      
      console.log('Rewordly: extractFromViewport - no valid paragraph text found');
    } catch (e) {
      console.warn('Rewordly: Viewport extraction failed', e);
    }
    return null;
  }

  private extractFromPages(): ExtractedText | null {
    try {
      const editorArea = this.findEditorArea();
      if (!editorArea) return null;

      const pages = editorArea.querySelectorAll('.kix-page');
      if (pages.length === 0) return null;

      const pageTexts: string[] = [];
      pages.forEach((page) => {
        const paragraphs = page.querySelectorAll('.kix-paragraphrenderer');
        if (paragraphs.length > 0) {
          const paraTexts: string[] = [];
          paragraphs.forEach((para) => {
            const text = para.textContent || '';
            const trimmedText = text.trim();
            if (trimmedText.length > 3) {
              paraTexts.push(trimmedText);
            }
          });
          if (paraTexts.length > 0) {
            pageTexts.push(paraTexts.join('\n'));
          }
        }
      });

      if (pageTexts.length > 0) {
        const fullText = pageTexts.join('\n\n');
        return { text: fullText, source: 'pages', scope: 'full' };
      }
    } catch (e) {
      console.warn('Rewordly: Page extraction failed', e);
    }
    return null;
  }

  private findEditorArea(): HTMLElement | null {
    const editor = this.container.querySelector('.kix-appview-editor') ||
                   this.container.querySelector('.kix-scrollareadocumentplugin') ||
                   this.container.querySelector('#kix-appview');
    return (editor as HTMLElement) || this.container;
  }

  private findTextNodesInEditor(editorArea: HTMLElement): Text[] {
    const textNodes: Text[] = [];
    const walker = document.createTreeWalker(
      editorArea,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          // Skip if parent is hidden or in UI elements
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          
          const style = window.getComputedStyle(parent);
          if (style.display === 'none' || style.visibility === 'hidden') {
            return NodeFilter.FILTER_REJECT;
          }
          
          // Skip UI elements
          if (parent.closest('[role="button"], [role="menu"], [role="toolbar"], [role="dialog"]')) {
            return NodeFilter.FILTER_REJECT;
          }
          
          // Only accept text in document structure
          const isInDocStructure = parent.closest('.kix-paragraphrenderer, .kix-lineview, .kix-page-content') !== null;
          if (!isInDocStructure) return NodeFilter.FILTER_REJECT;
          
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );
    
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (node.nodeType === Node.TEXT_NODE && node.textContent && node.textContent.trim().length > 0) {
        textNodes.push(node as Text);
      }
    }
    
    return textNodes;
  }

  private extractFromSelection(): ExtractedText | null {
    try {
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        const text = range.toString().trim();
        if (text.length > 10) {
          console.log('Rewordly: extractFromSelection - found text', { length: text.length });
          return { text, source: 'selection', scope: 'paragraph' };
        }
      }
    } catch (e) {
      console.warn('Rewordly: Selection extraction failed', e);
    }
    return null;
  }

  private extractFromAllTextNodes(): ExtractedText | null {
    try {
      const editorArea = this.findEditorArea();
      if (!editorArea) return null;

      // Get ALL text nodes in the editor area, not just those in specific structures
      const walker = document.createTreeWalker(
        editorArea,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: (node) => {
            const parent = node.parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;
            
            // Skip if hidden
            const style = window.getComputedStyle(parent);
            if (style.display === 'none' || style.visibility === 'hidden') {
              return NodeFilter.FILTER_REJECT;
            }
            
            // Skip UI elements
            if (parent.closest('[role="button"], [role="menu"], [role="toolbar"], [role="dialog"], [role="alert"]')) {
              return NodeFilter.FILTER_REJECT;
            }
            
            // Skip common UI classes
            const uiClasses = ['docs-titlebar', 'docs-menubar', 'docs-toolbar', 'docs-sidebar', 
                              'docs-statusbar', 'docs-footer', 'docs-header'];
            if (uiClasses.some(cls => parent.closest(`.${cls}`) !== null)) {
              return NodeFilter.FILTER_REJECT;
            }
            
            // Accept all other text nodes
            return NodeFilter.FILTER_ACCEPT;
          }
        }
      );
      
      const textParts: string[] = [];
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const text = node.textContent || '';
        const trimmedText = text.trim();
        if (trimmedText.length > 2) {
          textParts.push(trimmedText);
        }
      }
      
      if (textParts.length > 0) {
        const fullText = textParts.join(' ');
        console.log('Rewordly: extractFromAllTextNodes - found text', { length: fullText.length, parts: textParts.length });
        return { text: fullText, source: 'all_textnodes', scope: 'full' };
      }
    } catch (e) {
      console.warn('Rewordly: All text nodes extraction failed', e);
    }
    return null;
  }

  private extractBySelectAll(): ExtractedText | null {
    try {
      // Try to select all text in the editor and get it
      const editorArea = this.findEditorArea();
      if (!editorArea) return null;

      // Try to create a range that covers the editor
      const range = document.createRange();
      range.selectNodeContents(editorArea);
      
      const selection = window.getSelection();
      if (!selection) return null;

      // Save current selection
      const savedRanges: Range[] = [];
      if (selection.rangeCount > 0) {
        for (let i = 0; i < selection.rangeCount; i++) {
          savedRanges.push(selection.getRangeAt(i).cloneRange());
        }
      }

      try {
        selection.removeAllRanges();
        selection.addRange(range);
        
        const text = selection.toString().trim();
        
        // Restore selection
        selection.removeAllRanges();
        savedRanges.forEach(r => {
          try {
            selection.addRange(r);
          } catch (e) {
            // Ignore
          }
        });

        if (text.length > 10) {
          console.log('Rewordly: extractBySelectAll - found text', { length: text.length });
          return { text, source: 'selectall', scope: 'full' };
        }
      } catch (e) {
        // Restore selection on error
        selection.removeAllRanges();
        savedRanges.forEach(r => {
          try {
            selection.addRange(r);
          } catch (e) {
            // Ignore
          }
        });
        throw e;
      }
    } catch (e) {
      console.warn('Rewordly: SelectAll extraction failed', e);
    }
    return null;
  }

  private extractFromDocumentBody(): ExtractedText | null {
    try {
      // Last resort: search entire document body for text nodes
      // This is very aggressive and might pick up UI text, but better than nothing
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: (node) => {
            const parent = node.parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;
            
            // Skip if hidden
            const style = window.getComputedStyle(parent);
            if (style.display === 'none' || style.visibility === 'hidden') {
              return NodeFilter.FILTER_REJECT;
            }
            
            // Skip UI elements more aggressively
            if (parent.closest('[role="button"], [role="menu"], [role="toolbar"], [role="dialog"], [role="alert"], [role="navigation"]')) {
              return NodeFilter.FILTER_REJECT;
            }
            
            // Skip common UI classes
            const uiClasses = ['docs-titlebar', 'docs-menubar', 'docs-toolbar', 'docs-sidebar', 
                              'docs-statusbar', 'docs-footer', 'docs-header', 'docs-menubar',
                              'goog-menu', 'goog-toolbar', 'jfk-button'];
            if (uiClasses.some(cls => parent.classList.contains(cls) || parent.closest(`.${cls}`) !== null)) {
              return NodeFilter.FILTER_REJECT;
            }
            
            // Prefer text in editor-related structures
            const isInEditor = parent.closest('.kix-appview-editor, .kix-scrollareadocumentplugin, #kix-appview, .kix-page, .kix-paragraphrenderer') !== null;
            if (!isInEditor) {
              // Still accept if it's substantial text (might be document content)
              const text = node.textContent || '';
              if (text.trim().length < 20) {
                return NodeFilter.FILTER_REJECT; // Too short, likely UI
              }
            }
            
            return NodeFilter.FILTER_ACCEPT;
          }
        }
      );
      
      const textParts: string[] = [];
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const text = node.textContent || '';
        const trimmedText = text.trim();
        if (trimmedText.length > 5) {
          textParts.push(trimmedText);
        }
      }
      
      if (textParts.length > 0) {
        const fullText = textParts.join(' ');
        console.log('Rewordly: extractFromDocumentBody - found text', { length: fullText.length, parts: textParts.length });
        return { text: fullText, source: 'document_body', scope: 'full' };
      }
    } catch (e) {
      console.warn('Rewordly: Document body extraction failed', e);
    }
    return null;
  }

  setDebugMode(enabled: boolean): void {
    console.log('Rewordly: setDebugMode', enabled);
    // this.debugMode = enabled;
  }
}

/**
 * IssueAnchor: Fingerprint-based anchoring system
 */
class IssueAnchor {
  private anchors: Map<string, {
    error: GrammarError;
    fingerprint: string;
    prefix: string;
    suffix: string;
  }> = new Map();

  createFingerprint(error: GrammarError, text: string, contextSize: number = 50): string {
    const prefix = text.substring(Math.max(0, error.start - contextSize), error.start).trim();
    const suffix = text.substring(error.end, Math.min(text.length, error.end + contextSize)).trim();
    const errorText = error.word.trim();
    
    // Create fingerprint: prefix + error + suffix
    const fingerprint = `${prefix}|${errorText}|${suffix}`;
    
    this.anchors.set(error.id, {
      error,
      fingerprint,
      prefix,
      suffix
    });

    return fingerprint;
  }

  resolveAnchors(text: string): Map<string, { start: number; end: number }> {
    const resolved = new Map<string, { start: number; end: number }>();

    for (const [errorId, anchor] of this.anchors) {
      const { error, prefix, suffix } = anchor;
      const errorText = error.word.trim();

      // Try exact match first
      let foundIndex = this.findExactMatch(text, prefix, errorText, suffix);
      
      // Fallback to fuzzy match
      if (foundIndex === -1) {
        foundIndex = this.findFuzzyMatch(text, prefix, errorText, suffix);
      }

      if (foundIndex !== -1) {
        const start = foundIndex;
        const end = foundIndex + errorText.length;
        resolved.set(errorId, { start, end });
      }
    }

    return resolved;
  }

  private findExactMatch(text: string, prefix: string, errorText: string, suffix: string): number {
    const searchText = text.toLowerCase();
    const prefixLower = prefix.toLowerCase();
    const errorTextLower = errorText.toLowerCase();
    const suffixLower = suffix.toLowerCase();

    // Try to find prefix + error + suffix
    const fullPattern = prefixLower + errorTextLower + suffixLower;
    const fullIndex = searchText.indexOf(fullPattern);
    if (fullIndex !== -1) {
      return fullIndex + prefixLower.length;
    }

    // Try to find just prefix + error
    const prefixErrorPattern = prefixLower.slice(-30) + errorTextLower;
    let searchIndex = 0;
    while (true) {
      const index = searchText.indexOf(prefixErrorPattern, searchIndex);
      if (index === -1) break;
      
      // Check if suffix matches after
      const afterIndex = index + prefixErrorPattern.length;
      if (afterIndex < text.length) {
        const afterText = text.substring(afterIndex, Math.min(text.length, afterIndex + suffixLower.length)).toLowerCase();
        if (afterText.startsWith(suffixLower.slice(0, 20))) {
          return index + prefixErrorPattern.length - errorTextLower.length;
        }
      }
      searchIndex = index + 1;
    }

    // Try to find just error + suffix
    const errorSuffixPattern = errorTextLower + suffixLower.slice(0, 30);
    searchIndex = 0;
    while (true) {
      const index = searchText.indexOf(errorSuffixPattern, searchIndex);
      if (index === -1) break;
      
      // Check if prefix matches before
      if (index > 0) {
        const beforeText = text.substring(Math.max(0, index - prefixLower.length), index).toLowerCase();
        if (beforeText.endsWith(prefixLower.slice(-20))) {
          return index;
        }
      }
      searchIndex = index + 1;
    }

    return -1;
  }

  private findFuzzyMatch(text: string, _prefix: string, errorText: string, _suffix: string): number {
    // Simple token-based fuzzy matching
    const errorWords = errorText.toLowerCase().split(/\s+/).filter(w => w.length > 0);
    if (errorWords.length === 0) return -1;

    const textLower = text.toLowerCase();
    const firstWord = errorWords[0];
    if (!firstWord) return -1;

    // Find all occurrences of first word
    let searchIndex = 0;
    while (true) {
      const index = textLower.indexOf(firstWord, searchIndex);
      if (index === -1) break;

      // Check if subsequent words match
      let allMatch = true;
      let currentIndex = index + firstWord.length;
      
      for (let i = 1; i < errorWords.length; i++) {
        const word = errorWords[i];
        if (!word) {
          allMatch = false;
          break;
        }

        // Skip whitespace
        while (currentIndex < textLower.length && /\s/.test(textLower[currentIndex] || '')) {
          currentIndex++;
        }

        if (textLower.substring(currentIndex, currentIndex + word.length) !== word) {
          allMatch = false;
          break;
        }

        currentIndex += word.length;
      }

      if (allMatch) {
        return index;
      }

      searchIndex = index + 1;
    }

    return -1;
  }

  updateAnchors(errors: GrammarError[]): void {
    // Remove anchors for errors that no longer exist
    const currentErrorIds = new Set(errors.map(e => e.id));
    for (const errorId of this.anchors.keys()) {
      if (!currentErrorIds.has(errorId)) {
        this.anchors.delete(errorId);
      }
    }
  }

  clear(): void {
    this.anchors.clear();
  }
}

/**
 * HighlightEngine: Stable overlay rendering with correct coordinate space
 */
class HighlightEngine {
  private overlayRoot: HTMLElement | null = null;
  private scroller: HTMLElement | null = null;
  private container: HTMLElement;
  private pendingUpdates: Map<string, DOMRect[]> = new Map();
  private updateScheduled = false;

  constructor(container: HTMLElement) {
    this.container = container;
    this.findScroller();
    // Container is used in findScroller and other methods
  }

  private findScroller(): void {
    const editorAreaElement = this.container.querySelector('.kix-appview-editor') ||
                      this.container.querySelector('.kix-scrollareadocumentplugin') ||
                      this.container.querySelector('#kix-appview');
    const editorArea = (editorAreaElement as HTMLElement) || this.container;
    
    // Find the actual scrollable container
    let element: HTMLElement | null = editorArea;
    while (element) {
      const style = window.getComputedStyle(element);
      if (style.overflow === 'auto' || style.overflow === 'scroll' || 
          style.overflowY === 'auto' || style.overflowY === 'scroll') {
        this.scroller = element;
        break;
      }
      element = element.parentElement;
    }

    if (!this.scroller) {
      this.scroller = editorArea;
    }
  }

  initializeOverlay(): void {
    if (this.overlayRoot) return;

    // Create overlay root with fixed positioning (viewport coordinates)
    this.overlayRoot = document.createElement('div');
    this.overlayRoot.id = 'rewordly-docs-overlay';
    this.overlayRoot.style.cssText = `
      position: fixed !important;
      top: 0 !important;
      left: 0 !important;
      width: 100% !important;
      height: 100% !important;
      pointer-events: none !important;
      z-index: 2147483646 !important;
      overflow: visible !important;
    `;
    document.body.appendChild(this.overlayRoot);
  }

  renderHighlights(
    errors: GrammarError[],
    resolvedAnchors: Map<string, { start: number; end: number }>,
    text: string
  ): void {
    if (!this.overlayRoot) {
      this.initializeOverlay();
    }

    // Clear existing highlights
    if (this.overlayRoot) {
      this.overlayRoot.innerHTML = '';
    }

    // Get rects for each error
    const allRects: Array<{ error: GrammarError; rects: DOMRect[] }> = [];

    for (const error of errors) {
      const anchor = resolvedAnchors.get(error.id);
      if (!anchor) continue;

      const rects = this.getErrorRects(anchor.start, anchor.end, text);
      if (rects.length > 0) {
        allRects.push({ error, rects });
      }
    }

    // Batch render with requestAnimationFrame
    this.pendingUpdates.clear();
    for (const { error, rects } of allRects) {
      this.pendingUpdates.set(error.id, rects);
    }

    if (!this.updateScheduled) {
      this.updateScheduled = true;
      requestAnimationFrame(() => {
        this.flushUpdates();
        this.updateScheduled = false;
      });
    }
  }

  private flushUpdates(): void {
    if (!this.overlayRoot) return;

    for (const [errorId, rects] of this.pendingUpdates) {
      for (let i = 0; i < rects.length; i++) {
        const rect = rects[i];
        if (!rect) continue;
        const highlight = document.createElement('div');
        highlight.className = 'rewordly-docs-highlight';
        highlight.setAttribute('data-error-id', errorId);
        highlight.setAttribute('data-line-index', i.toString());
        highlight.style.cssText = `
          position: absolute !important;
          top: ${rect.top ?? 0}px !important;
          left: ${rect.left ?? 0}px !important;
          width: ${rect.width ?? 0}px !important;
          height: ${rect.height ?? 0}px !important;
          background: rgba(255, 0, 0, 0.2) !important;
          border-bottom: 2px solid red !important;
          pointer-events: none !important;
          z-index: 2147483647 !important;
        `;
        this.overlayRoot.appendChild(highlight);
      }
    }
  }

  private getErrorRects(start: number, end: number, text: string): DOMRect[] {
    const errorText = text.substring(start, end);
    if (!errorText) return [];

    try {
      // Use window.find() to locate text in accessibility layer
      const selection = window.getSelection();
      if (!selection) return [];

      // Save current selection
      const savedRanges: Range[] = [];
      if (selection.rangeCount > 0) {
        for (let i = 0; i < selection.rangeCount; i++) {
          savedRanges.push(selection.getRangeAt(i).cloneRange());
        }
      }

      try {
        selection.removeAllRanges();

        // Try to find the error text
        const found = (window as any).find(errorText, false, false, false);
        if (found && selection.rangeCount > 0) {
          const range = selection.getRangeAt(0);
          const clientRects = range.getClientRects();
          const rects: DOMRect[] = [];

          for (let i = 0; i < clientRects.length; i++) {
            const clientRect = clientRects[i];
            if (clientRect && clientRect.width > 0 && clientRect.height > 0) {
              // getBoundingClientRect() already gives viewport coordinates
              // which is what we need for position: fixed
              rects.push(new DOMRect(
                clientRect.left ?? 0,
                clientRect.top ?? 0,
                clientRect.width ?? 0,
                clientRect.height ?? 0
              ));
            }
          }

          // Restore selection
          selection.removeAllRanges();
          savedRanges.forEach(r => {
            try {
              selection.addRange(r);
            } catch (e) {
              // Ignore
            }
          });

          return rects;
        }

        // Restore selection
        selection.removeAllRanges();
        savedRanges.forEach(r => {
          try {
            selection.addRange(r);
          } catch (e) {
            // Ignore
          }
        });
      } catch (e) {
        // Restore selection on error
        selection.removeAllRanges();
        savedRanges.forEach(r => {
          try {
            selection.addRange(r);
          } catch (e) {
            // Ignore
          }
        });
      }
    } catch (e) {
      console.warn('Rewordly: Error getting rects', e);
    }

    return [];
  }

  updatePositions(): void {
    // Reposition all highlights (called on scroll)
    if (!this.overlayRoot) return;

    // Re-render all highlights
    // This is a simplified version - in practice, you'd want to cache errors
    // and re-resolve anchors, then re-render
    requestAnimationFrame(() => {
      // Trigger re-render by dispatching a custom event
      // The adapter will handle this
    });
  }

  getScrollerInfo(): { selector: string; scrollTop: number; scrollLeft: number } | null {
    if (!this.scroller) return null;

    const selector = this.scroller.className || this.scroller.id || this.scroller.tagName;
    return {
      selector,
      scrollTop: this.scroller.scrollTop || 0,
      scrollLeft: this.scroller.scrollLeft || 0
    };
  }

  getScaleInfo(): { browserZoom: number; docsZoom: number; devicePixelRatio: number } {
    // Browser zoom (approximate)
    const browserZoom = window.devicePixelRatio || 1;
    
    // Docs zoom (if available)
    let docsZoom = 1;
    try {
      // Google Docs stores zoom in various places - this is a simplified check
      const zoomElement = document.querySelector('[data-zoom]');
      if (zoomElement) {
        const zoomAttr = zoomElement.getAttribute('data-zoom');
        if (zoomAttr) {
          docsZoom = parseFloat(zoomAttr) || 1;
        }
      }
    } catch (e) {
      // Ignore
    }

    return {
      browserZoom,
      docsZoom,
      devicePixelRatio: window.devicePixelRatio || 1
    };
  }

  setDebugMode(_enabled: boolean): void {
    // Debug mode handled by DebugMode class
    if (_enabled && this.overlayRoot) {
      // Draw rect outlines in debug mode
      const highlights = this.overlayRoot.querySelectorAll('.rewordly-docs-highlight');
      highlights.forEach(h => {
        (h as HTMLElement).style.border = '2px solid blue !important';
      });
    }
  }

  cleanup(): void {
    if (this.overlayRoot) {
      this.overlayRoot.remove();
      this.overlayRoot = null;
    }
  }
}

/**
 * DebugMode: Comprehensive debugging and diagnostics
 */
class DebugMode {
  private panel: HTMLElement | null = null;
  private isEnabled = false;
  private changeDetector: DocsChangeDetector;
//   private textExtractor: DocsTextExtractor;
  private highlightEngine: HighlightEngine;
  private lastExtractedText: ExtractedText | null = null;
  private lastGrammarCheck: { timestamp: number; reason: string; textLength: number } | null = null;
  private currentErrors: GrammarError[] = [];

  constructor(
    changeDetector: DocsChangeDetector,
    // textExtractor: DocsTextExtractor,
    highlightEngine: HighlightEngine
  ) {
    this.changeDetector = changeDetector;
    // this.textExtractor = textExtractor;
    this.highlightEngine = highlightEngine;
  }

  toggle(): void {
    this.isEnabled = !this.isEnabled;
    if (this.isEnabled) {
      this.show();
    } else {
      this.hide();
    }
  }

  private show(): void {
    if (this.panel) {
      this.panel.style.display = 'block';
      this.update();
      return;
    }

    this.panel = document.createElement('div');
    this.panel.id = 'rewordly-docs-debug';
    this.panel.style.cssText = `
      position: fixed !important;
      top: 10px !important;
      right: 10px !important;
      width: 400px !important;
      max-height: 80vh !important;
      background: white !important;
      border: 2px solid #333 !important;
      border-radius: 8px !important;
      padding: 16px !important;
      z-index: 2147483648 !important;
      font-family: monospace !important;
      font-size: 12px !important;
      overflow-y: auto !important;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3) !important;
    `;

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '×';
    closeBtn.style.cssText = `
      position: absolute !important;
      top: 8px !important;
      right: 8px !important;
      background: #f00 !important;
      color: white !important;
      border: none !important;
      border-radius: 4px !important;
      width: 24px !important;
      height: 24px !important;
      cursor: pointer !important;
    `;
    closeBtn.onclick = () => this.toggle();
    this.panel.appendChild(closeBtn);

    document.body.appendChild(this.panel);
    this.update();
    
    // Update every second
    setInterval(() => this.update(), 1000);
  }

  private hide(): void {
    if (this.panel) {
      this.panel.style.display = 'none';
    }
  }

  update(): void {
    if (!this.panel || !this.isEnabled) return;

    const info = this.getDebugInfo();
    this.panel.innerHTML = this.renderDebugInfo(info);
    
    // Re-add close button
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '×';
    closeBtn.style.cssText = `
      position: absolute !important;
      top: 8px !important;
      right: 8px !important;
      background: #f00 !important;
      color: white !important;
      border: none !important;
      border-radius: 4px !important;
      width: 24px !important;
      height: 24px !important;
      cursor: pointer !important;
    `;
    closeBtn.onclick = () => this.toggle();
    this.panel.appendChild(closeBtn);
  }

  private getDebugInfo(): DebugInfo {
    return {
      events: this.changeDetector.getEventLogs(),
      lastGrammarCheck: this.lastGrammarCheck,
      extractedText: this.lastExtractedText ? {
        preview: this.lastExtractedText.text.substring(0, 500),
        length: this.lastExtractedText.text.length,
        scope: this.lastExtractedText.scope,
        source: this.lastExtractedText.source
      } : null,
      scroller: this.highlightEngine.getScrollerInfo(),
      scale: this.highlightEngine.getScaleInfo(),
      issues: {
        count: this.currentErrors.length,
        rectsCount: this.panel ? this.panel.querySelectorAll('.rewordly-docs-highlight').length : 0
      }
    };
  }

  private renderDebugInfo(info: DebugInfo): string {
    let html = '<h3 style="margin-top: 0;">Rewordly Docs Debug</h3>';

    // Events
    html += '<h4>Recent Events</h4>';
    html += '<div style="max-height: 150px; overflow-y: auto;">';
    const recentEvents = info.events.slice(-10);
    if (recentEvents.length === 0) {
      html += '<p>No events yet</p>';
    } else {
      recentEvents.forEach(event => {
        html += `<div style="margin: 4px 0; padding: 4px; background: #f0f0f0; border-radius: 4px;">`;
        html += `<strong>${event.type}</strong> @ ${new Date(event.timestamp).toLocaleTimeString()}`;
        if (event.isComposing) {
          html += ' <span style="color: orange;">[COMPOSING]</span>';
        }
        html += `</div>`;
      });
    }
    html += '</div>';

    // Last grammar check
    html += '<h4>Last Grammar Check</h4>';
    if (info.lastGrammarCheck) {
      html += `<p>Time: ${new Date(info.lastGrammarCheck.timestamp).toLocaleTimeString()}<br>`;
      html += `Reason: ${info.lastGrammarCheck.reason}<br>`;
      html += `Text Length: ${info.lastGrammarCheck.textLength}</p>`;
    } else {
      html += '<p>No grammar check yet</p>';
    }

    // Extracted text
    html += '<h4>Extracted Text</h4>';
    if (info.extractedText) {
      html += `<p>Source: ${info.extractedText.source}<br>`;
      html += `Scope: ${info.extractedText.scope}<br>`;
      html += `Length: ${info.extractedText.length}<br>`;
      html += `<pre style="max-height: 100px; overflow-y: auto; background: #f5f5f5; padding: 8px; border-radius: 4px;">${this.escapeHtml(info.extractedText.preview)}</pre></p>`;
    } else {
      html += '<p>No text extracted yet</p>';
    }

    // Scroller
    html += '<h4>Scroller</h4>';
    if (info.scroller) {
      html += `<p>Selector: ${info.scroller.selector}<br>`;
      html += `ScrollTop: ${info.scroller.scrollTop}<br>`;
      html += `ScrollLeft: ${info.scroller.scrollLeft}</p>`;
    } else {
      html += '<p>No scroller found</p>';
    }

    // Scale
    html += '<h4>Scale/Zoom</h4>';
    if (info.scale) {
      html += `<p>Browser Zoom: ${info.scale.browserZoom.toFixed(2)}<br>`;
      html += `Docs Zoom: ${info.scale.docsZoom.toFixed(2)}<br>`;
      html += `Device Pixel Ratio: ${info.scale.devicePixelRatio.toFixed(2)}</p>`;
    }

    // Issues
    html += '<h4>Issues</h4>';
    if (info.issues) {
      html += `<p>Count: ${info.issues.count}<br>`;
      html += `Rects: ${info.issues.rectsCount}</p>`;
    } else {
      html += '<p>No issues</p>';
    }

    return html;
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  updateExtractedText(text: ExtractedText): void {
    this.lastExtractedText = text;
    if (this.isEnabled) {
      this.update();
    }
  }

  updateGrammarCheck(reason: string, textLength: number): void {
    this.lastGrammarCheck = {
      timestamp: Date.now(),
      reason,
      textLength
    };
    if (this.isEnabled) {
      this.update();
    }
  }

  updateErrors(errors: GrammarError[]): void {
    this.currentErrors = errors;
    if (this.isEnabled) {
      this.update();
    }
  }

  cleanup(): void {
    if (this.panel) {
      this.panel.remove();
      this.panel = null;
    }
  }
}

/**
 * DocsAdapter: Orchestrates all components
 */
export class DocsAdapter {
//   private container: HTMLElement;
  private changeDetector: DocsChangeDetector;
  private textExtractor: DocsTextExtractor;
  private issueAnchor: IssueAnchor;
  private highlightEngine: HighlightEngine;
  private debugMode: DebugMode;
  private onGrammarCheck: (text: string) => Promise<GrammarError[]>;
  private lastText = '';
  private virtualElement: HTMLElement;

  constructor(
    container: HTMLElement,
    onGrammarCheck: (text: string) => Promise<GrammarError[]>
  ) {
    // this.container = container;
    this.onGrammarCheck = onGrammarCheck;

    // Create virtual element for compatibility with existing system
    this.virtualElement = document.createElement('div');
    this.virtualElement.style.display = 'none';
    this.virtualElement.setAttribute('contenteditable', 'true');
    document.body.appendChild(this.virtualElement);
    (this.virtualElement as any).__rewordlyGoogleDocsContainer = container;
    (this.virtualElement as any).__rewordlyIsGoogleDocs = true;

    // Initialize components
    this.changeDetector = new DocsChangeDetector((reason) => {
      this.handleCheckTriggered(reason);
    });
    this.textExtractor = new DocsTextExtractor(container);
    this.issueAnchor = new IssueAnchor();
    this.highlightEngine = new HighlightEngine(container);
    this.debugMode = new DebugMode(
      this.changeDetector,
    //   this.textExtractor,
      this.highlightEngine
    );

    // Attach event listeners
    this.changeDetector.attach(container);

    // Also use MutationObserver to detect changes in Google Docs DOM
    // Google Docs uses canvas rendering, so DOM events might not fire
    const mutationObserver = new MutationObserver(() => {
      // Debounce mutation observer triggers
      if ((this as any).mutationTimeout) {
        clearTimeout((this as any).mutationTimeout);
      }
      (this as any).mutationTimeout = setTimeout(() => {
        console.log('Rewordly: MutationObserver detected changes, triggering check');
        this.handleCheckTriggered('mutation');
      }, 1000);
    });

    // Observe the editor area for changes
    const editorArea = container.querySelector('.kix-appview-editor') || 
                       container.querySelector('.kix-scrollareadocumentplugin') ||
                       container.querySelector('#kix-appview') ||
                       container;
    
    if (editorArea) {
      mutationObserver.observe(editorArea, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['style', 'class']
      });
      console.log('Rewordly: MutationObserver attached to editor area');
    }

    // Store observer for cleanup
    (this as any).mutationObserver = mutationObserver;

    // Handle scroll for repositioning
    const scroller = this.highlightEngine.getScrollerInfo();
    if (scroller) {
      const scrollElement = container.querySelector(scroller.selector) || container;
      scrollElement.addEventListener('scroll', () => {
        this.highlightEngine.updatePositions();
      }, { passive: true });
    }

    // Debug toggle (Ctrl+Shift+D)
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'D') {
        this.debugMode.toggle();
      }
    });

    // Initial check after delays to allow page to load
    // Google Docs loads content asynchronously, so we try multiple times
    setTimeout(() => {
      console.log('Rewordly: Triggering initial grammar check (attempt 1)');
      this.handleCheckTriggered('initial');
    }, 2000);
    
    setTimeout(() => {
      console.log('Rewordly: Triggering initial grammar check (attempt 2)');
      this.handleCheckTriggered('initial');
    }, 5000);
    
    setTimeout(() => {
      console.log('Rewordly: Triggering initial grammar check (attempt 3)');
      this.handleCheckTriggered('initial');
    }, 10000);
  }

  private async handleCheckTriggered(reason: string): Promise<void> {
    console.log('Rewordly: handleCheckTriggered called', { reason });
    
    // Try multiple scopes if viewport fails
    let extracted = this.textExtractor.extract('viewport');
    console.log('Rewordly: Text extracted (viewport)', { 
      length: extracted.text.length, 
      source: extracted.source,
      scope: extracted.scope,
      preview: extracted.text.substring(0, 100)
    });
    
    // If viewport extraction failed, try full document
    if (extracted.text.trim().length < 3) {
      console.log('Rewordly: Viewport extraction failed, trying full document');
      extracted = this.textExtractor.extract('full');
      console.log('Rewordly: Text extracted (full)', { 
        length: extracted.text.length, 
        source: extracted.source,
        scope: extracted.scope,
        preview: extracted.text.substring(0, 100)
      });
    }
    
    // Check if text changed
    const textHash = this.hashText(extracted.text);
    if (textHash === this.lastText && reason !== 'compositionend' && reason !== 'initial') {
      console.log('Rewordly: Text hash unchanged, skipping check', { 
        textHash: textHash.substring(0, 50),
        lastText: this.lastText.substring(0, 50)
      });
      return; // Text hasn't changed
    }

    this.lastText = textHash;

    if (extracted.text.trim().length < 3) {
      console.log('Rewordly: Text too short, skipping check', { length: extracted.text.trim().length });
      return; // Text too short
    }

    console.log('Rewordly: Proceeding with grammar check', { 
      textLength: extracted.text.length,
      reason 
    });

    // Update virtual element
    this.virtualElement.textContent = extracted.text;

    // Update debug info
    this.debugMode.updateExtractedText(extracted);
    this.debugMode.updateGrammarCheck(reason, extracted.text.length);

    // Perform grammar check
    console.log('Rewordly: Calling onGrammarCheck callback');
    try {
      const errors = await this.onGrammarCheck(extracted.text);
      console.log('Rewordly: Grammar check completed', { errorCount: errors.length });
      
      // Create fingerprints for new errors
      for (const error of errors) {
        this.issueAnchor.createFingerprint(error, extracted.text);
      }

      // Update anchors
      this.issueAnchor.updateAnchors(errors);

      // Resolve anchors to current text positions
      const resolvedAnchors = this.issueAnchor.resolveAnchors(extracted.text);

      // Update errors with resolved positions
      const updatedErrors = errors.map(error => {
        const anchor = resolvedAnchors.get(error.id);
        if (anchor) {
          return { ...error, start: anchor.start, end: anchor.end };
        }
        return error;
      });

      // Store errors in virtual element (for compatibility)
      (this.virtualElement as any).__rewordlyErrors = updatedErrors;

      // Render highlights
      this.highlightEngine.renderHighlights(updatedErrors, resolvedAnchors, extracted.text);

      // Update debug info
      this.debugMode.updateErrors(updatedErrors);
    } catch (error) {
      console.error('Rewordly: Grammar check error:', error);
    }
  }

  private hashText(text: string): string {
    // Simple hash for change detection
    return text.substring(0, 100) + text.length.toString();
  }

  getVirtualElement(): HTMLElement {
    return this.virtualElement;
  }

  setDebugMode(enabled: boolean): void {
    this.changeDetector.setDebugMode(enabled);
    this.textExtractor.setDebugMode(enabled);
    this.highlightEngine.setDebugMode(enabled);
    if (enabled) {
      this.debugMode.toggle();
    }
  }

  cleanup(): void {
    this.changeDetector.cleanup();
    this.highlightEngine.cleanup();
    this.debugMode.cleanup();
    
    // Clean up mutation observer
    if ((this as any).mutationObserver) {
      (this as any).mutationObserver.disconnect();
      (this as any).mutationObserver = null;
    }
    if ((this as any).mutationTimeout) {
      clearTimeout((this as any).mutationTimeout);
      (this as any).mutationTimeout = null;
    }
    
    if (this.virtualElement && this.virtualElement.parentNode) {
      this.virtualElement.parentNode.removeChild(this.virtualElement);
    }
  }
}

