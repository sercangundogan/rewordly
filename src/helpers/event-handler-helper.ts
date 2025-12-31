/**
 * Event Handler Helper
 * Input, focus ve blur event handler'ları için yardımcı fonksiyonlar
 *
 * Bu dosya editable elementler üzerindeki event'leri işler.
 * Basitçe: Input işle, focus işle, blur işle gibi.
 */

import { GrammarError, RewordlyConfig } from "../types";
import { isEditableElement, getElementId } from "./element-helper";
import { isGrammarCheckAllowedSite } from "./config-helper";
import {
  HighlightContainerHelper,
  showGrammarOverlay,
  getErrorTextRects,
} from "./highlight-helper";
import { RewriteButtonHelper } from "./ui-helper";

/**
 * Handle input events on editable elements
 */
export function handleInput(
  event: Event,
  options: {
    config: RewordlyConfig;
    isPerformingReplace: boolean;
    grammarCheckTimeout: number | null;
    grammarCheckThrottle: number | null;
    highlightPositionUpdateTimeout: number | null;
    buttonBlurTimeout: number | null;
    currentFocusedElement: HTMLElement | null;
    grammarErrors: Map<HTMLElement, GrammarError[]>;
    highlightHelper: HighlightContainerHelper;
    rewriteButtonHelper: RewriteButtonHelper;
    GRAMMAR_CHECK_THROTTLE: number;
    validateAndRemoveInvalidHighlights: (element: HTMLElement) => void;
    performGrammarCheckDirect: (element: HTMLElement) => Promise<void>;
    showAIRewriteButton: (element: HTMLElement) => void;
    hideRewriteButton: () => void;
    setGrammarCheckTimeout: (timeout: number | null) => void;
    setGrammarCheckThrottle: (throttle: number | null) => void;
    setHighlightPositionUpdateTimeout: (timeout: number | null) => void;
    setButtonBlurTimeout: (timeout: number | null) => void;
    setCurrentFocusedElement: (element: HTMLElement | null) => void;
  }
): void {
  const {
    config,
    isPerformingReplace,
    grammarCheckTimeout,
    grammarCheckThrottle,
    highlightPositionUpdateTimeout,
    buttonBlurTimeout,
    grammarErrors,
    highlightHelper,
    GRAMMAR_CHECK_THROTTLE,
    validateAndRemoveInvalidHighlights,
    performGrammarCheckDirect,
    showAIRewriteButton,
    hideRewriteButton,
    setGrammarCheckTimeout,
    setGrammarCheckThrottle,
    setHighlightPositionUpdateTimeout,
    setButtonBlurTimeout,
    setCurrentFocusedElement,
  } = options;

  // Skip programmatic input events triggered by our replace operations
  // This prevents unnecessary grammar checks after replacements
  if ((event as any).__rewordlyProgrammatic) {
    console.log("Programmatic input event detected");
    return;
  }

  const element = event.target as HTMLElement;

  if (!isEditableElement(element)) {
    console.log("Element is not editable");
    return;
  }

  // Ignore input events during replace operations
  // This prevents grammar check from running after programmatic text replacement
  // (e.g., when execCommand('insertText') triggers input events in Lexical/Reddit)
  if (isPerformingReplace) {
    // Clear any pending grammar check timeout
    if (grammarCheckTimeout !== null) {
      clearTimeout(grammarCheckTimeout);
      setGrammarCheckTimeout(null);
    }
    return;
  }

  // Show AI button if element has focus and rewrite is enabled
  // For textarea/input: always show when focused (regardless of text length)
  // For contenteditable: only show if has text (at least 3 characters)
  // Only show on sites where grammar check is enabled
  if (
    config.rewriteEnabled &&
    isGrammarCheckAllowedSite() &&
    config.highlightsEnabled
  ) {
    // Cancel button blur timeout to prevent button from hiding
    if (buttonBlurTimeout !== null) {
      clearTimeout(buttonBlurTimeout);
      setButtonBlurTimeout(null);
    }

    // Check if element has focus (or is the active element)
    const hasFocus =
      document.activeElement === element ||
      (element instanceof HTMLInputElement &&
        document.activeElement === element) ||
      (element instanceof HTMLTextAreaElement &&
        document.activeElement === element);

    if (hasFocus) {
      // For textarea/input: always show button when focused
      if (
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement
      ) {
        // Set current focused element - this prevents button from being hidden
        setCurrentFocusedElement(element);
        showAIRewriteButton(element);
      } else {
        // For contenteditable: check if has text
        let hasText = false;
        if (
          element.getAttribute("contenteditable") === "true" ||
          element.isContentEditable
        ) {
          hasText =
            (element.innerText || element.textContent || "").trim().length >= 3;
        }

        if (hasText) {
          showAIRewriteButton(element);
        } else {
          // Hide button if text is less than 3 characters
          hideRewriteButton();
        }
      }
    }
  }

  // Clear previous timeout
  if (grammarCheckTimeout !== null) {
    clearTimeout(grammarCheckTimeout);
  }

  // Check if this is a Draft.js editor (Twitter)
  const isDraftJS =
    element.classList.contains("public-DraftEditor-content") ||
    element.closest(".DraftEditor-root") !== null;

  if (isDraftJS) {
    // For Draft.js, delay validation to allow DOM to update after programmatic changes
    // This prevents false invalidation of highlights after replace operations
    setTimeout(() => {
      validateAndRemoveInvalidHighlights(element);
    }, 50);
  } else {
    // For other editors, validate immediately (when user deletes characters)
    validateAndRemoveInvalidHighlights(element);
  }

  // Update highlight positions when text changes (if highlights exist)
  if (config.highlightsEnabled && grammarErrors.has(element)) {
    // Clear previous position update timeout
    if (highlightPositionUpdateTimeout !== null) {
      clearTimeout(highlightPositionUpdateTimeout);
    }

    // Update positions after DOM updates (using double requestAnimationFrame to ensure DOM is fully updated)
    const timeoutId = window.setTimeout(() => {
      requestAnimationFrame(() => {
        highlightHelper.updatePositions(
          element,
          grammarErrors.get(element) || [],
          (error: GrammarError) =>
            getErrorTextRects(element, error.start, error.end)
        );
      });
    }, 10);
    setHighlightPositionUpdateTimeout(timeoutId);
  }

  // Only perform grammar check if highlights are enabled
  if (config.highlightsEnabled) {
    // Use throttle instead of debounce for faster response
    // Cancel previous throttle if exists
    if (grammarCheckThrottle !== null) {
      clearTimeout(grammarCheckThrottle);
    }

    // Throttle: check every 300ms while user is typing
    const throttleId = window.setTimeout(() => {
      performGrammarCheckDirect(element);
      setGrammarCheckThrottle(null);
    }, GRAMMAR_CHECK_THROTTLE);
    setGrammarCheckThrottle(throttleId);
  }
}

