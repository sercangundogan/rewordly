/**
 * Rewordly Popup Script
 * Handles settings management and API key testing
 */

interface RewordlySettings {
  enabled: boolean;
  apiKey: string;
  model: string;
}

class RewordlyPopup {
  private settings: RewordlySettings = {
    enabled: true,
    apiKey: '',
    model: 'gpt-3.5-turbo'
  };

  private enabledToggle: HTMLInputElement | null = null;
  private modelSelect: HTMLSelectElement | null = null;

  constructor() {
    this.init();
  }

  private async init(): Promise<void> {
    // Initialize UI elements
    this.enabledToggle = document.getElementById('enabledToggle') as HTMLInputElement;
    this.modelSelect = document.getElementById('model') as HTMLSelectElement;
    
    // Load settings
    await this.loadSettings();
    
    // Set up event listeners
    this.setupEventListeners();
  }

  private async loadSettings(): Promise<void> {
    try {
      const result = await chrome.storage.sync.get(['rewordlyEnabled', 'rewordlyApiKey', 'rewordlyModel']);
      this.settings.enabled = result['rewordlyEnabled'] !== false;
      this.settings.apiKey = result['rewordlyApiKey'] || '';
      this.settings.model = result['rewordlyModel'] || 'gpt-3.5-turbo';
      
      this.updateUI();
    } catch (error) {
      console.error('Failed to load settings:', error);
    }
  }

  private setupEventListeners(): void {
    // Save button
    const saveBtn = document.getElementById('saveBtn') as HTMLButtonElement;
    saveBtn.addEventListener('click', this.saveSettings.bind(this));

    // Test button
    const testBtn = document.getElementById('testBtn') as HTMLButtonElement;
    testBtn.addEventListener('click', this.testApiKey.bind(this));

    // Toggle switch
    const enabledToggle = document.getElementById('enabledToggle') as HTMLDivElement;
    enabledToggle.addEventListener('click', this.toggleEnabled.bind(this));

    // Reset button
    const resetBtn = document.getElementById('resetBtn') as HTMLAnchorElement;
    resetBtn.addEventListener('click', this.resetSettings.bind(this));

    // Input fields
    const modelSelect = document.getElementById('model') as HTMLSelectElement;

    modelSelect.addEventListener('change', (e) => {
      this.settings.model = (e.target as HTMLSelectElement).value;
    });
  }

  private updateUI(): void {
    if (this.enabledToggle) {
      this.enabledToggle.checked = this.settings.enabled;
    }
    if (this.modelSelect) {
      this.modelSelect.value = this.settings.model;
    }
    
    // Update API key status
    const apiKeyStatus = document.getElementById('api-key-status');
    if (apiKeyStatus) {
      if (this.settings.apiKey) {
        apiKeyStatus.innerHTML = `
          <div style="background: #f0fdf4; border: 1px solid #10b981; border-radius: 8px; padding: 12px; margin-bottom: 20px;">
            <div style="display: flex; align-items: center; margin-bottom: 8px;">
              <span style="color: #059669; font-size: 16px; margin-right: 8px;">✅</span>
              <span style="font-weight: 600; color: #059669;">API Key Set</span>
            </div>
            <p style="margin: 0; color: #059669; font-size: 12px;">
              Your OpenAI API key is configured and ready to use.
            </p>
          </div>
        `;
      } else {
        apiKeyStatus.innerHTML = `
          <div style="background: #fef2f2; border: 1px solid #ef4444; border-radius: 8px; padding: 12px; margin-bottom: 20px;">
            <div style="display: flex; align-items: center; margin-bottom: 8px;">
              <span style="color: #dc2626; font-size: 16px; margin-right: 8px;">⚠️</span>
              <span style="font-weight: 600; color: #dc2626;">API Key Required</span>
            </div>
            <p style="margin: 0; color: #dc2626; font-size: 12px;">
              Please enter your OpenAI API key to use the rewrite feature.
            </p>
            <input type="password" id="api-key-input" placeholder="sk-..." style="width: 100%; margin-top: 8px; padding: 8px; border: 1px solid #d1d5db; border-radius: 4px;">
            <button id="save-api-key" style="margin-top: 8px; padding: 6px 12px; background: #059669; color: white; border: none; border-radius: 4px; cursor: pointer;">Save API Key</button>
          </div>
        `;
        
        // Add event listener for save button
        const saveButton = document.getElementById('save-api-key');
        const apiKeyInput = document.getElementById('api-key-input') as HTMLInputElement;
        if (saveButton && apiKeyInput) {
          saveButton.addEventListener('click', () => {
            this.settings.apiKey = apiKeyInput.value;
            chrome.storage.sync.set({ rewordlyApiKey: this.settings.apiKey });
            this.updateUI();
          });
        }
      }
    }
  }

  private async saveSettings(): Promise<void> {
    try {
      await chrome.storage.sync.set({
        rewordlyEnabled: this.settings.enabled,
        rewordlyApiKey: this.settings.apiKey,
        rewordlyModel: this.settings.model
      });

      this.showStatus('Settings saved successfully!', 'success');
      
      // Notify content scripts about the update
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'SETTINGS_UPDATED' });
      }
    } catch (error) {
      console.error('Failed to save settings:', error);
      this.showStatus('Failed to save settings. Please try again.', 'error');
    }
  }

  private async testApiKey(): Promise<void> {
    // Get the API key from settings (which should include the .env value)
    const apiKey = this.settings.apiKey || '';
    
    if (!apiKey) {
      this.showStatus('No API key found. Please check your .env file.', 'error');
      return;
    }

    const testBtn = document.getElementById('testBtn') as HTMLButtonElement;
    const originalText = testBtn.textContent;
    testBtn.textContent = 'Testing...';
    testBtn.disabled = true;

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'TEST_API_KEY',
        apiKey: apiKey
      });

      if (response.isValid) {
        this.showStatus('API key is valid! You can now use Rewordly.', 'success');
      } else {
        this.showStatus('Invalid API key. Please check your key and try again.', 'error');
      }
    } catch (error) {
      console.error('API key test failed:', error);
      this.showStatus('Failed to test API key. Please check your connection.', 'error');
    } finally {
      testBtn.textContent = originalText;
      testBtn.disabled = false;
    }
  }

  private toggleEnabled(): void {
    this.settings.enabled = !this.settings.enabled;
    const enabledToggle = document.getElementById('enabledToggle') as HTMLDivElement;
    
    if (this.settings.enabled) {
      enabledToggle.classList.add('active');
    } else {
      enabledToggle.classList.remove('active');
    }
  }

  private async resetSettings(): Promise<void> {
    if (confirm('Are you sure you want to reset all settings? This will reset to defaults.')) {
      this.settings = {
        enabled: true,
        apiKey: '',
        model: 'gpt-3.5-turbo'
      };

      await chrome.storage.sync.clear();
      this.updateUI();
      this.showStatus('Settings reset to defaults.', 'info');
    }
  }

  private showStatus(message: string, type: 'success' | 'error' | 'info'): void {
    const statusElement = document.getElementById('status') as HTMLDivElement;
    statusElement.textContent = message;
    statusElement.className = `status ${type}`;
    statusElement.classList.remove('hidden');

    // Auto-hide after 5 seconds
    setTimeout(() => {
      statusElement.classList.add('hidden');
    }, 5000);
  }
}

// Initialize popup when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  new RewordlyPopup();
}); 