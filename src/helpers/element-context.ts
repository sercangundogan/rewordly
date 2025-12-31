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
}
