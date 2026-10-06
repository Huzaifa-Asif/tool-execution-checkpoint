'use strict';

const SCHEMA_VERSION = 1;
const DEFAULT_MAX_PAYLOAD_BYTES = 65_536;
const STATUSES = Object.freeze(['ready', 'executing', 'uncertain', 'completed', 'delivering', 'delivered']);
const ACTIONS = Object.freeze({
  ready: 'execute',
  executing: 'reconcile-execution',
  uncertain: 'reconcile-execution',
  completed: 'deliver',
  delivering: 'reconcile-delivery',
  delivered: 'none'
});
const BINDING_LIMITS = Object.freeze({ namespace: 256, callId: 512, toolName: 256, toolRevision: 256, inputFingerprint: 512 });

class CheckpointError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CheckpointError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new CheckpointError(code, message);
}

function boundedString(value, name, max) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    fail('INVALID_INPUT', `${name} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

function validTime(value, name) {
  boundedString(value, name, 64);
  if (!Number.isFinite(Date.parse(value))) fail('INVALID_INPUT', `${name} must be a valid date-time string`);
  return value;
}

function normalizeBinding(binding) {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) fail('INVALID_INPUT', 'binding must be an object');
  const result = {};
  for (const [key, max] of Object.entries(BINDING_LIMITS)) result[key] = boundedString(binding[key], `binding.${key}`, max);
  return result;
}

function sameBinding(left, right) {
  return Object.keys(BINDING_LIMITS).every((key) => left[key] === right[key]);
}

function jsonClone(value, maxBytes = DEFAULT_MAX_PAYLOAD_BYTES) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 10_000_000) fail('INVALID_INPUT', 'maxPayloadBytes must be an integer from 1 to 10000000');
  const seen = new Set();
  let nodes = 0;
  function visit(item, depth) {
    if (++nodes > 10_000 || depth > 32) fail('INVALID_PAYLOAD', 'payload exceeds the structural limit');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object') fail('INVALID_PAYLOAD', 'payload must contain only JSON values');
    if (seen.has(item)) fail('INVALID_PAYLOAD', 'payload must not be cyclic');
    const prototype = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) fail('INVALID_PAYLOAD', 'payload objects must be plain objects');
    seen.add(item);
    if (Array.isArray(item)) {
      for (const key of Reflect.ownKeys(item)) {
        if (key === 'length') continue;
        if (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= item.length) {
          fail('INVALID_PAYLOAD', 'payload arrays must contain only canonical indexes');
        }
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('INVALID_PAYLOAD', 'payload arrays must contain only enumerable data properties');
      }
      for (const child of item) visit(child, depth + 1);
    } else {
      if (Reflect.ownKeys(item).length !== Object.keys(item).length) fail('INVALID_PAYLOAD', 'payload objects must have only enumerable string keys');
      for (const [key, child] of Object.entries(item)) {
        if (key === '__proto__') fail('INVALID_PAYLOAD', 'payload must not contain a __proto__ key');
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('INVALID_PAYLOAD', 'payload must not contain getters or setters');
        visit(child, depth + 1);
      }
    }
    seen.delete(item);
  }
  visit(value, 0);
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, 'utf8') > maxBytes) fail('PAYLOAD_TOO_LARGE', `payload exceeds ${maxBytes} bytes`);
  return JSON.parse(encoded);
}

function cloneRecord(record) {
  return JSON.parse(JSON.stringify(record));
}

function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeDeep(child);
  }
  return value;
}

function validateCheckpoint(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) fail('INVALID_CHECKPOINT', 'checkpoint must be an object');
  if (record.schemaVersion !== SCHEMA_VERSION) fail('UNSUPPORTED_SCHEMA', `schemaVersion must be ${SCHEMA_VERSION}`);
  if (!Number.isSafeInteger(record.revision) || record.revision < 0) fail('INVALID_CHECKPOINT', 'revision must be a non-negative safe integer');
  normalizeBinding(record.binding);
  if (!STATUSES.includes(record.status)) fail('INVALID_CHECKPOINT', 'checkpoint has an unknown status');
  validTime(record.createdAt, 'createdAt');
  validTime(record.updatedAt, 'updatedAt');
  const hasExecution = record.execution !== null;
  const needsExecution = record.status !== 'ready';
  if (hasExecution !== needsExecution) fail('INVALID_CHECKPOINT', 'execution metadata does not match status');
  if (hasExecution) {
    boundedString(record.execution.attemptId, 'execution.attemptId', 512);
    validTime(record.execution.startedAt, 'execution.startedAt');
  }
  const hasResult = record.result !== null;
  const needsResult = ['completed', 'delivering', 'delivered'].includes(record.status);
  if (hasResult !== needsResult) fail('INVALID_CHECKPOINT', 'result does not match status');
  if (hasResult) {
    if (typeof record.result !== 'object' || Array.isArray(record.result) || !Object.hasOwn(record.result, 'payload') || Object.keys(record.result).length !== 1) {
      fail('INVALID_CHECKPOINT', 'result must contain exactly one payload field');
    }
    jsonClone(record.result.payload, 10_000_000);
  }
  const hasDelivery = record.delivery !== null;
  const needsDelivery = ['delivering', 'delivered'].includes(record.status);
  if (hasDelivery !== needsDelivery) fail('INVALID_CHECKPOINT', 'delivery metadata does not match status');
  if (hasDelivery) {
    boundedString(record.delivery.deliveryId, 'delivery.deliveryId', 512);
    validTime(record.delivery.startedAt, 'delivery.startedAt');
  }
  if (record.status === 'uncertain') boundedString(record.uncertaintyReason, 'uncertaintyReason', 1024);
  else if (record.uncertaintyReason !== null) fail('INVALID_CHECKPOINT', 'uncertaintyReason is only valid for uncertain status');
  if (Date.parse(record.updatedAt) < Date.parse(record.createdAt)) fail('INVALID_CHECKPOINT', 'updatedAt must not precede createdAt');
  if (hasExecution && Date.parse(record.execution.startedAt) > Date.parse(record.updatedAt)) fail('INVALID_CHECKPOINT', 'execution.startedAt must not follow updatedAt');
  if (hasDelivery && Date.parse(record.delivery.startedAt) > Date.parse(record.updatedAt)) fail('INVALID_CHECKPOINT', 'delivery.startedAt must not follow updatedAt');
  return true;
}

function transition(record, patch, action) {
  const next = { ...cloneRecord(record), ...patch, revision: record.revision + 1 };
  if (Date.parse(next.updatedAt) < Date.parse(record.updatedAt)) fail('INVALID_INPUT', 'transition time must not move backward');
  validateCheckpoint(next);
  return freezeDeep({ action, expectedRevision: record.revision, next });
}

function createCheckpoint(binding, { createdAt } = {}) {
  const at = validTime(createdAt, 'createdAt');
  return freezeDeep({
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    binding: normalizeBinding(binding),
    status: 'ready',
    createdAt: at,
    updatedAt: at,
    execution: null,
    result: null,
    delivery: null,
    uncertaintyReason: null
  });
}

function decideCheckpoint(record, binding) {
  validateCheckpoint(record);
  const normalized = normalizeBinding(binding);
  if (!sameBinding(record.binding, normalized)) fail('BINDING_CONFLICT', 'checkpoint binding does not match this invocation');
  return freezeDeep({ action: ACTIONS[record.status], status: record.status, revision: record.revision });
}

function claimExecution(record, { attemptId, at } = {}) {
  validateCheckpoint(record);
  if (record.status !== 'ready') fail('INVALID_TRANSITION', `cannot claim execution from ${record.status}`);
  return transition(record, {
    status: 'executing', updatedAt: validTime(at, 'at'),
    execution: { attemptId: boundedString(attemptId, 'attemptId', 512), startedAt: at }
  }, 'execute');
}

function markExecutionUncertain(record, { attemptId, at, reason } = {}) {
  validateCheckpoint(record);
  if (record.status !== 'executing') fail('INVALID_TRANSITION', `cannot mark execution uncertain from ${record.status}`);
  if (record.execution.attemptId !== attemptId) fail('FENCE_CONFLICT', 'attemptId does not own this execution');
  return transition(record, {
    status: 'uncertain', updatedAt: validTime(at, 'at'),
    uncertaintyReason: boundedString(reason, 'reason', 1024)
  }, 'reconcile-execution');
}

function completeExecution(record, { attemptId, at, result, maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES } = {}) {
  validateCheckpoint(record);
  if (record.status !== 'executing' && record.status !== 'uncertain') fail('INVALID_TRANSITION', `cannot complete execution from ${record.status}`);
  if (record.execution.attemptId !== attemptId) fail('FENCE_CONFLICT', 'attemptId does not own this execution');
  return transition(record, {
    status: 'completed', updatedAt: validTime(at, 'at'),
    result: { payload: jsonClone(result, maxPayloadBytes) }, uncertaintyReason: null
  }, 'deliver');
}

function claimDelivery(record, { deliveryId, at } = {}) {
  validateCheckpoint(record);
  if (record.status !== 'completed') fail('INVALID_TRANSITION', `cannot claim delivery from ${record.status}`);
  return transition(record, {
    status: 'delivering', updatedAt: validTime(at, 'at'),
    delivery: { deliveryId: boundedString(deliveryId, 'deliveryId', 512), startedAt: at }
  }, 'deliver');
}

function releaseDelivery(record, { deliveryId, at } = {}) {
  validateCheckpoint(record);
  if (record.status !== 'delivering') fail('INVALID_TRANSITION', `cannot release delivery from ${record.status}`);
  if (record.delivery.deliveryId !== deliveryId) fail('FENCE_CONFLICT', 'deliveryId does not own this delivery');
  return transition(record, { status: 'completed', updatedAt: validTime(at, 'at'), delivery: null }, 'deliver');
}

function completeDelivery(record, { deliveryId, at } = {}) {
  validateCheckpoint(record);
  if (record.status !== 'delivering') fail('INVALID_TRANSITION', `cannot complete delivery from ${record.status}`);
  if (record.delivery.deliveryId !== deliveryId) fail('FENCE_CONFLICT', 'deliveryId does not own this delivery');
  return transition(record, { status: 'delivered', updatedAt: validTime(at, 'at') }, 'none');
}

module.exports = {
  ACTIONS, BINDING_LIMITS, CheckpointError, DEFAULT_MAX_PAYLOAD_BYTES, SCHEMA_VERSION, STATUSES,
  claimDelivery, claimExecution, completeDelivery, completeExecution, createCheckpoint,
  decideCheckpoint, markExecutionUncertain, releaseDelivery, validateCheckpoint
};
