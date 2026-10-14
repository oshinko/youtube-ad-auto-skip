(() => {
  const selectors = [
    '.ytp-skip-ad-button',
    '.ytp-ad-skip-button',
    '.ytp-ad-skip-button-modern'
  ];
  // Wait for the saved preference before attempting any clicks.
  let enabled = false;
  let lastClick = -Infinity;
  const responseTimeoutMs = 5000;
  let pending = null;
  let lastError = '';

  function finishRequest(request, error = '') {
    // A response can arrive after its timeout and after a new request starts.
    if (pending !== request) return;
    clearTimeout(request.timer);
    pending = null;
    if (error && error !== lastError) {
      console.warn('[YouTube Ad Auto Skip]', error);
    }
    lastError = error;
  }

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
    const request = {};
    pending = request;
    request.timer = setTimeout(() => {
      finishRequest(request, 'Skip request timed out; retrying on the next check.');
    }, responseTimeoutMs);
    try {
      chrome.runtime.sendMessage({ type: 'skip-visible-ad' }, response => {
        // Read lastError even for a stale response to acknowledge Chrome's error.
        const error = chrome.runtime.lastError?.message || response?.error || '';
        finishRequest(request, error);
      });
    } catch (error) {
      finishRequest(request, error.message || String(error));
    }
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
