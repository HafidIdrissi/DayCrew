# DayCrew Product

## Vision

DayCrew is an open-source AI work operating system where people create teams of
specialized AI professionals that work together like a real team. The product hides
coordination mechanics and presents understandable work, ownership, decisions, and
results.

The core flow is:

```text
Workspace -> Team -> Manager + Members -> Tasks and handoffs -> Human review
```

A user creates a Workspace and one or more Teams. Each Team has exactly one Manager.
The user gives the Manager a goal; the Manager breaks it into tasks, delegates to
specialist Members, coordinates handoffs, reviews outputs, and reports back. Members
may hand work to one another. The user primarily talks with the Manager.

Anything requiring approval, a decision, help with a blocker, or review of completed
work appears in a single **Needs You** inbox.

## Product principles

1. Open source.
2. Local-first.
3. AI engine and model agnostic.
4. Human-controlled.
5. Simple for non-technical users.
6. Extensible through Team Packs, AI Engine adapters, skills, and integrations.
7. Secure by default.
8. Ship a small, coherent MVP before advanced features.
9. Hide engine/model details by default; expose them only in Advanced Settings.
10. Put coordination complexity in the engine, not the interface.

## User-facing concepts

- **Workspace** — the local home for Teams, Knowledge, and work history.
- **Team** — one Manager plus zero or more specialist Members.
- **Manager** — the user's main contact and coordinator for a Team.
- **Team Member** — a specialist who owns and hands off tasks.
- **Task** — a visible unit of work in Todo, In Progress, Review, or Done.
- **Work Session** — one Team working toward one user goal.
- **Needs You** — one inbox for approvals, decisions, blockers, and completed work
  needing review.
- **Knowledge** — information shared with a Team.
- **Activity** — a human-readable audit trail of work and decisions.
- **AI Engine** — the technology used by a Team Member, normally configured
  automatically and shown only in Advanced Settings.

Internal implementation terms such as event bus, adapter, JSONL, protocol, and run
loop must not appear in the normal interface.

## Team examples

- Software Development: Engineering Manager, Software Architect, Developer, QA
  Engineer.
- E-commerce: Commerce Manager, Product Sourcing Specialist, Market Analyst,
  Pricing/Supplier Specialist.
- Job Search: Career Manager, Job Scout, Job Matcher, CV Specialist, Interview Coach.
- Research: Research Manager, Literature Scout, Research Analyst, Reviewer, Citation
  Checker.
- Custom: the user chooses the Manager, Members, responsibilities, and working rules.

## Primary interface

DayCrew has four primary views:

1. **Home** — Daily Brief, active Teams, completed work, approvals, blockers, and
   Needs You.
2. **Teams** — Manager conversation, Members, Team status, and Team Knowledge.
3. **Tasks** — Todo, In Progress, Review, Done, with ownership and handoffs.
4. **Office** — an optional, original DayCrew visualization of Members working. It
   is never required to operate the product and must not copy another product's
   visual identity.

## Human control

Teams support three autonomy levels:

- **Assist me** — ask frequently and keep the user closely involved.
- **Work with approval** — work independently, but ask before important or risky
  actions. This is the default.
- **Autonomous** — work independently within user-defined limits.

Hard safety boundaries continue to apply at every level. Destructive filesystem
operations, destructive shell commands, external publishing, spending money, Git
push/destructive Git actions, sensitive network access, and credential access are
always subject to explicit policy and audit.

## Extensibility

A Team Pack is data plus role instruction files; it must not require core code
changes. An AI Engine adapter translates one provider/runtime into DayCrew's neutral
contract; provider-specific behavior must stay outside the core.

## Non-goals

DayCrew is not a generic chat application, a terminal-first product, or an imitation
of another office simulation. The MVP does not add departments, divisions, squads,
or other hierarchy beyond Workspace -> Team -> Manager + Members.
