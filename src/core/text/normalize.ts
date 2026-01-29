/**
 * Core Text Normalization
 *
 * Platform-agnostic text normalization utilities.
 * Used by the orchestrator before grammar checking.
 *
 * RULES:
 * - No DOM imports (must work in Node.js/test environments)
 * - Pure functions only
 * - All offsets reference normalized text
 */

/**
 * Normalize whitespace in text
 * - Collapses multiple spaces into single space
 * - Trims leading/trailing whitespace
 * - Preserves line breaks
 */
export function normalizeWhitespace(text: string): string {
  // Replace multiple spaces with single space
  // But preserve line breaks (newlines, carriage returns)
  return text
    .replace(/[ \t]+/g, " ") // Multiple spaces/tabs -> single space
    .replace(/^[ \t]+/gm, "") // Trim leading spaces/tabs from each line
    .replace(/[ \t]+$/gm, ""); // Trim trailing spaces/tabs from each line
}

/**
 * Normalize line breaks
 * - Converts all line break variations to \n
 * - Removes trailing line breaks
 */
export function normalizeLineBreaks(text: string): string {
  return text
    .replace(/\r\n/g, "\n") // Windows line breaks
    .replace(/\r/g, "\n") // Old Mac line breaks
    .replace(/\n+$/, ""); // Remove trailing newlines
}

/**
 * Remove invisible characters
 * - Removes zero-width spaces, non-breaking spaces (except regular ones)
 * - Removes other invisible Unicode characters that might interfere
 */
export function removeInvisibleCharacters(text: string): string {
  return text
    .replace(/[\u200B-\u200D\uFEFF]/g, "") // Zero-width spaces, zero-width joiner/non-joiner, BOM
    .replace(/\u00A0/g, " "); // Non-breaking space -> regular space
}

/**
 * Normalize text for grammar checking
 * Applies all normalization steps in the correct order
 *
 * @param text - Raw text to normalize
 * @returns Normalized text ready for grammar checking
 */
export function normalizeText(text: string): string {
  if (!text || typeof text !== "string") {
    return "";
  }

  // Apply normalization steps in order:
  // 1. Remove invisible characters first
  // 2. Normalize line breaks
  // 3. Normalize whitespace
  let normalized = removeInvisibleCharacters(text);
  normalized = normalizeLineBreaks(normalized);
  normalized = normalizeWhitespace(normalized);

  return normalized;
}



