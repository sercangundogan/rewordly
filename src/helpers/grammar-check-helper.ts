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
import { extractTextExcludingSignature } from "./text-processing-helper";

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

/**
 * Perform grammar check directly (optimized method with request cancellation)
 */
export async function performGrammarCheckDirect(
  element: HTMLElement,
  options: {
    apiUtil: RewordlyAPIUtil;
    activeGrammarRequests: Map<HTMLElement, string>;
    isGrammarCheckAllowedSite: () => boolean;
    isElementIgnored: (element: HTMLElement) => boolean;
    isPerformingReplace: boolean;
    displayGrammarErrors: (
      element: HTMLElement,
      errors: GrammarError[]
    ) => void;
  }
): Promise<void> {
  const {
    apiUtil,
    activeGrammarRequests,
    isGrammarCheckAllowedSite,
    isElementIgnored,
    isPerformingReplace,
    displayGrammarErrors,
  } = options;

  // Only perform grammar check on allowed sites
  if (!isGrammarCheckAllowedSite()) {
    return;
  }

  // Check if element is in ignore list
  if (isElementIgnored(element)) {
    return;
  }

  // Don't perform grammar check if we're currently performing a replace operation
  if (isPerformingReplace) {
    return;
  }

  // Extract text excluding signature blocks
  const { text, textSource } = extractTextExcludingSignature(element);

  // Skip if text is too short
  if (text.trim().length < 3) {
    return;
  }

  // Store text source for overlay creation
  (element as any).__rewordlyTextSource = textSource;
  (element as any).__rewordlyText = text;

  // Cancel previous request for this element if exists
  const previousRequestId = activeGrammarRequests.get(element);
  if (previousRequestId) {
    apiUtil.cancelRequest(previousRequestId);
    activeGrammarRequests.delete(element);
  }

  try {
    // Call WebSocket API with cancellation support
    const result = await apiUtil.checkGrammar(
      text,
      "default",
      previousRequestId
    );

    console.log("Rewordly: Grammar check result", {
      errorsCount: result.errors.length,
      errors: result.errors,
      text: text.substring(0, 50) + "...",
      textLength: text.length,
    });

    // Store the new request ID
    activeGrammarRequests.set(element, result.requestId);

    // Check if detected language is English
    // For short texts, language detection can be inaccurate, so we allow grammar checking
    // if the text contains English words or if language detection confidence is low
    const textLength = text.trim().length;
    const isShortText = textLength < 50; // Consider text short if less than 50 characters

    if (
      result.detectedLanguage &&
      !result.detectedLanguage.code.toLowerCase().startsWith("en")
    ) {
      // For short texts, be more lenient - allow grammar checking if text contains English words
      if (isShortText) {
        // Check if text contains common English words or patterns
        const englishPattern =
          /\b(the|and|or|but|in|on|at|to|for|of|with|by|from|as|is|are|was|were|be|been|have|has|had|do|does|did|will|would|should|could|can|may|might|this|that|these|those|a|an)\b/i;
        const hasEnglishWords = englishPattern.test(text);

        if (hasEnglishWords) {
          console.log(
            "Rewordly: Short text with English words, allowing grammar check despite language detection",
            {
              detectedLanguage: result.detectedLanguage,
              textLength,
            }
          );
          // Continue with grammar check even if language is not detected as English
        } else {
          console.log(
            "Rewordly: Language is not English and no English words detected",
            result.detectedLanguage
          );
          displayGrammarErrors(element, []);
          activeGrammarRequests.delete(element);
          return;
        }
      } else {
        // For longer texts, trust language detection
        console.log(
          "Rewordly: Language is not English",
          result.detectedLanguage
        );
        displayGrammarErrors(element, []);
        activeGrammarRequests.delete(element);
        return;
      }
    }

    // Map errors to include id field
    const errorsWithId: GrammarError[] = result.errors.map((error) => ({
      id: generateErrorId(),
      start: error.start,
      end: error.end,
      word: error.word,
      suggestions: error.suggestions,
      type: error.type,
    }));

    console.log("Rewordly: Mapped errors", {
      errorsWithId,
      textLength: text.length,
    });

    // Display errors (or clear if no errors)
    displayGrammarErrors(element, errorsWithId);
    activeGrammarRequests.delete(element);
  } catch (error) {
    // Don't log cancellation errors
    if (error instanceof Error && error.message === "Request cancelled") {
      return;
    }
    console.error("Rewordly: Grammar check error:", error);
    activeGrammarRequests.delete(element);
    // Clear highlights on error
    displayGrammarErrors(element, []);
  }
}

