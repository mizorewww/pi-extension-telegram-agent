# Configuration and more bots

Every setting lives in `telegram.config.ts` at the project root; [`telegram.config.example.ts`](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/telegram.config.example.ts) lists every field with comments. Run `bun run restart` (or `/tg restart` in Pi) after editing.

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
4. restart and check it with `/tg attach <id>` in Pi.

Each bot has its own token, personality, session and statistics. They share the group's history and see each other's messages, but never trigger each other.

## When a bot replies

- **Always**: when someone @mentions it, replies to its message, or writes its `name`.
- **Sometimes**: an ordinary message goes to one bot with probability `routing_p` (all bots together may not exceed 1). If the chosen bot is busy or cooling down (`sampling_cooldown_ms`, default 2000), the message is skipped rather than handed to another bot; a chosen bot may still decide to stay quiet.
- `routing_p: 0` only turns off spontaneous replies; mentions still work.
- Messages from bots never trigger other bots.

## Models

- `provider` / `model` can be set at the top level (shared by all bots) or overridden per bot; when you change the provider you must also set `model`. If omitted, Pi's `/model` default is used.
- `reasoning_effort` defaults to `off` and must be a level the model actually supports (Pi `/model` shows them); otherwise startup fails.
- `compaction_model` is a cheap model used to summarize context (`provider/model:effort`). If a summary fails, the old context is kept; it never falls back to the main model.
- For your own gateway or proxy, register it in Pi's `~/.pi/agent/models.json` (`baseUrl`, `api: "openai-completions"`, `apiKey`, and each model's `input`, `contextWindow`, `maxTokens`), confirm it in Pi `/model`, then reference it here. No project change is needed.
- Admins can switch models from the group with `/model` buttons; see [Group commands](operations.md#group-commands).

## Tools

```ts
tools: { send: true, search: false, run_js: false }
```

- `send`: post in the group, send stickers, add reactions. Turn it off for a bot that only watches.
- `search`: search the web or read one public page (TinyFish). Requires `tiny_fish_api_key` in `.env`. Links in the group are not opened automatically, and private network addresses are refused.
- `run_js`: run small JavaScript snippets in a sandbox for exact calculations. The sandbox still has residual risk, so it is off by default.

## Images and videos

`media.mode` decides how bots "see" media:

| Mode | How | Requirement |
|---|---|---|
| `"vision"` (default) | with `vision.enabled: true`, a helper vision model (`auxiliary_visual_model`) describes each image or video as text, shared by all bots | none for the main model |
| `"context"` | images and video frames go straight to the main model without a vision model; at most `media.max_images_per_turn` (default 4) per request | the main model must accept image input |

Voice, audio, ordinary files and TGS animated stickers are text placeholders in both modes. Videos require FFmpeg on the host.

## Limits and defaults

| Field | Default | Purpose |
|---|---|---|
| `context_window` | 65,536 | the most context the main model uses |
| `compaction_threshold` | 32,768 | context beyond this is summarized (at most `context_window − 16,384`) |
| `compaction_keep_recent` | 1 | recent tokens kept verbatim after a summary; 1 keeps only the summary and the last turn, 20,000 is recommended for group chats |
| `max_suffix_tokens` / `max_message_tokens` | 12,000 / 4,096 | caps on new messages per turn and on one message |
| `context_image_budget_bytes` | 10,000,000 | an extra summary is made when images in context exceed this many bytes |
| `provider_timeout_ms` / `provider_retries` | 300,000 / 2 | per-request timeout and automatic retries |
| `cache_retention` | `"short"` | provider prompt cache retention |
| `telemetry_retention_days` etc. | 90 / 30 / 365 | days to keep usage, raw updates and message events |
| `telegram_admins` | empty | who may use admin commands in the group (numeric user id or `@username`) |

Most of these can also be overridden per bot.

After you change the model, personality, tools, media mode or other settings that affect what the model sees, each bot starts a new session on restart (the old session file is kept). This is expected.

Next: [Chat and observe in Pi](using-pi.md).
