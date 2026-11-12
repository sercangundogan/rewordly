/**
 * Welcome page script
 * Handles welcome page interactions
 */

import { API_BASE } from './config';

(async () => {
  // Get version from manifest
  const manifest = chrome.runtime.getManifest();
  
  // Close button functionality
  const closeBtn = document.getElementById('closeBtn');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      window.close();
    });
  }

  // "Try it now": live checking can't run on extension pages, so open the
  // playground on the website, where the first underlines appear right away.
  const getStartedBtn = document.getElementById('getStartedBtn');
  if (getStartedBtn) {
    getStartedBtn.addEventListener('click', (e) => {
      e.preventDefault();
      window.location.href = `${API_BASE}/try`;
    });
  }

  // Mark welcome as viewed
  await chrome.storage.local.set({
    welcomeShown: true,
    lastViewedVersion: manifest.version
  });
})();

