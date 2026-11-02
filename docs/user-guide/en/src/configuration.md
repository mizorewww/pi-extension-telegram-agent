# Configuration and more bots

Every setting lives in `telegram.config.ts` at the project root; [`telegram.config.example.ts`](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/telegram.config.example.ts) lists every field with comments. Restart the daemon after editing (`systemctl --user restart telegram-agent`, or run `bun run start` again).

## Files

| File | Content | Committed to Git |
|---|---|---|
| `telegram.config.ts` | group, bots, models, routing, tools, limits | no |
| `.env` | bot tokens, TinyFish key and other secrets | no |
| `personas/*.local.md` | your bots' personalities | no |
| `telegram.config.example.ts`, `personas/template.*.md` | public examples | yes |

`.env` uses a colon format (not `KEY=value`):

```text
telegram_bot_token: 123456:REPLACE_WITH_BOTFATHER_TOKEN
```

## Minimal configuration

```ts
import { defineConfig } from "./src/config.ts";

export default defineConfig({
  group_peer_id: 1234567890,
  provider: "openai-codex",
  model: "gpt-5.6-luna",
  bots: [{
    id: "friend",
    name: "Mochi",
    token_env: "telegram_bot_token",
    persona_path: "personas/friend.local.md",
    routing_p: 0.1,
  }],
});
```

Omitted fields use defaults. An invalid configuration fails at startup with every problem listed at once.

## Adding a bot

1. Add a new token line to `.env`, for example `helper_bot_token: ...`;
2. copy `personas/template.en.md` into a new persona;
3. append an entry to `bots` (`id` must be unique and contain only letters, digits, `_` and `-`);
4. restart and check it with `/status` in the group.

Each bot has its own token, personality, session and statistics. They share the group's history and see each other's messages, but do not trigger each other unless an admin turns on `/fire` (see below).

## When a bot replies

- **Always**: when someone @mentions it, replies to its message, or writes its `name`.
- **Sometimes**: an ordinary message goes to one bot with probability `routing_p` (all bots together may not exceed 1). If the chosen bot is busy or cooling down (`cooldown_ms`, default 2000), the message is skipped rather than handed to another bot; a chosen bot may still decide to stay quiet.
- `routing_p: 0` only turns off spontaneous replies; mentions still work.
- Messages from bots do not trigger other bots, unless an admin turns on [`/fire`](operations.md) for a bot.

## Models

