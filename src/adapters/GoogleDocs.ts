/**
 * Google Docs Platform Adapter
 * Google Docs için özel implementasyon
 */

import { BaseAdapter } from './BaseAdapter';
import { Platform, GrammarError } from '../types';
import { DocsAdapter } from '../docs-adapter';

export class GoogleDocsAdapter extends BaseAdapter {
  override readonly platform: Platform = 'google-docs';
  
  private docsAdapter: DocsAdapter | null = null;
  private container: HTMLElement | null = null;

  constructor(onGrammarCheck?: (text: string) => Promise<GrammarError[]>) {
    super(onGrammarCheck);
  }

  override isGrammarCheckEnabled(): boolean {
    return this.isHostname('docs.google.com');
  }

  initialize(): void {
    if (!this.isGrammarCheckEnabled()) {
      return;
    }

    console.log('Rewordly: Google Docs adapter initializing...');

    // Google Docs editor container'ını bul
    const checkForEditor = () => {
      const editorContainer = document.querySelector('.kix-appview-editor') || 
                              document.querySelector('.kix-scrollareadocumentplugin') ||
                              document.querySelector('#kix-appview');
      
      if (editorContainer) {
        console.log('Rewordly: Google Docs editor found');
        this.container = editorContainer as HTMLElement;
        this.attachToEditor(this.container);
      } else {
        // Retry after a short delay
        setTimeout(checkForEditor, 500);
      }
    };
    
    // Start checking immediately
    checkForEditor();
    
    // Also listen for DOM changes in case editor loads later
    const observer = new MutationObserver(() => {
      const editorContainer = document.querySelector('.kix-appview-editor') || 
                              document.querySelector('.kix-scrollareadocumentplugin') ||
                              document.querySelector('#kix-appview');
      if (editorContainer && !(editorContainer as any).__rewordlyAttached) {
        console.log('Rewordly: Google Docs editor found via MutationObserver');
        this.container = editorContainer as HTMLElement;
        this.attachToEditor(this.container);
      }
    });
    
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    // Store observer for cleanup
    (this as any).mutationObserver = observer;
  }

  private attachToEditor(container: HTMLElement): void {
    if ((container as any).__rewordlyAttached) {
      return;
    }

    (container as any).__rewordlyAttached = true;

    if (!this.onGrammarCheck) {
      console.error('Rewordly: onGrammarCheck callback not provided');
      return;
    }

    // DocsAdapter'ı kullan (mevcut robust pipeline)
    this.docsAdapter = new DocsAdapter(container, this.onGrammarCheck);
    console.log('Rewordly: Google Docs adapter attached');
  }

  cleanup(): void {
    if (this.docsAdapter) {
      this.docsAdapter.cleanup();
      this.docsAdapter = null;
    }

    if ((this as any).mutationObserver) {
      (this as any).mutationObserver.disconnect();
      (this as any).mutationObserver = null;
    }

    if (this.container) {
      (this.container as any).__rewordlyAttached = false;
      this.container = null;
    }
  }

  findEditableElements(): HTMLElement[] {
    // Google Docs canvas-based olduğu için normal editable element yok
    // DocsAdapter kendi text extraction'ını yapıyor
    return this.container ? [this.container] : [];
  }

  extractText(_element: HTMLElement): string {
    // Google Docs için DocsAdapter kendi extraction'ını yapıyor
    // Bu metod genel kullanım için boş string döner
    return '';
  }

  renderHighlights(_element: HTMLElement, _errors: GrammarError[]): void {
    // Google Docs için DocsAdapter kendi highlight rendering'ini yapıyor
    // Bu metod boş bırakıldı
  }

  clearHighlights(_element: HTMLElement): void {
    // Google Docs için DocsAdapter kendi cleanup'ını yapıyor
    // Bu metod boş bırakıldı
  }
}

