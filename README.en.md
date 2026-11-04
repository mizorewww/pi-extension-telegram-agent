# Pi Telegram Agent

[中文](README.md) · [English](README.en.md) · [Online Guide](https://mizorewww.github.io/pi-extension-telegram-agent/en/)

A self-hosted Telegram group companion daemon built on the [Pi SDK](https://github.com/earendil-works/pi).

Instead of a command-driven Q&A bot, it lets **one or more AI personas live in your Telegram supergroup** like real members: they follow the group conversation, chime in occasionally by probability or stay silent, always reply when addressed, and can search chat history, browse the web, run scripts, or process files inside their own isolated Linux containers and post the results back to the group.

---

## Highlights

### 1. Natural Group Participation & Deterministic Routing
- **Zero-waste routing**: Local deterministic code decides whether to invoke an LLM. Mentioning `@bot`, replying to the bot, or calling its configured `name` **always triggers a reply** (recorded as a durable reply obligation that survives restarts and provider outages). Ordinary messages are routed to at most one idle bot by probability (`routing_p`).
- **Silence is an option**: Even when selected by probability, a bot that has nothing worthwhile to add simply omits calling `send` and posts nothing to the group.
- **Native Telegram expression**: Through the single public output tool `send`, bots post Markdown messages (converted locally to classic Telegram entities for universal client compatibility), stickers (from configured sets or learned from group members), emoji reactions, and generated photos or documents.
- **Bounded bot-to-bot interaction (`/fire`)**: Bot messages are ignored by default to prevent loops. Admins can enable `/fire` per bot so sibling bots can trigger each other (capped at 3 consecutive bot-triggered turns per human message).

### 2. Layered, Opt-In Toolset
Each tool is toggled per bot in `telegram.config.ts`. Disabled tools are completely omitted from that bot's prompt:

| Tool / Mode | Capability | Configuration |
|---|---|---|
| `send` | Post text, stickers, emoji reactions, and work-box files to the group (turn off for a read-only observer bot) | `tools.send` (default `true`) |
| `hybrid` vision | A cheap vision model describes each new photo, sticker, or video (1–3 FFmpeg frames) once into SQLite for all bots to share; a bot calls `view_image` on demand when it needs to inspect the original image | Top-level `media.mode: "hybrid"` |
| `search` | Web search (up to 5 compact hits) and paginated public webpage reading via TinyFish (blocks private/loopback IPs) | `tools.search: true` + `tiny_fish_api_key` in `.env` |
| `codemode` + `tg_messages` | Run JavaScript inside Pi's QuickJS (Wasm) sandbox: exact math, parallel tool composition, and full group history queries via `tg_messages` (backed by SQLite FTS5 trigram search). Scripts can call `send` mid-run to acknowledge before finishing work | `tools.codemode: true` |
| `job` | Run a multi-minute batch `codemode` script in the background without blocking chat; wakes the bot to reply when finished | Registered automatically when `codemode` and `send` are enabled |
| `sandbox` (Work Box) | Per-bot isolated rootless Docker Linux container (Python, Node, FFmpeg, ImageMagick, Poppler, Git): copy group attachments into `/work` (`tg_download`), run shell commands (`sh_exec`), and send generated charts/files back (`send.files`) | `tools.sandbox: true` + top-level `sandbox` section |
| `tasks` (Background Tasks) | Spawn a disposable container running a full Pi workflow (`.pi` with `pi-subagents` and skills) for deep research, waking the bot on completion | `tools.tasks: true` + top-level `tasks` section |

### 3. Built Around Provider Prompt Caching
- **SQLite as single source of truth**: Every message, edit, reply snapshot, and vision description is stored as an immutable event in `data/agent.db`.
- **Strict Prefix Invariant**: System prompt, persona, sticker catalog, and tool schemas stay byte-identical; new group events are only appended as suffix batches and **never rewrite earlier messages**, maximizing provider prompt cache hit rates.
- **Dual-budget compaction**: When context tokens approach the threshold or attached images exceed the byte budget, a cheap `compaction_model` summarizes older turns into state (stripping assistant `thinking` so speculation never becomes "fact").

---

## Quick Start

### 1. Prerequisites
- [Node.js 24+](https://nodejs.org/)
- Local [Pi CLI](https://github.com/earendil-works/pi) installation (used once to authenticate model providers into `~/.pi/agent/auth.json`)
- A Telegram supergroup and at least one [@BotFather](https://t.me/BotFather) bot with **Group Privacy turned off**, added to the group
- *(Optional)* `ffmpeg` on the host (for video frame extraction) and rootless Docker (for `sandbox` work boxes and `tasks`; see the [sandbox runbook](docs/runbooks/sandbox.md))

### 2. Install & Authenticate Models

```bash
git clone https://github.com/mizorewww/pi-extension-telegram-agent.git
cd pi-extension-telegram-agent
npm ci
npm run build

# Log in to your model provider and pick a default model in Pi (exit when done)
pi
# Inside Pi, run: /login  and  /model
```

### 3. Configure & Start

```bash
cp telegram.config.example.ts telegram.config.ts
cp personas/template.en.md personas/friend.local.md
```

Create `.env` (uses `key: value` **colon syntax**):

```yaml
telegram_bot_token: 123456789:AAH...
# Required only when tools.search is true:
# tiny_fish_api_key: tf-...
```

Edit `telegram.config.ts` (minimal example below; see [`telegram.config.example.ts`](telegram.config.example.ts) for all commented fields):

```ts
import { defineConfig } from "./src/config.ts";

export default defineConfig({
  group_peer_id: 1234567890, // Your Telegram group ID (bare, negative, or -100-prefixed)
  provider: "openai-codex",
  model: "gpt-5.6-luna",
  media: { mode: "hybrid" }, // Enable image & video understanding
  telegram_admins: [987654321], // Numeric Telegram user IDs (message @userinfobot to find yours)
  bots: [
    {
      id: "friend",
      name: "Mochi", // Calling this name in chat also triggers a reply
      token_env: "telegram_bot_token",
      persona_path: "personas/friend.local.md",
      routing_p: 0.1, // 10% chance to join unaddressed messages
      tools: { send: true, search: false, codemode: true },
    },
  ],
});
```

Run in the foreground:

```bash
npm start
```

Once `"event":"ready"` appears in the output, mention `@your_bot` or send `/status` in the Telegram group. For long-running production use under systemd, see the [daemon runbook](docs/runbooks/daemon.md).

---

## In-Group Control Commands

Send commands directly in the Telegram group (use `/command@bot_username` when running multiple bots). Control commands and their replies **never enter the LLM context**.

| Command | Access | Description |
|---|---|---|
| `/help` | Everyone | Show command reference |
| `/status` | Everyone | Show bot state, context breakdown bar, token usage, cache hit rate, speed, and cost |
| `/fire status` | Everyone | Check whether other bots can trigger this bot and remaining budget |
| `/task` | Everyone | List recent background tasks and their token usage |
| `/model` | Admins | Open an inline button menu to switch models from Pi's authenticated catalog (writes back to `telegram.config.ts` and starts a new session) |
| `/set` | Admins | Open an inline button menu to adjust `routing_p` and `cooldown_ms` live (writes back to `telegram.config.ts`) |
| `/new` | Admins | Reset context and start a fresh session |
| `/compact` | Admins | Trigger immediate context summarization |
| `/fire [on\|off]` | Admins | Enable, disable, or toggle bot-to-bot triggering for this bot |
| `/box reset` | Admins | Wipe and recreate this bot's Linux work box container (also resets automatically every Monday at 05:00) |
| `/task cancel tN` | Admins | Cancel running background task `tN` |

---

## Diagnostics & Documentation

To diagnose why a bot did not reply or inspect recent runs without touching secrets or making network calls:

```bash
npm run debug -- --since 30m
npm run debug -- --bot friend --since 2h
```

- **User Guide** ([Online](https://mizorewww.github.io/pi-extension-telegram-agent/en/) · [Local](docs/user-guide/en/src/README.md)):
  - [What it can do](docs/user-guide/en/src/features.md) · [Installation and first setup](docs/user-guide/en/src/getting-started.md) · [Configuration and more bots](docs/user-guide/en/src/configuration.md) · [Daily operations and group commands](docs/user-guide/en/src/operations.md) · [Troubleshooting](docs/user-guide/en/src/troubleshooting.md) · [Design and philosophy](docs/user-guide/en/src/design.md)
- **Host Runbooks (Chinese)**:
  - [Daemon & systemd operations](docs/runbooks/daemon.md) · [Bot work boxes & task containers (Rootless Docker)](docs/runbooks/sandbox.md)
- **Engineering & Architecture**:
  - [Documentation index](docs/index.md) · [Architecture](docs/architecture.md) · [Cache engineering](docs/cache.md) · [Data model](docs/data-model.md) · [AGENTS.md](AGENTS.md)

Licensed under the BSD 2-Clause License; see [LICENSE](LICENSE).
