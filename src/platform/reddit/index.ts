/**
 * Reddit Platform Adapter (New Architecture)
 *
 * Implements PlatformAdapter interface for Reddit
 * Wraps existing helper logic to maintain compatibility
 *
 * TODO: Gradually migrate helper logic into this adapter
 */

import {
  PlatformAdapter,
  ChangeCallback,
  Unsubscribe,
} from "../base/PlatformAdapter";
import {
  DocumentSnapshot,
  Issue,
  Change,
  ApplyChangeResult,
  Viewport,
} from "../../core/contracts";
import {
  isEditableElement,
  getElementId,
  disableSpellCheck,
} from "../../helpers/element-helper";
import {
  displayGrammarErrors,
  HighlightContainerHelper,
  createHighlight as createHighlightHelper,
  attachHighlightHoverListener as attachHighlightHoverListenerHelper,
  getErrorTextRects,
  closeAllGrammarTooltips,
  validateAndRemoveInvalidHighlights,
  hideAllGrammarHighlights,
  showAllGrammarHighlights,
} from "../../helpers/highlight-helper";
import {
  extractText,
  adjustErrorPositionsForMultiWord,
} from "../../helpers/text-processing-helper";
import { getDismissKey } from "../../helpers/grammar-check-helper";
import { replaceGrammarError } from "../../helpers/text-replacement-helper";
import { GrammarError } from "../../types";
import { ChangeEmitter } from "../shared/changeEmitter";

/**
 * Reddit Platform Adapter
 * Handles Reddit-specific DOM operations
 */
export class RedditPlatformAdapter implements PlatformAdapter {
  readonly platform = "reddit";

  private editableElements: Set<HTMLElement> = new Set();
  private observer: MutationObserver | null = null;
  private changeEmitter: ChangeEmitter;
  private currentElement: HTMLElement | null = null;
  private isInitialized: boolean = false; // Prevent double initialization
  private highlightHelper: HighlightContainerHelper =
    new HighlightContainerHelper();
  private grammarErrors: Map<HTMLElement, GrammarError[]> = new Map();
  private dismissedErrors: Map<string, boolean> = new Map();
  private scheduledBlurHandlers: Map<HTMLElement, number> = new Map();
  private elementPositions: Map<HTMLElement, { top: number; left: number }> =
    new Map();
  private resizeObservers: Map<HTMLElement, ResizeObserver> = new Map();
  private scrollListeners: Map<HTMLElement, () => void> = new Map(); // Scroll listeners for each element
  private isCommentSearchOpen: boolean = false;
  private isPerformingReplace: boolean = false; // Flag to track replace operations
  private currentUrl: string = "";
  private urlCheckInterval: number | null = null;
  private messageTextareaScanInterval: number | null = null;

  constructor() {
    this.changeEmitter = new ChangeEmitter(this.platform);
  }

  /**
   * Check if adapter is enabled for current page
   */
  isEnabled(): boolean {
    return window.location.hostname.toLowerCase().includes("reddit.com");
  }

  /**
   * Initialize the adapter
   * STEP 4: Ensure single observer, prevent double initialization
   */
  initialize(): void {
    if (!this.isEnabled()) {
      return;
    }

    // Prevent double initialization
    if (this.isInitialized) {
      console.warn("Rewordly: Reddit adapter already initialized, skipping");
      return;
    }

    console.log("Rewordly: Reddit adapter (new architecture) initializing...");

    // Reddit-specific styles
    this.setupRedditStyles();

    // Find and attach to editable elements
    this.findAndAttachToEditableElements();

    // Set up SINGLE mutation observer for new elements
    // Ensure previous observer is cleaned up (shouldn't happen, but safety check)
    if (this.observer) {
      this.observer.disconnect();
    }

    this.observer = new MutationObserver((mutations) => {
      let shouldUpdatePositions = false;
      const currentElement =
        this.currentElement || this.getFirstEditableElement();

      // Check if comment search input is open/visible
      this.checkCommentSearchState();

      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const element = node as HTMLElement;

            // Check if this element itself is a message textarea
            if (element.tagName?.toLowerCase() === "textarea") {
              const name = element.getAttribute("name");
              const ariaLabel = element.getAttribute("aria-label");
              const placeholder = element.getAttribute("placeholder");
              const isMessageTextarea =
                name === "message" ||
                ariaLabel === "Write message" ||
                placeholder === "Message";

              if (isMessageTextarea) {
                console.log(
                  "Rewordly: MutationObserver detected message textarea directly",
                  {
                    element,
                    name,
                    ariaLabel,
                    placeholder,
                    alreadyAttached: this.editableElements.has(element),
                  }
                );
                this.attachToEditableElement(element);
              }
            }

            this.attachToEditableElement(element);
            this.findEditableInElement(element);

            // Special handling for message-box and form elements
            // These might contain textareas that need to be attached
            if (
              element.classList?.contains("message-box") ||
              element.tagName?.toLowerCase() === "form" ||
              element.querySelector?.(".message-box") ||
              element.closest?.(".message-box")
            ) {
              // Find textarea inside message-box or form
              const messageTextarea = element.querySelector?.(
                'textarea[name="message"], textarea[aria-label="Write message"], textarea[placeholder="Message"]'
              ) as HTMLTextAreaElement | null;

              if (
                messageTextarea &&
                !this.editableElements.has(messageTextarea)
              ) {
                console.log(
                  "Rewordly: Found message textarea in message-box/form",
                  {
                    messageTextarea,
                    parent: element,
                    name: messageTextarea.getAttribute("name"),
                    ariaLabel: messageTextarea.getAttribute("aria-label"),
                    placeholder: messageTextarea.getAttribute("placeholder"),
                  }
                );
                this.attachToEditableElement(messageTextarea);
              }
            }

            // If a textarea is added, check if it's inside a message-box or form with message-box
            if (element.tagName?.toLowerCase() === "textarea") {
              const messageBox = element.closest?.(".message-box");
              const formWithMessageBox = element.closest?.(
                "form:has(.message-box)"
              );
              if (
                (messageBox || formWithMessageBox) &&
                !this.editableElements.has(element)
              ) {
                const name = element.getAttribute("name");
                const ariaLabel = element.getAttribute("aria-label");
                const placeholder = element.getAttribute("placeholder");
                console.log(
                  "Rewordly: Found textarea inside message-box/form",
                  {
                    element,
                    name,
                    ariaLabel,
                    placeholder,
                    messageBox: !!messageBox,
                    formWithMessageBox: !!formWithMessageBox,
                  }
                );
                this.attachToEditableElement(element);
              }
            }

            // Also check parent chain for message-box or form containing message textarea
            let parent = element.parentElement;
            let depth = 0;
            while (parent && depth < 5) {
              const messageTextareaInParent = parent.querySelector?.(
                'textarea[name="message"], textarea[aria-label="Write message"], textarea[placeholder="Message"]'
              ) as HTMLTextAreaElement | null;

              if (
                messageTextareaInParent &&
                !this.editableElements.has(messageTextareaInParent)
              ) {
                const hasMessageBox =
                  parent.classList?.contains("message-box") ||
                  parent.querySelector?.(".message-box") ||
                  parent.closest?.(".message-box");
                const isForm = parent.tagName?.toLowerCase() === "form";

                if (hasMessageBox || isForm) {
                  console.log(
                    "Rewordly: Found message textarea in parent chain",
                    {
                      messageTextarea: messageTextareaInParent,
                      parent,
                      depth,
                      name: messageTextareaInParent.getAttribute("name"),
                      ariaLabel:
                        messageTextareaInParent.getAttribute("aria-label"),
                      placeholder:
                        messageTextareaInParent.getAttribute("placeholder"),
                    }
                  );
                  this.attachToEditableElement(messageTextareaInParent);
                  break; // Found it, no need to continue
                }
              }
              parent = parent.parentElement;
              depth++;
            }

            // Check if this is the comment search input or shreddit-async-loader
            if (
              element.tagName?.toLowerCase() === "pdp-comment-search-input" ||
              element.querySelector?.("pdp-comment-search-input") ||
              (element.tagName?.toLowerCase() === "shreddit-async-loader" &&
                element.getAttribute("bundlename") === "comment_composer") ||
              element.querySelector?.(
                'shreddit-async-loader[bundlename="comment_composer"]'
              )
            ) {
              this.checkCommentSearchState();
            }

            // CRITICAL: Check if this is Reddit chat related (nested shadow DOM)
            // Reddit chat uses: rs-app -> rs-room -> rs-message-composer (all with shadow roots)
            const isRedditChatRelated =
              element.tagName?.toLowerCase() === "rs-app" ||
              element.tagName?.toLowerCase() === "rs-room" ||
              element.tagName?.toLowerCase() === "rs-message-composer" ||
              element.querySelector?.("rs-app") ||
              element.querySelector?.("rs-room") ||
              element.querySelector?.("rs-message-composer") ||
              element.closest?.("rs-app") ||
              element.closest?.("rs-room") ||
              element.closest?.("rs-message-composer") ||
              element.getAttribute?.("data-testid") === "reddit-chat-client";

            if (isRedditChatRelated) {
              console.log(
                "Rewordly: MutationObserver detected Reddit chat related element",
                element.tagName
              );

              // Use specialized function to find message textarea in nested shadow DOM
              // Wait a bit for shadow DOMs to be ready
              setTimeout(() => {
                const messageTextarea = this.findMessageTextareaInRedditChat();
                if (
                  messageTextarea &&
                  !this.editableElements.has(messageTextarea)
                ) {
                  console.log(
                    "Rewordly: ✅ MutationObserver found message textarea in nested shadow DOM"
                  );
                  this.attachToEditableElement(messageTextarea);
                  // Trigger grammar check when message composer opens
                  setTimeout(() => {
                    if (this.editableElements.has(messageTextarea)) {
                      this.currentElement = messageTextarea;
                      this.changeEmitter.setCurrentElement(messageTextarea);
                      const { text } = extractText(messageTextarea);
                      this.changeEmitter.setLastText(messageTextarea, text);
                      this.changeEmitter.notifyChange(
                        () => messageTextarea,
                        extractText,
                        getElementId,
                        true // Force notification
                      );
                    }
                  }, 100);
                }
              }, 200);

              // Also try again after a longer delay (shadow DOMs might load asynchronously)
              setTimeout(() => {
                const messageTextarea = this.findMessageTextareaInRedditChat();
                if (
                  messageTextarea &&
                  !this.editableElements.has(messageTextarea)
                ) {
                  console.log(
                    "Rewordly: ✅ MutationObserver found message textarea (retry)"
                  );
                  this.attachToEditableElement(messageTextarea);
                }
              }, 500);
            }

            // Check if this is Reddit chat client
            const isRedditChatClient =
              element.getAttribute?.("data-testid") === "reddit-chat-client" ||
              element.closest?.('[data-testid="reddit-chat-client"]') ||
              element.tagName?.toLowerCase() === "rs-message-composer" ||
              element.querySelector?.("rs-message-composer") ||
              element.closest?.("rs-message-composer");

            if (isRedditChatClient) {
              // Chat client opened or became visible, find all editable elements inside
              const chatClient =
                element.getAttribute?.("data-testid") === "reddit-chat-client"
                  ? element
                  : element.closest?.('[data-testid="reddit-chat-client"]') ||
                    element;

              // Check if chat client is visible (not hidden)
              const isChatVisible =
                chatClient &&
                !chatClient.classList?.contains("hidden") &&
                (chatClient as HTMLElement).offsetParent !== null;

              if (isChatVisible) {
                // Find all editable elements in chat client (regular DOM)
                const editableSelectors = [
                  "textarea",
                  '[contenteditable="true"]',
                  'textarea[name="message"]',
                  'textarea[aria-label*="message" i]',
                  'textarea[placeholder*="message" i]',
                ];

                editableSelectors.forEach((selector) => {
                  const editableElements = (
                    chatClient as HTMLElement
                  ).querySelectorAll(selector);
                  editableElements.forEach((editableEl) => {
                    const editableElement = editableEl as HTMLElement;
                    if (
                      isEditableElement(editableElement) &&
                      !this.editableElements.has(editableElement)
                    ) {
                      this.attachToEditableElement(editableElement);
                      console.log(
                        "Rewordly: Attached to Reddit chat editable element",
                        editableElement
                      );
                    }
                  });
                });

                // CRITICAL: Also check shadow DOM in chat client
                if ((chatClient as HTMLElement).shadowRoot) {
                  const shadowEditableElements = this.findEditableInShadowDOM(
                    (chatClient as HTMLElement).shadowRoot!
                  );
                  shadowEditableElements.forEach((editableElement) => {
                    if (!this.editableElements.has(editableElement)) {
                      this.attachToEditableElement(editableElement);
                      console.log(
                        "Rewordly: Attached to Reddit chat editable element in shadow DOM",
                        editableElement
                      );
                    }
                  });
                }
              }
            }

            // Check if this is a message composer (message box)
            // Message composer can be detected by form with message-box class or textarea[name="message"]
            const isMessageComposer =
              element.classList?.contains("message-box") ||
              element.querySelector?.(".message-box") ||
              element.querySelector?.('textarea[name="message"]') ||
              element.querySelector?.('textarea[aria-label="Write message"]') ||
              (element.tagName?.toLowerCase() === "form" &&
                element.querySelector?.('textarea[name="message"]')) ||
              (element.tagName?.toLowerCase() === "textarea" &&
                (element.getAttribute("name") === "message" ||
                  element.getAttribute("aria-label") === "Write message"));

            if (isMessageComposer) {
              // Find and attach to message textarea
              const messageTextarea =
                element.tagName?.toLowerCase() === "textarea"
                  ? (element as HTMLTextAreaElement)
                  : (element.querySelector(
                      'textarea[name="message"], textarea[aria-label="Write message"]'
                    ) as HTMLTextAreaElement | null);

              if (messageTextarea) {
                this.attachToEditableElement(messageTextarea);
                // Trigger grammar check when message composer opens
                setTimeout(() => {
                  if (this.editableElements.has(messageTextarea)) {
                    this.currentElement = messageTextarea;
                    this.changeEmitter.setCurrentElement(messageTextarea);
                    const { text } = extractText(messageTextarea);
                    this.changeEmitter.setLastText(messageTextarea, text);
                    this.changeEmitter.notifyChange(
                      () => messageTextarea, // Use messageTextarea directly
                      extractText,
                      getElementId,
                      true // Force notification
                    );
                  }
                }, 100);
              }
            }

            // Check if this is a toolbar or formatting element that might affect positions
            // Reddit's formatting toolbar can be detected by class names or tag names
            const isToolbarRelated =
              element.tagName?.toLowerCase().includes("toolbar") ||
              element.classList?.toString().toLowerCase().includes("toolbar") ||
              element.classList?.toString().toLowerCase().includes("format") ||
              element.querySelector?.("toolbar") ||
              element.closest?.("reddit-rte") ||
              element.closest?.("shreddit-composer") ||
              element.closest?.('[slot="toolbar"]') ||
              element.closest?.('[slot="rte-toolbar"]') ||
              element.closest?.('[slot="toolbar-additions"]') ||
              element.hasAttribute?.("data-show-formatting-bar");

            if (isToolbarRelated) {
              shouldUpdatePositions = true;
            }
          }
        });

