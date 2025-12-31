/**
 * Config Context
 * Configuration ve platform adapter için context
 *
 * Bu context, config ve platform adapter'ı tek bir yerde toplar.
 */

import { RewordlyConfig, IPlatformAdapter } from "../types";

/**
 * Config işlemleri için context
 */
export class ConfigContext {
  constructor(
    public readonly config: RewordlyConfig,
    public readonly platformAdapter: IPlatformAdapter | null
  ) {}
}
