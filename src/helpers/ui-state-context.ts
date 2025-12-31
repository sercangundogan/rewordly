/**
 * UI State Context
 * UI helper'lar ve UI state'leri için context
 *
 * Bu context, UI ile ilgili tüm state'leri tek bir yerde toplar.
 */

import { RewriteButtonHelper, ModalHelper } from "./ui-helper";
import { HighlightContainerHelper } from "./highlight-helper";

/**
 * UI state işlemleri için context
 */
export class UIStateContext {
  constructor(
    public readonly rewriteButtonHelper: RewriteButtonHelper,
    public readonly modalHelper: ModalHelper,
    public readonly highlightHelper: HighlightContainerHelper,
    public readonly buttonBlurTimeout: {
      get: () => number | null;
      set: (value: number | null) => void;
    },
    public readonly currentFocusedElement: {
      get: () => HTMLElement | null;
      set: (value: HTMLElement | null) => void;
    },
    public readonly highlightPositionUpdateTimeout: {
      get: () => number | null;
      set: (value: number | null) => void;
    },
    public readonly aiButtonScrollListener: {
      get: () => (() => void) | null;
      set: (value: (() => void) | null) => void;
    }
  ) {}
}
