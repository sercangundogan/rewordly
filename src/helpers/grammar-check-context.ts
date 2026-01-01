/**
 * Grammar Check Context
 * Grammar check işlemleri için gerekli tüm state ve helper'lara erişim sağlar
 *
 * Bu context, grammar check ile ilgili tüm state'leri tek bir yerde toplar.
 */

import { GrammarError } from "../types";
import { RewordlyAPIUtil } from "../utils/api";

/**
 * Grammar check işlemleri için context
 */
export class GrammarCheckContext {
  constructor(
    public readonly grammarErrors: Map<HTMLElement, GrammarError[]>,
    public readonly activeGrammarRequests: Map<HTMLElement, string>,
    public readonly dismissedErrors: Map<string, boolean>,
    public readonly grammarCheckQueue: Array<{
      element: HTMLElement;
      priority?: number;
    }>,
    public readonly isProcessingQueue: {
      get: () => boolean;
      set: (value: boolean) => void;
    },
    public readonly grammarCheckTimeout: {
      get: () => number | null;
      set: (value: number | null) => void;
    },
    public readonly grammarCheckThrottle: {
      get: () => number | null;
      set: (value: number | null) => void;
    },
    public readonly apiUtil: RewordlyAPIUtil,
    public readonly BATCH_SIZE: number,
    public readonly BATCH_DELAY: number,
    public readonly GRAMMAR_CHECK_THROTTLE: number
  ) {}
}



