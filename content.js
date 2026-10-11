(() => {
  const selectors = [
    '.ytp-skip-ad-button',
    '.ytp-ad-skip-button',
    '.ytp-ad-skip-button-modern'
  ];
  // Wait for the saved preference before attempting any clicks.
  let enabled = false;
  let lastClick = -Infinity;
  let pending = false;
  let lastError = '';

  function isClickable(button) {
    if (!button.isConnected || !button.getClientRects().length) return false;
    if (button.matches(':disabled, [aria-disabled="true"]')) return false;
    // A skip button can remain in the DOM inside a hidden player/container.
    for (let element = button; element; element = element.parentElement) {
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' ||
          style.visibility === 'collapse' || style.opacity === '0') return false;
    }
    return true;
  }

  function skipIfPossible() {
    if (!enabled || pending || document.visibilityState === 'hidden') return;
    const now = Date.now();
    if (now - lastClick < 1000) return;
    const button = Array.from(document.querySelectorAll(selectors.join(',')))
      .find(isClickable);
    if (!button) return;
    lastClick = now;
    pending = true;
    chrome.runtime.sendMessage({ type: 'skip-visible-ad' }, response => {
      pending = false;
      const error = chrome.runtime.lastError?.message || response?.error || '';
      if (error && error !== lastError) {
        console.warn('[YouTube Ad Auto Skip]', error);
      }
      lastError = error;
    });
  }

  chrome.storage.local.get({ enabled: true }, result => {
    enabled = result.enabled;
    skipIfPossible();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.enabled) {
      enabled = changes.enabled.newValue;
      skipIfPossible();
    }
  });
  // A periodic check handles ads that appear without DOM changes.
  setInterval(skipIfPossible, 500);
})();
