/**
 * Rewordly Popup Script
 * Handles settings management and UI interactions
 */

interface RewordlySettings {
  rewriteEnabled: boolean;
}

class RewordlyPopup {
  private settings: RewordlySettings = {
    rewriteEnabled: true
  };

  private rewriteToggle: HTMLButtonElement | null = null;

  constructor() {
    this.init();
  }

  private async init(): Promise<void> {
    this.rewriteToggle = document.getElementById('rewriteToggle') as HTMLButtonElement;
    
    // Load settings
    await this.loadSettings();
    
    // Set up event listeners
    this.setupEventListeners();
  }

  private async loadSettings(): Promise<void> {
    try {
      const result = await chrome.storage.sync.get(['rewordlyRewriteEnabled']);
      this.settings.rewriteEnabled = result['rewordlyRewriteEnabled'] !== false;
      this.updateUI();
    } catch (error) {
      console.error('Failed to load settings:', error);
    }
  }

  private setupEventListeners(): void {
    if (this.rewriteToggle) {
      this.rewriteToggle.addEventListener('click', this.toggleRewrite.bind(this));
    }
  }

  private updateUI(): void {
    if (this.rewriteToggle) {
      if (this.settings.rewriteEnabled) {
        this.rewriteToggle.classList.add('active');
      } else {
        this.rewriteToggle.classList.remove('active');
      }
    }
  }

  private async toggleRewrite(): Promise<void> {
    this.settings.rewriteEnabled = !this.settings.rewriteEnabled;
    
    if (this.rewriteToggle) {
      if (this.settings.rewriteEnabled) {
        this.rewriteToggle.classList.add('active');
      } else {
        this.rewriteToggle.classList.remove('active');
      }
    }

    // Auto-save settings
    await this.saveSettings();
  }

  private async saveSettings(): Promise<void> {
    try {
      await chrome.storage.sync.set({
        rewordlyRewriteEnabled: this.settings.rewriteEnabled
      });

      this.showSuccessMessage();
      
      // Notify content scripts about the update
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'SETTINGS_UPDATED' });
      }
    } catch (error) {
      console.error('Failed to save settings:', error);
      this.showErrorMessage('Failed to save settings. Please try again.');
    }
  }

  private showSuccessMessage(): void {
    // Remove any existing success message
    const existingMessage = document.querySelector('.rewordly-success-message');
    if (existingMessage) {
      existingMessage.remove();
    }

    // Create success message element
    const successMessage = document.createElement('div');
    successMessage.className = 'rewordly-success-message';
    successMessage.innerHTML = `
      <div class="success-icon">✓</div>
      <div class="success-text">Settings saved!</div>
    `;

    // Add to the content area
    const content = document.querySelector('.content');
    if (content) {
      content.appendChild(successMessage);
    }

    // Trigger animation
    setTimeout(() => {
      successMessage.classList.add('show');
    }, 10);

    // Auto-remove after 3 seconds
    setTimeout(() => {
      successMessage.classList.remove('show');
      setTimeout(() => {
        if (successMessage.parentNode) {
          successMessage.remove();
        }
      }, 300);
    }, 3000);
  }

  private showErrorMessage(message: string): void {
    // Remove any existing error message
    const existingMessage = document.querySelector('.rewordly-error-message');
    if (existingMessage) {
      existingMessage.remove();
    }

    // Create error message element
    const errorMessage = document.createElement('div');
    errorMessage.className = 'rewordly-error-message';
    errorMessage.innerHTML = `
      <div class="error-icon">⚠</div>
      <div class="error-text">${message}</div>
    `;

    // Add to the content area
    const content = document.querySelector('.content');
    if (content) {
      content.appendChild(errorMessage);
    }

    // Trigger animation
    setTimeout(() => {
      errorMessage.classList.add('show');
    }, 10);

    // Auto-remove after 5 seconds
    setTimeout(() => {
      errorMessage.classList.remove('show');
      setTimeout(() => {
        if (errorMessage.parentNode) {
          errorMessage.remove();
        }
      }, 300);
    }, 5000);
  }
}

// Initialize popup when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  new RewordlyPopup();
}); 