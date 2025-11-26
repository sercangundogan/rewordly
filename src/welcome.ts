/**
 * Welcome page script
 * Handles welcome page interactions
 */

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

  // Get Started button
  const getStartedBtn = document.getElementById('getStartedBtn');
  if (getStartedBtn) {
    getStartedBtn.addEventListener('click', (e) => {
      e.preventDefault();
      window.close();
    });
  }

  // Mark welcome as viewed
  await chrome.storage.local.set({
    welcomeShown: true,
    lastViewedVersion: manifest.version
  });
})();

