const busyTabs = new Set();

// Resolve coordinates in the current document, never accept them from a message.
function findSkipPoint() {
  if (location.origin !== 'https://www.youtube.com' || document.visibilityState !== 'visible') return null;
  const selectors = '.ytp-skip-ad-button,.ytp-ad-skip-button,.ytp-ad-skip-button-modern';
  for (const button of document.querySelectorAll(selectors)) {
    if (!button.isConnected || !button.getClientRects().length ||
        button.matches(':disabled, [aria-disabled="true"]')) continue;
    let hidden = false;
    for (let element = button; element; element = element.parentElement) {
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' ||
          style.visibility === 'collapse' || style.opacity === '0') {
        hidden = true;
        break;
      }
    }
    if (hidden) continue;
    const rect = button.getBoundingClientRect();
    const left = Math.max(0, rect.left);
    const right = Math.min(innerWidth, rect.right);
    const top = Math.max(0, rect.top);
    const bottom = Math.min(innerHeight, rect.bottom);
    if (left >= right || top >= bottom) continue;
    const x = (left + right) / 2;
    const y = (top + bottom) / 2;
    const hit = document.elementFromPoint(x, y);
    if (hit && (hit === button || button.contains(hit))) return { x, y };
  }
  return null;
}

async function clickSkip(tabId) {
  const target = { tabId };
  let attached = false;
  try {
    const { enabled } = await chrome.storage.local.get({ enabled: true });
    const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!enabled || !activeTabs.some(tab => tab.id === tabId)) return { clicked: false };
    await chrome.debugger.attach(target, '1.3');
    attached = true;
    // Check the switch and active tab again after attaching.
    const settings = await chrome.storage.local.get({ enabled: true });
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!settings.enabled || !tabs.some(tab => tab.id === tabId)) return { clicked: false };
    const result = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
      expression: `(${findSkipPoint.toString()})()`,
      returnByValue: true
    });
    if (result.exceptionDetails) throw new Error('Could not inspect the skip button.');
    const point = result.result?.value;
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return { clicked: false };
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1
    });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1
    });
    return { clicked: true };
  } catch (error) {
    return { clicked: false, error: error.message || String(error) };
  } finally {
    if (attached) {
      try { await chrome.debugger.detach(target); } catch { /* Tab closed or detached already. */ }
    }
    busyTabs.delete(tabId);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'skip-visible-ad' || sender.id !== chrome.runtime.id ||
      sender.frameId !== 0 || !Number.isInteger(sender.tab?.id)) return;
  try {
    if (new URL(sender.url).origin !== 'https://www.youtube.com') return;
  } catch { return; }
  const tabId = sender.tab.id;
  if (busyTabs.has(tabId)) {
    sendResponse({ clicked: false });
    return;
  }
  busyTabs.add(tabId);
  clickSkip(tabId).then(sendResponse);
  return true;
});
