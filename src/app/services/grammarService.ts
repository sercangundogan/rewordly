/**
 * Grammar Service
 * 
 * App-level service for grammar checking.
 * Handles API calls, error mapping, and language filtering.
 * 
 * This service is shared across all platforms - no duplication.
 */

import { DocumentSnapshot, Issue } from "../../core/contracts";
import { RewordlyAPIUtil, createRewordlyAPIUtil } from "../../utils/api";

// Singleton API util instance
let apiUtilInstance: RewordlyAPIUtil | null = null;

/**
 * Get or create the API util instance
 */
function getAPIUtil(): RewordlyAPIUtil {
  if (!apiUtilInstance) {
    apiUtilInstance = createRewordlyAPIUtil();
  }
  return apiUtilInstance;
}

/**
 * Generate a unique error ID
 */
let errorIdCounter = 0;
function generateErrorId(): string {
  return `error-${Date.now()}-${errorIdCounter++}`;
}

/**
 * Check grammar for a document snapshot
 * 
 * @param snapshot - Document snapshot to check
 * @returns Promise<Issue[]> - Array of grammar/spelling issues
 */
export async function checkGrammar(
  snapshot: DocumentSnapshot
): Promise<Issue[]> {
  const apiUtil = getAPIUtil();

  try {
    // Call WebSocket API
    const result = await apiUtil.checkGrammar(snapshot.text, "default");

    // Filter by language: only English
    // For short texts, language detection can be inaccurate, so we allow grammar checking
    // if the text contains English words or if language detection confidence is low
    const textLength = snapshot.text.trim().length;
    const isShortText = textLength < 50;

    if (
      result.detectedLanguage &&
      !result.detectedLanguage.code.toLowerCase().startsWith("en")
    ) {
      // For short texts, be more lenient - allow grammar checking if text contains English words
      if (isShortText) {
        // Check if text contains English words (basic heuristic)
        const hasEnglishWords = /[a-zA-Z]{3,}/.test(snapshot.text);
        if (!hasEnglishWords) {
          // No English words detected, skip grammar check
          return [];
        }
      } else {
        // For longer texts, strict language check
        return [];
      }
    }

    // Map GrammarError[] to Issue[]
    const issues: Issue[] = result.errors.map((error) => ({
      id: generateErrorId(),
      start: error.start,
      end: error.end,
      word: error.word,
      suggestions: error.suggestions,
      type: error.type,
      snapshotVersion: snapshot.version,
    }));

    return issues;
  } catch (error) {
    // Don't log cancellation errors
    if (error instanceof Error && error.message === "Request cancelled") {
      throw error;
    }

    console.error("[REWORDLY] Grammar check error:", error);
    
    // Return empty array on error (fail gracefully)
    // The orchestrator will handle retries if needed
    return [];
  }
}




