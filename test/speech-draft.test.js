import test from 'node:test';
import assert from 'node:assert/strict';
import { startSpeechDraft } from '../src/task-conversation.js';

function fixture({ prefix = '', throws = false } = {}) {
  let engine;
  const drafts = [], ends = [], errors = [];
  class Speech {
    constructor() { engine = this; }
    start() { if (throws) throw new Error('denied'); }
    stop() { this.stopped = true; }
    abort() { this.onend(); }
  }
  const session = startSpeechDraft(Speech, { prefix, onDraft: text => drafts.push(text), onEnd: error => ends.push(error), onError: () => errors.push(true) });
  const result = (...texts) => engine.onresult({ results: texts.map(text => Object.assign([{ transcript: text }], { isFinal: false })) });
  return { engine, session, drafts, ends, errors, result };
}

test('speech enables actual interim results and replaces revised hypotheses', () => {
  const f = fixture();
  assert.equal(f.engine.interimResults, true);
  assert.equal(f.engine.continuous, true);
  f.result('改周'); f.result('改周四'); f.result('改周四下午四点');
  assert.deepEqual(f.drafts, ['改周', '改周四', '改周四下午四点']);
  assert.equal(f.engine.stopped, undefined, 'an interim result must not stop listening');
});
test('full result snapshots preserve earlier phrases without duplicating them', () => {
  const f = fixture({ prefix: '补充：' });
  f.result('明天', '下午'); f.result('明天', '下午三点');
  assert.equal(f.drafts.at(-1), '补充：明天下午三点');
  f.engine.onresult({ results: [{ 0: { transcript: '明天下午四点' }, isFinal: true }] });
  assert.equal(f.drafts.at(-1), '补充：明天下午四点');
});
test('stop still accepts final correction then ignores results after end', () => {
  const f = fixture(); f.result('四店'); f.session.stop(); f.result('四点'); f.engine.onend(); f.result('late');
  assert.deepEqual(f.drafts, ['四店', '四点']);
  assert.deepEqual(f.ends, [false]);
});
test('abort protects manual edits and next task from stale callbacks', () => {
  const old = fixture(); old.result('旧文字'); old.session.abort();
  const next = fixture(); next.result('新文字');
  old.result('过期结果'); old.engine.onerror(); old.engine.onend();
  assert.deepEqual(old.drafts, ['旧文字']); assert.deepEqual(old.errors, []); assert.deepEqual(old.ends, []);
  assert.deepEqual(next.drafts, ['新文字']);
});
test('recognition error preserves draft and ends in recoverable error state', () => {
  const f = fixture(); f.result('已说的内容'); f.engine.onerror(); f.engine.onend();
  assert.deepEqual(f.drafts, ['已说的内容']); assert.deepEqual(f.errors, [true]); assert.deepEqual(f.ends, [true]);
});
test('start failure reports error and releases listening state', () => {
  const f = fixture({ throws: true });
  assert.deepEqual(f.errors, [true]); assert.deepEqual(f.ends, [true]);
});
test('speech draft honors input length limit', () => {
  const f = fixture({ prefix: 'a'.repeat(9999) }); f.result('很多文字');
  assert.equal(f.drafts[0].length, 10000);
});
