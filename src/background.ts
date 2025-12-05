/**
 * Rewordly Background Service Worker
 * Handles extension lifecycle and background tasks
 */

// Handle extension installation and updates
chrome.runtime.onInstalled.addListener(async (details) => {
  // Create context menu items
  chrome.contextMenus.create({
    id: 'rewordly-menu',
    title: 'Rewordly',
    contexts: ['selection'] // Only show when text is selected
  });

  // Create sub-menu items
  chrome.contextMenus.create({
    id: 'rewordly-rewrite',
    parentId: 'rewordly-menu',
    title: 'Rewrite Text',
    contexts: ['selection']
  });

  chrome.contextMenus.create({
    id: 'rewordly-grammar',
    parentId: 'rewordly-menu',
    title: 'Check Grammar',
    contexts: ['selection']
  });

  const manifest = chrome.runtime.getManifest();
  const currentVersion = manifest.version;

  if (details.reason === 'install') {
    // Set default configuration
    await chrome.storage.sync.set({
      rewordlyEnabled: true
    });
    
    // Store current version as last viewed and mark welcome as shown
    await chrome.storage.local.set({
      lastViewedVersion: currentVersion,
      welcomeShown: true
    });
    
    // Open welcome page for new installs
    chrome.tabs.create({
      url: chrome.runtime.getURL('welcome.html')
    });
    
    console.log('Rewordly extension installed successfully!');
  } else if (details.reason === 'update') {
    // Check if user has seen this version's changelog
    const result = await chrome.storage.local.get(['lastViewedVersion']);
    const lastViewedVersion = result['lastViewedVersion'] as string | undefined;

    // If this is a new version, show changelog
    if (lastViewedVersion !== currentVersion) {
      chrome.tabs.create({
        url: chrome.runtime.getURL('changelog.html')
      });
      
      console.log(`Rewordly updated from ${details.previousVersion} to ${currentVersion}`);
    }
  }
});

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  // Log in service worker console
  console.log('Rewordly: Context menu clicked!', {
    menuItemId: info.menuItemId,
    selectedText: info.selectionText,
    tabId: tab?.id,
    tabUrl: tab?.url
  });

  if (info.menuItemId === 'rewordly-rewrite') {
    console.log('✅ Rewordly: Rewrite option clicked!', {
      selectedText: info.selectionText,
      tabId: tab?.id
    });
    
    // Also log in page console via content script
    if (tab?.id) {
      try {
        await chrome.tabs.sendMessage(tab.id, {
          type: 'CONTEXT_MENU_CLICKED',
          action: 'rewrite',
          selectedText: info.selectionText
        });
      } catch (error) {
        console.error('Rewordly: Could not send message to content script:', error);
      }
    }
  } else if (info.menuItemId === 'rewordly-grammar') {
    console.log('✅ Rewordly: Grammar check option clicked!', {
      selectedText: info.selectionText,
      tabId: tab?.id
    });
    
    // Also log in page console via content script
    if (tab?.id) {
      try {
        await chrome.tabs.sendMessage(tab.id, {
          type: 'CONTEXT_MENU_CLICKED',
          action: 'grammar',
          selectedText: info.selectionText
        });
      } catch (error) {
        console.error('Rewordly: Could not send message to content script:', error);
      }
    }
  } else {
    console.log('⚠️ Rewordly: Unknown menu item clicked:', info.menuItemId);
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