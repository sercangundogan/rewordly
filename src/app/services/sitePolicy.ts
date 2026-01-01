/**
 * Site Policy
 *
 * Platform-specific configuration and feature flags.
 * Centralized place for per-platform customization without code duplication.
 *
 * To add a new platform:
 * 1. Add platform name to PlatformConfig type
 * 2. Add config entry to PLATFORM_CONFIG map
 * 3. Use getPlatformConfig() in orchestrator initialization
 */

/**
 * Platform configuration
 */
export interface PlatformConfig {
  /** Debounce delay in milliseconds for change detection */
  debounceMs: number;

  /** Minimum text length to trigger grammar check */
  minTextLength: number;

  /** Optional: Additional platform-specific flags */
  flags?: {
    [key: string]: unknown;
  };
}

/**
 * Default configuration (used when platform not found)
 */
const DEFAULT_CONFIG: PlatformConfig = {
  debounceMs: 300,
  minTextLength: 3,
};

/**
 * Platform-specific configurations
 *
 * Order doesn't matter here - registry handles adapter selection order.
 */
const PLATFORM_CONFIG: Record<string, PlatformConfig> = {
  reddit: {
    debounceMs: 300,
    minTextLength: 3,
  },
  // TODO: Add other platforms as adapters are migrated
  // trello: {
  //   debounceMs: 500,
  //   minTextLength: 5,
  // },
  // notion: {
  //   debounceMs: 400,
  //   minTextLength: 3,
  // },
};

/**
 * Get platform configuration
 *
 * @param platform - Platform identifier (e.g., "reddit", "trello")
 * @returns PlatformConfig - Configuration for the platform, or defaults
 */
export function getPlatformConfig(platform: string): PlatformConfig {
  return PLATFORM_CONFIG[platform] || DEFAULT_CONFIG;
}