- `provider` / `model` can be set at the top level (shared by all bots) or overridden per bot; when you change the provider you must also set `model`. If omitted, Pi's `/model` default is used.
- `reasoning_effort` defaults to `off` and must be a level the model actually supports (Pi `/model` shows them); otherwise startup fails.
- `compaction_model` is a cheap model used to summarize context (`provider/model:effort`). If a summary fails, the old context is kept; it never falls back to the main model.
- For your own gateway or proxy, register it in Pi's `~/.pi/agent/models.json` (`baseUrl`, `api: "openai-completions"`, `apiKey`, and each model's `input`, `contextWindow`, `maxTokens`), confirm it in Pi `/model`, then reference it here. No project change is needed.
- Admins can switch models from the group with `/model` buttons; see [Group commands](operations.md#group-commands).

## Tools

Each bot switches its tools on in `tools`; only `send` is on by default:

```ts
tools: { send: true, search: false, codemode: false, sandbox: false, tasks: false }
```

| Switch | What it does | Needs |
|---|---|---|
| `send` | post in the group, send stickers, add reactions; turn it off for a bot that only watches | nothing |
| `search` | web search (up to 5 snippets) or read one public page, paging through long ones; localhost and private addresses are refused | `tiny_fish_api_key` in `.env` |
| `codemode` | the bot writes JavaScript scripts (Pi's native QuickJS sandbox) for exact calculations, to call other tools in bulk and filter the results, and to search the group's whole message history. Scripts have no network or file system, and can call `send` | nothing |
| `sandbox` | the bot's own Linux work box (a Docker container): run commands from scripts and copy in files people send; `send` can post images (jpg/png/webp up to 10 MB) and files (up to 50 MB) from the box straight to the group | `codemode: true`, a top-level `sandbox` section, rootless Docker on the host |
| `tasks` | hand long searches and research to a background task and reply to the requester when it is done | `sandbox: true`, a top-level `tasks` section |

The `view_image` tool has no switch: every bot gets it when `media.mode` is `"hybrid"` (see below).

### Work box (`sandbox`)

```ts
sandbox: { image: "tg-box:2", docker_host: "unix:///run/tgbox/docker.sock", memory: "1g", cpus: 2, pids: 256, network: true },
```

These are the defaults, so write only what you change, but the `sandbox` section itself must exist. Each bot with `sandbox` gets one long-lived container, run by rootless Docker under a dedicated Linux user, with no host directories mounted and no credentials inside. `network: false` takes the box offline.

- Files in the box stay until it is wiped every Monday at 05:00 (local time of the daemon's machine); the bot is told when that happens.
- Admins can send `/box reset` in the group at any time, and the bot can wipe its own box when it breaks.
- Host setup (the `tgbox` user, rootless Docker, building the image) is in the [sandbox runbook](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/runbooks/sandbox.md). It has only been tested on Linux hosts so far.

### Background tasks (`tasks`)

```ts
tasks: { workflows: { search: "~/pi-tasks/search" }, max_running: 2, timeout_minutes: 45, memory: "3g", cpus: 2 },
```

- `workflows` maps a name to a directory that must contain a `.pi` folder (Pi project settings, extensions, prompts). The bot picks a workflow when it starts a task; each task runs Pi with that `.pi` in a throwaway container sharing the box's `/work`, so the bot can post whatever files the task produces.
- `max_running` is how many tasks one bot may run at once; a task running past `timeout_minutes` fails. `memory` / `cpus` cap each task container.
- Pi inside a task needs its own model credentials, kept in a dedicated Docker volume; see the [sandbox runbook](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/runbooks/sandbox.md#任务凭证卷).
- In the group: the bot first says it is on it; progress, questions for you and the result reach the bot as `[task tN …]` lines, and the bot relays them and replies to whoever asked. To add details, just reply to the bot and it forwards them. A daemon restart interrupts running tasks, and the bot tells the requester.

## Images and videos

`media.mode` decides how bots "see" media:

| Mode | How | Needs |
|---|---|---|
| `"off"` (default) | text placeholders such as `[photo]` only | nothing |
| `"hybrid"` | a vision model (`media.vision_model`) describes each new image or video once as text, shared by all bots; when a description is not enough, the bot calls `view_image` to open one message's actual image or video frames, including replied-to or searched older messages | a main model with image input |

Use `hybrid` when the bot should understand images: it pays only for text descriptions until the bot really needs to look at the original.

`media.max_per_turn` caps new media described per turn (default 2) and `media.concurrency` caps parallel jobs (default 2). Voice, audio, ordinary files and TGS animated stickers are placeholders in every mode (a bot with `sandbox` can copy files into its box and work on them). Videos require FFmpeg on the host.

## Limits and defaults

| Field | Default | Purpose |
|---|---|---|
| `context_window` | 65,536 | the most context the main model uses |
| `compaction_threshold` | half of `context_window` | context beyond this is summarized (at most `context_window − 16,384`) |
| `compaction_keep_recent` | 20,000 | recent tokens kept verbatim after a summary (about 1–2 turns) |
| `max_suffix_tokens` / `max_message_tokens` | 12,000 / 4,096 | caps on new messages per turn and on one message |
| `context_image_budget_bytes` | 10,000,000 | an extra summary is made when images in context exceed this many bytes |
| `provider_timeout_ms` / `provider_retries` | 300,000 / 2 | per-request timeout and automatic retries |
| `cache_retention` | `"short"` | provider prompt cache retention |
| `telemetry_retention_days` etc. | 90 / 30 / 365 | days to keep usage, raw updates and message events |
| `telegram_admins` | empty | numeric user ids of people who may use admin commands (usernames are not accepted because they can change hands) |

Most of these can also be overridden per bot. Misspelled or retired fields fail at startup with a hint about what to write instead.

Don't know your numeric user id? Message [@userinfobot](https://t.me/userinfobot) privately.

After you change the model, personality, tools, media mode or other settings that affect what the model sees, each bot starts a new session on restart (the old session file is kept). This is expected.

Next: [Daily operations and group commands](operations.md).
