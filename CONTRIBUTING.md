# Contributing

Thank you for helping improve `tool-execution-checkpoint`.

1. Search existing issues and open a focused issue for behavioral changes.
2. Fork the repository and create a small branch.
3. Run `npm ci` and `npm run check` on Node.js 18 or newer.
4. Add tests for every state transition and recovery invariant you change.
5. Update the README and changelog when public behavior changes.
6. Open a pull request using the template.

Changes must preserve the central safety rule: no recovered `executing` or `uncertain` record may silently become permission to run the effect again. New persisted fields require a schema and migration discussion.

By contributing, you agree that your contribution is licensed under the MIT License. Follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report security issues using [SECURITY.md](SECURITY.md), not a public issue.
