import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CheckpointError, claimDelivery, claimExecution, completeDelivery, completeExecution,
  createCheckpoint, decideCheckpoint, markExecutionUncertain, releaseDelivery, validateCheckpoint
} from '../src/index.js';

const binding = Object.freeze({
  namespace: 'tenant-7', callId: 'toolu_123', toolName: 'charge-card',
  toolRevision: '2026-10-01', inputFingerprint: 'sha256:abc'
});
const times = ['2026-10-07T00:00:00Z', '2026-10-07T00:00:01Z', '2026-10-07T00:00:02Z', '2026-10-07T00:00:03Z'];
const make = () => createCheckpoint(binding, { createdAt: times[0] });
const run = () => claimExecution(make(), { attemptId: 'attempt-a', at: times[1] }).next;
const done = (result = { type: 'tool_result', content: 'ok' }) => completeExecution(run(), { attemptId: 'attempt-a', at: times[2], result }).next;

test('happy path fences execution and delivery with CAS revisions', () => {
  const fresh = make();
  assert.deepEqual(decideCheckpoint(fresh, binding), { action: 'execute', status: 'ready', revision: 0 });
  const executing = claimExecution(fresh, { attemptId: 'attempt-a', at: times[1] });
  assert.equal(executing.expectedRevision, 0);
  assert.equal(executing.next.revision, 1);
  const completed = completeExecution(executing.next, { attemptId: 'attempt-a', at: times[2], result: null });
  assert.equal(completed.next.result.payload, null);
  assert.equal(decideCheckpoint(completed.next, binding).action, 'deliver');
  const delivering = claimDelivery(completed.next, { deliveryId: 'post-a', at: times[2] });
  const delivered = completeDelivery(delivering.next, { deliveryId: 'post-a', at: times[3] });
  assert.equal(delivered.action, 'none');
  assert.equal(decideCheckpoint(delivered.next, binding).action, 'none');
});

test('completed result is retained exactly for a delivery retry', () => {
  const completed = done({ type: 'tool_result', content: [{ type: 'text', text: 'charged once' }] });
  const claimed = claimDelivery(completed, { deliveryId: 'post-a', at: times[2] }).next;
  const released = releaseDelivery(claimed, { deliveryId: 'post-a', at: times[3] }).next;
  assert.deepEqual(released.result, completed.result);
  assert.equal(released.status, 'completed');
  assert.equal(decideCheckpoint(released, binding).action, 'deliver');
});

test('in-flight recovery never advises automatic execution', () => {
  assert.equal(decideCheckpoint(run(), binding).action, 'reconcile-execution');
  const uncertain = markExecutionUncertain(run(), { attemptId: 'attempt-a', at: times[2], reason: 'worker disappeared after external request' }).next;
  assert.equal(uncertain.status, 'uncertain');
  assert.equal(decideCheckpoint(uncertain, binding).action, 'reconcile-execution');
  assert.throws(() => claimExecution(uncertain, { attemptId: 'attempt-b', at: times[3] }), { code: 'INVALID_TRANSITION' });
  const reconciled = completeExecution(uncertain, { attemptId: 'attempt-a', at: times[3], result: { content: 'confirmed externally' } }).next;
  assert.equal(decideCheckpoint(reconciled, binding).action, 'deliver');
});

test('a changed namespace, tool revision, or input fingerprint conflicts', () => {
  for (const key of ['namespace', 'callId', 'toolName', 'toolRevision', 'inputFingerprint']) {
    assert.throws(() => decideCheckpoint(make(), { ...binding, [key]: `${binding[key]}-changed` }), { code: 'BINDING_CONFLICT' });
  }
});

test('attempt and delivery fence tokens reject stale owners', () => {
  assert.throws(() => completeExecution(run(), { attemptId: 'stale', at: times[2], result: 'no' }), { code: 'FENCE_CONFLICT' });
  const delivering = claimDelivery(done(), { deliveryId: 'post-a', at: times[2] }).next;
  assert.throws(() => releaseDelivery(delivering, { deliveryId: 'post-b', at: times[3] }), { code: 'FENCE_CONFLICT' });
  assert.throws(() => completeDelivery(delivering, { deliveryId: 'post-b', at: times[3] }), { code: 'FENCE_CONFLICT' });
});

test('records, nested bindings, and results are immutable snapshots', () => {
  const input = { nested: ['ok'] };
  const completed = completeExecution(run(), { attemptId: 'attempt-a', at: times[2], result: input }).next;
  input.nested[0] = 'mutated';
  assert.equal(completed.result.payload.nested[0], 'ok');
  assert.ok(Object.isFrozen(completed));
  assert.ok(Object.isFrozen(completed.result.payload.nested));
});

