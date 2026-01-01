/**
 * Event Context
 * Event handling state'leri için context
 *
 * Bu context, event handling ile ilgili tüm state'leri tek bir yerde toplar.
 */

/**
 * Event handling işlemleri için context
 */
export class EventContext {
  constructor(
    public readonly boundHandleInput: (event: Event) => void,
    public readonly boundHandleFocus: (event: Event) => void,
    public readonly boundHandleBlur: (event: Event) => void,
    public readonly scheduledBlurHandlers: Map<HTMLElement, NodeJS.Timeout>,
    public readonly isPerformingReplace: {
      get: () => boolean;
      set: (value: boolean) => void;
    },
    public readonly isPerformingDismiss: {
      get: () => boolean;
      set: (value: boolean) => void;
    }
  ) {}
}



