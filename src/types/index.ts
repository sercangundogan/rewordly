/**
 * Rewordly Common Types
 * Tüm platformlar için ortak tip tanımlamaları
 */

/**
 * Rewordly yapılandırma ayarları
 */
export interface RewordlyConfig {
  highlightsEnabled: boolean;
  rewriteEnabled: boolean;
}

/**
 * Grammar hatası - benzersiz ID ile takip edilir
 * ID, pozisyon güncellemeleri arasında kalıcıdır, böylece aynı kelimeler doğru şekilde işlenir
 */
export interface GrammarError {
  id: string; // Bu hata örneği için benzersiz tanımlayıcı (değiştirmeler arasında kalıcı)
  start: number; // Metindeki başlangıç pozisyonu (diğer değiştirmelerden sonra güncellenebilir)
  end: number; // Metindeki bitiş pozisyonu (diğer değiştirmelerden sonra güncellenebilir)
  word: string; // Hatalı kelime/ifade
  suggestions: string[]; // Düzeltme önerileri
  type: 'grammar' | 'spelling'; // Hata tipi
}

/**
 * Grammar kontrolü API yanıtı
 */
export interface GrammarCheckResponse {
  errors: GrammarError[];
  corrected: string;
  detectedLanguage?: {
    code: string;
    name: string;
  };
}

/**
 * Platform tanımlayıcısı
 */
export type Platform = 'google-docs' | 'reddit' | 'notion' | 'twitter' | 'gmail' | 'medium' | 'generic';

/**
 * Platform adapter interface'i
 * Tüm platform adapters bu interface'i implement etmeli
 */
export interface IPlatformAdapter {
  /**
   * Platform adı
   */
  readonly platform: Platform;

  /**
   * Bu platform için grammar check aktif mi?
   */
  isGrammarCheckEnabled(): boolean;

  /**
   * Platform'a özel başlatma
   */
  initialize(): void;

  /**
   * Platform'a özel temizleme
   */
  cleanup(): void;

  /**
   * Platform'a özel editable element bulma
   */
  findEditableElements(): HTMLElement[];

  /**
   * Platform'a özel text extraction
   */
  extractText(element: HTMLElement): string;

  /**
   * Platform'a özel highlight rendering
   */
  renderHighlights(element: HTMLElement, errors: GrammarError[]): void;

  /**
   * Platform'a özel highlight temizleme
   */
  clearHighlights(element: HTMLElement): void;
}

