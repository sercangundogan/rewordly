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

  // Create disable/enable page menu item (always visible on pages)
  chrome.contextMenus.create({
    id: 'rewordly-disable-page',
    title: 'Disable Rewordly on this page',
    contexts: ['page']
  });

  const manifest = chrome.runtime.getManifest();
  const currentVersion = manifest.version;

  if (details.reason === 'install') {
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

  // Update context menu title for all open tabs after installation/update
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id && tab.url && tab.url.startsWith('http')) {
        updateDisablePageMenuTitle(tab.id);
      }
    }
  } catch (error) {
    console.error('Failed to update context menu titles on install:', error);
  }
});

// Update context menu title based on page disabled status
async function updateDisablePageMenuTitle(tabId?: number): Promise<void> {
  if (!tabId) {
    return;
  }

  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url || !tab.url.startsWith('http')) {
      return;
    }

    const result = await chrome.storage.sync.get(['rewordlyDisabledPages']);
    const disabledPages: string[] = result['rewordlyDisabledPages'] || [];
    
    const currentUrl = tab.url;
    const currentOrigin = new URL(currentUrl).origin;
    
    // Check if exact URL or origin is disabled
    const isDisabled = disabledPages.some(disabledUrl => {
      return disabledUrl === currentUrl || disabledUrl === currentOrigin;
    });

    const title = isDisabled 
      ? 'Enable Rewordly on this page' 
      : 'Disable Rewordly on this page';

    chrome.contextMenus.update('rewordly-disable-page', { title });
  } catch (error) {
    console.error('Failed to update context menu title:', error);
  }
}

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
    console.log('✅ Rewordly: Grammar check option clicked', { tabId: tab?.id });
    
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
  } else if (info.menuItemId === 'rewordly-disable-page') {
    // Handle disable/enable page
    if (!tab?.url || !tab.url.startsWith('http')) {
      return;
    }

    try {
      const result = await chrome.storage.sync.get(['rewordlyDisabledPages']);
      let disabledPages: string[] = result['rewordlyDisabledPages'] || [];
      
      const currentUrl = tab.url;
      const currentOrigin = new URL(currentUrl).origin;
      
      // Check if exact URL or origin is disabled
      const isDisabled = disabledPages.some(disabledUrl => {
        return disabledUrl === currentUrl || disabledUrl === currentOrigin;
      });

      if (isDisabled) {
        // Enable: Remove origin from disabled pages (remove all URLs from this origin)
        const updatedDisabledPages = disabledPages.filter(disabledUrl => {
          // Remove if it's the exact URL, or if it's any URL from the same origin
          if (disabledUrl === currentUrl) {
            return false;
          }
          try {
            const disabledOrigin = new URL(disabledUrl).origin;
            return disabledOrigin !== currentOrigin;
          } catch {
            // If disabledUrl is not a valid URL, keep it (shouldn't happen)
            return true;
          }
        });
        
        await chrome.storage.sync.set({
          rewordlyDisabledPages: updatedDisabledPages
        });
      } else {
        // Disable: Add origin to disabled pages (this will disable all pages from this origin)
        if (!disabledPages.includes(currentOrigin)) {
          // Remove any exact URLs from this origin first (cleanup)
          const cleanedPages = disabledPages.filter(disabledUrl => {
            try {
              const disabledOrigin = new URL(disabledUrl).origin;
              return disabledOrigin !== currentOrigin;
            } catch {
              return true;
            }
          });
          cleanedPages.push(currentOrigin);
          disabledPages = cleanedPages;
        }
        
        await chrome.storage.sync.set({
          rewordlyDisabledPages: disabledPages
        });
      }
      
      // Reload the current tab to apply changes
      if (tab.id) {
        chrome.tabs.reload(tab.id);
      }
    } catch (error) {
      console.error('Failed to toggle page disabled status:', error);
    }
  } else {
    console.log('⚠️ Rewordly: Unknown menu item clicked:', info.menuItemId);
  }
});

// Handle extension startup
chrome.runtime.onStartup.addListener(async () => {
  console.log('Rewordly extension started');
  
  // Update context menu title for all open tabs on startup
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id && tab.url && tab.url.startsWith('http')) {
        updateDisablePageMenuTitle(tab.id);
      }
    }
  } catch (error) {
    console.error('Failed to update context menu titles on startup:', error);
  }
});

// Handle messages from content script or popup
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  switch (request.type) {
    case 'GET_CONFIG':
      chrome.storage.sync.get(['rewordlyHighlightsEnabled', 'rewordlyRewriteEnabled'], (result) => {
        sendResponse(result);
      });
      return true; // Keep message channel open for async response
      
    case 'SET_CONFIG':
      chrome.storage.sync.set({
        rewordlyHighlightsEnabled: request.config.highlightsEnabled,
        rewordlyRewriteEnabled: request.config.rewriteEnabled
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
    const response = await fetch('https://rewordly.store/api/rewrite', {
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
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && tab.url.startsWith('http')) {
    // Content script is automatically injected via manifest.json
    console.log('Tab updated:', tab.url);
    // Update context menu title based on page disabled status
    updateDisablePageMenuTitle(tabId);
  }
});

// Update context menu when tab is activated
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  updateDisablePageMenuTitle(activeInfo.tabId);
});

// Update context menu title when context menu is shown (if API is available)
// Note: onShown is an optional API that may not be in TypeScript definitions
const contextMenusWithShown = chrome.contextMenus as typeof chrome.contextMenus & {
  onShown?: {
    addListener: (callback: (info: { menuIds: (string | number)[] }, tab: chrome.tabs.Tab) => void) => void;
  };
};

if (contextMenusWithShown.onShown) {
  contextMenusWithShown.onShown.addListener(async (_info, tab) => {
    if (tab?.id) {
      updateDisablePageMenuTitle(tab.id);
    }
  });
} 