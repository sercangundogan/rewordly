/**
 * Rewordly WebSocket API Utility for Rewordly Extension
 * Handles WebSocket connections and text rewriting/grammar functionality
 */

export interface RewordlyResponse {
  rewritten: string;
}

export interface GrammarResponse {
  corrected: string;
  errors?: Array<{
    start: number;
    end: number;
    word: string;
    suggestions: string[];
    type: "grammar" | "spelling";
  }>;
}

export interface RewriteOptions {
  preserveMeaning?: boolean;
}

// WebSocket message types
interface BaseMessage {
  id: string;
  type: string;
  timestamp?: number;
}

interface GrammarCheckRequest extends BaseMessage {
  type: "grammar_check";
  text: string;
  language?: string;
  mode?: "default" | "ai";
}

interface RewriteRequest extends BaseMessage {
  type: "rewrite";
  text: string;
  preserveMeaning?: boolean;
}

interface GrammarCheckResponse extends BaseMessage {
  type: "grammar_check_response";
  errors: Array<{
    start: number;
    end: number;
    word: string;
    suggestions: string[];
    type: "grammar" | "spelling";
  }>;
  corrected: string;
  detectedLanguage?: {
    code: string;
    name: string;
  };
}

interface RewriteResponse extends BaseMessage {
  type: "rewrite_response";
  rewritten: string;
}

interface ErrorResponse extends BaseMessage {
  type: "error";
  error: string;
  message: string;
}

type ServerMessage =
  | GrammarCheckResponse
  | RewriteResponse
  | ErrorResponse
  | { type: "connected" | "pong" };

