import { randomUUID } from 'node:crypto';
import { claimDelivery, claimExecution, completeDelivery, completeExecution, createCheckpoint, decideCheckpoint } from 'tool-execution-checkpoint';

// Replace this with a database transaction that atomically compares revision and writes next.
let stored = createCheckpoint({
  namespace: 'acme', callId: 'toolu_42', toolName: 'send-email',
  toolRevision: 'v3', inputFingerprint: 'sha256:your-canonical-input-digest'
}, { createdAt: new Date().toISOString() });

function cas({ expectedRevision, next }) {
  if (stored.revision !== expectedRevision) return false;
  stored = next;
  return true;
}

if (decideCheckpoint(stored, stored.binding).action === 'execute') {
  const attemptId = randomUUID();
  const claim = claimExecution(stored, { attemptId, at: new Date().toISOString() });
  if (cas(claim)) {
    // Invoke only after the claim is durably stored. This is the side effect.
    const exactProviderPayload = { type: 'tool_result', tool_use_id: stored.binding.callId, content: 'sent' };
    cas(completeExecution(stored, { attemptId, at: new Date().toISOString(), result: exactProviderPayload }));
  }
}

if (decideCheckpoint(stored, stored.binding).action === 'deliver') {
  const deliveryId = randomUUID();
  if (cas(claimDelivery(stored, { deliveryId, at: new Date().toISOString() }))) {
    await Promise.resolve(stored.result.payload); // POST this exact payload to your provider.
    cas(completeDelivery(stored, { deliveryId, at: new Date().toISOString() }));
  }
}
