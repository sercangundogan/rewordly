/**
 * Rewordly Background Service Worker
 * Handles extension lifecycle and background tasks
 */

// Handle extension installation
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    // Set default configuration
    chrome.storage.sync.set({
      rewordlyEnabled: true
    });
    
    // Open welcome page or show notification
    console.log('Rewordly extension installed successfully!');
  }
});

// Handle extension startup
chrome.runtime.onStartup.addListener(() => {
  console.log('Rewordly extension started');
});

// Handle messages from content script or popup
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  switch (request.type) {
    case 'GET_CONFIG':
      chrome.storage.sync.get(['rewordlyEnabled'], (result) => {
        sendResponse(result);
      });
      return true; // Keep message channel open for async response
      
    case 'SET_CONFIG':
      chrome.storage.sync.set({
        rewordlyEnabled: request.config.enabled
      }, () => {
        sendResponse({ success: true });
      });
      return true;
      
    case 'TEST_API':
      testApi().then((isValid) => {
        sendResponse({ isValid });
      }).catch((error) => {
        sendResponse({ isValid: false, error: error.message });
      });
      return true;
      
    default:
      sendResponse({ error: 'Unknown message type' });
      return false;
  }
});

// Test API validity
async function testApi(): Promise<boolean> {
  try {
    const response = await fetch('https://rewordly-web.vercel.app/api/rewrite', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text: 'Test'
      })
    });
    return response.ok;
  } catch (error) {
    console.error('API test failed:', error);
    return false;
  }
}

// Handle storage changes
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'sync') {
    console.log('Rewordly configuration updated:', changes);
  }
});

// Handle tab updates to inject content script if needed
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && tab.url.startsWith('http')) {
    // Content script is automatically injected via manifest.json
    console.log('Tab updated:', tab.url);
  }
}); 