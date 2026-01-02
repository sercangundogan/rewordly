/**
 * Text Replacement Helper
 * Text replacement işlemleri için yardımcı fonksiyonlar
 *
 * Bu dosya farklı editor tiplerinde (Draft.js, Lexical, Slate.js, Notion, etc.)
 * text replacement yapmakla ilgilenir.
 */

import { mapInnerTextToTextNodes } from "./text-processing-helper";
import { isNodeInDocument, getElementId } from "./element-helper";
import { GrammarError } from "../types";
import { getErrorTextRects } from "./highlight-helper";
import { closeAllGrammarTooltips } from "./highlight-helper";
import { HighlightContainerHelper } from "./highlight-helper";

/**
 * Replace text in Draft.js editor (Twitter)
 * Uses execCommand for reliable text replacement that Draft.js recognizes
 */
export function replaceTextInDraftJS(
  element: HTMLElement,
  start: number,
  end: number,
  replacement: string
): boolean {
  const selection = window.getSelection();
  if (!selection) {
    console.error("Rewordly: No selection available for Draft.js replacement");
    return false;
  }

  // CRITICAL: Clear any existing selection before starting replacement
  // This prevents replacement from happening at user-selected text locations
  selection.removeAllRanges();

  // Focus the element first to ensure Draft.js is ready
  element.focus();

  // CRITICAL: Clear selection again after focus, as focus might restore a selection
  selection.removeAllRanges();

  // Helper function to attempt replacement with retry
  const attemptReplacement = (retryCount: number = 0): boolean => {
    const maxRetries = 5;

    try {
      // Map innerText positions to text node positions
      const mapping = mapInnerTextToTextNodes(element, start, end);

      if (!mapping || !mapping.startNode) {
        if (retryCount < maxRetries) {
          // Wait a bit and retry - Draft.js DOM might be updating
          setTimeout(
            () => attemptReplacement(retryCount + 1),
            100 * (retryCount + 1)
          );
          return false;
        }
        console.error(
          "Rewordly: Could not map innerText positions to text nodes in Draft.js",
          { start, end, retryCount }
        );
        return false;
      }

      // Validate nodes are in document
      if (
        !isNodeInDocument(mapping.startNode) ||
        (mapping.endNode && !isNodeInDocument(mapping.endNode))
      ) {
        if (retryCount < maxRetries) {
          setTimeout(
            () => attemptReplacement(retryCount + 1),
            100 * (retryCount + 1)
          );
          return false;
        }
        console.warn(
          "Rewordly: Text nodes are not in document anymore (Draft.js DOM changed)",
          { retryCount }
        );
        return false;
      }

      // Create range for selection
      const range = document.createRange();

      if (mapping.endNode && mapping.startNode !== mapping.endNode) {
        // Error spans multiple text nodes
        const startNodeLength = mapping.startNode.textContent!.length;
        const endNodeLength = mapping.endNode.textContent!.length;

        range.setStart(
          mapping.startNode,
          Math.min(mapping.startOffset, startNodeLength)
        );
        range.setEnd(
          mapping.endNode,
          Math.min(mapping.endOffset, endNodeLength)
        );
      } else {
        // Error is within a single text node
        const startNodeLength = mapping.startNode.textContent!.length;
        const endPos = Math.min(mapping.endOffset, startNodeLength);

        range.setStart(
          mapping.startNode,
          Math.min(mapping.startOffset, startNodeLength)
        );
        range.setEnd(mapping.startNode, endPos);
      }

      // Set selection to the range
      try {
        selection.removeAllRanges();
        selection.addRange(range);

        // CRITICAL: Verify selection is set correctly before execCommand
        // Double-check that we have exactly one range and it's the one we want
        if (selection.rangeCount !== 1) {
          selection.removeAllRanges();
          selection.addRange(range);
        }

        // CRITICAL: Verify the range matches what we expect
        // Check that the selection is actually on the target range, not somewhere else
        if (selection.rangeCount > 0) {
          const currentRange = selection.getRangeAt(0);
          // Compare range boundaries to ensure we're selecting the right text
          if (
            currentRange.startContainer !== range.startContainer ||
            currentRange.startOffset !== range.startOffset ||
            currentRange.endContainer !== range.endContainer ||
            currentRange.endOffset !== range.endOffset
          ) {
            // Selection doesn't match - reset it
            selection.removeAllRanges();
            selection.addRange(range);
          }
        }
      } catch (e) {
        if (retryCount < maxRetries) {
          setTimeout(
            () => attemptReplacement(retryCount + 1),
            100 * (retryCount + 1)
          );
          return false;
        }
        console.error("Rewordly: Could not set selection in Draft.js", e);
        return false;
      }

      // CRITICAL: Clear ALL selections one more time RIGHT BEFORE execCommand
      // This is the final safeguard - some editors may restore selections at the last moment
      selection.removeAllRanges();
      selection.addRange(range);

      // Final verification - ensure we have exactly the range we want
      if (selection.rangeCount !== 1) {
        selection.removeAllRanges();
        selection.addRange(range);
      }

      // Use execCommand('insertText') - this is the most reliable way for Draft.js
      // Draft.js listens to execCommand and updates its internal state correctly
      const success = document.execCommand("insertText", false, replacement);

      if (!success) {
        // Fallback: manual DOM manipulation with proper events
        console.warn("Rewordly: execCommand failed, using fallback method");

        // Delete selected content
        try {
          range.deleteContents();
        } catch (e) {
          if (retryCount < maxRetries) {
            setTimeout(
              () => attemptReplacement(retryCount + 1),
              100 * (retryCount + 1)
            );
            return false;
          }
          console.error("Rewordly: Could not delete contents in Draft.js", e);
          return false;
        }

        // Insert replacement text
        const textNode = document.createTextNode(replacement);
        try {
          range.insertNode(textNode);

          // Move cursor after inserted text
          range.setStartAfter(textNode);
          range.collapse(true);
          selection.removeAllRanges();
          selection.addRange(range);
        } catch (e) {
          console.warn(
            "Rewordly: Could not position cursor after insertion",
            e
          );
        }

        // Trigger beforeinput event (Draft.js listens to this)
        const beforeInputEvent = new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          inputType: "insertText",
          data: replacement,
        });
        (beforeInputEvent as any).__rewordlyProgrammatic = true;
        element.dispatchEvent(beforeInputEvent);

        // Trigger input event (Draft.js uses this to update state)
        const inputEvent = new InputEvent("input", {
          bubbles: true,
          cancelable: false,
          inputType: "insertText",
          data: replacement,
        });
        (inputEvent as any).__rewordlyProgrammatic = true;
        element.dispatchEvent(inputEvent);
      }

      return true; // Success
    } catch (err) {
      if (retryCount < maxRetries) {
        setTimeout(
          () => attemptReplacement(retryCount + 1),
          100 * (retryCount + 1)
        );
        return false;
      }
      console.error("Rewordly: Error replacing text in Draft.js:", err);
      console.error("Rewordly: Error details:", { start, end, retryCount });
      return false;
    }
  };

  // Start the replacement attempt
  return attemptReplacement(0);
}

/**
 * Replace text in Lexical editor (Reddit) or regular contenteditable
 * Uses execCommand to ensure Lexical's internal state is properly updated
 */
