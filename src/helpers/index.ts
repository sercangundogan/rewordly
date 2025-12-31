/**
 * Helpers Index
 * Tüm helper'ları export eder
 *
 * Bu dosya tüm helper fonksiyonlarını tek bir yerden export eder.
 * Basitçe: import { ... } from './helpers' şeklinde kullanılabilir.
 */

// UI Helpers
export { RewriteButtonHelper, ModalHelper, TooltipHelper } from "./ui-helper";

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
  isNodeInDocument,
  findScrollableContainers,
  setupElementScrollListeners,
  removeElementScrollListeners,
  isSingleLineElement,
  getInputTextareaSelectionRect,
  findAndAttachToEditableElements,
  attachToEditableElement,
} from "./element-helper";

// Config Helpers
export {
  loadConfig,
  isPageDisabled,
  isGrammarCheckAllowedSite,
  createPlatformAdapterForSite,
  generateErrorId,
} from "./config-helper";

// Grammar Check Helpers
export {
  checkGrammarAPI,
  getDismissKey,
  isErrorDismissed,
  dismissError,
  undismissError,
  filterDismissedErrors,
  isElementIgnored,
  mockGrammarCheck,
  performGrammarCheckDirect,
  performGrammarCheck,
  queueGrammarCheck,
  processGrammarCheckQueue,
  checkAndPerformGrammarCheckForExistingText,
} from "./grammar-check-helper";

// Text Processing Helpers
export {
  mapInnerTextToTextNodes,
  extractTextExcludingSignature,
  updateErrorPositions,
  adjustErrorPositionsForMultiWord,
  escapeHtml,
  formatSuggestionForDisplay,
  type TextNodeMapping,
} from "./text-processing-helper";

// Highlight Helpers
export {
  HighlightContainerHelper,
  getContentEditableErrorRects,
  getInputErrorRects,
  getErrorTextRects,
  getInputTextareaErrorRects,
  getGoogleDocsErrorRects,
  closeAllGrammarTooltips,
  validateAndRemoveInvalidHighlights,
  createHighlight,
  displayGrammarErrors,
  attachHighlightHoverListener,
  showGrammarOverlay,
  clearGrammarErrors,
  clearAllGrammarErrors,
  hideAllGrammarHighlights,
} from "./highlight-helper";

// Text Replacement Helpers
export {
  replaceTextInDraftJS,
  replaceTextInContentEditable,
  replaceGrammarError,
} from "./text-replacement-helper";

// Event Handler Helpers
export {
  handleInput,
  handleFocus,
  handleBlur,
} from "./event-handler-helper";
