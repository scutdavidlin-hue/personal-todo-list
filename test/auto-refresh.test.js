import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

for (const [file, refreshName] of [['app.js', 'refreshTasks'], ['today.js', 'refresh']]) {
  const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const policy = source.slice(source.indexOf('let refreshInFlight'), source.indexOf(`async function ${refreshName}(`));
  function setup() {
    const state = { visibilityState: 'visible', editing: false, dialog: false };
    const calls = [];
    const scope = { document: { get visibilityState() { return state.visibilityState; }, querySelector: () => state.dialog, activeElement: { matches: () => state.editing } }, navigator: { onLine: true }, pendingIds: new Set(), [refreshName]: options => calls.push(options) };
    vm.createContext(scope); vm.runInContext(policy, scope);
    return { state, scope, calls, run: code => vm.runInContext(code, scope) };
  }
  test(`${file}: foreground auto refresh uses quiet existing cloud path`, () => {
    const f = setup(); f.run('autoRefresh()');
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].quiet, true); assert.equal(f.calls[0].automatic, true);
  });
  test(`${file}: background, offline, editing, open dialog and pending mutations defer refresh`, () => {
    const f = setup();
    f.state.visibilityState = 'hidden'; f.run('autoRefresh()'); f.state.visibilityState = 'visible';
    f.scope.navigator.onLine = false; f.run('autoRefresh()'); f.scope.navigator.onLine = true;
    f.state.editing = true; f.run('autoRefresh()'); f.state.editing = false;
    f.state.dialog = true; f.run('autoRefresh()'); f.state.dialog = false;
    f.scope.pendingIds.add('task'); f.run('autoRefresh()'); f.scope.pendingIds.clear();
    assert.equal(f.calls.length, 0); f.run('autoRefresh()'); assert.equal(f.calls.length, 1);
  });
  test(`${file}: adjacent focus and visibility events are throttled`, () => {
    const f = setup(); f.run('lastRefreshAt = Date.now(); autoRefresh()'); assert.equal(f.calls.length, 0);
    f.run('lastRefreshAt = Date.now() - 6000; autoRefresh()'); assert.equal(f.calls.length, 1);
  });
}
