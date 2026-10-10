# tool-execution-checkpoint

A small, zero-dependency state machine for keeping AI tool execution separate from result delivery.

When a tool has already changed the outside world but its result POST fails, blindly reconciling an “unanswered” call can run the tool again. This package gives the host an application-owned checkpoint: persist an execution claim, persist the exact completed result, then deliver it. After a reconnect, a completed checkpoint says `deliver`, never `execute`.

This is a storage protocol, not a workflow engine, provider SDK wrapper, distributed lock, or exactly-once system.

## Install

```sh
npm install tool-execution-checkpoint
```

Node.js 18 or newer. ESM, CommonJS, and TypeScript declarations are included. There are no runtime dependencies or lifecycle scripts.

## Quick start

```js
import {
  claimExecution,
  completeExecution,
  createCheckpoint,
  decideCheckpoint
} from 'tool-execution-checkpoint';

const binding = {
  namespace: 'tenant-acme',
  callId: 'toolu_42',
  toolName: 'send-email',
  toolRevision: 'v3',
  inputFingerprint: 'sha256:canonical-input-digest'
};

let stored = createCheckpoint(binding, { createdAt: new Date().toISOString() });

// Your store must compare stored.revision with expectedRevision and write next atomically.
const claim = claimExecution(stored, {
  attemptId: crypto.randomUUID(),
  at: new Date().toISOString()
});
if (await store.compareAndSwap(claim.expectedRevision, claim.next)) {
  stored = claim.next;
  const providerPayload = await runToolOnce();
  const completed = completeExecution(stored, {
    attemptId: stored.execution.attemptId,
    at: new Date().toISOString(),
    result: providerPayload
  });
  await store.compareAndSwap(completed.expectedRevision, completed.next);
}

const recovered = await store.get();
switch (decideCheckpoint(recovered, binding).action) {
  case 'execute':
    // Only a never-claimed `ready` record reaches here.
    break;
  case 'deliver':
    // Deliver recovered.result.payload; do not invoke the tool again.
    break;
  case 'reconcile-execution':
    // Outcome is unknown. Inspect the external system or use its idempotency key.
    break;
}
```

See [`examples/cas-store.mjs`](examples/cas-store.mjs) for execution and delivery fencing together.

## State model

| Status | Recovery action | Meaning |
| --- | --- | --- |
| `ready` | `execute` | No worker has claimed execution. |
| `executing` | `reconcile-execution` | A fenced worker may be running, or may have disappeared. Never automatically rerun. |
| `uncertain` | `reconcile-execution` | The host explicitly recorded an unknown external outcome. |
| `completed` | `deliver` | The exact terminal provider payload is stored; deliver it without rerunning the tool. |
| `delivering` | `reconcile-delivery` | A fenced delivery may have been accepted. Reconcile or deliberately retry. |
| `delivered` | `none` | The host recorded successful delivery. |

Every transition returns:

```ts
{ action, expectedRevision, next }
```

The host may act on the transition only after an atomic compare-and-swap from `expectedRevision` to `next` succeeds. An ordinary `get()` followed by `put()` is unsafe.

## API

### `createCheckpoint(binding, { createdAt })`

Creates immutable schema-version-1 state. All binding fields are required:

- `namespace`: tenant or security boundary;
- `callId`: provider or application tool-call ID;
- `toolName` and `toolRevision`: exact implementation identity;
- `inputFingerprint`: a caller-computed digest of canonical input.

The package intentionally does not hash raw input or store it. Choose a collision-resistant digest and include every value that changes the effect.

### `decideCheckpoint(record, binding)`

Validates persisted state and the full binding, then returns `{ action, status, revision }`. A changed binding throws `BINDING_CONFLICT`; it is never treated as a cache hit.

### Execution transitions

- `claimExecution(record, { attemptId, at })`: `ready → executing`.
- `completeExecution(record, { attemptId, at, result, maxPayloadBytes? })`: `executing → completed` for the owning fence only. After external reconciliation proves the outcome, the same fenced attempt may also move `uncertain → completed`. `result` may represent either a tool success or a handler error and must be the exact JSON payload to redeliver.
- `markExecutionUncertain(record, { attemptId, at, reason })`: `executing → uncertain` when the external outcome cannot be established.

There is deliberately no automatic `executing/uncertain → ready` transition and no lease-expiry retry.

### Delivery transitions

