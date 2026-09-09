# Security Policy

DayCrew runs AI-driven processes with real shell and filesystem access on a user's
machine. We take the security model seriously and welcome reports.

## Supported versions

DayCrew is pre-alpha. Only `main` is supported. There are no released versions yet.

## Reporting a vulnerability

**Do not open a public issue for security problems.**

- Use GitHub's **private vulnerability reporting** ("Report a vulnerability" on the
  Security tab), or
- Email **security@daycrew.dev** with details and, if possible, a proof of concept.

We aim to acknowledge within 3 business days and to provide a remediation timeline
within 10 business days.

There is currently **no bug bounty**. We will credit reporters in the release notes
unless you ask us not to.

## In scope

- Bypass of the human **approval gate** (risky action executes without approval).
- Escape from the **workspace (`cwd`) jail** — a member reading or writing outside
  the configured workspace without an approval.
- **Secret exfiltration** paths (credentials, `.env` contents) via network, logs, or
  inter-member messages.
- Privilege escalation between team members.
- Provider adapter flaws that break the trust boundary in
  [`docs/PROVIDER-ADAPTERS.md`](./docs/PROVIDER-ADAPTERS.md).
- Team Pack loading that executes untrusted code (packs are meant to be data only).

## Out of scope

- Vulnerabilities in the underlying engines themselves (Claude Code, Codex CLI, etc.)
  — report those to their vendors.
- Social-engineering of a user into approving a malicious action (we mitigate with
  clear prompts, but the user is the final authority).
- Denial of service from a user's own runaway objective (guardrails are best-effort).

## Hardening guidance for users

- Run DayCrew in a dedicated directory; never point a workspace at your home dir.
- Keep the default `deny-all-ask` network posture unless you trust the objective.
- Review the approval prompt before saying yes — it shows the exact command/path/URL.
- Do not store API keys inside a workspace directory.
