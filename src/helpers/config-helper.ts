/**
 * Config Helper
 * Yapılandırma ve platform kontrolü işlemleri
 *
 * Bu dosya ayarları yüklemek ve platform kontrolü yapmakla ilgilenir.
 * Basitçe: Config yükle, platform kontrol et gibi.
 */

import { RewordlyConfig } from "../types";
import { IPlatformAdapter } from "../types";
import { createPlatformAdapter } from "../adapters";

// Allowed sites for grammar check
const allowedSites = [
  "twitter.com",
  "x.com",
  "mail.google.com",
  "gmail.com",
  "reddit.com",
  "medium.com",
  "docs.google.com",
  "notion.so",
];

/**
 * Config yükle
 */
export async function loadConfig(): Promise<RewordlyConfig> {
  try {
    const result = await chrome.storage.sync.get([
      "rewordlyHighlightsEnabled",
      "rewordlyRewriteEnabled",
    ]);

    return {
      highlightsEnabled: result["rewordlyHighlightsEnabled"] !== false,
      rewriteEnabled: result["rewordlyRewriteEnabled"] !== false,
    };
  } catch (error) {
    console.error("Failed to load Rewordly config:", error);
    return {
      highlightsEnabled: true,
      rewriteEnabled: true,
    };
  }
}

/**
 * Sayfa disabled mı kontrol et
 */
export async function isPageDisabled(): Promise<boolean> {
  try {
    const result = await chrome.storage.sync.get(["rewordlyDisabledPages"]);
    const disabledPages: string[] = result["rewordlyDisabledPages"] || [];

    const currentUrl = window.location.href;
    const currentOrigin = window.location.origin;

    // Exact URL veya origin match
    return disabledPages.some((disabledUrl) => {
      const disabledPageOrigin = new URL(disabledUrl).origin ?? disabledUrl;
      return (
        disabledUrl === currentUrl ||
        disabledUrl === currentOrigin ||
        disabledPageOrigin === currentOrigin
      );
    });
  } catch (error) {
    console.error("Failed to check if page is disabled:", error);
    return false;
  }
}

/**
 * Grammar check bu sitede aktif mi?
 */
export function isGrammarCheckAllowedSite(): boolean {
  const hostname = window.location.hostname.toLowerCase();

  return allowedSites.some((site) => hostname.includes(site));
}

/**
 * Platform adapter oluştur
 */
export function createPlatformAdapterForSite(
  onGrammarCheck?: (text: string) => Promise<import("../types").GrammarError[]>
): IPlatformAdapter | null {
  return createPlatformAdapter(onGrammarCheck);
}

/**
 * Error ID oluştur
 */
let errorIdCounter = 0;
export function generateErrorId(): string {
  return `error-${Date.now()}-${errorIdCounter++}`;
}
