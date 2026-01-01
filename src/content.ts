/**
 * Rewordly Content Script (New Architecture Only)
 *
 * Minimal entrypoint that:
 * - Selects an adapter from registry
 * - If no adapter enabled: does nothing (no listeners, no observers, no UI)
 * - If adapter enabled: initializes adapter, starts orchestrator, sets up cleanup
 */

import { getEnabledAdapter } from "./platform/registry";
import { Orchestrator } from "./app/orchestrator/orchestrator";
import { DocumentSnapshot, Issue } from "./core/contracts";
import { globalDebugUI } from "./app/debug/debugUI";
import { checkGrammar } from "./app/services/grammarService";
import { getPlatformConfig } from "./app/services/sitePolicy";

console.log("[REWORDLY][NEW] content.ts loaded");

// Get enabled adapter from registry
const adapter = getEnabledAdapter();

if (!adapter) {
  // No adapter enabled for this site - do NOTHING
  // No listeners, no observers, no UI injection
  console.log(
    "[REWORDLY][NEW] No adapter enabled for this site, extension inactive"
  );
} else {
  console.log("[REWORDLY][NEW] Adapter selected:", adapter.platform);

  // Initialize adapter (sets up change listeners)
  adapter.initialize();

  // Get platform-specific config
  const platformConfig = getPlatformConfig(adapter.platform);

  // Initialize debug UI (only once)
  globalDebugUI.init();

  // Create grammar check function that uses the grammar service
  const checkGrammarForOrchestrator = async (
    snapshot: DocumentSnapshot
  ): Promise<Issue[]> => {
    return checkGrammar(snapshot);
  };

  // Create orchestrator with platform config
  const orchestrator = new Orchestrator(adapter, {
    debounceMs: platformConfig.debounceMs,
    minTextLength: platformConfig.minTextLength,
    checkGrammar: checkGrammarForOrchestrator,
  });

  // Start orchestrator (sets up change observation)
  console.log("[REWORDLY][NEW] Starting orchestrator");
  orchestrator.start().catch((error) => {
    console.error("[REWORDLY][NEW] Orchestrator start error:", error);
  });

  // Store orchestrator and adapter for reinitialization
  let isActive = true;

  // Cleanup handlers
  const cleanup = () => {
    if (!isActive) return;
    console.log("[REWORDLY][NEW] Cleaning up");
    orchestrator.stop();
    adapter.cleanup();
    isActive = false;
  };

  // Reinitialize when page becomes visible again
  const reinitialize = async () => {
    if (isActive) return;
    console.log("[REWORDLY][NEW] Reinitializing");
    isActive = true;

    // Reinitialize adapter
    adapter.initialize();

    // Restart orchestrator
    try {
      await orchestrator.start();
    } catch (error) {
      console.error("[REWORDLY][NEW] Orchestrator restart error:", error);
    }
  };

  // Cleanup on page unload
  if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", cleanup);

    // Handle visibility change - cleanup when hidden, reinitialize when visible
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        cleanup();
      } else if (document.visibilityState === "visible") {
        // Small delay to ensure page is fully loaded
        setTimeout(() => {
          reinitialize();
        }, 100);
      }
    });
  }
}