/**
 * Handle focus events on editable elements
 */
export function handleFocus(
  event: Event,
  options: {
    config: RewordlyConfig;
    grammarErrors: Map<HTMLElement, GrammarError[]>;
    highlightHelper: HighlightContainerHelper;
    rewriteButtonHelper: RewriteButtonHelper;
    grammarCheckThrottle: number | null;
    buttonBlurTimeout: number | null;
    scheduledBlurHandlers: Map<HTMLElement, NodeJS.Timeout>;
    currentFocusedElement: HTMLElement | null;
    isErrorDismissed: (element: HTMLElement, error: GrammarError) => boolean;
    createDisplayGrammarErrorsCallback: () => (
      element: HTMLElement,
      errors: GrammarError[]
    ) => void;
    performGrammarCheckDirect: (element: HTMLElement) => Promise<void>;
    showAIRewriteButton: (element: HTMLElement) => void;
    hideRewriteButton: () => void;
    setGrammarCheckThrottle: (throttle: number | null) => void;
    setButtonBlurTimeout: (timeout: number | null) => void;
    setCurrentFocusedElement: (element: HTMLElement | null) => void;
  }
): void {
  const {
    config,
    grammarErrors,
    highlightHelper,
    grammarCheckThrottle,
    buttonBlurTimeout,
    scheduledBlurHandlers,
    isErrorDismissed,
    createDisplayGrammarErrorsCallback,
    performGrammarCheckDirect,
    showAIRewriteButton,
    hideRewriteButton,
    setGrammarCheckThrottle,
    setButtonBlurTimeout,
    setCurrentFocusedElement,
  } = options;

  const element = event.target as HTMLElement;

  if (!element || !isEditableElement(element)) {
    return;
  }

  // Cancel any scheduled blur handlers for this element when focus is restored
  // This prevents highlights from being hidden after replace operations
  const existingBlurTimeout = scheduledBlurHandlers.get(element);
  if (existingBlurTimeout) {
    clearTimeout(existingBlurTimeout);
    scheduledBlurHandlers.delete(element);
  }

  // Cancel button blur timeout if exists (prevents button from hiding after focus)
  if (buttonBlurTimeout !== null) {
    clearTimeout(buttonBlurTimeout);
    setButtonBlurTimeout(null);
  }

  // Track currently focused element - this prevents button from being hidden
  setCurrentFocusedElement(element);

  // Check if element has text (at least 3 characters)
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

  // Show AI button on focus for textarea/input elements (always show on focus)
  // For contenteditable elements, only show if has text (at least 3 characters)
  // Only show on sites where grammar check is enabled
  if (
    config.rewriteEnabled &&
    isGrammarCheckAllowedSite() &&
    config.highlightsEnabled
  ) {
    // For textarea/input: show button immediately on focus, regardless of text length
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
    ) {
      // Set current focused element - this prevents button from being hidden
      setCurrentFocusedElement(element);
      showAIRewriteButton(element);
    } else if (hasText) {
      // For contenteditable: only show if has text
      showAIRewriteButton(element);
    } else {
      // Hide button if contenteditable and text is less than 3 characters
      hideRewriteButton();
    }
  }

  // If element has grammar errors and highlights are enabled, show the overlay again
  if (config.highlightsEnabled && grammarErrors.has(element)) {
    showGrammarOverlay(element, {
      grammarErrors,
      highlightHelper,
      displayGrammarErrors: createDisplayGrammarErrorsCallback(),
      isErrorDismissed,
      getElementId,
    });
  }

  // Perform immediate grammar check on focus (if element has text)
  if (config.highlightsEnabled && hasText && isGrammarCheckAllowedSite()) {
    // Cancel any pending throttle
    if (grammarCheckThrottle !== null) {
      clearTimeout(grammarCheckThrottle);
      setGrammarCheckThrottle(null);
    }
    // Check immediately on focus
    performGrammarCheckDirect(element);
  }
}

