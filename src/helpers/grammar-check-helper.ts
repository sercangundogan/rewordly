/**
 * Grammar Check Helper
 * Grammar kontrolü ve error yönetimi işlemleri
 * 
 * Bu dosya grammar check yapmak, error'ları göstermek ve dismiss etmekle ilgilenir.
 * Basitçe: Grammar check yap, error göster, dismiss et gibi.
 */

import { GrammarError, GrammarCheckResponse } from '../types';
import { RewordlyAPIUtil } from '../utils/api';
import { generateErrorId } from './config-helper';

/**
 * Grammar check API çağrısı yap
 */
export async function checkGrammarAPI(
  apiUtil: RewordlyAPIUtil,
  text: string
): Promise<GrammarCheckResponse> {
  try {
    const result = await apiUtil.checkGrammar(text, 'default');
    
    // Error'lara ID ekle
    const errorsWithId: GrammarError[] = result.errors.map((error) => ({
      id: generateErrorId(),
      start: error.start,
      end: error.end,
      word: error.word,
      suggestions: error.suggestions,
      type: error.type,
    }));
    
    return {
      errors: errorsWithId,
      corrected: result.corrected,
      ...(result.detectedLanguage && { detectedLanguage: result.detectedLanguage }),
    };
  } catch (error) {
    if (error instanceof Error && error.message === 'Request cancelled') {
      throw error;
    }
    console.error('Rewordly: WebSocket API request failed:', error);
    throw error;
  }
}

/**
 * Dismiss key oluştur
 * Error'ı dismiss etmek için benzersiz key
 */
export function getDismissKey(elementId: string, error: GrammarError, text: string): string {
  // Context ile birlikte key oluştur (position değişse bile çalışsın)
  const contextBefore = Math.max(0, error.start - 30);
  const contextAfter = Math.min(text.length, error.end + 30);
  const beforeText = text.substring(contextBefore, error.start).toLowerCase().trim();
  const afterText = text.substring(error.end, contextAfter).toLowerCase().trim();
  const wordText = error.word.toLowerCase().trim();
  
  return `${elementId}:${wordText}:${beforeText.slice(-20)}:${afterText.slice(0, 20)}`;
}

/**
 * Error dismissed mı kontrol et
 */
export function isErrorDismissed(
  elementId: string,
  error: GrammarError,
  text: string,
  dismissedErrors: Map<string, boolean>
): boolean {
  const dismissKey = getDismissKey(elementId, error, text);
  
  if (!dismissedErrors.has(dismissKey)) {
    return false;
  }
  
  // Word hala aynı mı kontrol et
  const currentWord = text.substring(error.start, error.end);
  const originalWord = error.word;
  
  if (currentWord.toLowerCase().trim() !== originalWord.toLowerCase().trim()) {
    // Word değişmiş, dismiss'i temizle
    dismissedErrors.delete(dismissKey);
    return false;
  }
  
  return true;
}

/**
 * Error'ı dismiss et
 */
export function dismissError(
  elementId: string,
  error: GrammarError,
  text: string,
  dismissedErrors: Map<string, boolean>
): void {
  const dismissKey = getDismissKey(elementId, error, text);
  dismissedErrors.set(dismissKey, true);
}

/**
 * Error'ın dismiss'ini kaldır
 */
export function undismissError(
  elementId: string,
  error: GrammarError,
  text: string,
  dismissedErrors: Map<string, boolean>
): void {
  const dismissKey = getDismissKey(elementId, error, text);
  dismissedErrors.delete(dismissKey);
}

/**
 * Filter dismissed errors
 */
export function filterDismissedErrors(
  elementId: string,
  errors: GrammarError[],
  text: string,
  dismissedErrors: Map<string, boolean>
): GrammarError[] {
  return errors.filter(error => !isErrorDismissed(elementId, error, text, dismissedErrors));
}