- `claimDelivery(record, { deliveryId, at })`: `completed → delivering`.
- `releaseDelivery(record, { deliveryId, at })`: `delivering → completed` after a known failed delivery.
- `completeDelivery(record, { deliveryId, at })`: `delivering → delivered` after acceptance.

Only the matching `attemptId` or `deliveryId` can finish its claim.

### `validateCheckpoint(record)`

Checks schema version, state invariants, bounds, timestamps, and JSON result shape. It returns `true` or throws `CheckpointError`. Validation is structural; it does not authenticate storage. Protect records with the access controls and integrity mechanism appropriate for your system.

## Storage contract

Your adapter must provide atomic create-if-absent and compare-and-swap. A typical key includes all binding fields or a collision-resistant digest of them. Keep the record until the upstream call can no longer be replayed.

1. Atomically create the `ready` record.
2. CAS `ready → executing` and wait for success before invoking the tool.
3. CAS `executing → completed` before trying to deliver the result.
4. CAS the delivery claim, POST `result.payload`, then CAS to `delivered`.

Do not execute a returned action when its transition lost the CAS race.

## Guarantees and limits

- Prevents this protocol’s recovery logic from rerunning a durably completed tool solely because result delivery failed.
- Does **not** make an external side effect exactly once. A process can crash after the effect and before `completed` is persisted; that remains `executing`/`uncertain` and requires reconciliation.
- Result delivery is at least once after deliberate recovery. A provider may accept a POST before the worker crashes prior to `delivered`; another POST can duplicate delivery.
- Cannot repair a non-atomic store. Never implement CAS as separate read and write calls.
- Does not generate input fingerprints, encrypt results, authenticate records, run tools, call providers, schedule retries, or clean up storage.
- Deleting or expiring a checkpoint while its call can be replayed reopens duplicate-execution risk. Use tombstones or retention longer than the replay window.
- Payloads default to 65,536 UTF-8 JSON bytes, 32 levels, and 10,000 values. Identifiers are bounded. Adjust `maxPayloadBytes` up to 10 MB only after considering storage and data-exposure costs.
- Results may contain secrets or personal data. Encrypt and restrict the backing store, minimize payloads, and define retention.

## Troubleshooting

### `BINDING_CONFLICT`

The same checkpoint key was reused across a tenant, call ID, tool version, or input. Fix key construction; do not overwrite the old record.

### `FENCE_CONFLICT`

A stale worker tried to commit another worker’s execution or delivery. Discard the stale result and reload state.

### `reconcile-execution`

Do not rerun automatically. Query the external system using its idempotency key or effect identifier. If it proves completion, the original fenced attempt can call `completeExecution` with the exact result. If absence is proven, start a new application-level call under a reviewed policy; this package intentionally does not reopen the old execution.

### `reconcile-delivery`

The provider may have accepted the result. Consult provider history if available. If you deliberately release and retry, result delivery may be duplicated; the tool effect is still not rerun.

### `INVALID_CHECKPOINT` or `UNSUPPORTED_SCHEMA`

Treat the record as quarantined. Do not reset it to `ready`, because that could reopen execution.

## Why this package exists

The failure mode was independently reported against Anthropic’s [TypeScript SDK](https://github.com/anthropics/anthropic-sdk-typescript/issues/1243) and [Python SDK](https://github.com/anthropics/anthropic-sdk-python/issues/1749) session runners: completed handlers could run again when result posting failed and reconciliation encountered the same unanswered tool-use ID. This module is a provider-neutral primitive for applications that want an explicit persisted boundary. The underlying idempotency/checkpoint pattern is established; this package does not claim to invent it.

Related alternatives include [AWS Lambda Powertools idempotency](https://docs.aws.amazon.com/powertools/typescript/latest/features/idempotency/) for Lambda workloads, [`armorer/idempotency`](https://github.com/armorer/idempotency) for a broader tool framework, and durable workflow systems for full orchestration. Prefer those when their runtime and storage model already fit.

## Runnable example and related tool

[`examples/cas-store.mjs`](examples/cas-store.mjs) demonstrates execution and
delivery claims against a minimal compare-and-swap store. It is executed by
`npm run check` and ships in the npm tarball. Replace the in-memory function
with a real transactional store before production use.

For deterministically closing every announced tool call after cancellation or
limits, see [`tool-call-closure`](https://www.npmjs.com/package/tool-call-closure).

## Security

See [SECURITY.md](SECURITY.md). Please report vulnerabilities privately rather than opening a public issue.

## License

MIT © Huzaifa Asif. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
