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

/**
 * Mock grammar check API - returns grammar errors with positions
 * Used as fallback when API is unavailable
 */
export function mockGrammarCheck(text: string): GrammarCheckResponse {
  // Mock grammar check with multiple error types
  // This is a mock - in real implementation, this would call the API

  const errors: GrammarError[] = [];
  const lowerText = text.toLowerCase();

  // Find ALL occurrences of "goes" (not just the first one)
  let searchIndex = 0;
  while (true) {
    const goesIndex = lowerText.indexOf(" goes ", searchIndex);
    if (goesIndex === -1) break;

    const start = text.indexOf(" goes ", goesIndex);
    if (start !== -1) {
      errors.push({
        id: generateErrorId(),
        start: start + 1,
        end: start + 5,
        word: "goes",
        suggestions: ["went", "go"],
        type: "grammar",
      });
    }
    searchIndex = goesIndex + 1;
  }

  // Find ALL occurrences of "buyed"
  searchIndex = 0;
  while (true) {
    const buyedIndex = lowerText.indexOf("buyed", searchIndex);
    if (buyedIndex === -1) break;

    errors.push({
      id: generateErrorId(),
      start: buyedIndex,
      end: buyedIndex + 5,
      word: "buyed",
      suggestions: ["bought", "buy"],
      type: "grammar",
    });
    searchIndex = buyedIndex + 1;
  }

  // Find ALL occurrences of "have" with singular subject
  searchIndex = 0;
  while (true) {
    const haveIndex = lowerText.indexOf(" have ", searchIndex);
    if (haveIndex === -1) break;

    if (haveIndex > 0) {
      const beforeHave = text
        .substring(Math.max(0, haveIndex - 20), haveIndex)
        .trim();
      const wordsBefore = beforeHave.split(/\s+/);
      const lastWord = wordsBefore[wordsBefore.length - 1];
      if (
        lastWord &&
        !lastWord.toLowerCase().endsWith("s") &&
        lastWord.toLowerCase() !== "they" &&
        lastWord.toLowerCase() !== "we" &&
        lastWord.toLowerCase() !== "you" &&
        lastWord.toLowerCase() !== "i"
      ) {
        const start = text.indexOf(" have ", haveIndex);
        if (start !== -1) {
          errors.push({
            id: generateErrorId(),
            start: start + 1,
            end: start + 5,
            word: "have",
            suggestions: ["has", "have"],
            type: "grammar",
          });
        }
      }
    }
    searchIndex = haveIndex + 1;
  }

  // Find ALL occurrences of "was" with plural subject
  searchIndex = 0;
  while (true) {
    const wasIndex = lowerText.indexOf(" was ", searchIndex);
    if (wasIndex === -1) break;

    if (wasIndex > 0) {
      const beforeWas = text
        .substring(Math.max(0, wasIndex - 10), wasIndex)
        .trim();
      const wordsBefore = beforeWas.split(/\s+/);
      const lastWord = wordsBefore[wordsBefore.length - 1];
      if (
        lastWord &&
        (lastWord.toLowerCase() === "they" ||
          lastWord.toLowerCase() === "we" ||
          lastWord.toLowerCase() === "you")
      ) {
        const start = text.indexOf(" was ", wasIndex);
        if (start !== -1) {
          errors.push({
            id: generateErrorId(),
            start: start + 1,
            end: start + 4,
            word: "was",
            suggestions: ["were", "was"],
            type: "grammar",
          });
        }
      }
    }
    searchIndex = wasIndex + 1;
  }

  // Find ALL occurrences of "do" with singular subject (e.g., "he do")
  searchIndex = 0;
  while (true) {
    const doIndex = lowerText.indexOf(" do ", searchIndex);
    if (doIndex === -1) break;

    if (doIndex > 0) {
      const beforeDo = text
        .substring(Math.max(0, doIndex - 10), doIndex)
        .trim();
      const wordsBefore = beforeDo.split(/\s+/);
      const lastWord = wordsBefore[wordsBefore.length - 1];
      if (
        lastWord &&
        (lastWord.toLowerCase() === "he" ||
          lastWord.toLowerCase() === "she" ||
          lastWord.toLowerCase() === "it")
      ) {
        const start = text.indexOf(" do ", doIndex);
        if (start !== -1) {
          errors.push({
            id: generateErrorId(),
            start: start + 1,
            end: start + 3,
            word: "do",
            suggestions: ["does", "do"],
            type: "grammar",
          });
        }
      }
    }
    searchIndex = doIndex + 1;
  }

  // Find ALL occurrences of "are" with singular subject (e.g., "he are")
  searchIndex = 0;
  while (true) {
    const areIndex = lowerText.indexOf(" are ", searchIndex);
    if (areIndex === -1) break;

    if (areIndex > 0) {
      const beforeAre = text
        .substring(Math.max(0, areIndex - 10), areIndex)
        .trim();
      const wordsBefore = beforeAre.split(/\s+/);
      const lastWord = wordsBefore[wordsBefore.length - 1];
      if (
        lastWord &&
        (lastWord.toLowerCase() === "he" ||
          lastWord.toLowerCase() === "she" ||
          lastWord.toLowerCase() === "it")
      ) {
        const start = text.indexOf(" are ", areIndex);
        if (start !== -1) {
          errors.push({
            id: generateErrorId(),
            start: start + 1,
            end: start + 4,
            word: "are",
            suggestions: ["is", "are"],
            type: "grammar",
          });
        }
      }
    }
    searchIndex = areIndex + 1;
  }

  // Remove duplicate errors (same position)
  const uniqueErrors = errors.filter(
    (error, index, self) =>
      index ===
      self.findIndex((e) => e.start === error.start && e.end === error.end)
  );

  // Generate corrected text
  let corrected = text;
  // Sort errors by position (reverse order to maintain indices)
  const sortedErrors = [...uniqueErrors].sort((a, b) => b.start - a.start);
  for (const error of sortedErrors) {
    if (error.suggestions.length > 0) {
      const before = corrected.substring(0, error.start);
      const after = corrected.substring(error.end);
      corrected = before + error.suggestions[0] + after;
    }
  }

  return {
    errors: uniqueErrors,
    corrected,
  };
}
