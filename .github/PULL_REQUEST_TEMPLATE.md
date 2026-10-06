## Summary

Describe the problem and the smallest change that solves it.

## Safety invariants

- [ ] Recovered in-flight or uncertain execution is never automatically reopened.
- [ ] Execution and delivery ownership remain fenced.
- [ ] Persisted schema compatibility was considered.

## Verification

- [ ] `npm run check`
- [ ] Tests cover success, conflict, boundary, and recovery behavior.
- [ ] Documentation and changelog are updated when needed.
