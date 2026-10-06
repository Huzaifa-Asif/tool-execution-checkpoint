export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type Status = 'ready' | 'executing' | 'uncertain' | 'completed' | 'delivering' | 'delivered';
export type Action = 'execute' | 'reconcile-execution' | 'deliver' | 'reconcile-delivery' | 'none';
export interface Binding { readonly namespace: string; readonly callId: string; readonly toolName: string; readonly toolRevision: string; readonly inputFingerprint: string }
export interface Checkpoint {
  readonly schemaVersion: 1; readonly revision: number; readonly binding: Binding; readonly status: Status; readonly createdAt: string; readonly updatedAt: string;
  readonly execution: null | { readonly attemptId: string; readonly startedAt: string };
  readonly result: { readonly payload: JsonValue } | null;
  readonly delivery: null | { readonly deliveryId: string; readonly startedAt: string };
  readonly uncertaintyReason: string | null;
}
export interface Transition { readonly action: Action; readonly expectedRevision: number; readonly next: Checkpoint }
export class CheckpointError extends Error { readonly code: 'INVALID_INPUT' | 'INVALID_PAYLOAD' | 'PAYLOAD_TOO_LARGE' | 'INVALID_CHECKPOINT' | 'UNSUPPORTED_SCHEMA' | 'BINDING_CONFLICT' | 'INVALID_TRANSITION' | 'FENCE_CONFLICT' }
export const SCHEMA_VERSION: 1;
export const DEFAULT_MAX_PAYLOAD_BYTES: 65536;
export const STATUSES: readonly Status[];
export const ACTIONS: Readonly<Record<Status, Action>>;
export const BINDING_LIMITS: Readonly<Record<keyof Binding, number>>;
export function createCheckpoint(binding: Binding, options: { createdAt: string }): Checkpoint;
export function validateCheckpoint(record: Checkpoint): true;
export function decideCheckpoint(record: Checkpoint, binding: Binding): { readonly action: Action; readonly status: Status; readonly revision: number };
export function claimExecution(record: Checkpoint, options: { attemptId: string; at: string }): Transition;
export function markExecutionUncertain(record: Checkpoint, options: { attemptId: string; at: string; reason: string }): Transition;
export function completeExecution(record: Checkpoint, options: { attemptId: string; at: string; result: JsonValue; maxPayloadBytes?: number }): Transition;
export function claimDelivery(record: Checkpoint, options: { deliveryId: string; at: string }): Transition;
export function releaseDelivery(record: Checkpoint, options: { deliveryId: string; at: string }): Transition;
export function completeDelivery(record: Checkpoint, options: { deliveryId: string; at: string }): Transition;
