# DayCrew conversations and configurable agents

## Product direction

DayCrew is an open-source, local-first workspace for working with AI colleagues
through a team-messaging interface. Users create agents, give each a name, role,
instructions and Skills, and explicitly choose its AI Engine. Different Members
of the same Team can use different engines.

The reference is familiar team messaging: a conversation list, an authored message
timeline and a composer. Munder Difflin is a reference for using local agent CLIs;
DayCrew keeps its own design and implementation.

This document defines the requested direction and the implemented chat baseline.
Provider support remains subject to the restrictions below.

## Agent setup

- Create a Member inside an existing Team, or configure its Manager.
- Set name, role, instructions and optional Skills.
- Choose Claude Code, Codex CLI, Cursor CLI or the Antigravity Agent API explicitly per Member.
- Show installed/authenticated status separately from supported capabilities.
- Offer model selection from the engine's own catalogue, validated on the server.
- Preserve the chosen engine on reload and Workspace switching.
- Never silently replace an explicitly chosen engine with another provider.
- Changes to engine or model start a new provider session. Existing messages retain
  their original author and engine attribution; session continuity is not implied.

## Conversations

The baseline is a private conversation with any Team Member, including the Manager.
A Team channel complements private conversations. Its recipient selector targets
one Member; the Manager replies by default.

Each conversation has a stable identity and persisted human/agent messages. Sending
a follow-up continues that conversation. Sending a message must not automatically
create a new work Goal. An explicit action asks the Manager to organize a Goal into
Tasks and delegate it to Members.

The message timeline shows the author, timestamp, response progress, completion,
failure and relevant approval cards. Tool protocol payloads are not chat messages.
Responses must come from the configured backend provider. A deterministic provider
is available only as visibly labelled Demo Mode.

If Team channels are included, the Manager coordinates participation. Mentioning a
Member targets that Member; one message must not broadcast paid requests to every
agent by default. Direct conversations remain separate from channel history.

## Layout

Keep Home, Teams, Tasks and Office in primary navigation, with Settings separate.
Inside Teams, provide a list of Teams and conversations, the selected chat, and a
contextual Member panel for role, Skills, AI Engine and capabilities. Office remains
an optional view. The chat is the main working surface for a Team.

## Current adapter constraints

| Engine | Current implementation | Requirement for normal chat |
|---|---|---|
| Claude Code | Conversation replies and follow-ups, with the existing approval bridge | Installed and authenticated CLI |
| Codex | Read-only chat preview in a disposable OS-temp folder | Explicit consent for unconfined reads; this is not filesystem isolation |
| Antigravity Agent API | Experimental chat in a disposable OS-temp folder | Explicit consent; no reliable approval controls or filesystem isolation |
| Cursor CLI | Read-only chat preview started in a disposable OS-temp folder | `cursor-agent login`; explicit consent. The folder is a convention, not a sandbox, and there are no reliable approval controls |
| Grok Build | Read-only chat preview started in a disposable OS-temp folder | `grok login --device-code`; explicit consent. No reliable approval bridge; the live turn boundary is not yet verified |

Do not remove these checks merely to make a selector work. An unavailable choice
must explain the limitation, rather than fail after the user sends a message.

Local-first means DayCrew stores its state locally. Requests to an AI Engine can be
sent to that provider through its CLI and authentication; it does not mean offline
inference or free model usage.

## Implementation order and acceptance

1. Member creation/editing and explicit engine selection, persisted and validated
   on the server. Existing Team Packs and Skill assignments remain compatible.
2. A conversation/message contract separate from work Goals, with Workspace
   isolation, serialized turns and accurate attribution.
3. A continuous private chat using a real supported adapter: send, stream, follow
   up, stop, recover from failure, reload history and surface approvals.
4. Team channel coordination if selected, reusing existing Tasks and handoffs.
5. Adapter-specific support work for Codex/Gemini and tests proving the capabilities
   actually offered by each selectable engine.

Acceptance includes two Members with different explicit engine choices, persistent
conversations, correct routing of messages, no cross-Workspace history, honest
unavailable-engine states, and a real-provider conversation followed by a Goal,
approval and completed Task. Demonstrations must distinguish real and simulated
execution.

## Implemented baseline and remaining limits

Teams now open a conversation surface with a Team channel, private Member chats,
agent creation/editing, explicit engine selection, persisted messages, reply
progress, stop, and links to approval decisions in Needs You. Starting a Team Goal
is a separate composer action. Skills remain configurable from the Team overview.

Engine readiness is checked before sending; preview consent is required for both
the Send button and keyboard shortcut. Model selection is offered per Member from
the selected CLI's catalogue — read live where the engine publishes one, from a
maintained list otherwise — and is validated again on the server before saving.
Existing model settings are retained when editing the same engine, and reset to the
engine default when choosing a different engine. An agent saved without a model
keeps using the engine default, so Team Packs and older Workspaces are unaffected.

Each reply starts a new provider session using bounded conversation history as
context (up to 24 completed messages and 40,000 characters). This does not resume
the provider's hidden state. The UI polls saved replies every 1.5 seconds. After a
restart, partial replies are shown as stopped; interrupted actions can still need
manual review. Channel participation uses the recipient selector, not automatic
parsing of @mentions or a broadcast to every Member.

Verification on 2026-09-12 includes server tests for routing, persisted follow-ups,
approval/resume, stopping, Workspace isolation and restart recovery, plus browser
component tests for readiness and preview consent. A real authenticated Claude
Code conversation successfully recalled a code from the previous message.

On 2026-09-13 the Antigravity chat preview was verified against the live engine: two
real turns where the second recalled a code from the first, a stopped reply that left
the work session cancelled with no pending approval and no leftover process, and a real
tool-using task whose answer required reading two planted files. On 2026-09-14, after
the account limit reset, Codex also passed real two-turn context, thread continuation,
cancellation, orchestration and write-refusal checks. Its real read task remains blocked
because Codex 0.154.0 rejects the PowerShell command host under DayCrew's exact
`read-only` / `never` policy before the read executes. Both engines' consent and
fail-closed gates were exercised for real. Full record, including what each engine does
**not** enforce, in [ENGINE-VALIDATION.md](./ENGINE-VALIDATION.md).

The earlier product guideline hiding engine choice in Advanced Settings is
superseded for Member setup by the user's explicit per-agent selection requirement.
