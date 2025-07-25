/**
 * OpenAI API Utility for Rewordly Extension
 * Handles API requests and text rewriting functionality
 */

export interface OpenAIResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface RewriteOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  preserveMeaning?: boolean;
}

export class OpenAIUtil {
  private apiKey: string;
  private baseUrl: string = 'https://api.openai.com/v1';

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Rewrite text using OpenAI's GPT API
   * @param text - The text to rewrite
   * @param options - Configuration options
   * @returns Promise<string> - The rewritten text
   */
  async rewriteText(text: string, options: RewriteOptions = {}): Promise<string> {
    const {
      model = 'gpt-3.5-turbo',
      maxTokens = 500,
      temperature = 0.7,
      preserveMeaning = true
    } = options;

    const systemPrompt = preserveMeaning
      ? 'You are a helpful assistant that rewrites text to improve grammar, clarity, and fluency while preserving the original meaning. Provide only the rewritten text without any explanations or additional formatting.'
      : 'You are a helpful assistant that rewrites text to improve grammar, clarity, and fluency. Provide only the rewritten text without any explanations or additional formatting.';

    const userPrompt = `Please rewrite the following text to improve its grammar, clarity, and fluency${preserveMeaning ? ' while preserving the original meaning' : ''}: "${text}"`;

    try {
      const response = await this.makeRequest('/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          max_tokens: maxTokens,
          temperature,
          top_p: 1,
          frequency_penalty: 0,
          presence_penalty: 0
        })
      });

      const data = response as OpenAIResponse;
      return data.choices[0]?.message?.content?.trim() || 'Failed to rewrite text.';
    } catch (error) {
      console.error('OpenAI API error:', error);
      throw new Error(`Failed to rewrite text: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Test if the API key is valid
   * @returns Promise<boolean> - Whether the API key is valid
   */
  async testApiKey(): Promise<boolean> {
    try {
      await this.makeRequest('/models', {
        method: 'GET'
      });
      return true;
    } catch (error) {
      console.error('API key test failed:', error);
      return false;
    }
  }

  /**
   * Get available models for the API key
   * @returns Promise<string[]> - List of available model IDs
   */
  async getAvailableModels(): Promise<string[]> {
    try {
      const response = await this.makeRequest('/models', {
        method: 'GET'
      }) as { data: Array<{ id: string }> };
      
      return response.data
        .filter(model => model.id.includes('gpt'))
        .map(model => model.id);
    } catch (error) {
      console.error('Failed to get models:', error);
      return ['gpt-3.5-turbo', 'gpt-4'];
    }
  }

  /**
   * Make a request to the OpenAI API
   * @param endpoint - API endpoint
   * @param options - Request options
   * @returns Promise<any> - API response
   */
  private async makeRequest(endpoint: string, options: RequestInit = {}): Promise<any> {
    const url = `${this.baseUrl}${endpoint}`;
    
    const requestOptions: RequestInit = {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
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

  /**
   * Get usage statistics for the API key
   * @param date - Date in YYYY-MM-DD format
   * @returns Promise<any> - Usage statistics
   */
  async getUsage(date?: string): Promise<any> {
    const dateParam = date || new Date().toISOString().split('T')[0];
    
    try {
      return await this.makeRequest(`/usage?date=${dateParam}`, {
        method: 'GET'
      });
    } catch (error) {
      console.error('Failed to get usage:', error);
      return null;
    }
  }
}

/**
 * Create a default OpenAI utility instance
 * @param apiKey - OpenAI API key
 * @returns OpenAIUtil instance
 */
export function createOpenAIUtil(apiKey: string): OpenAIUtil {
  return new OpenAIUtil(apiKey);
}

/**
 * Default rewrite function for easy use
 * @param text - Text to rewrite
 * @param apiKey - OpenAI API key
 * @param options - Rewrite options
 * @returns Promise<string> - Rewritten text
 */
export async function rewriteText(
  text: string,
  apiKey: string,
  options: RewriteOptions = {}
): Promise<string> {
  const openai = createOpenAIUtil(apiKey);
  return openai.rewriteText(text, options);
} 