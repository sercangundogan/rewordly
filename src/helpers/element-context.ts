/**
 * Editable Element Context
 * Editable element işlemleri için gerekli state'lere erişim sağlar
 *
 * Bu context, editable element yönetimi ile ilgili state'leri tek bir yerde toplar.
 */

import { GrammarError } from "../types";
import { HighlightContainerHelper } from "./highlight-helper";
import { GrammarCheckContext } from "./grammar-check-context";
import { UIStateContext } from "./ui-state-context";
import { EventContext } from "./event-context";
import { ConfigContext } from "./config-context";
import {
  getElementId,
  isEditableElement,
  shouldIgnoreElement,
  disableSpellCheck,
  checkExistingTextForGrammar,
  setupElementScrollListeners,
  findAllEditableElements,
  findEditableInShadowDOM,
} from "./element-helper";

/**
 * Editable element işlemleri için context
 */
export class EditableElementContext {
  constructor(
    public readonly editableElements: Set<HTMLElement>,
    public readonly ignoredElementIds: Set<string>,
    public readonly scrollableContainers: Map<HTMLElement, Set<HTMLElement>>,
    public readonly scrollListeners: Map<HTMLElement, () => void>,
    public readonly grammarCheckContext: GrammarCheckContext,
    public readonly uiStateContext: UIStateContext,
    public readonly eventContext: EventContext,
    public readonly configContext: ConfigContext,
    public readonly queueGrammarCheck: (
      element: HTMLElement,
      priority: number
    ) => void,
    public readonly getErrorTextRects: (
      element: HTMLElement,
      start: number,
      end: number
    ) => DOMRect[]
  ) {}

  // Convenience getters for nested context properties
  get grammarErrors(): Map<HTMLElement, GrammarError[]> {
    return this.grammarCheckContext.grammarErrors;
  }

  get highlightHelper(): HighlightContainerHelper {
    return this.uiStateContext.highlightHelper;
  }

  get config() {
    return this.configContext.config;
  }

  get boundHandleInput() {
    return this.eventContext.boundHandleInput;
  }

  get boundHandleFocus() {
    return this.eventContext.boundHandleFocus;
  }

  get boundHandleBlur() {
    return this.eventContext.boundHandleBlur;
  }

  /**
   * Attach an editable element to the context
   */
  attachToEditableElement(element: HTMLElement): void {
    // Validation
    if (!isEditableElement(element)) {
      return;
    }

    if (this.editableElements.has(element)) {
      return;
    }

    // Track element
    this.editableElements.add(element);

    // Check if this element should be ignored (e.g., Gmail's "To" field)
    if (shouldIgnoreElement(element)) {
      const elementId = getElementId(element);
      this.ignoredElementIds.add(elementId);
      return; // Don't attach grammar checking to ignored elements
    }

    // Disable spell check
    disableSpellCheck(element);

    // Attach event listeners
    this.attachEventListeners(element);

    // Check existing text for grammar errors
    checkExistingTextForGrammar(element, this);

    // Set up scroll listeners
    setupElementScrollListeners(element, this);
  }

  /**
   * Attach event listeners to an editable element
   */
  attachEventListeners(element: HTMLElement): void {
    // Add multiple event listeners to catch all input types
    // Use capture phase to catch events before they're stopped
    element.addEventListener("input", this.boundHandleInput, true);
    element.addEventListener("beforeinput", this.boundHandleInput, true);
    element.addEventListener("keyup", this.boundHandleInput, true);
    element.addEventListener("focus", this.boundHandleFocus, true);
    element.addEventListener("blur", this.boundHandleBlur, true);

    // For contenteditable, also listen to textInput
    if (element.getAttribute("contenteditable") === "true") {
      element.addEventListener("textInput", this.boundHandleInput, true);
    }
  }

  /**
   * Find all editable elements and attach listeners
   */
  findAndAttachToEditableElements(): void {
    const allEditable = findAllEditableElements();
    allEditable.forEach((element) => {
      this.attachToEditableElement(element);
    });

    // Check Shadow DOM
    const shadowEditable = findEditableInShadowDOM(document.body);
    shadowEditable.forEach((element) => {
      this.attachToEditableElement(element);
    });
  }

  /**
   * Element için scroll listener'ları kaldır
   */
  removeElementScrollListeners(element: HTMLElement): void {
    const containers = this.scrollableContainers.get(element);
    if (!containers) return;

    // Check if any other elements use these containers
    containers.forEach((container) => {
      let isUsedByOthers = false;
      this.scrollableContainers.forEach((otherContainers, otherElement) => {
        if (otherElement !== element && otherContainers.has(container)) {
          isUsedByOthers = true;
        }
      });

      // If no other elements use this container, remove the listener
      if (!isUsedByOthers) {
        const listener = this.scrollListeners.get(container);
        if (listener) {
          container.removeEventListener("scroll", listener);
          this.scrollListeners.delete(container);
        }
      }
    });

    this.scrollableContainers.delete(element);
  }
}
