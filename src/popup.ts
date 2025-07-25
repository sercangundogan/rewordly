/**
 * Rewordly Popup Script
 * Handles settings management and UI interactions
 */

interface RewordlySettings {
  enabled: boolean;
}

class RewordlyPopup {
  private settings: RewordlySettings = {
    enabled: true
  };

  private enabledToggle: HTMLButtonElement | null = null;

  constructor() {
    this.init();
  }

  private async init(): Promise<void> {
    // Initialize UI elements
    this.enabledToggle = document.getElementById('enabledToggle') as HTMLButtonElement;
    
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

    // Toggle switch
    if (this.enabledToggle) {
      this.enabledToggle.addEventListener('click', this.toggleEnabled.bind(this));
    }


  }

  private updateUI(): void {
    if (this.enabledToggle) {
      if (this.settings.enabled) {
        this.enabledToggle.classList.add('active');
      } else {
        this.enabledToggle.classList.remove('active');
      }
    }
    
    // Update API status
    const apiStatus = document.getElementById('api-key-status');
    if (apiStatus) {
      apiStatus.innerHTML = `
        <div class="status-card">
          <div class="status-header">
            <div class="status-icon"></div>
            <div class="status-title">API Ready</div>
          </div>
          <p class="status-description">
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

  private toggleEnabled(): void {
    this.settings.enabled = !this.settings.enabled;
    
    if (this.enabledToggle) {
      if (this.settings.enabled) {
        this.enabledToggle.classList.add('active');
      } else {
        this.enabledToggle.classList.remove('active');
      }
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