export function replaceTextInContentEditable(
  element: HTMLElement,
  start: number,
  end: number,
  replacement: string,
  useExecCommand: boolean = false
): void {
  const selection = window.getSelection();
  if (!selection) {
    console.error("Rewordly: No selection available for Lexical replacement");
    return;
  }

  // CRITICAL: Clear any existing selection before starting replacement
  // This prevents replacement from happening at user-selected text locations
  selection.removeAllRanges();

  // Map innerText positions to text node positions
  const mapping = mapInnerTextToTextNodes(element, start, end);

  if (!mapping || !mapping.startNode) {
    console.error(
      "Rewordly: Could not map innerText positions to text nodes in Lexical",
      { start, end }
    );
    return;
  }

  try {
    // Focus the element first to ensure Lexical is ready
    element.focus();

    // CRITICAL: Clear selection again after focus, as focus might restore a selection
    selection.removeAllRanges();

    // Create range for the text to replace
    const range = document.createRange();

    // Validate positions
    const startNodeLength = mapping.startNode.textContent!.length;
    if (mapping.startOffset < 0 || mapping.startOffset > startNodeLength) {
      console.error("Rewordly: Invalid start offset in Lexical text node", {
        startOffset: mapping.startOffset,
        nodeLength: startNodeLength,
        globalStart: start,
      });
      return;
    }

    if (mapping.endNode && mapping.startNode !== mapping.endNode) {
      // Error spans multiple text nodes
      const endNodeLength = mapping.endNode.textContent!.length;
      if (mapping.endOffset < 0 || mapping.endOffset > endNodeLength) {
        console.error("Rewordly: Invalid end offset in Lexical text node", {
          endOffset: mapping.endOffset,
          nodeLength: endNodeLength,
          globalEnd: end,
        });
        return;
      }

      range.setStart(
        mapping.startNode,
        Math.min(mapping.startOffset, startNodeLength)
      );
      range.setEnd(mapping.endNode, Math.min(mapping.endOffset, endNodeLength));
    } else {
      // Error is within a single text node
      const endPos = mapping.endOffset;

      if (endPos > startNodeLength) {
        console.error("Rewordly: Invalid end position in Lexical text node", {
          startOffset: mapping.startOffset,
          endPos,
          nodeLength: startNodeLength,
          globalStart: start,
          globalEnd: end,
        });
        return;
      }

      range.setStart(mapping.startNode, mapping.startOffset);
      range.setEnd(mapping.startNode, endPos);
    }

    // Set selection to the range
    selection.removeAllRanges();
    selection.addRange(range);

    // CRITICAL: Verify selection is set correctly before execCommand
    // Double-check that we have exactly one range and it's the one we want
    if (selection.rangeCount !== 1) {
      selection.removeAllRanges();
      selection.addRange(range);
    }

    // CRITICAL: Verify the range matches what we expect
    // Check that the selection is actually on the target range, not somewhere else
    if (selection.rangeCount > 0) {
      const currentRange = selection.getRangeAt(0);
      // Compare range boundaries to ensure we're selecting the right text
      if (
        currentRange.startContainer !== range.startContainer ||
        currentRange.startOffset !== range.startOffset ||
        currentRange.endContainer !== range.endContainer ||
        currentRange.endOffset !== range.endOffset
      ) {
        // Selection doesn't match - reset it
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }

    if (useExecCommand) {
      // CRITICAL: Clear ALL selections in the entire document before execCommand
      // This is the key fix - we must clear selections everywhere, not just in our element
      const allSelections = document.getSelection();
      if (allSelections) {
        allSelections.removeAllRanges();
      }

      // Also clear selection in any iframes that might be present
      try {
        const iframes = document.querySelectorAll("iframe");
        iframes.forEach((iframe) => {
          try {
            const iframeDoc =
              iframe.contentDocument || iframe.contentWindow?.document;
            if (iframeDoc) {
              const iframeSelection = iframeDoc.getSelection();
              if (iframeSelection) {
                iframeSelection.removeAllRanges();
              }
            }
          } catch (e) {
            // Cross-origin iframe - ignore
          }
        });
      } catch (e) {
        // Ignore iframe errors
      }

      // Now set ONLY our target range
      selection.removeAllRanges();
      selection.addRange(range);

      // Final verification - ensure we have exactly the range we want
      if (selection.rangeCount !== 1) {
        selection.removeAllRanges();
        selection.addRange(range);
      }

      // Use execCommand to replace text - this ensures Lexical's internal state is updated correctly
      // Lexical listens to execCommand and updates its internal state accordingly
      const success = document.execCommand("insertText", false, replacement);

      // CRITICAL: Immediately clear selection after execCommand to prevent any side effects
      selection.removeAllRanges();

      if (!success) {
        // Fallback: try using beforeinput/input events
        console.warn("Rewordly: execCommand failed, trying fallback method");

        // Delete the selected content first
        range.deleteContents();

        // Insert the replacement text
        const textNode = document.createTextNode(replacement);
        range.insertNode(textNode);

        // Move cursor after the inserted text
        range.setStartAfter(textNode);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);

        // Trigger input events to notify editor
        const beforeInputEvent = new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          inputType: "insertText",
          data: replacement,
        });
        (beforeInputEvent as any).__rewordlyProgrammatic = true;
        element.dispatchEvent(beforeInputEvent);

        const inputEvent = new InputEvent("input", {
          bubbles: true,
          cancelable: false,
          inputType: "insertText",
          data: replacement,
        });
        (inputEvent as any).__rewordlyProgrammatic = true;
        element.dispatchEvent(inputEvent);
      }
    } else {
      // Standard replacement for simple contenteditable (Gmail, etc.)
      range.deleteContents();
      range.insertNode(document.createTextNode(replacement));

      // Normalize to merge adjacent text nodes
      element.normalize();

      // Move cursor to end of replacement
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }

    // Clear selection
    selection.removeAllRanges();
  } catch (err) {
    console.error("Rewordly: Error replacing text in Lexical:", err);
    console.error("Rewordly: Error details:", {
      start,
      end,
      mapping,
    });
  }
}

/**
 * Replace a grammar error in an element with the provided replacement text
 * Handles different editor types (input/textarea, Lexical, Draft.js, Slate.js, Notion, contenteditable)
 */
