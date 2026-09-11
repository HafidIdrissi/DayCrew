# Security Policy

DayCrew is pre-release software that will eventually coordinate AI engines with local
filesystem, shell, and network capabilities. Only the `main` branch is currently
supported.

## Reporting

Do not open a public issue for a vulnerability. Use GitHub's private vulnerability
reporting feature for this repository and include impact, reproduction steps, and a
minimal proof of concept when possible.

## In scope

- Execution of a risky action without the required human approval.
- Escape from the configured Workspace boundary.
- Credential exposure through logs, events, Team Packs, or Member handoffs.
- Provider adapters that misrepresent or bypass their safety boundary.
- Team Pack loading that executes code or permits path traversal.
- Destructive Git, filesystem, publishing, spending, or sensitive network actions
  that evade policy or audit.

Underlying third-party AI engine vulnerabilities should also be reported to that
engine's vendor. DayCrew currently offers no bug bounty.
