/**
 * Grammar Check Helper
 * Grammar kontrolü ve error yönetimi işlemleri
 *
 * Bu dosya grammar check yapmak, error'ları göstermek ve dismiss etmekle ilgilenir.
 * Basitçe: Grammar check yap, error göster, dismiss et gibi.
 */

import { GrammarError, GrammarCheckResponse } from "../types";
import { RewordlyAPIUtil } from "../utils/api";
import { generateErrorId } from "./config-helper";

/**
 * Grammar check API çağrısı yap
 */
export async function checkGrammarAPI(
  apiUtil: RewordlyAPIUtil,
  text: string
): Promise<GrammarCheckResponse> {
  try {
    const result = await apiUtil.checkGrammar(text, "default");

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
      ...(result.detectedLanguage && {
        detectedLanguage: result.detectedLanguage,
      }),
    };
  } catch (error) {
    if (error instanceof Error && error.message === "Request cancelled") {
      throw error;
    }
    console.error("Rewordly: WebSocket API request failed:", error);
    throw error;
  }
}

/**
 * Dismiss key oluştur
 * Error'ı dismiss etmek için benzersiz key
 * Content.ts versiyonu ile uyumlu - 10 karakter context kullanır
 */
export function getDismissKey(
  elementId: string,
  error: GrammarError,
  text: string
): string {
  const wordLower = error.word.toLowerCase().trim();
  const beforeContext = text
    .substring(Math.max(0, error.start - 10), error.start)
    .toLowerCase()
    .trim();
  const afterContext = text
    .substring(error.end, Math.min(text.length, error.end + 10))
    .toLowerCase()
    .trim();

  return `${elementId}:${wordLower}:${beforeContext}:${afterContext}`;
}

/**
 * Error dismissed mı kontrol et
 * Content.ts versiyonu ile uyumlu - context matching ile çalışır
 */
export function isErrorDismissed(
  elementId: string,
  error: GrammarError,
  text: string,
  dismissedErrors: Map<string, boolean>
): boolean {
  // Get current text to verify position is still valid
  // If position is invalid, try to find the word by matching context from dismiss keys
  // This handles cases where text was added/removed above the error
  if (error.start < 0 || error.end > text.length || error.start >= error.end) {
    const wordLower = error.word.toLowerCase().trim();
    const elementIdPrefix = `${elementId}:${wordLower}:`;
    const searchText = text.toLowerCase();
    let foundMatch = false;

    // Check all dismiss keys for this element and word
    for (const [dismissKey, _] of dismissedErrors.entries()) {
      if (!dismissKey.startsWith(elementIdPrefix)) continue;

      // Extract context from dismiss key (format: elementId:word:before:after)
      // Note: context may contain colons, so we need to be careful
      const afterPrefix = dismissKey.substring(elementIdPrefix.length);
      const lastColonIndex = afterPrefix.lastIndexOf(":");
      if (lastColonIndex === -1) continue;

      const beforeContext = afterPrefix.substring(0, lastColonIndex);
      const afterContext = afterPrefix.substring(lastColonIndex + 1);

      // Search for word with matching context
      let searchIndex = 0;
      while (true) {
        const wordIndex = searchText.indexOf(wordLower, searchIndex);
        if (wordIndex === -1) break;

        // Check context before and after
        const beforeText = searchText
          .substring(Math.max(0, wordIndex - beforeContext.length), wordIndex)
          .toLowerCase();
        const afterText = searchText
          .substring(
            wordIndex + wordLower.length,
            Math.min(
              text.length,
              wordIndex + wordLower.length + afterContext.length
            )
          )
          .toLowerCase();

        if (beforeText === beforeContext && afterText === afterContext) {
          foundMatch = true;
          break;
        }

        searchIndex = wordIndex + 1;
      }

      if (foundMatch) break;
    }

    if (
      !foundMatch ||
      error.start < 0 ||
      error.end > text.length ||
      error.start >= error.end
    ) {
      return false;
    }
  }

  // Generate dismiss key using word + context (not position)
  const dismissKey = getDismissKey(elementId, error, text);

  if (!dismissedErrors.has(dismissKey)) {
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
  return errors.filter(
    (error) => !isErrorDismissed(elementId, error, text, dismissedErrors)
  );
}

/**
 * Check if element is ignored (should not have grammar checking)
 */
export function isElementIgnored(
  elementId: string,
  ignoredElementIds: Set<string>
): boolean {
  return ignoredElementIds.has(elementId);
}
