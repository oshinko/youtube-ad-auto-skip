const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(`${__dirname}/content.js`, 'utf8');

function button(options = {}) {
  return {
    isConnected: true,
    parentElement: null,
    style: { display: 'block', visibility: 'visible', opacity: '1' },
    clicks: 0,
    getClientRects() { return [ {} ]; },
    matches() { return false; },
    click() { this.clicks++; },
    ...options
  };
}

function start(buttons, { enabled = true, deferSettings = false } = {}) {
  const requests = [];
  let tick, onChanged, loadSettings;
  let now = 10000;
  vm.runInNewContext(source, {
    document: { querySelectorAll: () => buttons },
    getComputedStyle: element => element.style,
    Date: { now: () => now },
    setInterval(callback, delay) {
      assert.equal(delay, 500);
      tick = callback;
    },
    chrome: {
      runtime: {
        sendMessage(message, callback) {
          assert.equal(message.type, 'skip-visible-ad');
          requests.push(message);
          callback({ clicked: true });
        }
      },
      storage: {
        local: { get(defaults, callback) { loadSettings = () => callback({ enabled }); } },
        onChanged: { addListener(callback) { onChanged = callback; } }
      }
    }
  });
  if (!deferSettings) loadSettings();
  return {
    requests,
    tick,
    loadSettings,
    advance(ms) { now += ms; tick(); },
    toggle(value, area = 'local') { onChanged({ enabled: { newValue: value } }, area); }
  };
}

test('a hidden first match does not mask the visible skip button', () => {
  const hidden = button({ style: { display: 'none' } });
  const visible = button();
  const runtime = start([hidden, visible]);
  assert.equal(hidden.clicks, 0);
  assert.equal(visible.clicks, 0);
  assert.equal(runtime.requests.length, 1);
});

test('ignores unavailable candidates, including a transparent ancestor', () => {
  const unavailable = [
    button({ isConnected: false }),
    button({ getClientRects: () => [] }),
    button({ matches: () => true }),
    button({ style: { visibility: 'hidden' } }),
    button({ parentElement: { style: { opacity: '0' }, parentElement: null } })
  ];
  const visible = button();
  const runtime = start(unavailable);
  assert.equal(runtime.requests.length, 0);
  unavailable.push(visible);
  runtime.tick();
  assert.equal(runtime.requests.length, 1);
});

test('does not click before settings load or while switched off', () => {
  const visible = button();
  const runtime = start([visible], { enabled: false, deferSettings: true });
  runtime.tick();
  assert.equal(runtime.requests.length, 0);
  runtime.loadSettings();
  runtime.advance(2000);
  assert.equal(runtime.requests.length, 0);
  runtime.toggle(true, 'sync');
  assert.equal(runtime.requests.length, 0);
  runtime.toggle(true);
  assert.equal(runtime.requests.length, 1);
  runtime.toggle(false);
  runtime.advance(2000);
  assert.equal(runtime.requests.length, 1);
});

test('retries at most once a second and detects buttons added later', () => {
  const buttons = [];
  const runtime = start(buttons);
  const visible = button();
  buttons.push(visible);
  runtime.tick();
  assert.equal(runtime.requests.length, 1);
  runtime.advance(500);
  assert.equal(runtime.requests.length, 1);
  runtime.advance(500);
  assert.equal(runtime.requests.length, 2);
});