export class RewordlyAPIUtil {
  private wsUrl: string;
  private ws: WebSocket | null = null;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 5;
  private reconnectDelay: number = 1000;
  private pendingRequests: Map<
    string,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timeoutId?: NodeJS.Timeout;
    }
  > = new Map();
  private connectionPromise: Promise<void> | null = null;

  constructor(wsUrl?: string) {
    // Production WebSocket server URL (WSS with Let's Encrypt SSL)
    // For Chrome extension, we can't use process.env, so we use a default or pass it in
    this.wsUrl = wsUrl || "wss://rewordly.store";
  }

  /**
   * Generate a unique message ID
   */
  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Connect to WebSocket server
   */
  private async connect(): Promise<void> {
    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    this.connectionPromise = new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.wsUrl);

        this.ws.onopen = () => {
          console.log("WebSocket connected");
          this.reconnectAttempts = 0;
          resolve();
        };

        this.ws.onmessage = (event) => {
          try {
            const message: ServerMessage = JSON.parse(event.data);
            this.handleMessage(message);
          } catch (error) {
            console.error("Error parsing WebSocket message:", error);
          }
        };

        this.ws.onerror = (error) => {
          console.error("WebSocket error:", error);
          reject(new Error("WebSocket connection error"));
        };

        this.ws.onclose = () => {
          console.log("WebSocket disconnected");
          this.ws = null;
          this.connectionPromise = null;
          this.handleReconnect();
        };
      } catch (error) {
        this.connectionPromise = null;
        reject(error);
      }
    });

    return this.connectionPromise;
  }

  /**
   * Handle incoming WebSocket messages
   */
  private handleMessage(message: ServerMessage): void {
    if (message.type === "connected" || message.type === "pong") {
      return; // Ignore connection/ping messages
    }

    if (message.type === "error") {
      const errorMsg = message as ErrorResponse;
      const pending = this.pendingRequests.get(errorMsg.id);
      if (pending) {
        this.pendingRequests.delete(errorMsg.id);
        pending.reject(new Error(errorMsg.message || errorMsg.error));
      }
      return;
    }

    // Handle response messages (at this point, message must have an id)
    if ("id" in message) {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        this.pendingRequests.delete(message.id);
        pending.resolve(message);
      }
    }
  }

  /**
   * Handle reconnection logic
   */
  private handleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error("Max reconnection attempts reached");
      // Reject all pending requests
      this.pendingRequests.forEach(({ reject }) => {
        reject(new Error("WebSocket connection lost and reconnection failed"));
      });
      this.pendingRequests.clear();
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    console.log(
      `Attempting to reconnect in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`
    );

    setTimeout(() => {
      this.connect().catch((error) => {
        console.error("Reconnection failed:", error);
      });
    }, delay);
  }

  /**
   * Send a message and wait for response
   */
  private async sendMessage<T extends ServerMessage>(
    message: GrammarCheckRequest | RewriteRequest,
    cancelPrevious?: string // ID of previous request to cancel
  ): Promise<T> {
    // Cancel previous request if specified
    if (cancelPrevious && this.pendingRequests.has(cancelPrevious)) {
      const previous = this.pendingRequests.get(cancelPrevious);
      if (previous) {
        if (previous.timeoutId) {
          clearTimeout(previous.timeoutId);
        }
        this.pendingRequests.delete(cancelPrevious);
        previous.reject(new Error("Request cancelled"));
      }
    }

    // Ensure connection
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await this.connect();
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not connected");
    }

    return new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (this.pendingRequests.has(message.id)) {
          this.pendingRequests.delete(message.id);
          reject(new Error("Request timeout"));
        }
      }, 30000); // 30 second timeout

      this.pendingRequests.set(message.id, { resolve, reject, timeoutId });
      this.ws!.send(JSON.stringify(message));
    });
  }

  /**
   * Cancel a pending request by ID
   */
  cancelRequest(requestId: string): void {
    const pending = this.pendingRequests.get(requestId);
    if (pending) {
      if (pending.timeoutId) {
        clearTimeout(pending.timeoutId);
      }
      this.pendingRequests.delete(requestId);
      pending.reject(new Error("Request cancelled"));
    }
  }

  /**
   * Rewrite text using Rewordly WebSocket API
   * @param text - The text to rewrite
   * @param options - Configuration options
   * @returns Promise<string> - The rewritten text
   */
  async rewriteText(
    text: string,
    _options: RewriteOptions = {}
  ): Promise<string> {
    try {
      const message: RewriteRequest = {
        id: this.generateId(),
        type: "rewrite",
        text: text,
        ...(_options.preserveMeaning !== undefined && {
          preserveMeaning: _options.preserveMeaning,
        }),
      };

      const response = await this.sendMessage<RewriteResponse>(message);
      return response.rewritten || "Failed to rewrite text.";
    } catch (error) {
      console.error("Rewordly API error:", error);
      throw new Error(
        `Failed to rewrite text: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }

  /**
   * Fix grammar in text using Rewordly WebSocket API
   * @param text - The text to fix grammar for
   * @param mode - 'default' uses LanguageTool, 'ai' uses OpenAI
   * @returns Promise<string> - The grammar-corrected text
   */
  async grammarText(
    text: string,
    mode: "default" | "ai" = "default"
  ): Promise<string> {
    try {
      const message: GrammarCheckRequest = {
        id: this.generateId(),
        type: "grammar_check",
        text: text,
        mode: mode,
      };

      const response = await this.sendMessage<GrammarCheckResponse>(message);
      return response.corrected || "Failed to fix grammar.";
    } catch (error) {
      console.error("Rewordly Grammar API error:", error);
      throw new Error(
        `Failed to fix grammar: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }

  /**
   * Check grammar and return full response with errors
   * @param text - The text to check grammar for
   * @param mode - 'default' uses LanguageTool, 'ai' uses OpenAI
   * @param cancelPreviousId - Optional ID of previous request to cancel
   * @returns Promise with errors, corrected text, and detected language
   */
  async checkGrammar(
    text: string,
    mode: "default" | "ai" = "default",
    cancelPreviousId?: string
  ): Promise<{
    errors: Array<{
      start: number;
      end: number;
      word: string;
      suggestions: string[];
      type: "grammar" | "spelling";
    }>;
    corrected: string;
    detectedLanguage?: {
      code: string;
      name: string;
    };
    requestId: string; // Return request ID for cancellation
  }> {
    try {
      const message: GrammarCheckRequest = {
        id: this.generateId(),
        type: "grammar_check",
        text: text,
        mode: mode,
      };

      const response = await this.sendMessage<GrammarCheckResponse>(
        message,
        cancelPreviousId
      );
      return {
        errors: response.errors || [],
        corrected: response.corrected || text,
        ...(response.detectedLanguage && {
          detectedLanguage: response.detectedLanguage,
        }),
        requestId: message.id,
      };
    } catch (error) {
      // Don't log cancellation errors
      if (error instanceof Error && error.message === "Request cancelled") {
        throw error;
      }
      console.error("Rewordly Grammar API error:", error);
      throw new Error(
        `Failed to check grammar: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }

  /**
   * Test if the WebSocket connection is available
   * @returns Promise<boolean> - Whether the connection is available
   */
  async testApi(): Promise<boolean> {
    try {
      await this.connect();
      return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
    } catch (error) {
      console.error("API test failed:", error);
      return false;
    }
  }

  /**
   * Close WebSocket connection
   */
  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this.connectionPromise = null;
    }
    this.pendingRequests.clear();
  }
}

/**
 * Create a default Rewordly API utility instance
 * @param wsUrl - Optional WebSocket server URL (defaults to wss://rewordly.store)
 * @returns RewordlyAPIUtil instance
 */
export function createRewordlyAPIUtil(wsUrl?: string): RewordlyAPIUtil {
  console.log("Bağlantı kuruluyor...");
  return new RewordlyAPIUtil(wsUrl);
}

/**
 * Default rewrite function for easy use
 * @param text - Text to rewrite
 * @param options - Rewrite options
 * @returns Promise<string> - Rewritten text
 */
export async function rewriteText(
  text: string,
  options: RewriteOptions = {}
): Promise<string> {
  const rewordly = createRewordlyAPIUtil();
  try {
    return await rewordly.rewriteText(text, options);
  } finally {
    rewordly.disconnect();
  }
}
