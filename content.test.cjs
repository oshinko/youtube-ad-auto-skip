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

function start(buttons, { enabled = true, deferSettings = false, sendMessage } = {}) {
  const requests = [];
  const callbacks = [];
  const timers = new Map();
  const warnings = [];
  let nextTimerId = 0;
  let tick, onChanged, loadSettings;
  let now = 10000;
  vm.runInNewContext(source, {
    document: { querySelectorAll: () => buttons },
    getComputedStyle: element => element.style,
    Date: { now: () => now },
    console: { warn: (...args) => warnings.push(args) },
    setTimeout(callback, delay) {
      const id = ++nextTimerId;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    setInterval(callback, delay) {
      assert.equal(delay, 500);
      tick = callback;
    },
    chrome: {
      runtime: {
        sendMessage(message, callback) {
          assert.equal(message.type, 'skip-visible-ad');
          requests.push(message);
          callbacks.push(callback);
          if (sendMessage) sendMessage(callback);
          else callback({ clicked: true });
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
    callbacks,
    warnings,
    timers,
    tick,
    loadSettings,
    advance(ms) {
      now += ms;
      for (const [id, timer] of Array.from(timers)) {
        if (timer.at <= now && timers.delete(id)) timer.callback();
      }
      tick();
    },
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

test('retries after a missing response without overlapping requests before timeout', () => {
  const runtime = start([button()], { sendMessage() {} });
  runtime.advance(4999);
  assert.equal(runtime.requests.length, 1);
  runtime.advance(1);
  assert.equal(runtime.requests.length, 2);
  assert.match(runtime.warnings[0][1], /timed out/);
  runtime.advance(1000);
  assert.equal(runtime.requests.length, 2);
});

test('a stale response does not release a newer pending request', () => {
  const runtime = start([button()], { sendMessage() {} });
  runtime.advance(5000);
  assert.equal(runtime.requests.length, 2);
  runtime.callbacks[0]({ clicked: true });
  runtime.advance(1000);
  assert.equal(runtime.requests.length, 2);
  runtime.callbacks[1]({ clicked: true });
  assert.equal(runtime.timers.size, 0);
  runtime.advance(500);
  assert.equal(runtime.requests.length, 3);
});

test('a synchronous send failure releases pending and cancels its timeout', () => {
  const runtime = start([button()], {
    sendMessage() { throw new Error('Extension context invalidated.'); }
  });
  assert.equal(runtime.timers.size, 0);
  assert.match(runtime.warnings[0][1], /Extension context invalidated/);
  runtime.advance(1000);
  assert.equal(runtime.requests.length, 2);
  assert.equal(runtime.timers.size, 0);
  assert.equal(runtime.warnings.length, 1);
});

test('an error response releases pending immediately', () => {
  const runtime = start([button()], {
    sendMessage(callback) { callback({ error: 'Debugger unavailable' }); }
  });
  assert.equal(runtime.timers.size, 0);
  runtime.advance(1000);
  assert.equal(runtime.requests.length, 2);
  assert.match(runtime.warnings[0][1], /Debugger unavailable/);
});

test('a timeout does not send a retry while the switch is off', () => {
  const runtime = start([button()], { sendMessage() {} });
  runtime.toggle(false);
  runtime.advance(5000);
  assert.equal(runtime.requests.length, 1);
  runtime.toggle(true);
  assert.equal(runtime.requests.length, 2);
});

test('successful responses cancel their timers', () => {
  const runtime = start([button()]);
  runtime.advance(5000);
  assert.equal(runtime.requests.length, 2);
  assert.equal(runtime.timers.size, 0);
  assert.equal(runtime.warnings.length, 0);
});
