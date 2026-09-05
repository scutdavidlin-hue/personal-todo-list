import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForActivation } from '../app-loader.js';
class Worker extends EventTarget {
  state = 'installing';
  transition(state) { this.state = state; this.dispatchEvent(new Event('statechange')); }
}
test('offline upgrade waits until the new worker is activated before proceeding', async () => {
  const worker = new Worker(); let done = false;
  const waiting = waitForActivation(worker).then(() => { done = true; });
  worker.transition('installed'); await Promise.resolve(); assert.equal(done, false);
  worker.transition('activating'); await Promise.resolve(); assert.equal(done, false);
  worker.transition('activated'); await waiting; assert.equal(done, true);
});
test('failed or stalled upgrades produce a retryable error instead of silently using old code', async () => {
  const worker = new Worker(); const waiting = waitForActivation(worker);
  worker.transition('redundant'); await assert.rejects(waiting, /更新/);
  await assert.rejects(waitForActivation(new Worker(), 10), /超时/);
});
test('an already active worker does not block startup', async () => {
  const worker = new Worker(); worker.state = 'activated'; await waitForActivation(worker);
  await waitForActivation(null);
});
