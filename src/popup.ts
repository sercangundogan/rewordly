/**
 * Rewordly Popup Script
 * Handles settings management, auth (website login + code), and UI interactions
 */

import { API_BASE, AUTH_ENABLED } from './config';
import { getSession, setSession, SESSION_KEY } from './auth';

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

    await this.loadSettings();
    this.setupEventListeners();
    this.updateShortcutLabels();
    await this.renderAccount();

    // Re-render shortly so we pick up session set by dashboard (e.g. user just logged in)
    setTimeout(() => void this.renderAccount(), 400);

    // Re-render when session changes (e.g. after dashboard sets it)
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local' && changes[SESSION_KEY]) void this.renderAccount();
    });
  }

  private async loadSettings(): Promise<void> {
    try {
      const result = await chrome.storage.sync.get(['rewordlyRewriteEnabled']);
      const stored = result['rewordlyRewriteEnabled'];
      // Default to true when never set (first install)
      this.settings.rewriteEnabled = stored !== false;
      if (stored === undefined) {
        await chrome.storage.sync.set({ rewordlyRewriteEnabled: true });
      }
      this.updateUI();
    } catch (error) {
      console.error('Failed to load settings:', error);
    }
  }

  private setupEventListeners(): void {
    if (this.rewriteToggle) {
      this.rewriteToggle.addEventListener('click', this.toggleRewrite.bind(this));
    }
    document.getElementById('loginWebsiteBtn')?.addEventListener('click', () => this.openWebsiteLogin());
    document.getElementById('logoutBtn')?.addEventListener('click', () => this.handleLogout());
    document.getElementById('openShortcutsBtn')?.addEventListener('click', () => this.openShortcutsPage());
  }

  private updateShortcutLabels(): void {
    const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform);
    const rewriteKbd = document.getElementById('shortcutRewrite');
    const grammarKbd = document.getElementById('shortcutGrammar');
    if (rewriteKbd) rewriteKbd.textContent = isMac ? '⌘+Shift+E' : 'Ctrl+Shift+E';
    if (grammarKbd) grammarKbd.textContent = isMac ? '⌘+Shift+L' : 'Ctrl+Shift+L';
  }

  private openShortcutsPage(): void {
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  }

  private showAccountState(
    notConfigured: HTMLElement | null,
    loggedOut: HTMLElement | null,
    loggedIn: HTMLElement | null,
    state: 'notConfigured' | 'loggedOut' | 'loggedIn'
  ): void {
    notConfigured && (notConfigured.style.display = state === 'notConfigured' ? 'block' : 'none');
    loggedOut && (loggedOut.style.display = state === 'loggedOut' ? 'block' : 'none');
    loggedIn && (loggedIn.style.display = state === 'loggedIn' ? 'block' : 'none');
  }

  private async renderAccount(): Promise<void> {
    const section = document.getElementById('accountSection');
    const notConfigured = document.getElementById('accountNotConfigured');
    const loggedOut = document.getElementById('accountLoggedOut');
    const loggedIn = document.getElementById('accountLoggedIn');

    if (!section) return;
    section.style.display = 'block';

    // Always check session first: user may have connected via dashboard even when AUTH_ENABLED is false
    const session = await getSession();
    if (session?.access_token) {
      await this.showLoggedInState(session, notConfigured, loggedOut, loggedIn);
      return;
    }

    if (!AUTH_ENABLED) {
      this.showAccountState(notConfigured, loggedOut, loggedIn, 'notConfigured');
      return;
    }

    this.showAccountState(notConfigured, loggedOut, loggedIn, 'loggedOut');
  }

  private async showLoggedInState(
    session: { access_token: string },
    notConfigured: HTMLElement | null,
    loggedOut: HTMLElement | null,
    loggedIn: HTMLElement | null
  ): Promise<void> {
    this.showAccountState(notConfigured, loggedOut, loggedIn, 'loggedIn');

    const emailEl = document.getElementById('accountEmail') as HTMLElement | null;
    const skeletonEl = document.getElementById('accountEmailSkeleton') as HTMLElement | null;
    if (skeletonEl) skeletonEl.style.display = 'block';
    if (emailEl) {
      emailEl.style.display = 'none';
      emailEl.textContent = '';
    }

    let email: string = 'Logged in';
    let isPro = false;
    try {
      const usageRes = await fetch(`${API_BASE}/api/usage`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const data = await usageRes.json().catch(() => ({}));

      if (usageRes.status === 401 || (usageRes.ok && data.requireLogin)) {
        await setSession(null);
        void this.renderAccount();
        return;
      }

      if (usageRes.ok && !data.requireLogin) {
        email = data?.user?.email ?? 'Logged in';
        isPro = Boolean(data?.isSubscribed);
      }
    } catch {
      // Network error: keep session, show logged in with fallback text
    }

    if (skeletonEl) skeletonEl.style.display = 'none';
    if (emailEl) {
      emailEl.textContent = email;
      emailEl.style.display = 'block';
    }
    const proBadge = document.getElementById('proBadge');
    const plansComingSoon = document.getElementById('plansComingSoon');
    if (proBadge) proBadge.style.display = isPro ? 'inline-block' : 'none';
    if (plansComingSoon) plansComingSoon.style.display = isPro ? 'none' : 'block';
  }

  private openWebsiteLogin(): void {
    chrome.tabs.create({ url: `${API_BASE}/login` });
  }

  private async handleLogout(): Promise<void> {
    await setSession(null);
    await this.renderAccount();
    // Open logout page so website session is also cleared, then redirects to home
    chrome.tabs.create({ url: `${API_BASE}/logout` });
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

  private showSuccessMessage(message?: string): void {
    const existingMessage = document.querySelector('.rewordly-success-message');
    if (existingMessage) existingMessage.remove();

    const successMessage = document.createElement('div');
    successMessage.className = 'rewordly-success-message';
    successMessage.innerHTML = `
      <div class="success-icon">✓</div>
      <div class="success-text">${message ?? 'Settings saved!'}</div>
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

// Initialize popup when DOM is ready (popup may already be loaded when script runs)
function initPopup(): void {
  new RewordlyPopup();
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initPopup);
} else {
  initPopup();
} 