/**
 * Perform grammar check on an element (legacy method - kept for queue system)
 */
export async function performGrammarCheck(
  element: HTMLElement,
  options: {
    apiUtil: RewordlyAPIUtil;
    isGrammarCheckAllowedSite: () => boolean;
    isElementIgnored: (element: HTMLElement) => boolean;
    isPerformingReplace: boolean;
    displayGrammarErrors: (
      element: HTMLElement,
      errors: GrammarError[]
    ) => void;
  }
): Promise<void> {
  const {
    apiUtil,
    isGrammarCheckAllowedSite,
    isElementIgnored,
    isPerformingReplace,
    displayGrammarErrors,
  } = options;

  // Only perform grammar check on allowed sites (Twitter, Gmail, Reddit, Medium)
  if (!isGrammarCheckAllowedSite()) {
    return;
  }

  // Check if element is in ignore list
  if (isElementIgnored(element)) {
    return;
  }

  // Don't perform grammar check if we're currently performing a replace operation
  // This prevents race conditions where API returns old errors while we're updating positions
  if (isPerformingReplace) {
    return;
  }

  // Extract text excluding signature blocks
  const { text, textSource } = extractTextExcludingSignature(element);

  // Skip if text is too short
  if (text.trim().length < 3) {
    return;
  }

  // Store text source for overlay creation
  (element as any).__rewordlyTextSource = textSource;
  (element as any).__rewordlyText = text;

  try {
    // Call real API
    const response = await checkGrammarAPI(apiUtil, text);

    // Check if detected language is English
    if (
      response.detectedLanguage &&
      !response.detectedLanguage.code.toLowerCase().startsWith("en")
    ) {
      // Language is not English, clear all highlights and skip grammar check
      displayGrammarErrors(element, []);
      return;
    }

    // Display errors (or clear if no errors)
    displayGrammarErrors(element, response.errors);
  } catch (error) {
    console.error("Rewordly: Grammar check error:", error);
    // Fallback to mock if API fails (for development)
    try {
      const mockResponse = mockGrammarCheck(text);
      // Mock always assumes English, so we can proceed
      displayGrammarErrors(element, mockResponse.errors);
    } catch (mockError) {
      console.error("Rewordly: Mock grammar check also failed:", mockError);
      // Clear all highlights if both API and mock fail
      displayGrammarErrors(element, []);
    }
  }
}

/**
 * Add element to grammar check queue
 * @deprecated Using direct requests now, but kept for backward compatibility
 */
export function queueGrammarCheck(
  element: HTMLElement,
  priority: number,
  options: {
    isGrammarCheckAllowedSite: () => boolean;
    grammarCheckQueue: Array<{ element: HTMLElement; priority?: number }>;
    isProcessingQueue: { get: () => boolean; set: (value: boolean) => void };
    processGrammarCheckQueue: () => Promise<void>;
  }
): void {
  const {
    isGrammarCheckAllowedSite,
    grammarCheckQueue,
    isProcessingQueue,
    processGrammarCheckQueue,
  } = options;

  // Only queue grammar check on allowed sites (Twitter, Gmail, Reddit, Medium)
  if (!isGrammarCheckAllowedSite()) {
    return;
  }

  // Check if element is already in queue
  const existingIndex = grammarCheckQueue.findIndex(
    (item) => item.element === element
  );

  if (existingIndex !== -1) {
    // Update priority if new priority is higher
    const existingItem = grammarCheckQueue[existingIndex];
    if (existingItem && priority > (existingItem.priority || 0)) {
      existingItem.priority = priority;
    }
    return;
  }

  // Add to queue
  grammarCheckQueue.push({ element, priority });

  // Sort queue by priority (higher priority first)
  grammarCheckQueue.sort((a, b) => (b.priority || 0) - (a.priority || 0));

  // Start processing queue if not already processing
  if (!isProcessingQueue.get()) {
    processGrammarCheckQueue();
  }
}

