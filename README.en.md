# Pi Telegram Agent

[中文](README.md) · [English](README.en.md) · [Online documentation](https://mizorewww.github.io/pi-extension-telegram-agent/en/)

A self-hosted Telegram group agent built on [Pi Durable 1.5.0](https://github.com/earendil-works/pi). One or more bots with distinct personalities live in the same group: they answer when addressed, sometimes join in, research topics, search history, process files and deliver results.

This project maintains the Telegram wrapper. Pi owns conversations, persistent queues, compaction, retries, tool execution, background tasks and cumulative usage. Models and authentication come from installed Pi providers. Pi Durable is experimental; all Pi packages are pinned exactly to 1.5.0.

## Capabilities

| Capability | Configuration | Behavior |
|---|---|---|
| Public replies | `tools.send`, enabled by default | The sole public channel for text, stickers, reactions, images and files; disable it for an observer |
| Images and videos | `media.mode: "hybrid"` | Describe each media item once across bots; `view_image` supplies originals or video frames as native Pi images when needed |
| Search | `tools.search` + TinyFish key | Search or page through public websites; private and loopback addresses are refused |
| Scripts and history | `tools.codemode` | Compose tools, calculate and filter results in Pi QuickJS; query the group archive with `tg_messages` |
| Linux work box | `tools.sandbox` + `sandbox` | Native read/write/edit/bash run through pi-env in rootless Docker; `tg_download` imports attachments and send delivers files |
| Background research | `tools.tasks` + `tasks` | A workflow directory's `AGENTS.md` guides a Pi child conversation sharing the isolated work box and host authentication |
| Background scripts | codemode and send together | `job` runs a native Pi tool task without an additional model call |

Deterministic routing handles mentions, replies and configured names. Ordinary messages reach at most one bot by probability, skipping busy bots. Pending direct replies persist, with at most one repair prompt after a healthy but unpublished response. Bots do not trigger each other by default; admins can enable bounded interaction with `/fire`.

Only send posts to the group. Text is converted to escaped HTML using classic Telegram messages; sends with an unknown outcome are never automatically retried. Background work resumes after restarts under Pi's tool replay rules; unsafe operations that started but have an unknown outcome are not blindly repeated.

## Context and cost

The Telegram archive lives in `data/agent.db`; each bot's Pi conversations, tasks and usage live in `data/pi/<bot>.sqlite`. Inputs append within a context segment, preserving existing prefixes. Compaction, model changes and `/new` establish new prefixes.

Compaction uses the current chat model and reasoning effort with a fixed 16,384-token reserve. The effective planning window is the minimum of the catalog window, `context_window`, and `compaction_threshold + 16,384`. Summary output is capped at 13,107 tokens or the model limit, whichever is smaller. Pi 1.5.0 does not split oversized summary inputs automatically or precisely estimate encrypted thinking-signature costs.

Hybrid normally uses cached descriptions and opens originals only for details. Pi persists image bytes. `/status` reports Pi's cumulative ledger, including children and history; `/new` does not clear it. The provider's bill remains authoritative.

## Quick start

You need Node.js 24+, an installed Pi CLI and a Telegram bot created in BotFather with group privacy disabled and access to the target supergroup. Video understanding needs host FFmpeg. The work box needs Linux rootless Docker and `tg-box:4`; see the [work box runbook](docs/runbooks/sandbox.md).

```bash
git clone https://github.com/mizorewww/pi-extension-telegram-agent.git
cd pi-extension-telegram-agent
npm ci
npm run build
pi
# In Pi, use /login and /model, then exit.
cp telegram.config.example.ts telegram.config.ts
cp personas/template.en.md personas/friend.local.md
```

Create `.env` using colon syntax:

```text
telegram_bot_token: 123456:REPLACE_WITH_BOTFATHER_TOKEN
```

Edit `telegram.config.ts` with the group ID, bot name and persona path. Omit provider/model to inherit Pi's defaults. A minimal example:

```ts
import { defineConfig } from "./src/config.ts";

export default defineConfig({
  group_peer_id: 1234567890,
  telegram_admins: [987654321],
  bots: [{
    id: "friend",
    name: "Mochi",
    token_env: "telegram_bot_token",
    persona_path: "personas/friend.local.md",
    routing_p: 0.1,
  }],
});
```

Run `npm start` in the foreground. After `ready`, mention the bot or use `/status`. Use systemd for a server; run `npm ci && npm run build` before restarting after updates. Never poll the same token simultaneously on a development machine and the server.

## Group controls

| Command | Access | Effect |
|---|---|---|
| `/help`, `/status` | Everyone | Help, live state, context estimate and cumulative Pi usage |
| `/fire status`, `/task` | Everyone | Bot interaction budget and background task state |
| `/model`, `/set` | Admins | Choose models or routing settings with buttons, apply immediately and atomically write back to `telegram.config.ts` |
| `/new` | Admins | Wait for old replies and background work to stop, then reset the conversation and work box |
| `/compact` | Admins | Run native compaction with the current chat model; incurs model charges |
| `/fire [on\|off]` | Admins | Control whether other bots can trigger this bot |
| `/box reset`, `/task cancel tN` | Admins | Wipe the work box or cancel a background task |

With multiple bots, target one using `/command@bot_username`. Control messages and replies do not enter model context. See the [configuration example](telegram.config.example.ts) for all settings.

## Diagnostics and documentation

```bash
npm run debug -- --bot friend --since 30m
```

Diagnostics read archive/routing facts and structured logs; use `/status` for live Pi state. Back up the whole `data/` directory, private configuration, personas and `.env`. When upgrading from AgentSession, old JSONL sessions are not imported into the new Harness; the group archive remains. Follow the operational runbooks for the upgrade.

- [User guide](docs/user-guide/en/src/README.md): [Setup](docs/user-guide/en/src/getting-started.md) · [Configuration](docs/user-guide/en/src/configuration.md) · [Operations](docs/user-guide/en/src/operations.md) · [Troubleshooting](docs/user-guide/en/src/troubleshooting.md) · [Design](docs/user-guide/en/src/design.md)
- [Daemon and systemd](docs/runbooks/daemon.md) · [Rootless work boxes](docs/runbooks/sandbox.md)
- [Documentation index](docs/index.md) · [Architecture](docs/architecture.md) · [Cache](docs/cache.md) · [Usage](docs/telemetry.md) · [Development constraints](AGENTS.md)

BSD 2-Clause; see [LICENSE](LICENSE).