        // Also detect text changes in editable elements
        if (
          mutation.type === "characterData" ||
          mutation.type === "childList"
        ) {
          // Check if mutation is in an editable element
          let target = mutation.target as HTMLElement;
          if (target.nodeType === Node.TEXT_NODE) {
            target = target.parentElement as HTMLElement;
          }

          let editableElement: HTMLElement | null = null;
          if (target && isEditableElement(target)) {
            editableElement = target;
          } else if (target) {
            // Check if mutation is inside an editable element
            const editableParent = target.closest(
              'textarea, [contenteditable="true"]'
            ) as HTMLElement;
            if (editableParent && isEditableElement(editableParent)) {
              editableElement = editableParent;
            }
          }

          if (editableElement) {
            this.currentElement = editableElement;
            this.changeEmitter.setCurrentElement(editableElement);

            // STEP 4: Skip aggressive validation - anchor system handles remapping
            // The orchestrator will remap anchors immediately on change, so we don't need
            // to validate and remove highlights here. This prevents highlights from
            // disappearing before the anchor remapping happens.
            // validateAndRemoveInvalidHighlights is now only called during replace operations
            // where it's needed to prevent stale highlights.

            this.changeEmitter.notifyChange(
              () => this.getFirstEditableElement(),
              extractText,
              getElementId
            );
          }
        }

