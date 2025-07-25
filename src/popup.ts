/**
 * Rewordly Popup Script
 * Handles settings management and API key testing
 */

interface RewordlySettings {
  enabled: boolean;
}

class RewordlyPopup {
  private settings: RewordlySettings = {
    enabled: true
  };

  private enabledToggle: HTMLInputElement | null = null;

  constructor() {
    this.init();
  }

  private async init(): Promise<void> {
    // Initialize UI elements
    this.enabledToggle = document.getElementById('enabledToggle') as HTMLInputElement;
    
    // Load settings
    await this.loadSettings();
    
    // Set up event listeners
    this.setupEventListeners();
  }

  private async loadSettings(): Promise<void> {
    try {
      const result = await chrome.storage.sync.get(['rewordlyEnabled']);
      this.settings.enabled = result['rewordlyEnabled'] !== false;
      
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
    testBtn.addEventListener('click', this.testApi.bind(this));

    // Toggle switch
    const enabledToggle = document.getElementById('enabledToggle') as HTMLDivElement;
    enabledToggle.addEventListener('click', this.toggleEnabled.bind(this));

    // Reset button
    const resetBtn = document.getElementById('resetBtn') as HTMLAnchorElement;
    resetBtn.addEventListener('click', this.resetSettings.bind(this));
  }

  private updateUI(): void {
    if (this.enabledToggle) {
      this.enabledToggle.checked = this.settings.enabled;
    }
    
    // Update API status
    const apiStatus = document.getElementById('api-key-status');
    if (apiStatus) {
      apiStatus.innerHTML = `
        <div style="background: #f0fdf4; border: 1px solid #10b981; border-radius: 8px; padding: 12px; margin-bottom: 20px;">
          <div style="display: flex; align-items: center; margin-bottom: 8px;">
            <span style="color: #059669; font-size: 16px; margin-right: 8px;">✅</span>
            <span style="font-weight: 600; color: #059669;">API Ready</span>
          </div>
          <p style="margin: 0; color: #059669; font-size: 12px;">
            Rewordly API is ready to use. No API key required.
          </p>
        </div>
      `;
    }
  }

  private async saveSettings(): Promise<void> {
    try {
      await chrome.storage.sync.set({
        rewordlyEnabled: this.settings.enabled
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

  private async testApi(): Promise<void> {
    const testBtn = document.getElementById('testBtn') as HTMLButtonElement;
    const originalText = testBtn.textContent;
    testBtn.textContent = 'Testing...';
    testBtn.disabled = true;

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'TEST_API'
      });

      if (response.isValid) {
        this.showStatus('API is working! You can now use Rewordly.', 'success');
      } else {
        this.showStatus('API test failed. Please try again.', 'error');
      }
    } catch (error) {
      console.error('API test failed:', error);
      this.showStatus('Failed to test API. Please check your connection.', 'error');
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
        enabled: true
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