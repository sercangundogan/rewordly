/**
 * Text Replacement Helper
 * Text replacement işlemleri için yardımcı fonksiyonlar
 *
 * Bu dosya farklı editor tiplerinde (Draft.js, Lexical, Slate.js, Notion, etc.)
 * text replacement yapmakla ilgilenir.
 */

import { mapInnerTextToTextNodes } from "./text-processing-helper";
import { isNodeInDocument } from "./element-helper";

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

  // Focus the element first to ensure Draft.js is ready
  element.focus();

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

    if (useExecCommand) {
      // Use execCommand to replace text - this ensures Lexical's internal state is updated correctly
      // Lexical listens to execCommand and updates its internal state accordingly
      const success = document.execCommand("insertText", false, replacement);

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
