/**
 * Changelog page script
 * Handles version display and marking changelog as viewed
 */

(async () => {
  // Get version from manifest
  const manifest = chrome.runtime.getManifest();
  const versionBadge = document.getElementById('versionBadge');
  if (versionBadge) {
    versionBadge.textContent = `Version ${manifest.version}`;
  }

  // Close button functionality
  const closeBtn = document.getElementById('closeBtn');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      window.close();
    });
  }

  // Mark changelog as viewed
  await chrome.storage.local.set({
    lastViewedVersion: manifest.version
  });
})();