export function replaceGrammarError(
  element: HTMLElement,
  targetError: GrammarError,
  replacement: string,
  options: {
    grammarErrors: Map<HTMLElement, GrammarError[]>;
    highlightsContent: HTMLElement | null;
    isPerformingReplace: { get: () => boolean; set: (value: boolean) => void };
    highlightHelper: HighlightContainerHelper;
    scheduledBlurHandlers: Map<HTMLElement, number>;
    performGrammarCheck: (element: HTMLElement) => Promise<void>;
  }
): void {
  if (!targetError || !targetError.id) {
    console.error("Rewordly: Invalid error provided", targetError);
    return;
  }

  const errorId = targetError.id;
  const {
    grammarErrors,
    highlightsContent,
    isPerformingReplace,
    highlightHelper,
    scheduledBlurHandlers,
    performGrammarCheck,
  } = options;

  // Close all tooltips before replacement
  closeAllGrammarTooltips();

  // CRITICAL: Clear any existing text selection before replacement
  // This prevents replacement from happening at both the highlight location AND any user-selected text
  // Clear ALL selections in the document, not just the current one
  const selection = window.getSelection();
  if (selection) {
    selection.removeAllRanges();
  }

  // CRITICAL: Also try to clear Lexical's internal selection if it exists
  // Lexical may maintain its own selection state that we need to clear
  try {
    // Check if Lexical's selection API is available
    const lexicalEditor = (element as any).__lexicalEditor;
    if (lexicalEditor) {
      const lexicalState = lexicalEditor.getEditorState();
      if (lexicalState && lexicalState._selection) {
        // Try to clear Lexical's selection by setting it to null
        lexicalEditor.update(() => {
          const root = lexicalEditor.getRootElement();
          if (root) {
            root.focus();
          }
        });
      }
    }
  } catch (e) {
    // Lexical API not available or error - ignore
  }

  // CRITICAL: Force clear selection one more time after potential Lexical operations
  if (selection) {
    selection.removeAllRanges();
  }

  // Get current errors for position updates
  const currentErrors = grammarErrors.get(element) || [];

  // Use the error's positions (they are always up-to-date if from grammarErrors,
  // but might be outdated if from highlight - we'll validate below)
  let actualStart = targetError.start;
  let actualEnd = targetError.end;

  // Validate positions against current text length
  let currentText = "";
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement
  ) {
    currentText = element.value;
  } else if (
    element.getAttribute("contenteditable") === "true" ||
    element.isContentEditable
  ) {
    currentText = element.innerText || element.textContent || "";
  }

  // Validate positions
  if (
    actualStart < 0 ||
    actualEnd > currentText.length ||
    actualStart >= actualEnd
  ) {
    // If positions are invalid, try to find the word in current text as fallback
    if (targetError.word) {
      // Try to find the word near the original position (within 50 chars)
      const searchStart = Math.max(
        0,
        Math.min(actualStart, currentText.length - 1)
      );
      const wordIndex = currentText.indexOf(
        targetError.word,
        Math.max(0, searchStart - 50)
      );
      if (wordIndex !== -1) {
        actualStart = wordIndex;
        actualEnd = wordIndex + targetError.word.length;
        console.warn(
          "Rewordly: Recalculated error positions (original positions were invalid)",
          {
            errorId,
            oldStart: targetError.start,
            oldEnd: targetError.end,
            newStart: actualStart,
            newEnd: actualEnd,
            word: targetError.word,
          }
        );
      } else {
        console.error(
          "Rewordly: Invalid error positions and word not found in text",
          {
            actualStart,
            actualEnd,
            textLength: currentText.length,
            errorId: targetError.id,
            word: targetError.word,
          }
        );
        return;
      }
    } else {
      console.error(
        "Rewordly: Invalid error positions and no word to search for",
        {
          actualStart,
          actualEnd,
          textLength: currentText.length,
          errorId: targetError.id,
        }
      );
      return;
    }
  }

  // Update stored errors - remove the replaced error by ID
  const updatedErrors = currentErrors.filter((err) => err.id !== errorId);
  grammarErrors.set(element, updatedErrors);

  // Remove only the replaced error's highlight (not all highlights) - match by ID
  // Do this AFTER updating grammarErrors to ensure consistency
  if (highlightsContent) {
    const elementId = getElementId(element);
    const highlights = highlightsContent.querySelectorAll(
      `[data-element-id="${elementId}"]`
    );
    highlights.forEach((highlight) => {
      const highlightErrorId = (highlight as HTMLElement).getAttribute(
        "data-error-id"
      );
      if (highlightErrorId === errorId) {
        highlight.remove();
      }
    });
  }

  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement
  ) {
    // For input/textarea
    // Set flag to prevent blur handler from hiding highlights during replace
    isPerformingReplace.set(true);

    const text = element.value;
    const newText =
      text.substring(0, actualStart) + replacement + text.substring(actualEnd);
    const replacementLength = replacement.length;
    const originalLength = actualEnd - actualStart;
    const lengthDiff = replacementLength - originalLength;

    element.value = newText;

    // Update error positions for remaining errors (they may have shifted)
    const updatedErrorsAfterReplace = updatedErrors.map((err) => {
      // If error is after the replaced text, adjust its position
      if (err.start > actualEnd) {
        return {
          ...err,
          start: err.start + lengthDiff,
          end: err.end + lengthDiff,
        };
      }
      // If error overlaps with replaced text, it's already removed
      return err;
    });
    grammarErrors.set(element, updatedErrorsAfterReplace);

    // Update all highlight data-error attributes with new positions - match by ID
    // This ensures all highlights have the most up-to-date error data
    // IMPORTANT: Do this BEFORE updateHighlightsPosition to ensure highlights have correct data
    if (highlightsContent) {
      const elementId = getElementId(element);
      const highlights = highlightsContent.querySelectorAll(
        `[data-element-id="${elementId}"]`
      );
      highlights.forEach((highlight) => {
        const highlightErrorId = (highlight as HTMLElement).getAttribute(
          "data-error-id"
        );
        if (!highlightErrorId) return;

        // Find the updated error by ID (guaranteed unique match)
        const updatedError = updatedErrorsAfterReplace.find(
          (err) => err.id === highlightErrorId
        );

        if (updatedError) {
          // Update data-error attribute with new positions (ID remains the same)
          (highlight as HTMLElement).setAttribute(
            "data-error",
            JSON.stringify(updatedError)
          );
        } else {
          // This error was removed, highlight should already be removed
          // But remove it here as safety measure
          highlight.remove();
        }
      });
    }

    // Update highlight positions after DOM has updated (for proper text wrapping calculation)
    // Use multiple requestAnimationFrame calls to ensure text wrapping is recalculated after replace
    // This will also update data-error attributes again, ensuring consistency
    // IMPORTANT: Use multiple delayed updates to ensure DOM has fully settled, especially for last-line highlights
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        highlightHelper.updatePositions(
          element,
          updatedErrorsAfterReplace,
          (error: GrammarError) =>
            getErrorTextRects(element, error.start, error.end)
        );

        // Additional update after a short delay to catch any delayed DOM changes
        setTimeout(() => {
          highlightHelper.updatePositions(
            element,
            updatedErrorsAfterReplace,
            (error: GrammarError) =>
              getErrorTextRects(element, error.start, error.end)
          );
        }, 100);
      });
    });

    // Cancel any scheduled blur handlers for this element
    const existingBlurTimeout = scheduledBlurHandlers.get(element);
    if (existingBlurTimeout) {
      clearTimeout(existingBlurTimeout);
      scheduledBlurHandlers.delete(element);
    }

    // Restore focus and set cursor position after replacement
    // Calculate new cursor position (after the replaced text)
    const newCursorPosition = actualStart + replacement.length;

    // Use requestAnimationFrame to ensure DOM is ready before focusing
    requestAnimationFrame(() => {
      // Keep flag true during focus restore to prevent blur handler from hiding highlights
      isPerformingReplace.set(true);

      element.focus();
      // Set cursor position to the end of the replacement
      element.setSelectionRange(newCursorPosition, newCursorPosition);

      // Clear the replace flag after a short delay to ensure focus is stable
      setTimeout(() => {
        isPerformingReplace.set(false);
        // Trigger grammar check after replace is complete
        performGrammarCheck(element).catch((error: unknown) => {
          console.error(
            "Rewordly: Error performing grammar check after replace:",
            error
          );
        });
      }, 150);

      // Trigger input event (this will reset timeout but won't clear errors)
      const inputEvent = new Event("input", { bubbles: true });
      // Mark as programmatic to prevent handleInput from processing it
      (inputEvent as any).__rewordlyProgrammatic = true;
      element.dispatchEvent(inputEvent);
    });
  } else if (
    element.getAttribute("contenteditable") === "true" ||
    element.isContentEditable
  ) {
    // For contenteditable - check if it's Lexical (Reddit) or Draft.js (Twitter)
    const isLexical =
      element.getAttribute("data-lexical-editor") === "true" ||
      element.closest('[data-lexical-editor="true"]') !== null;
    const isDraftJS =
      element.classList.contains("public-DraftEditor-content") ||
      element.closest(".DraftEditor-root") !== null;

    if (isLexical) {
      // For Lexical editors (Reddit), use execCommand to maintain editor state
      // This simulates user typing, which Lexical handles correctly
      isPerformingReplace.set(true);

      try {
        // Use execCommand('insertText') which is safest for Lexical
        replaceTextInContentEditable(
          element,
          actualStart,
          actualEnd,
          replacement,
          true
        );

        // Calculate length difference for position adjustment
        const replacementLength = replacement.length;
        const originalLength = actualEnd - actualStart;
        const lengthDiff = replacementLength - originalLength;

        // Update stored errors - adjust positions but keep IDs intact
        const updatedErrorsAfterReplace = updatedErrors.map((err) => {
          // If error is after the replaced text, adjust its position (keep ID!)
          if (err.start > actualEnd) {
            return {
              ...err,
              start: err.start + lengthDiff,
              end: err.end + lengthDiff,
            };
          }
          // If error overlaps with replaced text, it's already removed
          return err;
        });
        grammarErrors.set(element, updatedErrorsAfterReplace);

        // Update all highlight data-error attributes with new positions - match by ID
        if (highlightsContent) {
          const elementId = getElementId(element);
          const highlights = highlightsContent.querySelectorAll(
            `[data-element-id="${elementId}"]`
          );
          highlights.forEach((highlight) => {
            const highlightErrorId = (highlight as HTMLElement).getAttribute(
              "data-error-id"
            );
            if (!highlightErrorId) return;

            // Find the updated error by ID
            const updatedError = updatedErrorsAfterReplace.find(
              (err) => err.id === highlightErrorId
            );

            if (updatedError) {
              // Update data-error attribute with new positions (ID remains the same)
              (highlight as HTMLElement).setAttribute(
                "data-error",
                JSON.stringify(updatedError)
              );
            } else {
              // This error was removed
              highlight.remove();
            }
          });
        }

        // Wait for Lexical to update its DOM before repositioning highlights
        // Also keep flag true longer to catch any input events triggered by execCommand
        // Use multiple delayed updates to ensure DOM has fully settled
        setTimeout(() => {
          // First update attempt - DOM might still be updating
          highlightHelper.updatePositions(
            element,
            updatedErrorsAfterReplace,
            (error: GrammarError) =>
              getErrorTextRects(element, error.start, error.end)
          );

          // Second update after a delay to catch any delayed DOM changes
          setTimeout(() => {
            highlightHelper.updatePositions(
              element,
              updatedErrorsAfterReplace,
              (error: GrammarError) =>
                getErrorTextRects(element, error.start, error.end)
            );
          }, 100);

          // Cancel any scheduled blur handlers for this element
          const existingBlurTimeout = scheduledBlurHandlers.get(element);
          if (existingBlurTimeout) {
            clearTimeout(existingBlurTimeout);
            scheduledBlurHandlers.delete(element);
          }

          // Restore focus and set cursor position after replacement
          // Use requestAnimationFrame to ensure DOM is ready before focusing
          requestAnimationFrame(() => {
            // Keep flag true during focus restore to prevent blur handler from hiding highlights
            isPerformingReplace.set(true);

            element.focus();

            // Keep flag true longer (300ms) to catch input events triggered by execCommand
            // Lexical may trigger input events asynchronously after execCommand
            setTimeout(() => {
              isPerformingReplace.set(false);
              // Trigger grammar check after replace is complete
              performGrammarCheck(element).catch((error) => {
                console.error(
                  "Rewordly: Error performing grammar check after replace:",
                  error
                );
              });
            }, 300);
          });
        }, 100);
      } catch (err) {
        console.error("Rewordly: Error replacing text in Lexical:", err);
        isPerformingReplace.set(false);
      }
    } else if (isDraftJS) {
      // Set flag to prevent blur handler from hiding highlights during replace
      isPerformingReplace.set(true);

      // Cancel any scheduled blur handlers immediately to prevent them from hiding highlights
      const existingBlurTimeout = scheduledBlurHandlers.get(element);
      if (existingBlurTimeout) {
        clearTimeout(existingBlurTimeout);
        scheduledBlurHandlers.delete(element);
      }

      // Store original text for verification
      const originalText = element.innerText || element.textContent || "";

      // For Draft.js editors (Twitter), use execCommand-based replacement
      const replaceSuccess = replaceTextInDraftJS(
        element,
        actualStart,
        actualEnd,
        replacement
      );

      if (!replaceSuccess) {
        console.error("Rewordly: Failed to replace text in Draft.js");
        isPerformingReplace.set(false);
        return; // Don't update highlights if replace failed
      }

      // Calculate length difference for position adjustment (do this immediately, not in timeout)
      const replacementLength = replacement.length;
      const originalLength = actualEnd - actualStart;
      const lengthDiff = replacementLength - originalLength;

      // Update stored errors - adjust positions but keep IDs intact
      const updatedErrorsAfterReplace = updatedErrors.map((err) => {
        // If error is after the replaced text, adjust its position (keep ID!)
        if (err.start > actualEnd) {
          return {
            ...err,
            start: err.start + lengthDiff,
            end: err.end + lengthDiff,
          };
        }
        // If error overlaps with replaced text, it's already removed
        return err;
      });
      grammarErrors.set(element, updatedErrorsAfterReplace);

      // Update all highlight data-error attributes with new positions - match by ID
      if (highlightsContent) {
        const elementId = getElementId(element);
        const highlights = highlightsContent.querySelectorAll(
          `[data-element-id="${elementId}"]`
        );

        highlights.forEach((highlight) => {
          const highlightErrorId = (highlight as HTMLElement).getAttribute(
            "data-error-id"
          );
          if (!highlightErrorId) return;

          // Find the updated error by ID
          const updatedError = updatedErrorsAfterReplace.find(
            (err) => err.id === highlightErrorId
          );

          if (updatedError) {
            // Update data-error attribute with new positions (ID remains the same)
            (highlight as HTMLElement).setAttribute(
              "data-error",
              JSON.stringify(updatedError)
            );
          } else {
            // This error was removed - fade out and remove
            (highlight as HTMLElement).style.opacity = "0";
            setTimeout(() => highlight.remove(), 150);
          }
        });
      }

      // IMMEDIATELY update highlight positions after replace (no timeout for Twitter)
      // This ensures highlights move instantly to their new positions
      requestAnimationFrame(() => {
        highlightHelper.updatePositions(
          element,
          updatedErrorsAfterReplace,
          (error: GrammarError) =>
            getErrorTextRects(element, error.start, error.end)
        );
      });

      // Restore focus and cursor position
      requestAnimationFrame(() => {
        element.focus();

        // Set cursor position using Selection API
        const selection = window.getSelection();
        if (selection) {
          const newCursorPosition = actualStart + replacement.length;

          // Map cursor position to text node
          const cursorMapping = mapInnerTextToTextNodes(
            element,
            newCursorPosition,
            newCursorPosition
          );
          if (cursorMapping && cursorMapping.startNode) {
            try {
              // Check if node is still in document before using range
              if (isNodeInDocument(cursorMapping.startNode)) {
                const cursorRange = document.createRange();
                const offset = Math.min(
                  cursorMapping.startOffset,
                  cursorMapping.startNode.textContent!.length
                );
                cursorRange.setStart(cursorMapping.startNode, offset);
                cursorRange.collapse(true);
                selection.removeAllRanges();
                selection.addRange(cursorRange);
              }
            } catch (e) {
              // Cursor positioning failed - not critical, user can click to reposition
              console.warn(
                "Rewordly: Could not set cursor position after replacement",
                e
              );
            }
          }
        }
      });

      // For Draft.js, also do a delayed verification to catch any DOM changes that Draft.js makes asynchronously
      // But the immediate update above ensures highlights move instantly
      setTimeout(() => {
        const newText = element.innerText || element.textContent || "";

        // Verify replacement was successful - check if text changed
        if (newText === originalText && originalText.length > 0) {
          console.warn(
            "Rewordly: Replacement verification failed - text was not replaced"
          );
          isPerformingReplace.set(false);
          return;
        }

        // Cancel any blur handlers that might have been scheduled
        const existingBlurTimeout2 = scheduledBlurHandlers.get(element);
        if (existingBlurTimeout2) {
          clearTimeout(existingBlurTimeout2);
          scheduledBlurHandlers.delete(element);
        }

        // Verify and update highlights (in case Draft.js made additional DOM changes)
        highlightHelper.updatePositions(
          element,
          updatedErrorsAfterReplace,
          (error: GrammarError) =>
            getErrorTextRects(element, error.start, error.end)
        );

        // Keep isPerformingReplace true a bit longer to catch async Draft.js events
        setTimeout(() => {
          isPerformingReplace.set(false);
          // Trigger grammar check after replace is complete
          performGrammarCheck(element).catch((error) => {
            console.error(
              "Rewordly: Error performing grammar check after replace:",
              error
            );
          });
        }, 200);
      }, 200); // Small delay only for verification, not for initial update
    } else {
      // Check if this is Slate.js (Medium)
      const isSlate =
        element.getAttribute("data-slate-editor") === "true" ||
        element.querySelector('[data-slate-editor="true"]') !== null ||
        element.closest('[data-slate-editor="true"]') !== null;

      // Check if this is Notion
      const isNotion =
        element.getAttribute("data-content-editable-leaf") === "true" ||
        element.classList.contains("notion-selectable") ||
        window.location.hostname.includes("notion.so");

      if (isSlate) {
        // For Slate.js editors (Medium), use a special approach that properly updates Slate's internal state
        isPerformingReplace.set(true);

        // Use an async IIFE to handle the async operations
        (async () => {
          try {
            // CRITICAL: Clear any existing selection before starting replacement
            const initialSelection = window.getSelection();
            if (initialSelection) {
              initialSelection.removeAllRanges();
            }

            // Focus the element first
            element.focus();

            // CRITICAL: Clear selection again after focus, as focus might restore a selection
            if (initialSelection) {
              initialSelection.removeAllRanges();
            }

            // Get current text to validate positions
            const currentText = element.innerText || element.textContent || "";
            if (
              actualStart < 0 ||
              actualEnd > currentText.length ||
              actualStart >= actualEnd
            ) {
              console.error(
                "Rewordly: Invalid positions for Slate.js replacement",
                {
                  start: actualStart,
                  end: actualEnd,
                  textLength: currentText.length,
                }
              );
              isPerformingReplace.set(false);
              return;
            }

            const selection = window.getSelection();
            if (!selection) {
              isPerformingReplace.set(false);
              return;
            }

            // CRITICAL: Ensure selection is clear before proceeding
            selection.removeAllRanges();

            // Map innerText positions to text node positions
            const mapping = mapInnerTextToTextNodes(
              element,
              actualStart,
              actualEnd
            );

            if (!mapping || !mapping.startNode) {
              console.error(
                "Rewordly: Could not map innerText positions to text nodes for Slate.js"
              );
              isPerformingReplace.set(false);
              return;
            }

            // Create range for the text to replace
            const range = document.createRange();

            // Set range start
            const startNodeLength = mapping.startNode.textContent!.length;
            const startOffset = Math.min(mapping.startOffset, startNodeLength);
            range.setStart(mapping.startNode, startOffset);

            // Set range end
            if (mapping.endNode && mapping.startNode !== mapping.endNode) {
              const endNodeLength = mapping.endNode.textContent!.length;
              const endOffset = Math.min(mapping.endOffset, endNodeLength);
              range.setEnd(mapping.endNode, endOffset);
            } else {
              const endPos = Math.min(mapping.endOffset, startNodeLength);
              range.setEnd(mapping.startNode, endPos);
            }

            // Select the text first - this is important for Slate.js
            selection.removeAllRanges();
            selection.addRange(range);

            // CRITICAL: Verify selection is set correctly
            // Double-check that we have exactly one range and it's the one we want
            if (selection.rangeCount !== 1) {
              selection.removeAllRanges();
              selection.addRange(range);
            }

            // Wait a bit for Slate.js to recognize the selection
            await new Promise((resolve) => setTimeout(resolve, 20));

            // For Slate.js, we need to use beforeinput events properly
            // Slate.js listens to beforeinput events to update its internal state
            // We'll use deleteContent to delete selected text, then insertText to insert replacement

            // Step 1: Delete the selected content using deleteContent inputType
            const deleteBeforeInputEvent = new InputEvent("beforeinput", {
              bubbles: true,
              cancelable: true,
              inputType: "deleteContent",
              isComposing: false,
            });
            // Add getTargetRanges method for Slate.js compatibility
            (deleteBeforeInputEvent as any).getTargetRanges = () => [
              range.cloneRange(),
            ];
            (deleteBeforeInputEvent as any).__rewordlyProgrammatic = true;

            const deleteCancelled = !element.dispatchEvent(
              deleteBeforeInputEvent
            );

            if (!deleteCancelled) {
              // Delete the selected content from DOM
              range.deleteContents();

              // Trigger input event for deletion
              const deleteInputEvent = new InputEvent("input", {
                bubbles: true,
                cancelable: false,
                inputType: "deleteContent",
                isComposing: false,
              });
              (deleteInputEvent as any).__rewordlyProgrammatic = true;
              element.dispatchEvent(deleteInputEvent);
            }

            // Wait for Slate.js to process the deletion
            await new Promise((resolve) => setTimeout(resolve, 20));

            // Step 2: Insert the replacement text
            // Get the current selection (should be collapsed at deletion point)
            const currentRange =
              selection.rangeCount > 0 ? selection.getRangeAt(0) : range;

            // Ensure range is collapsed
            if (!currentRange.collapsed) {
              currentRange.collapse(true);
            }

            // Trigger beforeinput event for insertion
            const insertBeforeInputEvent = new InputEvent("beforeinput", {
              bubbles: true,
              cancelable: true,
              inputType: "insertText",
              data: replacement,
              isComposing: false,
            });
            // Add getTargetRanges method for Slate.js compatibility
            (insertBeforeInputEvent as any).getTargetRanges = () => [
              currentRange.cloneRange(),
            ];
            (insertBeforeInputEvent as any).__rewordlyProgrammatic = true;

            const insertCancelled = !element.dispatchEvent(
              insertBeforeInputEvent
            );

            if (!insertCancelled) {
              // Insert the replacement text into DOM
              const textNode = document.createTextNode(replacement);
              currentRange.insertNode(textNode);

              // Move cursor after the inserted text
              currentRange.setStartAfter(textNode);
              currentRange.collapse(true);
              selection.removeAllRanges();
              selection.addRange(currentRange);

              // Trigger input event for insertion
              const insertInputEvent = new InputEvent("input", {
                bubbles: true,
                cancelable: false,
                inputType: "insertText",
                data: replacement,
                isComposing: false,
              });
              (insertInputEvent as any).__rewordlyProgrammatic = true;
              element.dispatchEvent(insertInputEvent);
            }

            // Also try execCommand as a backup (some Slate.js versions may prefer it)
            // But only if the above didn't work
            try {
              // Re-select the text we just inserted to verify it's there
              const verifyRange = document.createRange();
              const verifyMapping = mapInnerTextToTextNodes(
                element,
                actualStart,
                actualStart + replacement.length
              );
              if (verifyMapping && verifyMapping.startNode) {
                verifyRange.setStart(
                  verifyMapping.startNode,
                  Math.min(
                    verifyMapping.startOffset,
                    verifyMapping.startNode.textContent!.length
                  )
                );
                if (
                  verifyMapping.endNode &&
                  verifyMapping.endNode !== verifyMapping.startNode
                ) {
                  verifyRange.setEnd(
                    verifyMapping.endNode,
                    Math.min(
                      verifyMapping.endOffset,
                      verifyMapping.endNode.textContent!.length
                    )
                  );
                } else {
                  verifyRange.setEnd(
                    verifyMapping.startNode,
                    Math.min(
                      verifyMapping.endOffset,
                      verifyMapping.startNode.textContent!.length
                    )
                  );
                }
                selection.removeAllRanges();
                selection.addRange(verifyRange);
              }
            } catch (e) {
              // Ignore errors in verification
            }

            // Wait longer for Slate.js to fully process the changes
            await new Promise((resolve) => setTimeout(resolve, 100));

            // Verify the replacement was successful by checking the text content
            const newText = element.innerText || element.textContent || "";
            const expectedText =
              currentText.substring(0, actualStart) +
              replacement +
              currentText.substring(actualEnd);

            // If replacement didn't work, try one more time with execCommand
            if (newText !== expectedText) {
              console.warn(
                "Rewordly: Slate.js replacement verification failed, trying execCommand fallback",
                {
                  expected: expectedText.substring(0, 50),
                  actual: newText.substring(0, 50),
                }
              );

              // Try execCommand as a last resort
              try {
                // Re-select the original text range
                const retryMapping = mapInnerTextToTextNodes(
                  element,
                  actualStart,
                  actualEnd
                );
                if (retryMapping && retryMapping.startNode) {
                  const retryRange = document.createRange();
                  retryRange.setStart(
                    retryMapping.startNode,
                    Math.min(
                      retryMapping.startOffset,
                      retryMapping.startNode.textContent!.length
                    )
                  );
                  if (
                    retryMapping.endNode &&
                    retryMapping.endNode !== retryMapping.startNode
                  ) {
                    retryRange.setEnd(
                      retryMapping.endNode,
                      Math.min(
                        retryMapping.endOffset,
                        retryMapping.endNode.textContent!.length
                      )
                    );
                  } else {
                    retryRange.setEnd(
                      retryMapping.startNode,
                      Math.min(
                        retryMapping.endOffset,
                        retryMapping.startNode.textContent!.length
                      )
                    );
                  }

                  selection.removeAllRanges();
                  selection.addRange(retryRange);

                  await new Promise((resolve) => setTimeout(resolve, 20));

                  // Try execCommand insertText which should replace selected text
                  const execSuccess = document.execCommand(
                    "insertText",
                    false,
                    replacement
                  );
                  if (execSuccess) {
                    await new Promise((resolve) => setTimeout(resolve, 50));
                    // Verify again
                    const retryText =
                      element.innerText || element.textContent || "";
                    if (retryText === expectedText) {
                      console.log(
                        "Rewordly: execCommand fallback succeeded for Slate.js"
                      );
                    }
                  }
                }
              } catch (e) {
                console.error("Rewordly: execCommand fallback failed", e);
              }
            }

            // Calculate length difference for position adjustment
            const replacementLength = replacement.length;
            const originalLength = actualEnd - actualStart;
            const lengthDiff = replacementLength - originalLength;

            // Update stored errors - adjust positions but keep IDs intact
            const updatedErrorsAfterReplace = updatedErrors.map((err) => {
              if (err.start > actualEnd) {
                return {
                  ...err,
                  start: err.start + lengthDiff,
                  end: err.end + lengthDiff,
                };
              }
              return err;
            });
            grammarErrors.set(element, updatedErrorsAfterReplace);

            // Update highlights
            if (highlightsContent) {
              const elementId = getElementId(element);
              const highlights = highlightsContent.querySelectorAll(
                `[data-element-id="${elementId}"]`
              );
              highlights.forEach((highlight) => {
                const highlightErrorId = (
                  highlight as HTMLElement
                ).getAttribute("data-error-id");
                if (!highlightErrorId) return;

                const updatedError = updatedErrorsAfterReplace.find(
                  (err) => err.id === highlightErrorId
                );
                if (updatedError) {
                  (highlight as HTMLElement).setAttribute(
                    "data-error",
                    JSON.stringify(updatedError)
                  );
                } else {
                  highlight.remove();
                }
              });
            }

            // Update highlight positions after Slate.js has updated its DOM
            // Use longer delay to ensure Slate.js has fully updated its internal state
            setTimeout(() => {
              // First, update highlight positions with the adjusted error positions
              highlightHelper.updatePositions(
                element,
                updatedErrorsAfterReplace,
                (error: GrammarError) =>
                  getErrorTextRects(element, error.start, error.end)
              );

              // Cancel blur handlers
              const existingBlurTimeout = scheduledBlurHandlers.get(element);
              if (existingBlurTimeout) {
                clearTimeout(existingBlurTimeout);
                scheduledBlurHandlers.delete(element);
              }

              // Restore focus and cursor position
              requestAnimationFrame(() => {
                element.focus();
                const newCursorPosition = actualStart + replacement.length;
                const cursorMapping = mapInnerTextToTextNodes(
                  element,
                  newCursorPosition,
                  newCursorPosition
                );
                if (cursorMapping && cursorMapping.startNode) {
                  const cursorRange = document.createRange();
                  const offset = Math.min(
                    cursorMapping.startOffset,
                    cursorMapping.startNode.textContent!.length
                  );
                  cursorRange.setStart(cursorMapping.startNode, offset);
                  cursorRange.collapse(true);
                  const sel = window.getSelection();
                  if (sel) {
                    sel.removeAllRanges();
                    sel.addRange(cursorRange);
                  }
                }

                // Keep flag true longer to catch any async Slate.js events
                setTimeout(() => {
                  // Update highlight positions again after a delay to ensure they're correct
                  // This ensures highlights are positioned correctly after Slate.js has fully updated
                  setTimeout(() => {
                    highlightHelper.updatePositions(
                      element,
                      updatedErrorsAfterReplace,
                      (error: GrammarError) =>
                        getErrorTextRects(element, error.start, error.end)
                    );

                    // Update again after another delay to catch any late DOM updates
                    setTimeout(() => {
                      highlightHelper.updatePositions(
                        element,
                        updatedErrorsAfterReplace,
                        (error: GrammarError) =>
                          getErrorTextRects(element, error.start, error.end)
                      );

                      // One more update to ensure positions are stable
                      setTimeout(() => {
                        highlightHelper.updatePositions(
                          element,
                          updatedErrorsAfterReplace,
                          (error: GrammarError) =>
                            getErrorTextRects(element, error.start, error.end)
                        );
                        isPerformingReplace.set(false);

                        // Don't trigger grammar check immediately after replace
                        // The existing highlights with updated positions should be sufficient
                        // Grammar check will happen naturally on next user input or focus change
                        // This prevents highlights from disappearing due to re-checking
                      }, 200);
                    }, 200);
                  }, 200);
                }, 300);
              });
            }, 200); // Increased delay to ensure Slate.js has updated its DOM
          } catch (err) {
            console.error("Rewordly: Error replacing text in Slate.js:", err);
            isPerformingReplace.set(false);
          }
        })();
      } else if (isNotion) {
        // For Notion, use a more reliable approach that works with their complex DOM structure
        isPerformingReplace.set(true);

        // Use an async IIFE to handle the async operations
        (async () => {
          try {
            // CRITICAL: Clear any existing selection before starting replacement
            const initialSelection = window.getSelection();
            if (initialSelection) {
              initialSelection.removeAllRanges();
            }

            // Focus the element first
            element.focus();

            // CRITICAL: Clear selection again after focus, as focus might restore a selection
            if (initialSelection) {
              initialSelection.removeAllRanges();
            }

            // Get current text to validate positions
            const currentText = element.innerText || element.textContent || "";
            if (
              actualStart < 0 ||
              actualEnd > currentText.length ||
              actualStart >= actualEnd
            ) {
              console.error(
                "Rewordly: Invalid positions for Notion replacement",
                {
                  start: actualStart,
                  end: actualEnd,
                  textLength: currentText.length,
                }
              );
              isPerformingReplace.set(false);
              return;
            }

            const selection = window.getSelection();
            if (!selection) {
              isPerformingReplace.set(false);
              return;
            }

            // CRITICAL: Ensure selection is clear before proceeding
            selection.removeAllRanges();

            // For Notion, we need to create a range that spans the correct text nodes
            // Notion's DOM has nested spans, so we need to be careful
            const range = document.createRange();

            // Map innerText positions to text node positions
            const mapping = mapInnerTextToTextNodes(
              element,
              actualStart,
              actualEnd
            );

            if (!mapping || !mapping.startNode) {
              console.error(
                "Rewordly: Could not map innerText positions to text nodes for Notion"
              );
              isPerformingReplace.set(false);
              return;
            }

            // Set range start
            const startNodeLength = mapping.startNode.textContent!.length;
            const startOffset = Math.min(mapping.startOffset, startNodeLength);
            range.setStart(mapping.startNode, startOffset);

            // Set range end
            if (mapping.endNode && mapping.startNode !== mapping.endNode) {
              const endNodeLength = mapping.endNode.textContent!.length;
              const endOffset = Math.min(mapping.endOffset, endNodeLength);
              range.setEnd(mapping.endNode, endOffset);
            } else {
              const endPos = Math.min(mapping.endOffset, startNodeLength);
              range.setEnd(mapping.startNode, endPos);
            }

            // Select the text first - this is important for Notion
            selection.removeAllRanges();
            selection.addRange(range);

            // CRITICAL: Verify selection is set correctly before execCommand
            // Double-check that we have exactly one range and it's the one we want
            if (selection.rangeCount !== 1) {
              selection.removeAllRanges();
              selection.addRange(range);
            }

            // Wait a bit for Notion to recognize the selection
            await new Promise((resolve) => setTimeout(resolve, 10));

            // Try execCommand first (some browsers still support it)
            let success = false;
            try {
              success = document.execCommand("insertText", false, replacement);
            } catch (e) {
              // execCommand might fail, use fallback
              success = false;
            }

            if (!success) {
              // Fallback: manually delete and insert
              // Delete the selected content
              range.deleteContents();

              // Insert the replacement text
              // For Notion, we need to preserve the structure, so we insert as a text node
              const textNode = document.createTextNode(replacement);
              range.insertNode(textNode);

              // Collapse range to the end of inserted text
              range.setStartAfter(textNode);
              range.collapse(true);

              // Update selection
              selection.removeAllRanges();
              selection.addRange(range);
            }

            // Clear selection after a brief moment
            setTimeout(() => {
              selection.removeAllRanges();
            }, 10);

            // Trigger beforeinput event first (Notion listens to this)
            const beforeInputEvent = new InputEvent("beforeinput", {
              bubbles: true,
              cancelable: true,
              inputType: "insertText",
              data: replacement,
              isComposing: false,
            });
            (beforeInputEvent as any).__rewordlyProgrammatic = true;
            element.dispatchEvent(beforeInputEvent);

            // Trigger input event (Notion uses this to update internal state)
            const inputEvent = new InputEvent("input", {
              bubbles: true,
              cancelable: false,
              inputType: "insertText",
              data: replacement,
              isComposing: false,
            });
            (inputEvent as any).__rewordlyProgrammatic = true;
            element.dispatchEvent(inputEvent);

            // Also trigger a composition event (some editors listen to this)
            const compositionStartEvent = new CompositionEvent(
              "compositionstart",
              {
                bubbles: true,
                cancelable: true,
                data: replacement,
              }
            );
            (compositionStartEvent as any).__rewordlyProgrammatic = true;
            element.dispatchEvent(compositionStartEvent);

            const compositionEndEvent = new CompositionEvent("compositionend", {
              bubbles: true,
              cancelable: true,
              data: replacement,
            });
            (compositionEndEvent as any).__rewordlyProgrammatic = true;
            element.dispatchEvent(compositionEndEvent);

            // Calculate length difference for position adjustment
            const replacementLength = replacement.length;
            const originalLength = actualEnd - actualStart;
            const lengthDiff = replacementLength - originalLength;

            // Update stored errors - adjust positions but keep IDs intact
            const updatedErrorsAfterReplace = updatedErrors.map((err) => {
              if (err.start > actualEnd) {
                return {
                  ...err,
                  start: err.start + lengthDiff,
                  end: err.end + lengthDiff,
                };
              }
              return err;
            });
            grammarErrors.set(element, updatedErrorsAfterReplace);

            // Update highlights
            if (highlightsContent) {
              const elementId = getElementId(element);
              const highlights = highlightsContent.querySelectorAll(
                `[data-element-id="${elementId}"]`
              );
              highlights.forEach((highlight) => {
                const highlightErrorId = (
                  highlight as HTMLElement
                ).getAttribute("data-error-id");
                if (!highlightErrorId) return;

                const updatedError = updatedErrorsAfterReplace.find(
                  (err) => err.id === highlightErrorId
                );
                if (updatedError) {
                  (highlight as HTMLElement).setAttribute(
                    "data-error",
                    JSON.stringify(updatedError)
                  );
                } else {
                  highlight.remove();
                }
              });
            }

            // Update highlight positions
            setTimeout(() => {
              highlightHelper.updatePositions(
                element,
                updatedErrorsAfterReplace,
                (error: GrammarError) =>
                  getErrorTextRects(element, error.start, error.end)
              );

              // Cancel blur handlers
              const existingBlurTimeout = scheduledBlurHandlers.get(element);
              if (existingBlurTimeout) {
                clearTimeout(existingBlurTimeout);
                scheduledBlurHandlers.delete(element);
              }

              // Restore focus and cursor position
              requestAnimationFrame(() => {
                element.focus();
                const newCursorPosition = actualStart + replacement.length;
                const cursorMapping = mapInnerTextToTextNodes(
                  element,
                  newCursorPosition,
                  newCursorPosition
                );
                if (cursorMapping && cursorMapping.startNode) {
                  const cursorRange = document.createRange();
                  const offset = Math.min(
                    cursorMapping.startOffset,
                    cursorMapping.startNode.textContent!.length
                  );
                  cursorRange.setStart(cursorMapping.startNode, offset);
                  cursorRange.collapse(true);
                  selection.removeAllRanges();
                  selection.addRange(cursorRange);
                }

                setTimeout(() => {
                  isPerformingReplace.set(false);
                  // Trigger grammar check after replace is complete
                  performGrammarCheck(element).catch((error) => {
                    console.error(
                      "Rewordly: Error performing grammar check after replace:",
                      error
                    );
                  });
                }, 150);
              });
            }, 100);
          } catch (err) {
            console.error("Rewordly: Error replacing text in Notion:", err);
            isPerformingReplace.set(false);
          }
        })();

        // Return early since we're handling everything in the async IIFE
        return;
      } else {
        // For regular contenteditable
        // Set flag to prevent blur handler from hiding highlights during replace
        isPerformingReplace.set(true);

        const selection = window.getSelection();
        if (!selection) {
          isPerformingReplace.set(false);
          return;
        }

        // CRITICAL: Clear any existing selection before starting replacement
        // This prevents replacement from happening at user-selected text locations
        selection.removeAllRanges();

        // Get current text to validate positions
        const currentText = element.innerText || element.textContent || "";
        if (
          actualStart < 0 ||
          actualEnd > currentText.length ||
          actualStart >= actualEnd
        ) {
          console.error("Rewordly: Invalid positions for replacement", {
            start: actualStart,
            end: actualEnd,
            textLength: currentText.length,
            currentErrors: grammarErrors.get(element),
          });
          isPerformingReplace.set(false);
          return;
        }

        // Map innerText positions to text node positions
        const mapping = mapInnerTextToTextNodes(
          element,
          actualStart,
          actualEnd
        );

        if (!mapping || !mapping.startNode) {
          console.error(
            "Rewordly: Could not map innerText positions to text nodes",
            {
              start: actualStart,
              end: actualEnd,
              textLength: currentText.length,
              innerText: currentText.substring(
                Math.max(0, actualStart - 10),
                Math.min(currentText.length, actualEnd + 10)
              ),
            }
          );
          isPerformingReplace.set(false);
          return;
        }

        try {
          const range = document.createRange();

          // Validate positions
          const startNodeLength = mapping.startNode.textContent!.length;
          if (
            mapping.startOffset < 0 ||
            mapping.startOffset > startNodeLength
          ) {
            console.error("Rewordly: Invalid start offset in text node", {
              startOffset: mapping.startOffset,
              nodeLength: startNodeLength,
              globalStart: actualStart,
            });
            return;
          }

          if (mapping.endNode && mapping.startNode !== mapping.endNode) {
            // Error spans multiple text nodes
            const endNodeLength = mapping.endNode.textContent!.length;
            if (mapping.endOffset < 0 || mapping.endOffset > endNodeLength) {
              console.error("Rewordly: Invalid end offset in text node", {
                endOffset: mapping.endOffset,
                nodeLength: endNodeLength,
                globalEnd: actualEnd,
              });
              return;
            }

            range.setStart(
              mapping.startNode,
              Math.min(mapping.startOffset, startNodeLength)
            );
            range.setEnd(
              mapping.endNode,
              Math.min(mapping.endOffset, endNodeLength)
            );
          } else {
            // Error is within a single text node
            const endPos = mapping.endOffset;

            if (endPos > startNodeLength) {
              console.error("Rewordly: Invalid end position in text node", {
                startOffset: mapping.startOffset,
                endPos,
                nodeLength: startNodeLength,
                globalStart: actualStart,
                globalEnd: actualEnd,
              });
              return;
            }

            range.setStart(mapping.startNode, mapping.startOffset);
            range.setEnd(mapping.startNode, endPos);
          }

          selection.removeAllRanges();
          selection.addRange(range);

          // CRITICAL: Verify selection is set correctly
          // Double-check that we have exactly one range and it's the one we want
          if (selection.rangeCount !== 1) {
            selection.removeAllRanges();
            selection.addRange(range);
          }

          // Replace selected text
          range.deleteContents();
          const textNode = document.createTextNode(replacement);
          range.insertNode(textNode);

          // Clear selection
          selection.removeAllRanges();

          // Trigger multiple events to ensure contenteditable picks it up
          const events = ["beforeinput", "input", "textInput"];
          events.forEach((eventType) => {
            const event = new Event(eventType, {
              bubbles: true,
              cancelable: true,
            });
            (event as any).data = replacement;
            // Mark as programmatic to prevent handleInput from processing it
            (event as any).__rewordlyProgrammatic = true;
            element.dispatchEvent(event);
          });

          // Calculate length difference for position adjustment
          const replacementLength = replacement.length;
          const originalLength = actualEnd - actualStart;
          const lengthDiff = replacementLength - originalLength;

          // Update stored errors - adjust positions but keep IDs intact
          const updatedErrorsAfterReplace = updatedErrors.map((err) => {
            // If error is after the replaced text, adjust its position (keep ID!)
            if (err.start > actualEnd) {
              return {
                ...err,
                start: err.start + lengthDiff,
                end: err.end + lengthDiff,
              };
            }
            // If error overlaps with replaced text, it's already removed
            return err;
          });
          grammarErrors.set(element, updatedErrorsAfterReplace);

          // Update all highlight data-error attributes with new positions - match by ID
          if (highlightsContent) {
            const elementId = getElementId(element);
            const highlights = highlightsContent.querySelectorAll(
              `[data-element-id="${elementId}"]`
            );
            highlights.forEach((highlight) => {
              const highlightErrorId = (highlight as HTMLElement).getAttribute(
                "data-error-id"
              );
              if (!highlightErrorId) return;

              // Find the updated error by ID
              const updatedError = updatedErrorsAfterReplace.find(
                (err) => err.id === highlightErrorId
              );

              if (updatedError) {
                // Update data-error attribute with new positions (ID remains the same)
                (highlight as HTMLElement).setAttribute(
                  "data-error",
                  JSON.stringify(updatedError)
                );
              } else {
                // This error was removed
                highlight.remove();
              }
            });
          }

          // Update highlight positions after DOM has updated (for proper text wrapping calculation)
          // Use requestAnimationFrame to ensure text wrapping is recalculated after replace
          requestAnimationFrame(() => {
            highlightHelper.updatePositions(
              element,
              updatedErrorsAfterReplace,
              (error: GrammarError) =>
                getErrorTextRects(element, error.start, error.end)
            );
          });

          // Cancel any scheduled blur handlers for this element
          const existingBlurTimeout = scheduledBlurHandlers.get(element);
          if (existingBlurTimeout) {
            clearTimeout(existingBlurTimeout);
            scheduledBlurHandlers.delete(element);
          }

          // Restore focus and set cursor position after replacement
          // Use requestAnimationFrame to ensure DOM is ready before focusing
          requestAnimationFrame(() => {
            // Keep flag true during focus restore to prevent blur handler from hiding highlights
            isPerformingReplace.set(true);

            element.focus();
            // Set cursor position to the end of the replacement
            const newCursorPosition = actualStart + replacement.length;
            const cursorMapping = mapInnerTextToTextNodes(
              element,
              newCursorPosition,
              newCursorPosition
            );
            if (cursorMapping && cursorMapping.startNode) {
              const cursorRange = document.createRange();
              const offset = Math.min(
                cursorMapping.startOffset,
                cursorMapping.startNode.textContent!.length
              );
              cursorRange.setStart(cursorMapping.startNode, offset);
              cursorRange.collapse(true);
              selection.removeAllRanges();
              selection.addRange(cursorRange);
            }

            // Clear the replace flag after a short delay to ensure focus is stable
            setTimeout(() => {
              isPerformingReplace.set(false);
              // Trigger grammar check after replace is complete
              performGrammarCheck(element).catch((error) => {
                console.error(
                  "Rewordly: Error performing grammar check after replace:",
                  error
                );
              });
            }, 150);
          });
        } catch (err) {
          console.error("Rewordly: Error replacing text:", err);
          console.error("Rewordly: Error details:", {
            start: actualStart,
            end: actualEnd,
            mapping,
          });
          // Clear flag even on error
          isPerformingReplace.set(false);
        }
      }
    }
  }
}