/**
 * Process grammar check queue in batches
 * @deprecated Using direct requests now, but kept for backward compatibility
 */
export async function processGrammarCheckQueue(options: {
  grammarCheckQueue: Array<{ element: HTMLElement; priority?: number }>;
  isProcessingQueue: { get: () => boolean; set: (value: boolean) => void };
  performGrammarCheck: (element: HTMLElement) => Promise<void>;
  BATCH_SIZE: number;
  BATCH_DELAY: number;
}): Promise<void> {
  const {
    grammarCheckQueue,
    isProcessingQueue,
    performGrammarCheck,
    BATCH_SIZE,
    BATCH_DELAY,
  } = options;

  if (isProcessingQueue.get() || grammarCheckQueue.length === 0) {
    return;
  }

  isProcessingQueue.set(true);

  while (grammarCheckQueue.length > 0) {
    // Get next batch
    const batch = grammarCheckQueue.splice(0, BATCH_SIZE);

    // Process batch in parallel
    const promises = batch.map((item) => {
      // Check if element still exists and is valid
      if (!item.element || !item.element.isConnected) {
        return Promise.resolve();
      }
      return performGrammarCheck(item.element).catch((error: unknown) => {
        console.error("Rewordly: Grammar check error in queue:", error);
      });
    });

    // Wait for batch to complete
    await Promise.all(promises);

    // Wait before processing next batch (if there are more items)
    if (grammarCheckQueue.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY));
    }
  }

  isProcessingQueue.set(false);
}

/**
 * Check if element has existing text and perform grammar check when element is visible
 */
export function checkAndPerformGrammarCheckForExistingText(
  element: HTMLElement,
  options: {
    isGrammarCheckAllowedSite: () => boolean;
    config: { highlightsEnabled: boolean };
    queueGrammarCheck: (element: HTMLElement, priority: number) => void;
    isEditableElement: (element: HTMLElement) => boolean;
    isElementVisible: (element: HTMLElement) => boolean;
  }
): void {
  const {
    isGrammarCheckAllowedSite,
    config,
    queueGrammarCheck,
    isEditableElement,
    isElementVisible,
  } = options;

  // Only perform grammar check on allowed sites (Twitter, Gmail, Reddit, Medium)
  if (!isGrammarCheckAllowedSite()) {
    return;
  }

  if (!config.highlightsEnabled) {
    return;
  }

  // Check if element has text
  let hasText = false;
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement
  ) {
    hasText = element.value.trim().length >= 3;
  } else if (
    element.getAttribute("contenteditable") === "true" ||
    element.isContentEditable
  ) {
    hasText =
      (element.innerText || element.textContent || "").trim().length >= 3;
  }

  if (!hasText || !isEditableElement(element)) {
    return;
  }

  // Check if element is visible
  const isVisible = isElementVisible(element);

  if (isVisible) {
    // Element is visible, queue grammar check
    setTimeout(() => {
      if (isEditableElement(element)) {
        queueGrammarCheck(element, 0);
      }
    }, 300); // Small delay to ensure element is fully rendered
  } else {
    // Element is not visible yet, wait for it to become visible
    // Use IntersectionObserver to detect when element becomes visible
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && entry.intersectionRatio > 0) {
            // Element is now visible, queue grammar check
            setTimeout(() => {
              if (isEditableElement(element)) {
                queueGrammarCheck(element, 0);
              }
            }, 300);
            observer.disconnect();
          }
        });
      },
      {
        threshold: 0.1, // Trigger when at least 10% of element is visible
        rootMargin: "50px", // Start checking slightly before element enters viewport
      }
    );

    observer.observe(element);

    // Also try after a delay in case IntersectionObserver doesn't work
    setTimeout(() => {
      if (isElementVisible(element) && isEditableElement(element)) {
        queueGrammarCheck(element, 0);
      }
      observer.disconnect();
    }, 2000); // Fallback: try after 2 seconds
  }
}
