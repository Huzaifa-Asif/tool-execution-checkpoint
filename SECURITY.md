# Security policy

## Supported versions

Security fixes are provided for the latest published major version.

## Reporting

Do not open a public issue for a suspected vulnerability. Use GitHub’s private vulnerability reporting for this repository. If that is unavailable, contact the maintainer privately through the contact method on their GitHub profile.

Include affected versions, a minimal reproduction, impact, and any suggested mitigation. Please allow reasonable time to investigate before public disclosure.

## Security boundaries

This library validates its state machine but does not authenticate, encrypt, persist, or replicate records. The host is responsible for atomic CAS, access control, integrity protection, result confidentiality, input fingerprint quality, retention, and reconciliation with external systems. A checkpoint is an application orchestration record—not cryptographic proof that an external effect occurred.
