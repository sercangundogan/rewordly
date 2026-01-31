/**
 * Rewordly API Utility for Rewordly Extension
 * Handles API requests and text rewriting functionality
 */

export interface RewordlyResponse {
  rewritten: string;
}

export interface GrammarResponse {
  corrected: string;
}

export interface RewriteOptions {
  preserveMeaning?: boolean;
}

export class RewordlyAPIUtil {
  private baseUrl: string = 'https://rewordly.store/api';

  constructor() {
    // No API key needed for the new endpoint
  }

  /**
   * Rewrite text using Rewordly API
   * @param text - The text to rewrite
   * @param options - Configuration options
   * @returns Promise<string> - The rewritten text
   */
  async rewriteText(text: string, _options: RewriteOptions = {}): Promise<string> {

    try {
      const response = await this.makeRequest('/rewrite', {
        method: 'POST',
        body: JSON.stringify({
          text: text
        })
      });

      const data = response as RewordlyResponse;
      return data.rewritten || 'Failed to rewrite text.';
    } catch (error) {
      console.error('Rewordly API error:', error);
      throw new Error(`Failed to rewrite text: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Fix grammar in text using Rewordly API
   * @param text - The text to fix grammar for
   * @returns Promise<string> - The grammar-corrected text
   */
  async grammarText(text: string): Promise<string> {
    try {
      const response = await this.makeRequest('/grammar', {
        method: 'POST',
        body: JSON.stringify({
          text: text
        })
      });

      const data = response as GrammarResponse;
      return data.corrected || 'Failed to fix grammar.';
    } catch (error) {
      console.error('Rewordly Grammar API error:', error);
      throw new Error(`Failed to fix grammar: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Test if the API is accessible
   * @returns Promise<boolean> - Whether the API is accessible
   */
  async testApi(): Promise<boolean> {
    try {
      await this.makeRequest('/rewrite', {
        method: 'POST',
        body: JSON.stringify({
          text: 'Test'
        })
      });
      return true;
    } catch (error) {
      console.error('API test failed:', error);
      return false;
    }
  }

  /**
   * Make a request to the Rewordly API
   * @param endpoint - API endpoint
   * @param options - Request options
   * @returns Promise<any> - API response
   */
  private async makeRequest(endpoint: string, options: RequestInit = {}): Promise<any> {
    const url = `${this.baseUrl}${endpoint}`;
    
    const requestOptions: RequestInit = {
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      },
      ...options
    };

    const response = await fetch(url, requestOptions);

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage: string;
      
      try {
        const errorData = JSON.parse(errorText);
        errorMessage = errorData.error?.message || `HTTP ${response.status}: ${response.statusText}`;
      } catch {
        errorMessage = `HTTP ${response.status}: ${response.statusText}`;
      }

      throw new Error(errorMessage);
    }

    return response.json();
  }
}

/**
 * Create a default Rewordly API utility instance
 * @returns RewordlyAPIUtil instance
 */
export function createRewordlyAPIUtil(): RewordlyAPIUtil {
  return new RewordlyAPIUtil();
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
  return rewordly.rewriteText(text, options);
}
