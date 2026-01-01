/**
 * Platform Registry
 * 
 * Single place to register and select platform adapters.
 * Ensures only one adapter is active at a time.
 * 
 * To add a new platform (e.g., Trello):
 * 1. Create src/platform/trello/index.ts implementing PlatformAdapter
 * 2. Import it here
 * 3. Add it to the ADAPTERS array (order matters - more specific first)
 */

import { PlatformAdapter } from "./base/PlatformAdapter";
import { RedditPlatformAdapter } from "./reddit/index";
// TODO: Uncomment as adapters are migrated
// import { NotionPlatformAdapter } from "./notion/index";
// import { GmailPlatformAdapter } from "./gmail/index";
// import { GoogleDocsPlatformAdapter } from "./google-docs/index";

/**
 * All available adapters
 * Order matters: more specific adapters should come first
 * The first enabled adapter will be selected
 */
const ADAPTERS: PlatformAdapter[] = [
  new RedditPlatformAdapter(),
  // TODO: Uncomment as adapters are migrated
  // new NotionPlatformAdapter(),
  // new GmailPlatformAdapter(),
  // new GoogleDocsPlatformAdapter(),
];

/**
 * Get the first enabled adapter for the current page
 * Returns null if no adapter is enabled
 */
export function getEnabledAdapter(): PlatformAdapter | null {
  for (const adapter of ADAPTERS) {
    if (adapter.isEnabled()) {
      return adapter;
    }
  }
  return null;
}

/**
 * List all registered adapters
 * Useful for debugging or admin interfaces
 */
export function listAdapters(): PlatformAdapter[] {
  return ADAPTERS;
}

