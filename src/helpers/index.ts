/**
 * Helpers Index
 * Tüm helper'ları export eder
 * 
 * Bu dosya tüm helper fonksiyonlarını tek bir yerden export eder.
 * Basitçe: import { ... } from './helpers' şeklinde kullanılabilir.
 */

// UI Helpers
export { RewriteButtonHelper, ModalHelper, TooltipHelper } from './ui-helper';

// Element Helpers
export {
  isEditableElement,
  extractTextFromElement,
  isElementVisible,
  getElementId,
  findAllEditableElements,
  findEditableInElement,
  findEditableInShadowDOM,
  shouldIgnoreElement,
  isNodeInDocument
} from './element-helper';

// Config Helpers
export {
  loadConfig,
  isPageDisabled,
  isGrammarCheckAllowedSite,
  createPlatformAdapterForSite,
  generateErrorId
} from './config-helper';

// Grammar Check Helpers
export {
  checkGrammarAPI,
  getDismissKey,
  isErrorDismissed,
  dismissError,
  undismissError,
  filterDismissedErrors
} from './grammar-check-helper';

// Text Processing Helpers
export {
  mapInnerTextToTextNodes,
  extractTextExcludingSignature,
  updateErrorPositions,
  type TextNodeMapping
} from './text-processing-helper';

// Highlight Helpers
export {
  HighlightContainerHelper,
  getContentEditableErrorRects,
  getInputErrorRects
} from './highlight-helper';

