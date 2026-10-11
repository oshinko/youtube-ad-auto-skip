const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(`${__dirname}/background.js`, 'utf8');
const sender = { id: 'extension', frameId: 0, tab: { id: 7 }, url: 'https://www.youtube.com/watch?v=test' };

function start({ enabled = true, active = true, point = { x: 120, y: 80 }, fail = '', disableAfterAttach = false } = {}) {
  const calls = [];
  let listener;
  const context = vm.createContext({
    URL,
    chrome: {
      runtime: { id: 'extension', onMessage: { addListener(fn) { listener = fn; } } },
      storage: { local: { async get() { return { enabled }; } } },
      tabs: { async query() { return active ? [{ id: 7 }] : [{ id: 8 }]; } },
      debugger: {
        async attach(target) {
          calls.push(['attach', target]);
          if (fail === 'attach') throw new Error('Debugger already attached');
          if (disableAfterAttach) enabled = false;
        },
        async sendCommand(target, method, params) {
          calls.push([method, params]);
          if (method === fail) throw new Error('Command failed');
          if (method === 'Runtime.evaluate') return { result: { value: point } };
          return {};
        },
        async detach() { calls.push(['detach']); }
      }
    }
  });
  vm.runInContext(source, context);
  return {
    calls, context,
    send(from = sender, message = { type: 'skip-visible-ad' }) {
      return new Promise(resolve => {
        const pending = listener(message, from, resolve);
        if (!pending) resolve(undefined);
      });
    }
  };
}

test('sends browser mouse press/release and detaches', async () => {
  const runtime = start();
  const result = await runtime.send();
  assert.equal(result.clicked, true);
  assert.deepEqual(runtime.calls.map(call => call[0]), [
    'attach', 'Runtime.evaluate', 'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent', 'detach'
  ]);
  const press = runtime.calls[2][1];
  const release = runtime.calls[3][1];
  assert.equal(press.type, 'mousePressed');
  assert.equal(release.type, 'mouseReleased');
  assert.equal(press.button, 'left');
  assert.equal(press.x, 120);
  assert.equal(press.y, 80);
  assert.equal(release.buttons, 0);
});

test('rejects other origins, frames, extensions and message types', async () => {
  const runtime = start();
  for (const from of [
    { ...sender, url: 'https://www.youtube.com.evil.example/' },
    { ...sender, frameId: 1 },
    { ...sender, id: 'other-extension' },
    { ...sender, tab: undefined }
  ]) assert.equal(await runtime.send(from), undefined);
  assert.equal(await runtime.send(sender, { type: 'other' }), undefined);
  assert.equal(runtime.calls.length, 0);
});

test('does not attach when disabled or in a background tab', async () => {
  for (const options of [{ enabled: false }, { active: false }]) {
    const runtime = start(options);
    assert.equal((await runtime.send()).clicked, false);
    assert.equal(runtime.calls.length, 0);
  }
});

test('does not send input when the button disappeared or was switched off', async () => {
  for (const options of [{ point: null }, { disableAfterAttach: true }]) {
    const runtime = start(options);
    assert.equal((await runtime.send()).clicked, false);
    assert.equal(runtime.calls.some(call => call[0] === 'Input.dispatchMouseEvent'), false);
    assert.equal(runtime.calls.at(-1)[0], 'detach');
  }
});

test('reports failure, releases owned debugger and allows a retry', async () => {
  const runtime = start({ fail: 'Input.dispatchMouseEvent' });
  assert.match((await runtime.send()).error, /Command failed/);
  assert.equal(runtime.calls.at(-1)[0], 'detach');
  assert.match((await runtime.send()).error, /Command failed/);
  const occupied = start({ fail: 'attach' });
  assert.match((await occupied.send()).error, /already attached/);
  assert.equal(occupied.calls.some(call => call[0] === 'detach'), false);
});

test('serializes requests for the same tab', async () => {
  const runtime = start();
  const first = runtime.send();
  const second = runtime.send();
  assert.equal((await second).clicked, false);
  assert.equal((await first).clicked, true);
  assert.equal(runtime.calls.filter(call => call[0] === 'attach').length, 1);
});

test('resolves a visible unobstructed button, ignores hidden and covered candidates', () => {
  const runtime = start();
  const makeButton = overrides => ({
    isConnected: true, parentElement: null,
    style: { display: 'block', visibility: 'visible', opacity: '1' },
    getClientRects: () => [{}], matches: () => false,
    getBoundingClientRect: () => ({ left: 100, right: 140, top: 60, bottom: 100 }),
    contains: () => false,
    ...overrides
  });
  const hidden = makeButton({ style: { opacity: '0' } });
  const covered = makeButton({});
  const visible = makeButton({});
  let candidates = [hidden, covered, visible];
  Object.assign(runtime.context, {
    location: { origin: 'https://www.youtube.com' },
    innerWidth: 800, innerHeight: 600,
    getComputedStyle: element => element.style,
    document: {
      visibilityState: 'visible',
      querySelectorAll: () => candidates,
      elementFromPoint: () => visible
    }
  });
  let result = vm.runInContext('findSkipPoint()', runtime.context);
  assert.equal(result.x, 120);
  assert.equal(result.y, 80);
  candidates = [hidden, covered];
  assert.equal(vm.runInContext('findSkipPoint()', runtime.context), null);
  runtime.context.location.origin = 'https://example.com';
  assert.equal(vm.runInContext('findSkipPoint()', runtime.context), null);
});