test('payload boundaries accept exact bytes and reject overflow', () => {
  assert.equal(completeExecution(run(), { attemptId: 'attempt-a', at: times[2], result: '1234', maxPayloadBytes: 6 }).next.result.payload, '1234');
  assert.throws(() => completeExecution(run(), { attemptId: 'attempt-a', at: times[2], result: '1234', maxPayloadBytes: 5 }), { code: 'PAYLOAD_TOO_LARGE' });
});

test('rejects lossy, cyclic, non-plain, and excessively deep payloads', () => {
  const bad = [{ x: undefined }, { x: NaN }, new Date()];
  for (const result of bad) assert.throws(() => completeExecution(run(), { attemptId: 'attempt-a', at: times[2], result }), { code: 'INVALID_PAYLOAD' });
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => completeExecution(run(), { attemptId: 'attempt-a', at: times[2], result: cyclic }), { code: 'INVALID_PAYLOAD' });
  let deep = null; for (let index = 0; index < 34; index++) deep = [deep];
  assert.throws(() => completeExecution(run(), { attemptId: 'attempt-a', at: times[2], result: deep }), { code: 'INVALID_PAYLOAD' });
  const symbolic = { ok: true }; symbolic[Symbol('lost')] = true;
  assert.throws(() => completeExecution(run(), { attemptId: 'attempt-a', at: times[2], result: symbolic }), { code: 'INVALID_PAYLOAD' });
  const getter = {}; Object.defineProperty(getter, 'value', { enumerable: true, get: () => 'side effect' });
  assert.throws(() => completeExecution(run(), { attemptId: 'attempt-a', at: times[2], result: getter }), { code: 'INVALID_PAYLOAD' });
  const arrayExtra = ['ok']; arrayExtra.extra = 'lost';
  assert.throws(() => completeExecution(run(), { attemptId: 'attempt-a', at: times[2], result: arrayExtra }), { code: 'INVALID_PAYLOAD' });
  const arraySymbol = ['ok']; arraySymbol[Symbol('lost')] = true;
  assert.throws(() => completeExecution(run(), { attemptId: 'attempt-a', at: times[2], result: arraySymbol }), { code: 'INVALID_PAYLOAD' });
  let getterCalls = 0;
  const arrayGetter = []; Object.defineProperty(arrayGetter, '0', { enumerable: true, get: () => { getterCalls++; return 'no'; } }); arrayGetter.length = 1;
  assert.throws(() => completeExecution(run(), { attemptId: 'attempt-a', at: times[2], result: arrayGetter }), { code: 'INVALID_PAYLOAD' });
  assert.equal(getterCalls, 0);
});

test('invalid identifiers and timestamps are rejected', () => {
  for (const key of Object.keys(binding)) assert.throws(() => createCheckpoint({ ...binding, [key]: '' }, { createdAt: times[0] }), CheckpointError);
  assert.throws(() => createCheckpoint(binding, { createdAt: 'not-a-time' }), { code: 'INVALID_INPUT' });
  assert.throws(() => claimExecution(make(), { attemptId: '', at: times[1] }), { code: 'INVALID_INPUT' });
});

test('forged and unsupported persisted records fail closed', () => {
  const cases = [
    { ...make(), schemaVersion: 2 },
    { ...make(), revision: -1 },
    { ...make(), status: 'completed' },
    { ...make(), delivery: { deliveryId: 'x', startedAt: times[1] } },
    { ...run(), uncertaintyReason: 'wrong state' },
    { ...done(), result: {} },
    { ...make(), updatedAt: '2026-10-06T23:59:59Z' }
  ];
  for (const value of cases) assert.throws(() => validateCheckpoint(value), CheckpointError);
});

test('transition timestamps cannot move backward', () => {
  assert.throws(() => claimExecution(make(), { attemptId: 'attempt-a', at: '2026-10-06T23:59:59Z' }), { code: 'INVALID_INPUT' });
});

test('all status decisions remain stable through JSON persistence', () => {
  const states = [make(), run(), markExecutionUncertain(run(), { attemptId: 'attempt-a', at: times[2], reason: 'unknown outcome' }).next, done()];
  const delivering = claimDelivery(done(), { deliveryId: 'post-a', at: times[2] }).next;
  states.push(delivering, completeDelivery(delivering, { deliveryId: 'post-a', at: times[3] }).next);
  const actions = ['execute', 'reconcile-execution', 'reconcile-execution', 'deliver', 'reconcile-delivery', 'none'];
  states.forEach((state, index) => assert.equal(decideCheckpoint(JSON.parse(JSON.stringify(state)), binding).action, actions[index]));
});

test('random invalid transitions never reopen execution', () => {
  const states = [run(), markExecutionUncertain(run(), { attemptId: 'attempt-a', at: times[2], reason: 'unknown' }).next, done()];
  for (let index = 0; index < 250; index++) {
    const state = states[index % states.length];
    assert.notEqual(decideCheckpoint(state, binding).action, 'execute');
    assert.throws(() => claimExecution(state, { attemptId: `retry-${index}`, at: times[3] }), { code: 'INVALID_TRANSITION' });
  }
});
