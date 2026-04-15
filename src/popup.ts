/**
 * Rewordly Popup Script
 * Handles settings management, auth (website login + code), and UI interactions
 */

import { API_BASE, AUTH_ENABLED } from './config';
import { getSession, setSession, SESSION_KEY, getApiHeaders } from './auth';

interface RewordlySettings {
  rewriteEnabled: boolean;
  rewriteTone: 'standard' | 'formal' | 'casual' | 'concise' | 'elaborate';
}

class RewordlyPopup {
  private settings: RewordlySettings = {
    rewriteEnabled: true,
    rewriteTone: 'standard',
  };

  private rewriteToggle: HTMLButtonElement | null = null;
  private toneSelect: HTMLSelectElement | null = null;

  constructor() {
    this.init();
  }

  private async init(): Promise<void> {
    this.rewriteToggle = document.getElementById('rewriteToggle') as HTMLButtonElement;
    this.toneSelect = document.getElementById('rewriteTone') as HTMLSelectElement;

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

  private async fetchUsageData(): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
    try {
      const headers = await getApiHeaders();
      const res = await fetch(`${API_BASE}/api/usage`, { method: 'GET', headers });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return { ok: res.ok, status: res.status, data };
    } catch {
      return { ok: false, status: 0, data: {} };
    }
  }

  /**
   * Updates the "Today's usage" card from /api/usage payload.
   */
  private applyUsageToUI(data: Record<string, unknown> | null, opts?: { error?: string }): void {
    const section = document.getElementById('usageSection');
    const summary = document.getElementById('usageSummary');
    const rows = document.getElementById('usageRows');
    const footnote = section?.querySelector('.usage-footnote') as HTMLElement | null;
    const rewriteVals = document.getElementById('usageRewriteValues');
    const grammarVals = document.getElementById('usageGrammarValues');
    const rewriteBar = document.getElementById('usageRewriteBar');
    const grammarBar = document.getElementById('usageGrammarBar');

    if (!section || !summary || !rows || !rewriteVals || !grammarVals || !rewriteBar || !grammarBar) return;

    section.style.display = 'block';

    if (opts?.error) {
      summary.textContent = opts.error;
      rows.style.display = 'none';
      if (footnote) footnote.style.display = 'none';
      return;
    }

    if (!data) {
      summary.textContent = "Couldn't load today's usage.";
      rows.style.display = 'none';
      if (footnote) footnote.style.display = 'none';
      return;
    }

    const rLimit = data['rewriteLimit'];
    const gLimit = data['grammarLimit'];
    const unlimited = rLimit === null && gLimit === null;

    if (unlimited) {
      summary.textContent = 'Unlimited rewrites and grammar today (Pro).';
      rows.style.display = 'none';
      if (footnote) {
        footnote.style.display = 'block';
        footnote.textContent = 'Your plan has no daily cap for these actions.';
      }
      return;
    }

    rows.style.display = 'block';
    if (footnote) {
      footnote.style.display = 'block';
      footnote.textContent =
        data['requireLogin'] === true
          ? 'Anonymous limits apply to this browser. Log in for higher daily limits.'
          : 'Counts reset daily (UTC).';
    }

    const rUsed = Number(data['rewriteUsed'] ?? 0);
    const gUsed = Number(data['grammarUsed'] ?? 0);
    const rMax = typeof rLimit === 'number' ? rLimit : Number(rLimit);
    const gMax = typeof gLimit === 'number' ? gLimit : Number(gLimit);

    summary.textContent = "Today's usage for rewrite and grammar.";

    const setBar = (el: HTMLElement, used: number, max: number) => {
      if (!Number.isFinite(max) || max <= 0) {
        el.style.width = '0%';
        el.classList.remove('usage-bar-warn', 'usage-bar-full');
        return;
      }
      const ratio = used / max;
      const pct = Math.min(100, Math.round(ratio * 100));
      el.style.width = `${pct}%`;
      el.classList.remove('usage-bar-warn', 'usage-bar-full');
      if (used >= max) el.classList.add('usage-bar-full');
      else if (ratio >= 0.8) el.classList.add('usage-bar-warn');
    };

    if (rLimit === null || rLimit === undefined) {
      rewriteVals.textContent = 'Unlimited';
      rewriteBar.style.width = '0%';
      rewriteBar.classList.remove('usage-bar-warn', 'usage-bar-full');
    } else {
      rewriteVals.textContent = `${rUsed} / ${rMax}`;
      setBar(rewriteBar, rUsed, rMax);
    }

    if (gLimit === null || gLimit === undefined) {
      grammarVals.textContent = 'Unlimited';
      grammarBar.style.width = '0%';
      grammarBar.classList.remove('usage-bar-warn', 'usage-bar-full');
    } else {
      grammarVals.textContent = `${gUsed} / ${gMax}`;
      setBar(grammarBar, gUsed, gMax);
    }
  }

  private async refreshUsageFromNetwork(): Promise<void> {
    const { ok, status, data } = await this.fetchUsageData();
    if (status === 401) {
      await setSession(null);
      void this.renderAccount();
      return;
    }
    if (ok) this.applyUsageToUI(data);
    else this.applyUsageToUI(null, { error: "Couldn't load today's usage." });
  }

  private async loadSettings(): Promise<void> {
    try {
      const result = await chrome.storage.sync.get(['rewordlyRewriteEnabled', 'rewordlyRewriteTone']);
      const stored = result['rewordlyRewriteEnabled'];
      // Default to true when never set (first install)
      this.settings.rewriteEnabled = stored !== false;
      if (stored === undefined) {
        await chrome.storage.sync.set({ rewordlyRewriteEnabled: true });
      }

      const storedTone = result['rewordlyRewriteTone'];
      const validTones: RewordlySettings['rewriteTone'][] = [
        'standard',
        'formal',
        'casual',
        'concise',
        'elaborate',
      ];
      this.settings.rewriteTone = validTones.includes(storedTone) ? storedTone : 'standard';
      if (storedTone === undefined) {
        await chrome.storage.sync.set({ rewordlyRewriteTone: this.settings.rewriteTone });
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
    if (this.toneSelect) {
      this.toneSelect.addEventListener('change', this.handleToneChange.bind(this));
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
      await this.refreshUsageFromNetwork();
      return;
    }

    this.showAccountState(notConfigured, loggedOut, loggedIn, 'loggedOut');
    await this.refreshUsageFromNetwork();
  }

  private async showLoggedInState(
    _session: { access_token: string },
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
    const { ok, status, data } = await this.fetchUsageData();

    if (status === 401 || (ok && data['requireLogin'])) {
      await setSession(null);
      void this.renderAccount();
      return;
    }

    if (ok) {
      const user = data['user'] as { email?: string } | undefined;
      email = user?.email ?? 'Logged in';
      isPro = Boolean(data['isSubscribed']);
      this.applyUsageToUI(data);
    } else {
      this.applyUsageToUI(null, { error: "Couldn't load today's usage." });
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
    if (this.toneSelect) {
      this.toneSelect.value = this.settings.rewriteTone;
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

  private async handleToneChange(): Promise<void> {
    if (!this.toneSelect) return;
    const value = this.toneSelect.value as RewordlySettings['rewriteTone'];
    this.settings.rewriteTone = value;
    await this.saveSettings();
  }

  private async saveSettings(): Promise<void> {
    try {
      await chrome.storage.sync.set({
        rewordlyRewriteEnabled: this.settings.rewriteEnabled,
        rewordlyRewriteTone: this.settings.rewriteTone,
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