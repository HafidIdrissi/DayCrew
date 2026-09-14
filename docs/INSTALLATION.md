# Installation

DayCrew v0.1.0-alpha runs locally from source. It does not require a cloud account.

## Prerequisites

- Git
- Node.js 20.19 or newer
- Corepack with pnpm 10.15.1

Windows users can install Node with the official installer or a version manager and run the commands in PowerShell. macOS users can use the official installer, Homebrew, or a version manager. Linux users should use their distribution package source or a Node version manager. Confirm `node --version` before continuing.

## Install and start

```bash
git clone https://github.com/daycrew/daycrew.git
cd daycrew
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm dev
```

Open `http://127.0.0.1:5173`. The local API listens on `http://127.0.0.1:5005` and rejects non-local browser requests.

`pnpm dev` starts exactly two processes: the DayCrew server (`@daycrew/server`) and the app frontend (`@daycrew/web`). The header of every app screen shows whether the local service is reachable; if it reads *Local service unreachable*, the server process has stopped or port 5005 is taken.

## The public site

The marketing site in `packages/site` is a separate, static experience. It is never required to run the app.

```bash
pnpm dev:site     # http://127.0.0.1:4173
pnpm build:site   # static files in packages/site/dist
```

The built output is plain HTML, CSS, and assets, so it can be hosted on any static host independently of your local installation. It makes no request to the local API.

Create or open an existing folder as a Workspace. DayCrew writes runtime state only under that folder's `.daycrew/` directory. The selected path is remembered in the operating system's application-data directory; it is not stored in the DayCrew checkout.

## AI Engines

Every DayCrew engine is a command-line tool that you install and sign in to yourself.
DayCrew runs it locally and reuses the sign-in that tool already holds. **DayCrew never
asks for an API key and never stores a provider credential.**

Auto uses Claude Code only. Every other engine must be chosen explicitly on an agent.

| Engine | Program | Install | Sign in |
|---|---|---|---|
| Claude Code | `claude` | `npm install -g @anthropic-ai/claude-code` | `claude auth login` |
| Codex CLI | `codex` | `npm install -g @openai/codex` | `codex login` |
| Cursor CLI | `cursor-agent` | `curl https://cursor.com/install -fsS \| bash` (macOS/Linux/WSL)<br>`irm 'https://cursor.com/install?win32=true' \| iex` (Windows PowerShell) | `cursor-agent login` |
| Antigravity Agent API | Antigravity desktop app | Install Antigravity from antigravity.google | Sign in inside the app |

Settings → **AI Engines** lists the same table with a **Detect AI Engines** button,
install and sign-in commands, and the state of each tool on this machine.

```bash
node packages/cli/dist/bin.js provider detect claude-code
node packages/cli/dist/bin.js provider detect codex
node packages/cli/dist/bin.js provider detect cursor
```

### Reading the readiness badge

DayCrew reports three separate facts, and a failed check never pretends to be an answer:

| Badge | Meaning |
|---|---|
| **Ready to run** | The program answered and reported that it is signed in. |
| **Installed · signed out** | The program ran, and it said it is not signed in. Run its sign-in command. |
| **Not installed** | The executable was not found on `PATH`. |
| **State unknown** | The check could not settle the question — a timeout, a permission error, an unrecognized status message, or a platform where discovery is unsupported. This is **not** the same as "missing". |

The Antigravity bridge is discovered on Windows only; on macOS and Linux its state stays
unknown rather than being reported as absent.

On Windows the Cursor CLI installs as `cursor-agent.cmd`, which Node cannot spawn
directly. DayCrew resolves the bundled `node.exe` the shim itself would run, so no shell
ever re-parses a prompt. Set `DAYCREW_CURSOR_BINARY` to override that resolution.

### Choose a model per agent

Open an agent (**Team → conversation → Edit agent**) and pick an AI Engine. In manual
mode a **Model** field appears with the models that CLI accepts:

| Engine | Where the list comes from | Custom identifier |
|---|---|---|
| Claude Code | Maintained list of documented aliases (`opus`, `sonnet`, `haiku`, `fable`) and model names | Allowed — the CLI documents full model names |
| Codex CLI | `codex debug models` on this machine | Allowed |
| Cursor CLI | `cursor-agent models` for the signed-in account | Allowed — Cursor publishes no canonical list |
| Antigravity Agent API | The three tiers its Agent API exposes (`flash`, `flash_lite`, `pro`) | Not allowed |

Leave the field on **Default model of the CLI** to let the tool choose. That is what
every agent created before model selection existed does, and those agents keep working
unchanged. Auto always uses the CLI default. The choice is passed to the tool through
its own documented option (`--model`, or `--model=<tier>` for Antigravity). Changing the
engine or model starts a new provider session; earlier messages keep their attribution.

If a list cannot be read — the CLI is not installed, or not signed in — the form says
so and still offers the maintained list plus a custom identifier, so setup is never
blocked by a failed lookup. The server validates the engine/model pair again on save
and rejects an identifier that could smuggle an argument into the command line.

## Troubleshooting

- If `pnpm` is missing, run `corepack enable` and reopen the terminal.
- If port 5005 or 5173 is busy, stop the existing local process before starting DayCrew. The site uses 4173 and can run at the same time as the app.
- If a Workspace cannot open, verify that the folder exists and that your user can read and write it.
- Normal UI errors intentionally hide raw OS paths, provider protocol payloads, and stack traces. Use the server log only for local development.

An `npx daycrew` distribution is a post-alpha packaging goal. It is not claimed for this release.