/**
 * Handle blur events on editable elements
 */
export function handleBlur(
  event: Event,
  options: {
    config: RewordlyConfig;
    grammarCheckTimeout: number | null;
    highlightPositionUpdateTimeout: number | null;
    buttonBlurTimeout: number | null;
    currentFocusedElement: HTMLElement | null;
    scheduledBlurHandlers: Map<HTMLElement, NodeJS.Timeout>;
    isPerformingReplace: boolean;
    isPerformingDismiss: boolean;
    grammarErrors: Map<HTMLElement, GrammarError[]>;
    highlightHelper: HighlightContainerHelper;
    rewriteButtonHelper: RewriteButtonHelper;
    setGrammarCheckTimeout: (timeout: number | null) => void;
    setHighlightPositionUpdateTimeout: (timeout: number | null) => void;
    setButtonBlurTimeout: (timeout: number | null) => void;
    setCurrentFocusedElement: (element: HTMLElement | null) => void;
    hideRewriteButton: () => void;
  }
): void {
  const {
    grammarCheckTimeout,
    highlightPositionUpdateTimeout,
    buttonBlurTimeout,
    currentFocusedElement,
    scheduledBlurHandlers,
    isPerformingReplace,
    isPerformingDismiss,
    grammarErrors,
    highlightHelper,
    rewriteButtonHelper,
    setGrammarCheckTimeout,
    setHighlightPositionUpdateTimeout,
    setButtonBlurTimeout,
    setCurrentFocusedElement,
    hideRewriteButton,
  } = options;

  const element = event.target as HTMLElement;

  // Clear timeout if user leaves the field
  if (grammarCheckTimeout !== null) {
    clearTimeout(grammarCheckTimeout);
    setGrammarCheckTimeout(null);
  }

  // Clear highlight position update timeout
  if (highlightPositionUpdateTimeout !== null) {
    clearTimeout(highlightPositionUpdateTimeout);
    setHighlightPositionUpdateTimeout(null);
  }

  // Hide AI button when focus is lost (with delay to allow button click)
  // Check if the blur is caused by clicking the button
  const relatedTarget = (event as FocusEvent)
    .relatedTarget as HTMLElement | null;
  const button = (rewriteButtonHelper as any).button;
  const isClickingButton =
    relatedTarget &&
    (relatedTarget === button || button?.contains(relatedTarget));

  if (!isClickingButton) {
    // Cancel any existing button blur timeout
    if (buttonBlurTimeout !== null) {
      clearTimeout(buttonBlurTimeout);
      setButtonBlurTimeout(null);
    }

    // Clear current focused element - allow button to be hidden
    // But use a delay to allow for focus transfer (e.g., clicking on button)
    const blurredElement = element;
    setCurrentFocusedElement(null);

    // Small delay to allow for focus transfer (e.g., clicking on button)
    const timeoutId = window.setTimeout(() => {
      // Check if element still doesn't have focus and button wasn't clicked
      const button = (rewriteButtonHelper as any).button;
      const shouldHide =
        document.activeElement !== blurredElement &&
        document.activeElement !== button &&
        !button?.contains(document.activeElement) &&
        currentFocusedElement !== blurredElement; // Check if element is no longer the focused element

      // Only hide if element truly lost focus and is not the current focused element
      if (shouldHide) {
        // Double-check: if element regained focus, don't hide
        if (document.activeElement === blurredElement) {
          // Element regained focus, update current focused element
          setCurrentFocusedElement(blurredElement);
          setButtonBlurTimeout(null);
          return;
        }
        hideRewriteButton();
      }
      setButtonBlurTimeout(null);
    }, 150);
    setButtonBlurTimeout(timeoutId);
  }

  // Hide grammar errors/overlay when focus is lost (but don't delete)
  // However, if element has text, keep highlights visible even without focus
  if (element && isEditableElement(element)) {
    // Cancel any existing scheduled blur handler for this element
    const existingTimeout = scheduledBlurHandlers.get(element);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
      scheduledBlurHandlers.delete(element);
    }

    // Small delay to allow for focus transfer (e.g., clicking on overlay)
    // For Draft.js (Twitter), use longer delay as DOM updates are asynchronous
    const isDraftJS =
      element.classList.contains("public-DraftEditor-content") ||
      element.closest(".DraftEditor-root") !== null;
    const blurDelay = isDraftJS ? 400 : 100; // Longer delay for Draft.js to account for async DOM updates

    const timeoutId = setTimeout(() => {
      // Remove from map when executed
      scheduledBlurHandlers.delete(element);

      // Don't hide if we're performing a replace or dismiss operation (prevents highlights from being hidden during replace/dismiss)
      if (isPerformingReplace || isPerformingDismiss) {
        return;
      }

      // Check if element still doesn't have focus
      if (document.activeElement !== element) {
        // Keep highlights visible as long as element is in the DOM and has text
        // Only hide if element is removed from DOM or has no text
        let hasText = false;
        if (
          element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement
        ) {
          hasText = element.value.trim().length > 0;
        } else if (
          element.getAttribute("contenteditable") === "true" ||
          element.isContentEditable
        ) {
          hasText =
            (element.innerText || element.textContent || "").trim().length > 0;
        }

        // Check if element is still in the DOM
        const isInDOM = document.body.contains(element) || element.isConnected;

        // Only hide highlights if element has no text or is removed from DOM
        if (!hasText || !isInDOM) {
          // Element has no text or was removed, hide highlights
          const highlightsContent = highlightHelper.getContent();
          if (highlightsContent) {
            const elementId = getElementId(element);
            const highlights = highlightsContent.querySelectorAll(
              `[data-element-id="${elementId}"]`
            );
            highlights.forEach((highlight: Element) => {
              highlight.remove();
            });
          }
          // Clear errors for this element
          grammarErrors.delete(element);
        }
        // Otherwise, keep highlights visible even without focus
      }
    }, blurDelay);

    // Store timeout ID so we can cancel it if needed
    scheduledBlurHandlers.set(element, timeoutId);
  }
}