        // Check for removed nodes (e.g., comment search input being removed)
        mutation.removedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const element = node as HTMLElement;
            // Check if comment search input or shreddit-async-loader was removed
            if (
              element.tagName?.toLowerCase() === "pdp-comment-search-input" ||
              element.querySelector?.("pdp-comment-search-input") ||
              (element.tagName?.toLowerCase() === "shreddit-async-loader" &&
                element.getAttribute("bundlename") === "comment_composer") ||
              element.querySelector?.(
                'shreddit-async-loader[bundlename="comment_composer"]'
              )
            ) {
              this.checkCommentSearchState();
            }
          }
        });

        // Check for attribute changes that might affect layout (like toolbar opening)
        if (mutation.type === "attributes") {
          const target = mutation.target as HTMLElement;

          // Check if this is the comment search input or shreddit-async-loader
          if (
            target.tagName?.toLowerCase() === "pdp-comment-search-input" ||
            target.closest?.("pdp-comment-search-input") ||
            (target.tagName?.toLowerCase() === "shreddit-async-loader" &&
              target.getAttribute("bundlename") === "comment_composer") ||
            target.closest?.(
              'shreddit-async-loader[bundlename="comment_composer"]'
            )
          ) {
            // Especially check for class changes (hidden class being added/removed)
            if (mutation.attributeName === "class") {
              // Directly check if hidden class is present and hide/show highlights immediately
              const isHidden = target.classList.contains("hidden");
              if (isHidden && !this.isCommentSearchOpen) {
                // Search just opened - hide highlights immediately
                this.isCommentSearchOpen = true;
                hideAllGrammarHighlights({
                  highlightHelper: this.highlightHelper,
                });
              } else if (!isHidden && this.isCommentSearchOpen) {
                // Search just closed - show highlights immediately
                this.isCommentSearchOpen = false;
                showAllGrammarHighlights({
                  highlightHelper: this.highlightHelper,
                });
              } else {
                // Fallback to full state check
                this.checkCommentSearchState();
              }
            }
          }

          // Check for data-show-formatting-bar attribute change (Reddit toolbar toggle)
          if (mutation.attributeName === "data-show-formatting-bar") {
            shouldUpdatePositions = true;
          }

          // Check if this is related to toolbar or formatting
          const isToolbarRelated =
            target.tagName?.toLowerCase().includes("toolbar") ||
            target.classList?.toString().toLowerCase().includes("toolbar") ||
            target.classList?.toString().toLowerCase().includes("format") ||
            target.closest?.("reddit-rte") ||
            target.closest?.("shreddit-composer") ||
            target.closest?.('[contenteditable="true"]') ||
            target.closest?.('[slot="toolbar"]') ||
            target.closest?.('[slot="rte-toolbar"]') ||
            target.closest?.('[slot="toolbar-additions"]') ||
            target.hasAttribute?.("data-show-formatting-bar");

          if (isToolbarRelated) {
            shouldUpdatePositions = true;
          }

          // Also check for style/class changes that might affect layout
          if (
            mutation.attributeName === "style" ||
            mutation.attributeName === "class" ||
            mutation.attributeName === "hidden" ||
            mutation.attributeName === "aria-expanded"
          ) {
            // Check if this is Reddit chat client that just became visible
            const isRedditChatClient =
              target.getAttribute?.("data-testid") === "reddit-chat-client" ||
              target.closest?.('[data-testid="reddit-chat-client"]') ||
              target.tagName?.toLowerCase() === "rs-message-composer" ||
              target.closest?.("rs-message-composer");

            if (isRedditChatClient) {
              const chatClient =
                target.getAttribute?.("data-testid") === "reddit-chat-client"
                  ? target
                  : target.closest?.('[data-testid="reddit-chat-client"]') ||
                    target;

              // Check if chat client is visible (not hidden)
              const isChatVisible =
                chatClient &&
                !chatClient.classList?.contains("hidden") &&
                (chatClient as HTMLElement).offsetParent !== null;

              if (isChatVisible) {
                // Find all editable elements in chat client
                const editableSelectors = [
                  "textarea",
                  '[contenteditable="true"]',
                  'textarea[name="message"]',
                  'textarea[aria-label*="message" i]',
                  'textarea[placeholder*="message" i]',
                ];

                editableSelectors.forEach((selector) => {
                  const editableElements = (
                    chatClient as HTMLElement
                  ).querySelectorAll(selector);
                  editableElements.forEach((editableEl) => {
                    const editableElement = editableEl as HTMLElement;
                    if (
                      isEditableElement(editableElement) &&
                      !this.editableElements.has(editableElement)
                    ) {
                      this.attachToEditableElement(editableElement);
                      console.log(
                        "Rewordly: Attached to Reddit chat editable element (attribute change)",
                        editableElement
                      );

                      // If this element gets focus, trigger grammar check
                      setTimeout(() => {
                        if (this.editableElements.has(editableElement)) {
                          // Check if element is focused
                          if (document.activeElement === editableElement) {
                            this.currentElement = editableElement;
                            this.changeEmitter.setCurrentElement(
                              editableElement
                            );
                            const { text } = extractText(editableElement);
                            this.changeEmitter.setLastText(
                              editableElement,
                              text
                            );
                            this.changeEmitter.notifyChange(
                              () => editableElement,
                              extractText,
                              getElementId,
                              true // Force notification
                            );
                          }
                        }
                      }, 100);
                    }
                  });
                });
              }
            }

            // CRITICAL: Check if this is Reddit chat related (nested shadow DOM)
            const isRedditChatRelated =
              target.tagName?.toLowerCase() === "rs-app" ||
              target.tagName?.toLowerCase() === "rs-room" ||
              target.tagName?.toLowerCase() === "rs-message-composer" ||
              target.closest?.("rs-app") ||
              target.closest?.("rs-room") ||
              target.closest?.("rs-message-composer") ||
              target.getAttribute?.("data-testid") === "reddit-chat-client";

            if (isRedditChatRelated) {
              console.log(
                "Rewordly: Attribute change detected on Reddit chat element",
                target.tagName
              );

              // Use specialized function to find message textarea in nested shadow DOM
              setTimeout(() => {
                const messageTextarea = this.findMessageTextareaInRedditChat();
                if (
                  messageTextarea &&
                  !this.editableElements.has(messageTextarea)
                ) {
                  console.log(
                    "Rewordly: ✅ Found message textarea in nested shadow DOM (attribute change)"
                  );
                  this.attachToEditableElement(messageTextarea);
                  // Trigger grammar check when message composer opens
                  setTimeout(() => {
                    if (this.editableElements.has(messageTextarea)) {
                      this.currentElement = messageTextarea;
                      this.changeEmitter.setCurrentElement(messageTextarea);
                      const { text } = extractText(messageTextarea);
                      this.changeEmitter.setLastText(messageTextarea, text);
                      this.changeEmitter.notifyChange(
                        () => messageTextarea,
                        extractText,
                        getElementId,
                        true // Force notification
                      );
                    }
                  }, 100);
                }
              }, 200);
            }

            // Check if this is a message composer that just became visible
            const isMessageComposerRelated =
              target.classList?.contains("message-box") ||
              target.closest?.(".message-box") ||
              target.querySelector?.('textarea[name="message"]') ||
              target.querySelector?.('textarea[aria-label="Write message"]') ||
              (target.tagName?.toLowerCase() === "form" &&
                target.querySelector?.('textarea[name="message"]')) ||
              target.closest?.('form:has(textarea[name="message"])');

            if (isMessageComposerRelated) {
              // Check if message composer is visible (not hidden)
              const messageBox = target.classList?.contains("message-box")
                ? target
                : ((target.querySelector?.(".message-box") ||
                    target.closest?.(".message-box")) as HTMLElement | null);
              const isVisible =
                messageBox &&
                !messageBox.classList?.contains("hidden") &&
                (messageBox as HTMLElement).offsetParent !== null;

              if (isVisible) {
                // Find and attach to message textarea (regular DOM)
                const messageTextarea = (target.querySelector?.(
                  'textarea[name="message"], textarea[aria-label="Write message"]'
                ) ||
                  messageBox?.querySelector?.(
                    'textarea[name="message"], textarea[aria-label="Write message"]'
                  )) as HTMLTextAreaElement | null;

                if (
                  messageTextarea &&
                  !this.editableElements.has(messageTextarea)
                ) {
                  this.attachToEditableElement(messageTextarea);
                  // Trigger grammar check when message composer opens
                  setTimeout(() => {
                    if (this.editableElements.has(messageTextarea)) {
                      this.currentElement = messageTextarea;
                      this.changeEmitter.setCurrentElement(messageTextarea);
                      const { text } = extractText(messageTextarea);
                      this.changeEmitter.setLastText(messageTextarea, text);
                      this.changeEmitter.notifyChange(
                        () => messageTextarea, // Use messageTextarea directly
                        extractText,
                        getElementId,
                        true // Force notification
                      );
                    }
                  }, 100);
                }
              }
            }

            // Check if this is related to comment search (check state when hidden/class changes)
            if (
              target.tagName?.toLowerCase() === "pdp-comment-search-input" ||
              target.closest?.("pdp-comment-search-input") ||
              (target.tagName?.toLowerCase() === "shreddit-async-loader" &&
                target.getAttribute("bundlename") === "comment_composer") ||
              target.closest?.(
                'shreddit-async-loader[bundlename="comment_composer"]'
              )
            ) {
              // Directly check if hidden class is present for shreddit-async-loader
              if (
                target.tagName?.toLowerCase() === "shreddit-async-loader" &&
                target.getAttribute("bundlename") === "comment_composer"
              ) {
                const isHidden = target.classList.contains("hidden");
                if (isHidden && !this.isCommentSearchOpen) {
                  // Search just opened - hide highlights immediately
                  this.isCommentSearchOpen = true;
                  hideAllGrammarHighlights({
                    highlightHelper: this.highlightHelper,
                  });
                } else if (!isHidden && this.isCommentSearchOpen) {
                  // Search just closed - show highlights immediately
                  this.isCommentSearchOpen = false;
                  showAllGrammarHighlights({
                    highlightHelper: this.highlightHelper,
                  });
                }
              } else {
                // Fallback to full state check for other elements
                this.checkCommentSearchState();
              }
            }

            // Check if this is near the editable element
            if (currentElement) {
              const isNearEditable =
                target === currentElement ||
                target.contains(currentElement) ||
                currentElement.contains(target) ||
                target.closest?.("reddit-rte") ===
                  currentElement.closest?.("reddit-rte") ||
                target.closest?.("shreddit-composer") ===
                  currentElement.closest?.("shreddit-composer");

              if (isNearEditable) {
                shouldUpdatePositions = true;
              }
            }
          }
        }
      });

      // Check if element position changed (indicates layout shift)
      // Also check parent container position for toolbar-related shifts
      if (currentElement) {
        const rect = currentElement.getBoundingClientRect();
        const lastPosition = this.elementPositions.get(currentElement);

        // Check element position
        if (lastPosition) {
          const positionChanged =
            Math.abs(rect.top - lastPosition.top) > 1 ||
            Math.abs(rect.left - lastPosition.left) > 1;

          if (positionChanged) {
            shouldUpdatePositions = true;
          }
        }

        // Also check parent container (reddit-rte or shreddit-composer) position for toolbar shifts
        const parentContainer =
          currentElement.closest("reddit-rte") ||
          currentElement.closest("shreddit-composer");
        if (parentContainer) {
          const parentRect = parentContainer.getBoundingClientRect();
          const lastParentPosition = this.elementPositions.get(
            parentContainer as HTMLElement
          );

          if (lastParentPosition) {
            const parentPositionChanged =
              Math.abs(parentRect.top - lastParentPosition.top) > 1 ||
              Math.abs(parentRect.left - lastParentPosition.left) > 1;

            if (parentPositionChanged) {
              shouldUpdatePositions = true;
            }
          }

          // Update stored parent position
          this.elementPositions.set(parentContainer as HTMLElement, {
            top: parentRect.top,
            left: parentRect.left,
          });
        }

        // Update stored position
        this.elementPositions.set(currentElement, {
          top: rect.top,
          left: rect.left,
        });
      }

      // Update highlight positions if toolbar or layout changed
      if (shouldUpdatePositions && currentElement) {
        if (this.grammarErrors.has(currentElement)) {
          const errors = this.grammarErrors.get(currentElement) || [];
          if (errors.length > 0) {
            // Use multiple requestAnimationFrame calls to ensure DOM has fully settled
            // Toolbar animations can take time
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                  this.highlightHelper.updatePositions(
                    currentElement!,
                    errors,
                    (error: GrammarError) =>
                      getErrorTextRects(currentElement!, error.start, error.end)
                  );
                });
              });
            });

            // Also schedule an additional update after a short delay
            // This catches any delayed layout changes from toolbar animations
            setTimeout(() => {
              if (this.grammarErrors.has(currentElement)) {
                const delayedErrors =
                  this.grammarErrors.get(currentElement) || [];
                if (delayedErrors.length > 0) {
                  this.highlightHelper.updatePositions(
                    currentElement!,
                    delayedErrors,
                    (error: GrammarError) =>
                      getErrorTextRects(currentElement!, error.start, error.end)
                  );
                }
              }
            }, 100);
          }
        }
      }
    });

    if (document.body) {
      this.observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [
          "contenteditable",
          "data-show-formatting-bar", // Track Reddit toolbar state
          "style",
          "class", // Track class changes (e.g., hidden class on shreddit-async-loader)
          "hidden",
          "aria-expanded",
        ],
        characterData: true, // Detect text changes
      });
    }

    // Set up ResizeObserver for editable elements to catch layout changes
    this.setupResizeObservers();

    // Set up input listeners for change detection
    this.setupInputListeners();

    // Check for existing text in editable elements and trigger initial check
    this.checkExistingTextAndNotify();

    // Set up URL change detection for SPA navigation
    this.setupUrlChangeDetection();

    // Set up periodic scan for message textareas (in case they're missed by MutationObserver)
    this.setupPeriodicMessageTextareaScan();

    this.isInitialized = true;
  }

  /**
   * Cleanup resources
   * STEP 4: Ensure clean unsubscribe, no memory leaks
   */
  cleanup(): void {
    // Disconnect observer
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }

    // Remove event listeners
    this.removeInputListeners();

    // Remove direct event listeners from shadow DOM elements
    this.editableElements.forEach((element) => {
      element.removeEventListener("input", this.handleInputDirect, true);
      element.removeEventListener("focusin", this.handleFocusDirect, true);
      element.removeEventListener(
        "compositionupdate",
        this.handleInputDirect,
        true
      );
      element.removeEventListener(
        "compositionend",
        this.handleInputDirect,
        true
      );
    });

    // Remove URL change detection
    this.removeUrlChangeDetection();

    // Remove periodic message textarea scan
    this.removePeriodicMessageTextareaScan();

    // Cleanup change emitter
    this.changeEmitter.cleanup();

    // Clear element tracking
    this.editableElements.clear();
    this.elementPositions.clear();

    // Disconnect all ResizeObservers
    this.resizeObservers.forEach((observer) => {
      observer.disconnect();
    });
    this.resizeObservers.clear();

    // Remove all scroll listeners
    this.scrollListeners.forEach((listener, element) => {
      const scrollContainer = this.findScrollContainer(element);
      if (scrollContainer && scrollContainer !== window) {
        (scrollContainer as HTMLElement).removeEventListener(
          "scroll",
          listener,
          true
        );
      } else {
        window.removeEventListener("scroll", listener, true);
      }
    });
    this.scrollListeners.clear();

    // Clear grammar errors
    this.grammarErrors.clear();
    this.dismissedErrors.clear();
    this.scheduledBlurHandlers.clear();

    // Cleanup highlight helper
    this.highlightHelper.cleanup();

    // Reset state
    this.currentElement = null;
    this.changeEmitter.setCurrentElement(null);
    this.isInitialized = false;
    this.currentUrl = "";
  }

  /**
   * Get current document snapshot
   * For Reddit, we track the focused element
   * STEP 4: Ensure version increments correctly on every meaningful change
   */
  getSnapshot(): DocumentSnapshot {
    return this.changeEmitter.getSnapshot(
      () => this.getFirstEditableElement(),
      extractText,
      getElementId
    );
  }

  /**
   * Observe document changes
   */
  observeChanges(callback: ChangeCallback): Unsubscribe {
    return this.changeEmitter.observeChanges(callback);
  }

  /**
   * Render issues on the document
   * Maps platform-agnostic issues to DOM highlights
   *
   * STEP 4: With anchor system, issues already have remapped positions.
   * The displayGrammarErrors function will reuse existing highlights by issue.id
   * and update their positions instead of recreating them.
   */
  renderIssues(issues: Issue[], _snapshotVersion: number): void {
    const element = this.currentElement || this.getFirstEditableElement();

    if (!element) {
      return;
    }

    // Convert Issue[] to GrammarError[] for existing helper
    const grammarErrorsArray: GrammarError[] = issues.map((issue) => ({
      id: issue.id,
      start: issue.start,
      end: issue.end,
      word: issue.word,
      suggestions: issue.suggestions,
      type: issue.type,
    }));

    // Create wrapper for createHighlight with all required dependencies
    const createHighlightWrapper = (
      elem: HTMLElement,
      error: GrammarError,
      index: number,
      animate: boolean
    ): void => {
      const highlightsContent = this.highlightHelper.getContent();
      createHighlightHelper(
        elem,
        error,
        index,
        highlightsContent,
        (el: HTMLElement, start: number, end: number) =>
          getErrorTextRects(el, start, end),
        extractText,
        adjustErrorPositionsForMultiWord,
        getElementId,
        (el: HTMLElement, err: GrammarError) => {
          const elementId = getElementId(el);
          const { text } = extractText(el);
          const dismissKey = getDismissKey(elementId, err, text);
          return this.dismissedErrors.get(dismissKey) === true;
        },
        attachHighlightHoverListenerWrapper,
        animate
      );

      // CRITICAL: After creating highlight, check if it's outside message container
      // and hide it if necessary
      setTimeout(() => {
        this.checkAndHideHighlightsOutsideContainer(elem);
      }, 0);
    };

    // Create wrapper for attachHighlightHoverListener with all required dependencies
    const attachHighlightHoverListenerWrapper = (
      highlight: HTMLElement,
      error: GrammarError,
      elem: HTMLElement
    ): void => {
      attachHighlightHoverListenerHelper(highlight, error, elem, {
        grammarErrors: this.grammarErrors,
        dismissedErrors: this.dismissedErrors,
        highlightsContent: this.highlightHelper.getContent(),
        replaceGrammarError: (
          el: HTMLElement,
          targetError: GrammarError,
          replacement: string
        ) => {
          replaceGrammarError(el, targetError, replacement, {
            grammarErrors: this.grammarErrors,
            highlightsContent: this.highlightHelper.getContent(),
            isPerformingReplace: {
              get: () => this.isPerformingReplace,
              set: (value: boolean) => {
                this.isPerformingReplace = value;
              },
            },
            highlightHelper: this.highlightHelper,
            scheduledBlurHandlers: this.scheduledBlurHandlers,
            performGrammarCheck: async () => {
              // Grammar check will be triggered after replace is complete
            },
          });
        },
        closeAllGrammarTooltips,
        scheduledBlurHandlers: this.scheduledBlurHandlers,
        isPerformingDismiss: { value: false },
        getElementId,
      });
    };

    // Use existing helper to display errors
    displayGrammarErrors(element, grammarErrorsArray, {
      grammarErrors: this.grammarErrors,
      highlightHelper: this.highlightHelper,
      dismissedErrors: this.dismissedErrors,
      isErrorDismissed: (el: HTMLElement, err: GrammarError) => {
        const elementId = getElementId(el);
        const { text } = extractText(el);
        const dismissKey = getDismissKey(elementId, err, text);
        return this.dismissedErrors.get(dismissKey) === true;
      },
      createHighlight: createHighlightWrapper,
      attachHighlightHoverListener: attachHighlightHoverListenerWrapper,
      highlightsContent: this.highlightHelper.getContent(),
      isPerformingReplace: this.isPerformingReplace,
    });

    // CRITICAL: After rendering, check and hide highlights outside message container
    // Use setTimeout to ensure highlights are rendered first
    setTimeout(() => {
      this.checkAndHideHighlightsOutsideContainer(element);
    }, 0);
  }

  /**
   * Apply a change to the document
   */
  applyChange(change: Change): ApplyChangeResult {
    const element = this.currentElement || this.getFirstEditableElement();

    if (!element) {
      const version = 0;

      return {
        success: false,
        newVersion: version,
        error: "No editable element available",
      };
    }

    try {
      if (change.type === "replace") {
        // Use existing helper for text replacement
        // TODO: Migrate to new system
        const grammarError: GrammarError = {
          id: "",
          start: change.range.start,
          end: change.range.end,
          word: "",
          suggestions: [change.text],
          type: "grammar",
        };

        // Set flag to prevent highlight validation during replace
        this.isPerformingReplace = true;

        replaceGrammarError(element, grammarError, change.text, {
          grammarErrors: this.grammarErrors,
          highlightsContent: this.highlightHelper.getContent(),
          isPerformingReplace: {
            get: () => this.isPerformingReplace,
            set: (value: boolean) => {
              this.isPerformingReplace = value;
            },
          },
          highlightHelper: this.highlightHelper,
          scheduledBlurHandlers: this.scheduledBlurHandlers,
          performGrammarCheck: async () => {
            // Grammar check will be triggered after replace is complete
          },
        });

        // Increment version
        const newVersion = this.changeEmitter.incrementVersion(element);

        return {
          success: true,
          newVersion,
          snapshot: this.getSnapshot(),
        };
      } else if (change.type === "insert") {
        // TODO: Implement insert
        const version = this.changeEmitter.getVersion(element);
        return {
          success: false,
          newVersion: version,
          error: "Insert not yet implemented",
        };
      } else if (change.type === "delete") {
        // TODO: Implement delete
        const version = this.changeEmitter.getVersion(element);
        return {
          success: false,
          newVersion: version,
          error: "Delete not yet implemented",
        };
      }

      const version = this.changeEmitter.getVersion(element);
      return {
        success: false,
        newVersion: version,
        error: "Unknown change type",
      };
    } catch (error) {
      const element = this.currentElement || this.getFirstEditableElement();
      const version = element ? this.changeEmitter.getVersion(element) : 0;

      return {
        success: false,
        newVersion: version,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Get current viewport
   */
  getViewport(): Viewport {
    return {
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      width: window.innerWidth,
      height: window.innerHeight,
    };
  }

  /**
   * Clear all rendered issues
   */
  clearIssues(): void {
    // Clear all highlights from the highlight helper
    const highlightsContent = this.highlightHelper.getContent();
    if (highlightsContent) {
      const allHighlights =
        highlightsContent.querySelectorAll("[data-element-id]");
      allHighlights.forEach((highlight) => {
        highlight.remove();
      });
    }

    // Clear all grammar errors
    this.grammarErrors.clear();
    this.dismissedErrors.clear();

    // Clear tracked elements in highlight helper
    this.highlightHelper.cleanup();
    // Recreate the highlight helper container
    this.highlightHelper = new HighlightContainerHelper();
  }

  // Private helper methods

  private setupRedditStyles(): void {
    // Define custom element for highlights container
    if (
      typeof customElements !== "undefined" &&
      customElements &&
      !customElements.get("rewordly-highlights")
    ) {
      customElements.define(
        "rewordly-highlights",
        class extends HTMLElement {
          constructor() {
            super();
          }
        }
      );
    }

    // Add global style override
    const styleId = "rewordly-reddit-override";
    if (!document.getElementById(styleId)) {
      const style = document.createElement("style");
      style.id = styleId;
      style.textContent = `
        rewordly-highlights {
          visibility: visible !important;
        }
        /* Hide browser's default spellcheck highlights */
        [contenteditable="true"]::spelling-error,
        [contenteditable="true"]::grammar-error,
        textarea::spelling-error,
        textarea::grammar-error,
        input[type="text"]::spelling-error,
        input[type="text"]::grammar-error,
        input[type="email"]::spelling-error,
        input[type="email"]::grammar-error,
        input[type="search"]::spelling-error,
        input[type="search"]::grammar-error,
        input[type="url"]::spelling-error,
        input[type="url"]::grammar-error {
          text-decoration: none !important;
          background: none !important;
          border: none !important;
          box-shadow: none !important;
        }
        /* Also hide any spellcheck markers */
        [contenteditable="true"] mark[data-spellcheck],
        textarea mark[data-spellcheck],
        input mark[data-spellcheck] {
          display: none !important;
        }
      `;
      document.head.appendChild(style);
    }
  }

  /**
   * Find editable elements in shadow DOM
   * Recursively traverses shadow roots to find all editable elements
   * CRITICAL: Handles deeply nested shadow roots (rs-app -> rs-room -> rs-message-composer)
   */
  private findEditableInShadowDOM(root: Node | ShadowRoot): HTMLElement[] {
    const elements: HTMLElement[] = [];

    if (!root) return elements;

    // Use TreeWalker to traverse all elements
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node: Node | null;

    while ((node = walker.nextNode())) {
      const element = node as HTMLElement;

      // Check if element itself is editable
      if (isEditableElement(element)) {
        elements.push(element);
      }

      // CRITICAL: Recursively check shadow roots (handles nested shadow DOMs)
      if (element.shadowRoot) {
        const shadowElements = this.findEditableInShadowDOM(element.shadowRoot);
        elements.push(...shadowElements);
      }
    }

    return elements;
  }

  /**
   * Find a specific element by tag name in all shadow DOMs recursively
   * Searches the entire document including all nested shadow roots
   */
  private findElementInAllShadowDOMs(tagName: string): HTMLElement | null {
    // First try direct query
    const direct = document.querySelector(tagName) as HTMLElement | null;
    if (direct) {
      return direct;
    }

    // Then search in all shadow DOMs
    const allElements = document.querySelectorAll("*");
    for (const element of allElements) {
      const el = element as HTMLElement;
      if (el.shadowRoot) {
        const found = this.findElementInShadowDOMRecursive(
          el.shadowRoot,
          tagName
        );
        if (found) {
          return found;
        }
      }
    }

    return null;
  }

  /**
   * Recursively search for an element in a shadow root
   */
  private findElementInShadowDOMRecursive(
    root: ShadowRoot | Node,
    tagName: string
  ): HTMLElement | null {
    if (!root) return null;

    // Try direct query in this shadow root
    const found = (root as ShadowRoot).querySelector?.(
      tagName
    ) as HTMLElement | null;
    if (found) {
      return found;
    }

    // Recursively search in nested shadow roots
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node: Node | null;

    while ((node = walker.nextNode())) {
      const element = node as HTMLElement;
      if (element.shadowRoot) {
        const found = this.findElementInShadowDOMRecursive(
          element.shadowRoot,
          tagName
        );
        if (found) {
          return found;
        }
      }
    }

    return null;
  }

  /**
   * CRITICAL: Specialized function to find message textarea in Reddit chat client
   * Handles the nested shadow DOM structure: rs-app -> rs-room -> rs-message-composer
   * Enhanced with detailed logging and multiple fallback strategies
   */
  private findMessageTextareaInRedditChat(): HTMLElement | null {
    console.log(
      "Rewordly: 🔍 Starting search for message textarea in Reddit chat..."
    );

    // Step 1: Try multiple strategies to find rs-app
    let rsApp: HTMLElement | null = null;

    // Strategy 1: Direct query
    rsApp = document.querySelector("rs-app") as HTMLElement | null;
    if (rsApp) {
      console.log("Rewordly: ✅ Found rs-app via direct query");
    }

    // Strategy 2: Search in reddit-chat-client
    if (!rsApp) {
      const chatClient = document.querySelector(
        '[data-testid="reddit-chat-client"]'
      ) as HTMLElement | null;
      if (chatClient) {
        console.log(
          "Rewordly: Found reddit-chat-client, searching for rs-app inside..."
        );
        rsApp = chatClient.querySelector("rs-app") as HTMLElement | null;
        if (rsApp) {
          console.log("Rewordly: ✅ Found rs-app inside reddit-chat-client");
        }
      }
    }

    // Strategy 3: Search in all shadow DOMs recursively
    if (!rsApp) {
      console.log("Rewordly: Searching for rs-app in all shadow DOMs...");
      rsApp = this.findElementInAllShadowDOMs("rs-app");
      if (rsApp) {
        console.log("Rewordly: ✅ Found rs-app in shadow DOM");
      }
    }

    // Strategy 4: Search for rs-message-composer directly (skip rs-app/rs-room)
    if (!rsApp) {
      console.log(
        "Rewordly: rs-app not found, trying to find rs-message-composer directly..."
      );
      const rsMessageComposer = this.findElementInAllShadowDOMs(
        "rs-message-composer"
      );
      if (rsMessageComposer && rsMessageComposer.shadowRoot) {
        console.log(
          "Rewordly: ✅ Found rs-message-composer directly, searching for textarea..."
        );
        return this.findTextareaInMessageComposer(rsMessageComposer);
      }
    }

    if (!rsApp) {
      console.log("Rewordly: ❌ rs-app not found anywhere");
      return null;
    }

    if (!rsApp.shadowRoot) {
      console.log("Rewordly: ❌ rs-app found but has no shadow root");
      return null;
    }

    console.log("Rewordly: ✅ Found rs-app, traversing shadow DOM...");
    return this.traverseShadowDOMForTextarea(rsApp);
  }

  /**
   * Helper function to traverse shadow DOM starting from rs-app
   */
  private traverseShadowDOMForTextarea(rsApp: HTMLElement): HTMLElement | null {
    if (!rsApp.shadowRoot) {
      console.log("Rewordly: ❌ rs-app has no shadow root");
      return null;
    }

    // Step 2: Find rs-room inside rs-app shadow root
    const rsRoom = rsApp.shadowRoot.querySelector(
      "rs-room"
    ) as HTMLElement | null;
    if (!rsRoom) {
      console.log("Rewordly: ❌ rs-room not found in rs-app shadow root");
      // Fallback: Try to find rs-message-composer directly in rs-app shadow root
      console.log(
        "Rewordly: Trying to find rs-message-composer directly in rs-app shadow root..."
      );
      const rsMessageComposer = rsApp.shadowRoot.querySelector(
        "rs-message-composer"
      ) as HTMLElement | null;
      if (rsMessageComposer && rsMessageComposer.shadowRoot) {
        return this.findTextareaInMessageComposer(rsMessageComposer);
      }
      return null;
    }

    if (!rsRoom.shadowRoot) {
      console.log("Rewordly: ❌ rs-room found but has no shadow root");
      return null;
    }

    console.log("Rewordly: ✅ Found rs-room, traversing shadow DOM...");

    // Step 3: Find rs-message-composer inside rs-room shadow root
    const rsMessageComposer = rsRoom.shadowRoot.querySelector(
      "rs-message-composer"
    ) as HTMLElement | null;
    if (!rsMessageComposer) {
      console.log(
        "Rewordly: ❌ rs-message-composer not found in rs-room shadow root"
      );
      // Debug: List all elements in rs-room shadow root
      const allElements = rsRoom.shadowRoot.querySelectorAll("*");
      console.log(
        `Rewordly: Found ${allElements.length} elements in rs-room shadow root:`,
        Array.from(allElements)
          .map((el) => el.tagName)
          .slice(0, 10)
      );
      return null;
    }

    if (!rsMessageComposer.shadowRoot) {
      console.log(
        "Rewordly: ❌ rs-message-composer found but has no shadow root"
      );
      return null;
    }

    console.log(
      "Rewordly: ✅ Found rs-message-composer, searching for textarea..."
    );
    return this.findTextareaInMessageComposer(rsMessageComposer);
  }

  /**
   * Helper function to find textarea inside rs-message-composer shadow root
   */
  private findTextareaInMessageComposer(
    rsMessageComposer: HTMLElement
  ): HTMLElement | null {
    if (!rsMessageComposer.shadowRoot) {
      return null;
    }

    // Step 4: Find textarea inside rs-message-composer shadow root
    // Try multiple selectors
    const selectors = [
      'textarea[name="message"]',
      'textarea[aria-label="Write message"]',
      'textarea[placeholder="Message"]',
      "textarea",
    ];

    for (const selector of selectors) {
      const textarea = rsMessageComposer.shadowRoot.querySelector(
        selector
      ) as HTMLTextAreaElement | null;

      if (textarea) {
        const name = textarea.getAttribute("name");
        const ariaLabel = textarea.getAttribute("aria-label");
        const placeholder = textarea.getAttribute("placeholder");
        console.log(`Rewordly: Found textarea with selector "${selector}":`, {
          textarea,
          name,
          ariaLabel,
          placeholder,
          isEditable: isEditableElement(textarea),
        });

        if (isEditableElement(textarea)) {
          // Verify it's the message textarea
          if (
            name === "message" ||
            ariaLabel === "Write message" ||
            placeholder === "Message"
          ) {
            console.log(
              "Rewordly: ✅ Found message textarea in nested shadow DOM!",
              {
                textarea,
                name,
                ariaLabel,
                placeholder,
              }
            );
            return textarea;
          }
        }
      }
    }

    // Fallback: Use recursive search if direct path fails
    console.log("Rewordly: Direct selectors failed, using recursive search...");
    const allEditableElements = this.findEditableInShadowDOM(
      rsMessageComposer.shadowRoot
    );
    console.log(
      `Rewordly: Found ${allEditableElements.length} editable elements via recursive search`
    );

    const messageTextarea = allEditableElements.find((el) => {
      const name = el.getAttribute("name");
      const ariaLabel = el.getAttribute("aria-label");
      const placeholder = el.getAttribute("placeholder");
      const isMatch =
        name === "message" ||
        ariaLabel === "Write message" ||
        placeholder === "Message";

      if (isMatch) {
        console.log("Rewordly: Found potential message textarea:", {
          element: el,
          name,
          ariaLabel,
          placeholder,
          tagName: el.tagName,
        });
      }

      return isMatch;
    });

    if (messageTextarea) {
      console.log("Rewordly: ✅ Found message textarea via recursive search!", {
        messageTextarea,
      });
      return messageTextarea;
    }

    // Last resort: Return first textarea if any found
    const firstTextarea = allEditableElements.find(
      (el) => el.tagName === "TEXTAREA"
    );
    if (firstTextarea) {
      console.log(
        "Rewordly: ⚠️ Using first textarea found (may not be message textarea):",
        {
          firstTextarea,
          name: firstTextarea.getAttribute("name"),
          ariaLabel: firstTextarea.getAttribute("aria-label"),
          placeholder: firstTextarea.getAttribute("placeholder"),
        }
      );
      return firstTextarea;
    }

    console.log("Rewordly: ❌ Message textarea not found in nested shadow DOM");
    return null;
  }

  /**
   * Find and attach to editable elements, including those in shadow DOM
   */
  private findAndAttachToEditableElements(): void {
    const selectors = [
      'textarea[placeholder*="What are your thoughts"]',
      'textarea[placeholder*="Add a comment"]',
      'textarea[name="message"]', // Reddit message composer textarea
      'textarea[aria-label="Write message"]', // Reddit message composer textarea (alternative)
      'textarea[placeholder="Message"]', // Reddit message composer textarea (placeholder variant)
      '[contenteditable="true"]',
      "textarea",
    ];

    // First, find elements in regular DOM
    selectors.forEach((selector) => {
      const elements = document.querySelectorAll(selector);
      console.log(
        `Rewordly: Found ${elements.length} elements for selector: ${selector}`
      );
      elements.forEach((el) => {
        const element = el as HTMLElement;
        console.log("Rewordly: Attempting to attach element:", element, {
          name: element.getAttribute("name"),
          ariaLabel: element.getAttribute("aria-label"),
          placeholder: element.getAttribute("placeholder"),
          isEditable: isEditableElement(element),
          alreadyAttached: this.editableElements.has(element),
        });
        this.attachToEditableElement(element);
      });
    });

    // CRITICAL: Search for message textarea in Reddit chat client (nested shadow DOM)
    // Reddit chat uses: rs-app -> rs-room -> rs-message-composer (all with shadow roots)
    const messageTextarea = this.findMessageTextareaInRedditChat();
    if (messageTextarea && !this.editableElements.has(messageTextarea)) {
      console.log(
        "Rewordly: ✅ Attaching to message textarea found in nested shadow DOM"
      );
      this.attachToEditableElement(messageTextarea);
    }

    // Also check for rs-message-composer directly (fallback)
    const messageComposers = document.querySelectorAll("rs-message-composer");
    console.log(
      `Rewordly: Found ${messageComposers.length} rs-message-composer elements (direct)`
    );
    messageComposers.forEach((composer) => {
      const composerElement = composer as HTMLElement;

      // Check if composer has shadow root
      if (composerElement.shadowRoot) {
        console.log(
          "Rewordly: Found rs-message-composer with shadow root, searching for editable elements"
        );
        const shadowEditableElements = this.findEditableInShadowDOM(
          composerElement.shadowRoot
        );
        console.log(
          `Rewordly: Found ${shadowEditableElements.length} editable elements in shadow DOM`
        );
        shadowEditableElements.forEach((element) => {
          if (!this.editableElements.has(element)) {
            const name = element.getAttribute("name");
            const ariaLabel = element.getAttribute("aria-label");
            const placeholder = element.getAttribute("placeholder");
            console.log("Rewordly: Found editable element in shadow DOM:", {
              element,
              tagName: element.tagName,
              name,
              ariaLabel,
              placeholder,
            });
            this.attachToEditableElement(element);
          }
        });
      }
    });

    // Also check Reddit chat client for editable elements (including shadow DOM)
    const chatClient = document.querySelector(
      '[data-testid="reddit-chat-client"]'
    ) as HTMLElement | null;
    if (chatClient && !chatClient.classList.contains("hidden")) {
      const chatSelectors = [
        "textarea",
        '[contenteditable="true"]',
        'textarea[name="message"]',
        'textarea[aria-label*="message" i]',
        'textarea[placeholder*="message" i]',
      ];

      // Check regular DOM
      chatSelectors.forEach((selector) => {
        const elements = chatClient.querySelectorAll(selector);
        elements.forEach((el) => {
          const editableElement = el as HTMLElement;
          if (isEditableElement(editableElement)) {
            this.attachToEditableElement(editableElement);
            console.log(
              "Rewordly: Attached to Reddit chat editable element (initial)",
              editableElement
            );
          }
        });
      });

      // Check shadow DOM in chat client
      if (chatClient.shadowRoot) {
        const shadowEditableElements = this.findEditableInShadowDOM(
          chatClient.shadowRoot
        );
        shadowEditableElements.forEach((element) => {
          this.attachToEditableElement(element);
          console.log(
            "Rewordly: Attached to Reddit chat editable element in shadow DOM (initial)",
            element
          );
        });
      }
    }

    // Also search all shadow DOMs in the document for editable elements
    // This catches any other custom elements with shadow DOM
    const allElements = document.querySelectorAll("*");
    allElements.forEach((el) => {
      const element = el as HTMLElement;
      if (element.shadowRoot) {
        const shadowEditableElements = this.findEditableInShadowDOM(
          element.shadowRoot
        );
        shadowEditableElements.forEach((editableElement) => {
          // Only attach if it's a message textarea or other important element
          const name = editableElement.getAttribute("name");
          const ariaLabel = editableElement.getAttribute("aria-label");
          const placeholder = editableElement.getAttribute("placeholder");
          const isMessageTextarea =
            name === "message" ||
            ariaLabel === "Write message" ||
            placeholder === "Message";

          if (isMessageTextarea || editableElement.tagName === "TEXTAREA") {
            console.log(
              "Rewordly: Found editable element in shadow DOM (general search):",
              {
                element: editableElement,
                parent: element,
                name,
                ariaLabel,
                placeholder,
              }
            );
            this.attachToEditableElement(editableElement);
          }
        });
      }
    });
  }

  private findEditableInElement(element: HTMLElement): void {
    const selectors = ["textarea", '[contenteditable="true"]'];

    // Check regular DOM
    selectors.forEach((selector) => {
      const children = element.querySelectorAll(selector);
      children.forEach((child) => {
        this.attachToEditableElement(child as HTMLElement);
      });
    });

    // CRITICAL: Also check shadow DOM
    if (element.shadowRoot) {
      const shadowEditableElements = this.findEditableInShadowDOM(
        element.shadowRoot
      );
      shadowEditableElements.forEach((editableElement) => {
        console.log(
          "Rewordly: Found editable element in shadow DOM (findEditableInElement):",
          {
            element: editableElement,
            parent: element,
            name: editableElement.getAttribute("name"),
            ariaLabel: editableElement.getAttribute("aria-label"),
            placeholder: editableElement.getAttribute("placeholder"),
          }
        );
        this.attachToEditableElement(editableElement);
      });
    }
  }

  private attachToEditableElement(element: HTMLElement): void {
    if (!element) {
      console.warn(
        "Rewordly: attachToEditableElement called with null element"
      );
      return;
    }

    const isEditable = isEditableElement(element);
    const alreadyAttached = this.editableElements.has(element);
    const name = element.getAttribute("name");
    const ariaLabel = element.getAttribute("aria-label");
    const placeholder = element.getAttribute("placeholder");
    const isMessageTextarea =
      name === "message" ||
      ariaLabel === "Write message" ||
      placeholder === "Message";

    // Only log non-message elements if they're actually editable to reduce noise
    if (!isMessageTextarea) {
      console.log("Rewordly: attachToEditableElement called", {
        element,
        tagName: element.tagName,
        name,
        ariaLabel,
        placeholder,
        isEditable,
        alreadyAttached,
      });
    } else {
      console.log(
        "Rewordly: attachToEditableElement called for MESSAGE TEXTAREA",
        {
          element,
          tagName: element.tagName,
          name,
          ariaLabel,
          placeholder,
          isEditable,
          alreadyAttached,
        }
      );
    }

    if (!isEditable) {
      if (isMessageTextarea) {
        console.warn("Rewordly: MESSAGE TEXTAREA is not editable, skipping", {
          element,
          name,
          ariaLabel,
          placeholder,
          tagName: element.tagName,
        });
      } else {
        // console.warn("Rewordly: Element is not editable, skipping", element);
      }
      return;
    }

    if (alreadyAttached) {
      if (isMessageTextarea) {
        console.log("Rewordly: MESSAGE TEXTAREA already attached, skipping", {
          element,
          name,
          ariaLabel,
          placeholder,
        });
      } else {
        console.log("Rewordly: Element already attached, skipping", element);
      }
      return;
    }

    this.editableElements.add(element);
    this.changeEmitter.initializeElement(element);

    // Disable browser's native spellcheck
    disableSpellCheck(element);

    // CRITICAL: For shadow DOM elements, add direct event listeners
    // Document-level listeners may not work reliably for shadow DOM elements
    const isInShadowDOM = element.getRootNode() instanceof ShadowRoot;
    if (isInShadowDOM) {
      console.log(
        "Rewordly: Element is in shadow DOM, adding direct event listeners",
        element
      );
      // Add input listener directly to element
      element.addEventListener("input", this.handleInputDirect, true);
      element.addEventListener("focusin", this.handleFocusDirect, true);
      // Also listen to composition events (for IME input)
      element.addEventListener(
        "compositionupdate",
        this.handleInputDirect,
        true
      );
      element.addEventListener("compositionend", this.handleInputDirect, true);
    }

    // Set up ResizeObserver for this element to catch layout changes
    this.setupResizeObserverForElement(element);

    // CRITICAL: Set up scroll listener for message textarea (like comment areas)
    if (isMessageTextarea) {
      this.setupScrollListenerForElement(element);
      // Also set up clipping for message textarea container
      this.setupHighlightClippingForElement(element);
    }

    if (isMessageTextarea) {
      console.log(
        "✅ Rewordly: Reddit adapter SUCCESSFULLY attached to MESSAGE TEXTAREA",
        {
          element,
          name,
          ariaLabel,
          placeholder,
          tagName: element.tagName,
          isInShadowDOM,
        }
      );
    } else {
      console.log("Rewordly: Reddit adapter attached to element", element, {
        name,
        ariaLabel,
        placeholder,
        isInShadowDOM,
      });
    }
  }

  /**
   * Direct input handler for shadow DOM elements
   * This ensures events from shadow DOM elements are properly captured
   */
  private handleInputDirect = (event: Event): void => {
    // Delegate to main handler
    this.handleInput(event);
  };

  /**
   * Direct focus handler for shadow DOM elements
   * This ensures events from shadow DOM elements are properly captured
   */
  private handleFocusDirect = (event: Event): void => {
    // Delegate to main handler
    this.handleFocus(event);
  };

  /**
   * Set up ResizeObserver for all editable elements
   */
  private setupResizeObservers(): void {
    // This will be called for each element via attachToEditableElement
  }

  /**
   * Set up ResizeObserver for a specific element to catch layout changes
   */
  private setupResizeObserverForElement(element: HTMLElement): void {
    // Remove existing observer if any
    const existingObserver = this.resizeObservers.get(element);
    if (existingObserver) {
      existingObserver.disconnect();
    }

    // Create new ResizeObserver
    const resizeObserver = new ResizeObserver(() => {
      // Element size changed, update highlight positions
      if (this.grammarErrors.has(element)) {
        const errors = this.grammarErrors.get(element) || [];
        if (errors.length > 0) {
          // Use requestAnimationFrame to ensure DOM has settled
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              this.highlightHelper.updatePositions(
                element,
                errors,
                (error: GrammarError) =>
                  getErrorTextRects(element, error.start, error.end)
              );
              // CRITICAL: After updating positions, check and hide highlights outside container
              this.checkAndHideHighlightsOutsideContainer(element);
            });
          });
        }
      }
    });

    // Observe the element and its parent container
    resizeObserver.observe(element);

    // Also observe parent container (shreddit-composer) for toolbar-related changes
    const parentContainer =
      element.closest("reddit-rte") || element.closest("shreddit-composer");
    if (parentContainer) {
      resizeObserver.observe(parentContainer);
    }

    this.resizeObservers.set(element, resizeObserver);
  }

  /**
   * Set up scroll listener for an element to update highlight positions
   * Similar to comment areas - highlights should update immediately on scroll
   */
  private setupScrollListenerForElement(element: HTMLElement): void {
    // Remove existing listener if any
    const existingListener = this.scrollListeners.get(element);
    if (existingListener) {
      // Find scroll container
      const scrollContainer = this.findScrollContainer(element);
      if (scrollContainer && scrollContainer !== window) {
        (scrollContainer as HTMLElement).removeEventListener(
          "scroll",
          existingListener,
          true
        );
      } else {
        window.removeEventListener("scroll", existingListener, true);
      }
    }

    // Create debounced scroll handler
    let scrollTimeout: number | null = null;
    const scrollHandler = () => {
      if (scrollTimeout !== null) {
        cancelAnimationFrame(scrollTimeout);
      }
      scrollTimeout = requestAnimationFrame(() => {
        // Update highlight positions for this element
        if (this.grammarErrors.has(element)) {
          const errors = this.grammarErrors.get(element) || [];
          if (errors.length > 0) {
            this.highlightHelper.updatePositions(
              element,
              errors,
              (error: GrammarError) =>
                getErrorTextRects(element, error.start, error.end)
            );
            // CRITICAL: After updating positions, check and hide highlights outside container
            this.checkAndHideHighlightsOutsideContainer(element);
          }
        }
      });
    };

    // Find scroll container (could be element itself, parent, or window)
    const scrollContainer = this.findScrollContainer(element);
    if (scrollContainer && scrollContainer !== window) {
      (scrollContainer as HTMLElement).addEventListener(
        "scroll",
        scrollHandler,
        true
      );
      console.log(
        "Rewordly: Added scroll listener to container for message textarea",
        scrollContainer
      );
    } else {
      // Fallback to window scroll
      window.addEventListener("scroll", scrollHandler, true);
      console.log(
        "Rewordly: Added scroll listener to window for message textarea"
      );
    }

    this.scrollListeners.set(element, scrollHandler);
  }

  /**
   * Find the scroll container for an element
   * Checks element itself, parents, and shadow DOM parents
   */
  private findScrollContainer(element: HTMLElement): HTMLElement | Window {
    // Check if element itself is scrollable
    const style = window.getComputedStyle(element);
    if (
      style.overflow === "auto" ||
      style.overflow === "scroll" ||
      style.overflowY === "auto" ||
      style.overflowY === "scroll"
    ) {
      return element;
    }

    // Check parent chain
    let parent = element.parentElement;
    let depth = 0;
    while (parent && depth < 10) {
      const parentStyle = window.getComputedStyle(parent);
      if (
        parentStyle.overflow === "auto" ||
        parentStyle.overflow === "scroll" ||
        parentStyle.overflowY === "auto" ||
        parentStyle.overflowY === "scroll"
      ) {
        return parent;
      }

      // Check if parent is message-box or form (common containers for message textarea)
      if (
        parent.classList?.contains("message-box") ||
        parent.tagName?.toLowerCase() === "form"
      ) {
        // Check if this container is scrollable
        if (
          parentStyle.overflow === "auto" ||
          parentStyle.overflow === "scroll" ||
          parentStyle.overflowY === "auto" ||
          parentStyle.overflowY === "scroll"
        ) {
          return parent;
        }
        // Even if not scrollable, return it as the container for clipping
        return parent;
      }

      parent = parent.parentElement;
      depth++;
    }

    // Check shadow DOM parent
    const root = element.getRootNode();
    if (root instanceof ShadowRoot) {
      const host = root.host as HTMLElement;
      if (host) {
        const hostStyle = window.getComputedStyle(host);
        if (
          hostStyle.overflow === "auto" ||
          hostStyle.overflow === "scroll" ||
          hostStyle.overflowY === "auto" ||
          hostStyle.overflowY === "scroll"
        ) {
          return host;
        }
      }
    }

    // Default to window
    return window;
  }

  /**
   * Set up clipping for highlights to stay within message textarea container
   * Highlights outside the message area should not be visible
   */
  private setupHighlightClippingForElement(element: HTMLElement): void {
    // Function to check and hide highlights outside container
    const checkAndHide = () => {
      this.checkAndHideHighlightsOutsideContainer(element);
    };

    // Initial check
    checkAndHide();

    // Update on scroll/resize
    const scrollContainer = this.findScrollContainer(element);
    if (scrollContainer && scrollContainer !== window) {
      (scrollContainer as HTMLElement).addEventListener(
        "scroll",
        checkAndHide,
        true
      );
    }
    window.addEventListener("resize", checkAndHide);
    window.addEventListener("scroll", checkAndHide, true);

    console.log(
      "Rewordly: Set up highlight visibility check for message textarea"
    );
  }

  /**
   * Check if highlights are outside the message container and hide them
   * This is more reliable than clip-path for fixed positioned elements
   */
  private checkAndHideHighlightsOutsideContainer(element: HTMLElement): void {
    // Find the message container (message-box or form)
    const messageContainer =
      element.closest(".message-box") ||
      element.closest("form") ||
      element.parentElement;

    if (!messageContainer) {
      return;
    }

    // Get highlight container
    const highlightsContent = this.highlightHelper.getContent();
    if (!highlightsContent) {
      return;
    }

    const elementId = getElementId(element);
    const highlights = highlightsContent.querySelectorAll(
      `[data-element-id="${elementId}"]`
    );

    if (highlights.length === 0) {
      return;
    }

    // Get container bounds
    const containerRect = (
      messageContainer as HTMLElement
    ).getBoundingClientRect();
    const containerTop = containerRect.top;
    const containerBottom = containerRect.bottom;
    const containerLeft = containerRect.left;
    const containerRight = containerRect.right;

    // Add small tolerance (5px) to account for rounding errors
    const tolerance = 5;

    highlights.forEach((highlight) => {
      const highlightEl = highlight as HTMLElement;
      const highlightRect = highlightEl.getBoundingClientRect();

      // Check if highlight is completely outside container bounds
      const isOutside =
        highlightRect.bottom < containerTop - tolerance ||
        highlightRect.top > containerBottom + tolerance ||
        highlightRect.right < containerLeft - tolerance ||
        highlightRect.left > containerRight + tolerance;

      if (isOutside) {
        // Hide highlight if outside container
        highlightEl.style.display = "none";
        highlightEl.setAttribute("data-hidden-outside-container", "true");
      } else {
        // Show highlight if inside container
        highlightEl.style.display = "";
        highlightEl.removeAttribute("data-hidden-outside-container");
      }
    });
  }

  private setupInputListeners(): void {
    document.addEventListener("input", this.handleInput, true);
    document.addEventListener("focusin", this.handleFocus, true);
  }

  private removeInputListeners(): void {
    document.removeEventListener("input", this.handleInput, true);
    document.removeEventListener("focusin", this.handleFocus, true);
  }

  private handleInput = (event: Event): void => {
    const element = event.target as HTMLElement;
    if (!element || !isEditableElement(element)) {
      return;
    }

    // Ignore programmatic input events (triggered by replace operations)
    if ((event as any).__rewordlyProgrammatic) {
      return;
    }

    // Don't validate highlights during replace operations
    if (this.isPerformingReplace) {
      return;
    }

    // Ensure element is attached (important for dynamically added elements like message textarea)
    if (!this.editableElements.has(element)) {
      console.log(
        "Rewordly: Element not attached in handleInput, attaching now",
        element
      );
      this.attachToEditableElement(element);
    }

    this.currentElement = element;
    this.changeEmitter.setCurrentElement(element);

    // Get current and previous text to detect changes
    const { text: currentText } = extractText(element);
    const previousText = this.changeEmitter.getLastText(element) || "";

    // If text changed and we have errors, update their positions
    if (currentText !== previousText && this.grammarErrors.has(element)) {
      const errors = this.grammarErrors.get(element) || [];

      if (errors.length > 0) {
        // Calculate where the change occurred by finding the first difference
        const changePosition = this.findChangePosition(
          previousText,
          currentText
        );
        const lengthDiff = currentText.length - previousText.length;

        // Update error positions based on the change
        const updatedErrors = errors.map((error) => {
          // If error is after the change position, adjust its position
          if (error.start >= changePosition) {
            return {
              ...error,
              start: Math.max(0, error.start + lengthDiff),
              end: Math.max(0, error.end + lengthDiff),
            };
          }
          // If error overlaps with the change position, it might be invalid
          // (validateAndRemoveInvalidHighlights will handle this)
          return error;
        });

        // Update grammar errors with new positions
        this.grammarErrors.set(element, updatedErrors);

        // Immediately update highlight data-error attributes to reflect new positions
        // This must be done BEFORE validateAndRemoveInvalidHighlights so it uses updated positions
        const highlightsContent = this.highlightHelper.getContent();
        if (highlightsContent) {
          const elementId = getElementId(element);
          const highlights = highlightsContent.querySelectorAll(
            `[data-element-id="${elementId}"]`
          );
          highlights.forEach((highlight) => {
            const errorId = (highlight as HTMLElement).getAttribute(
              "data-error-id"
            );
            if (errorId) {
              const updatedError = updatedErrors.find((e) => e.id === errorId);
              if (updatedError) {
                (highlight as HTMLElement).setAttribute(
                  "data-error",
                  JSON.stringify(updatedError)
                );
              }
            }
          });
        }

        // Now validate with updated positions - this will only remove highlights where the word changed
        // (not where only position changed, since we've already updated data-error attributes)
        validateAndRemoveInvalidHighlights(
          element,
          this.highlightHelper.getContent(),
          this.grammarErrors,
          extractText,
          getElementId,
          this.isPerformingReplace
        );

        // Immediately update highlight positions to reflect the new error positions
        // Use requestAnimationFrame to ensure DOM has updated
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (this.grammarErrors.has(element)) {
              const currentErrors = this.grammarErrors.get(element) || [];
              if (currentErrors.length > 0) {
                // Update highlight positions with new positions
                this.highlightHelper.updatePositions(
                  element,
                  currentErrors,
                  (error: GrammarError) =>
                    getErrorTextRects(element, error.start, error.end)
                );
              }
            }
          });
        });

        // Notify change BEFORE updating last text so change can be detected
        this.changeEmitter.notifyChange(
          () => element, // Use element directly instead of getFirstEditableElement
          extractText,
          getElementId
        );
        // Update last text after notifying (notifyChange updates it internally, but we ensure it's set)
        this.changeEmitter.setLastText(element, currentText);
        return; // Early return - we've already handled validation and position updates
      }
    }

    // Validate and remove invalid highlights when text changes
    // This ensures highlights for changed words are removed immediately
    // BUT: Only if we haven't already updated positions above (text didn't change or no errors)
    if (this.grammarErrors.has(element)) {
      validateAndRemoveInvalidHighlights(
        element,
        this.highlightHelper.getContent(),
        this.grammarErrors,
        extractText,
        getElementId,
        this.isPerformingReplace
      );
    }

    // Notify change BEFORE updating last text so change can be detected
    this.changeEmitter.notifyChange(
      () => element, // Use element directly instead of getFirstEditableElement
      extractText,
      getElementId
    );
    // Update last text after notifying (notifyChange updates it internally, but we ensure it's set)
    this.changeEmitter.setLastText(element, currentText);
  };

  /**
   * Check for existing text in editable elements and trigger initial check
   */
  private checkExistingTextAndNotify(): void {
    // Find first editable element with text
    for (const element of this.editableElements) {
      const { text } = extractText(element);
      if (text.trim().length > 0) {
        // Found element with text, set as current and notify
        this.currentElement = element;
        this.changeEmitter.setCurrentElement(element);
        this.changeEmitter.setLastText(element, text);
        // Trigger initial check by notifying change
        this.changeEmitter.notifyChange(
          () => this.getFirstEditableElement(),
          extractText,
          getElementId
        );
        break; // Only check first element with text
      }
    }
  }

  private handleFocus = (event: Event): void => {
    const element = event.target as HTMLElement;
    if (!element || !isEditableElement(element)) {
      return;
    }

    // Check if this element is inside Reddit chat client
    const isInChatClient =
      element.closest?.('[data-testid="reddit-chat-client"]') ||
      element.closest?.("rs-message-composer");

    // Check if this is a message textarea that needs to be attached
    const name = element.getAttribute("name");
    const ariaLabel = element.getAttribute("aria-label");
    const placeholder = element.getAttribute("placeholder");
    const isMessageTextarea =
      (element instanceof HTMLTextAreaElement &&
        (element.name === "message" ||
          element.getAttribute("aria-label") === "Write message" ||
          element.getAttribute("placeholder") === "Message")) ||
      (element.tagName?.toLowerCase() === "textarea" &&
        (name === "message" ||
          ariaLabel === "Write message" ||
          placeholder === "Message"));

    // If this is a message textarea or in chat client and not yet attached, attach it
    if (
      (isMessageTextarea || isInChatClient) &&
      !this.editableElements.has(element)
    ) {
      console.log("Rewordly: Message/chat element focused, attaching...", {
        isMessageTextarea,
        isInChatClient,
        element,
      });
      this.attachToEditableElement(element);
    }

    // Ensure element is in editableElements set (safety check)
    if (!this.editableElements.has(element)) {
      this.attachToEditableElement(element);
    }

    this.currentElement = element;
    this.changeEmitter.setCurrentElement(element);

    // Always trigger check on focus (even if text is empty or unchanged)
    // This ensures connection is established immediately and highlights are shown
    const { text } = extractText(element);
    // Initialize lastText for this element if not set
    if (!this.changeEmitter.getLastText(element)) {
      this.changeEmitter.setLastText(element, text);
    }
    // Force check on focus - even if text hasn't changed
    this.changeEmitter.notifyChange(
      () => element, // Use the focused element directly instead of getFirstEditableElement
      extractText,
      getElementId,
      true // Pass true to force notification
    );
  };

  /**
   * STEP 1: Editable Candidate Policy for Reddit
   *
   * Determines if an element is a valid editable candidate for grammar checking.
   * This function implements the policy for which elements should be considered
   * for grammar checking on Reddit.
   *
   * Rules:
   * 1. Element must be editable (textarea, contenteditable, or valid input)
   * 2. Element must be visible (not hidden, has offsetParent)
   * 3. Element must be in a valid context (not in search overlay, etc.)
   * 4. Element must be attached to the adapter (in editableElements set)
   *
   * Priority order (for future use):
   * - Currently focused element (highest priority)
   * - Message/DM textarea (high priority)
   * - Comment box (medium priority)
   * - Post editor (medium priority)
   * - Search input (low priority, may be excluded)
   *
   * NOTE: This function will be used in subsequent steps to replace
   * getFirstEditableElement() fallback logic.
   *
   * @param element - The element to check
   * @returns Object with isCandidate boolean and metadata
   */
  // private isEditableCandidate(element: HTMLElement | null): {
  //   isCandidate: boolean;
  //   priority: number;
  //   reason: string;
  // } {
  //   // Null check
  //   if (!element) {
  //     return {
  //       isCandidate: false,
  //       priority: 0,
  //       reason: "Element is null",
  //     };
  //   }

  //   // Must be editable
  //   if (!isEditableElement(element)) {
  //     return {
  //       isCandidate: false,
  //       priority: 0,
  //       reason: "Element is not editable",
  //     };
  //   }

  //   // Must be attached to adapter
  //   if (!this.editableElements.has(element)) {
  //     return {
  //       isCandidate: false,
  //       priority: 0,
  //       reason: "Element is not attached to adapter",
  //     };
  //   }

  //   // Must be visible (not hidden, has offsetParent)
  //   const isVisible =
  //     element.offsetParent !== null &&
  //     !element.classList.contains("hidden") &&
  //     !element.hasAttribute("hidden") &&
  //     window.getComputedStyle(element).display !== "none" &&
  //     window.getComputedStyle(element).visibility !== "hidden";

  //   if (!isVisible) {
  //     return {
  //       isCandidate: false,
  //       priority: 0,
  //       reason: "Element is not visible",
  //     };
  //   }

  //   // Check if element is in an invalid context (e.g., search overlay)
  //   // When comment search is open, we should not check elements in that context
  //   if (this.isCommentSearchOpen) {
  //     const isInSearchContext =
  //       element.closest("pdp-comment-search-input") !== null ||
  //       element.closest(
  //         'shreddit-async-loader[bundlename="comment_composer"]'
  //       ) !== null;

  //     if (isInSearchContext) {
  //       return {
  //         isCandidate: false,
  //         priority: 0,
  //         reason: "Element is in comment search context (search is open)",
  //       };
  //     }
  //   }

  //   // Determine element type and priority
  //   const name = element.getAttribute("name");
  //   const ariaLabel = element.getAttribute("aria-label");
  //   const placeholder = element.getAttribute("placeholder");
  //   const isFocused = document.activeElement === element;

  //   // Check if this is a message/DM textarea
  //   const isMessageTextarea =
  //     name === "message" ||
  //     ariaLabel === "Write message" ||
  //     placeholder === "Message";

  //   // Check if this is a comment box
  //   const isCommentBox =
  //     placeholder?.includes("What are your thoughts") ||
  //     placeholder?.includes("Add a comment") ||
  //     element.closest("shreddit-composer") !== null ||
  //     element.closest("reddit-rte") !== null;

  //   // Check if this is a post editor
  //   const isPostEditor =
  //     element.closest("shreddit-composer") !== null ||
  //     element.closest("reddit-rte") !== null ||
  //     (element.hasAttribute("contenteditable") &&
  //       element.getAttribute("contenteditable") === "true");

  //   // Check if this is a search input (lower priority, may exclude)
  //   const isSearchInput =
  //     element instanceof HTMLInputElement &&
  //     (element.type === "search" ||
  //       element.getAttribute("type") === "search" ||
  //       element.getAttribute("role") === "searchbox" ||
  //       element.closest('[role="search"]') !== null);

  //   // Calculate priority
  //   let priority = 0;
  //   let reason = "";

  //   if (isFocused) {
  //     // Currently focused element gets highest priority
  //     priority = 100;
  //     reason = "Currently focused element";
  //   } else if (isMessageTextarea) {
  //     // Message/DM textarea gets high priority
  //     priority = 80;
  //     reason = "Message/DM textarea";
  //   } else if (isCommentBox && !isSearchInput) {
  //     // Comment box gets medium-high priority
  //     priority = 60;
  //     reason = "Comment box";
  //   } else if (isPostEditor && !isSearchInput) {
  //     // Post editor gets medium priority
  //     priority = 50;
  //     reason = "Post editor";
  //   } else if (isSearchInput) {
  //     // Search inputs get low priority (may be excluded in future)
  //     priority = 10;
  //     reason = "Search input (low priority)";
  //   } else {
  //     // Other editable elements get low priority
  //     priority = 20;
  //     reason = "Other editable element";
  //   }

  //   return {
  //     isCandidate: true,
  //     priority,
  //     reason,
  //   };
  // }

  private getFirstEditableElement(): HTMLElement | null {
    // If there's a current element, prefer it
    if (this.currentElement && this.editableElements.has(this.currentElement)) {
      return this.currentElement;
    }

    if (this.editableElements.size === 0) {
      return null;
    }
    return Array.from(this.editableElements)[0] || null;
  }

  /**
   * Find the position where text changed between oldText and newText
   * Returns the position of the first difference
   */
  private findChangePosition(oldText: string, newText: string): number {
    // Find the first position where texts differ
    const minLength = Math.min(oldText.length, newText.length);
    let changePosition = minLength;

    for (let i = 0; i < minLength; i++) {
      if (oldText[i] !== newText[i]) {
        changePosition = i;
        break;
      }
    }

    // If texts are identical up to minLength, change is at the end
    // (either insertion or deletion)
    return changePosition;
  }

  /**
   * Check if comment search input is open/visible and hide/show highlights accordingly
   * When shreddit-async-loader has 'hidden' class, comment search is open
   */
  private checkCommentSearchState(): void {
    // Check if shreddit-async-loader element with bundlename="comment_composer" has hidden class
    // When comment search is open, this element gets the 'hidden' class
    const commentComposerLoader = document.querySelector(
      'shreddit-async-loader[bundlename="comment_composer"]'
    ) as HTMLElement | null;

    // Primary check: If shreddit-async-loader has 'hidden' class, search is open
    const isSearchOpen =
      commentComposerLoader !== null &&
      commentComposerLoader.classList.contains("hidden");

    // Only update if state changed
    if (isSearchOpen !== this.isCommentSearchOpen) {
      this.isCommentSearchOpen = isSearchOpen;

      if (isSearchOpen) {
        // Hide highlights when search is open
        hideAllGrammarHighlights({
          highlightHelper: this.highlightHelper,
        });
      } else {
        // Show highlights when search is closed
        showAllGrammarHighlights({
          highlightHelper: this.highlightHelper,
        });
      }
    }
  }

  /**
   * Set up URL change detection for Reddit SPA navigation
   * Reddit uses client-side routing, so we need to detect URL changes
   */
  private setupUrlChangeDetection(): void {
    // Initialize current URL
    this.currentUrl = window.location.href;

    // Listen for popstate events (browser back/forward)
    window.addEventListener("popstate", this.handleUrlChange);

    // Monitor URL changes via interval (for programmatic navigation)
    // Reddit uses pushState/replaceState which doesn't trigger popstate
    this.urlCheckInterval = window.setInterval(() => {
      const newUrl = window.location.href;
      if (newUrl !== this.currentUrl) {
        this.handleUrlChange();
      }
    }, 500); // Check every 500ms
  }

  /**
   * Remove URL change detection
   */
  private removeUrlChangeDetection(): void {
    window.removeEventListener("popstate", this.handleUrlChange);
    if (this.urlCheckInterval !== null) {
      clearInterval(this.urlCheckInterval);
      this.urlCheckInterval = null;
    }
  }

  /**
   * Handle URL change - clear all highlights and reset state
   */
  private handleUrlChange = (): void => {
    const newUrl = window.location.href;

    // Only clear if URL actually changed (not just a hash change within same page)
    const currentPath = new URL(this.currentUrl).pathname;
    const newPath = new URL(newUrl).pathname;

    if (currentPath !== newPath) {
      console.log("Rewordly: Reddit page changed, clearing highlights");

      // Clear all highlights
      this.clearIssues();

      // Reset element tracking
      this.editableElements.clear();
      this.currentElement = null;
      this.changeEmitter.setCurrentElement(null);

      // Update current URL
      this.currentUrl = newUrl;

      // Re-find editable elements for the new page
      // Small delay to ensure DOM is ready
      setTimeout(() => {
        this.findAndAttachToEditableElements();
      }, 100);
    } else {
      // Just update URL (hash change or query param change)
      this.currentUrl = newUrl;
    }
  };

  /**
   * Set up periodic scan for message textareas
   * This catches any message textareas that might be missed by MutationObserver
   */
  private setupPeriodicMessageTextareaScan(): void {
    // Scan immediately
    this.scanForMessageTextareas();

    // Then scan every 2 seconds
    this.messageTextareaScanInterval = window.setInterval(() => {
      this.scanForMessageTextareas();
    }, 2000);
  }

  /**
   * Remove periodic message textarea scan
   */
  private removePeriodicMessageTextareaScan(): void {
    if (this.messageTextareaScanInterval !== null) {
      clearInterval(this.messageTextareaScanInterval);
      this.messageTextareaScanInterval = null;
    }
  }

  /**
   * Scan for message textareas in the document (including shadow DOM)
   */
  private scanForMessageTextareas(): void {
    const selectors = [
      'textarea[name="message"]',
      'textarea[aria-label="Write message"]',
      'textarea[placeholder="Message"]',
    ];

    // Scan regular DOM
    selectors.forEach((selector) => {
      const elements = document.querySelectorAll(selector);
      elements.forEach((el) => {
        const element = el as HTMLTextAreaElement;
        if (isEditableElement(element) && !this.editableElements.has(element)) {
          // Check if it's inside a message-box or form
          const messageBox = element.closest?.(".message-box");
          const formWithMessageBox = element.closest?.(
            "form:has(.message-box)"
          );
          const isInForm = element.closest?.("form");

          if (messageBox || formWithMessageBox || isInForm) {
            console.log(
              "Rewordly: Periodic scan found unattached message textarea",
              {
                element,
                name: element.getAttribute("name"),
                ariaLabel: element.getAttribute("aria-label"),
                placeholder: element.getAttribute("placeholder"),
                messageBox: !!messageBox,
                formWithMessageBox: !!formWithMessageBox,
                isInForm: !!isInForm,
              }
            );
            this.attachToEditableElement(element);
          }
        }
      });
    });

    // CRITICAL: Use specialized function to find message textarea in nested shadow DOM
    const messageTextarea = this.findMessageTextareaInRedditChat();
    if (
      messageTextarea &&
      isEditableElement(messageTextarea) &&
      !this.editableElements.has(messageTextarea)
    ) {
      console.log(
        "Rewordly: Periodic scan found unattached message textarea in nested shadow DOM",
        {
          element: messageTextarea,
          name: messageTextarea.getAttribute("name"),
          ariaLabel: messageTextarea.getAttribute("aria-label"),
          placeholder: messageTextarea.getAttribute("placeholder"),
        }
      );
      this.attachToEditableElement(messageTextarea);
    }

    // Also check for rs-message-composer directly (fallback)
    const messageComposers = document.querySelectorAll("rs-message-composer");
    messageComposers.forEach((composer) => {
      const composerElement = composer as HTMLElement;
      if (composerElement.shadowRoot) {
        const shadowEditableElements = this.findEditableInShadowDOM(
          composerElement.shadowRoot
        );
        shadowEditableElements.forEach((element) => {
          const name = element.getAttribute("name");
          const ariaLabel = element.getAttribute("aria-label");
          const placeholder = element.getAttribute("placeholder");
          const isMessageTextarea =
            name === "message" ||
            ariaLabel === "Write message" ||
            placeholder === "Message";

          if (
            isMessageTextarea &&
            isEditableElement(element) &&
            !this.editableElements.has(element)
          ) {
            console.log(
              "Rewordly: Periodic scan found unattached message textarea in shadow DOM (fallback)",
              {
                element,
                name,
                ariaLabel,
                placeholder,
                parent: composerElement,
              }
            );
            this.attachToEditableElement(element);
          }
        });
      }
    });
  }
}
