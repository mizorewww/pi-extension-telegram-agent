# Configuration and additional bots

`/tg config` is the recommended entry point. To add bots or tune advanced fields, edit the ignored `telegram.config.ts`, then run `bun run restart` or `/tg restart` in Pi.

## File boundaries

| File | Contents | Commit it? |
| --- | --- | --- |
| `telegram.config.ts` | Group, bots, Pi model selection, routing, cost bounds, tools | No |
| `.env` | Telegram/TinyFish tokens and router secret | No |
| `personas/*.local.md` | Real deployment personas | No |
| `telegram.config.example.ts` | Public typed schema example | Yes |
| `personas/template.*.md` | Public generic persona templates | Yes |

`.env` uses the project's colon format, not dotenv equals syntax:

```text
telegram_bot_token: 123456:REPLACE_WITH_BOTFATHER_TOKEN
router_secret: REPLACE_WITH_RANDOM_LOCAL_SECRET
```

## Cost-first one-bot configuration

```ts
import { defineConfig } from "./src/config.ts";

export default defineConfig({
  group_peer_id: 1234567890,
  provider: "openai-codex",
  model: "gpt-5.6-luna",
  reasoning_effort: "off",
  cache_retention: "short",
  compaction_model: "openai-codex/gpt-5.6-luna:low",
  max_suffix_tokens: 12_000,
  max_message_tokens: 4_096,
  vision: {
    enabled: false,
    foreground_media_limit: 2,
    concurrency: 2,
  },
  telemetry_retention_days: 90,
  raw_update_retention_days: 30,
  message_event_retention_days: 365,
  bots: [{
    id: "friend",
    name: "Mochi",
    token_env: "telegram_bot_token",
    persona_path: "personas/friend.local.md",
    routing_p: 0.1,
    sticker_sets: [],
    tools: { send: true, search: false, run_js: false },
  }],
});
```

See the repository's `telegram.config.example.ts` for annotated advanced defaults. TypeScript config is trusted local code. Edit only configuration you maintain; do not execute unreviewed snippets.

## Add a second or third bot

1. Add a distinct token key to `.env`.
2. Copy a public template to a new ignored persona.
3. Append an object to `bots`; `id` must be unique and contain only letters, numbers, `_`, or `-`.
4. Perform a controlled restart, then verify with `/tg attach <id>` and `/tg status <id>`.

```ts
{
  id: "helper",
  name: "Nori",
  token_env: "helper_bot_token",
  persona_path: "personas/helper.local.md",
  routing_p: 0,
  tools: { send: true, search: false, run_js: false },
}
```

`routing_p: 0` disables only probability sampling. Mentions, direct replies, and the configured name remain explicit triggers. The sum of every bot's `routing_p` must be `<= 1`, and configuration order defines deterministic probability-bucket order.

Each bot has an isolated Telegram poller, agent session, model selection, state, and telemetry. Bots share one Pi model runtime/auth snapshot plus the target group and canonical SQLite history.

## Pi model and tool overrides

The public example pins an explicit cost-first profile: Luna, reasoning off, short cache retention, and Luna low for compaction. The wizard pins the provider/model that it already preflighted through Pi, so a later Pi default change cannot silently change this deployment. Existing hand-written configuration may still omit those two fields for compatibility and inherit Pi's merged defaults, but omitted `reasoning_effort` means `off` rather than inheriting Pi's thinking level. The daemon uses Pi's native resource loader for user-installed provider extensions, so plugin model capabilities and cost metadata match interactive Pi; project extensions do not enter bot sessions. A per-bot override may select another catalog entry; switching provider requires both provider and model. Authentication always comes from Pi, never this configuration or `.env`.

`reasoning_effort` must be both a valid Pi-wide enum and a level supported by the selected model. Pi's SDK silently clamps unsupported values to a nearby level; to prevent cost, behavior, and status from disagreeing, Telegram agent refuses to start before any Telegram/provider call and reports the requested and supported values. The same check covers main bots, `compaction_model`, and an enabled vision model. Use Pi `/model` to inspect selectable levels; for example, `deepseek-v4-flash` accepts only `off`, `high`, and `max`.

If the `compaction_model` request fails with a provider error, compaction retries once with the bot's main model and logs `compaction_fallback`, so an unavailable compaction model cannot permanently wedge an overflowed session; intentional aborts (e.g. daemon shutdown) are not retried.

These controls are bounded by default:

- `max_suffix_tokens: 12000` and `max_message_tokens: 4096` cap new provider-visible Telegram context;
- `cache_retention: "short"` controls the main chat request, while compaction always uses its configured cheap task model with provider cache retention disabled;
- `vision.enabled` is false by default. When enabled, each turn handles at most `foreground_media_limit` uncached media items and all bots share one FIFO gate with `concurrency` active jobs. A video occupies one slot from Telegram download through frame extraction and its provider request. Video understanding requires `ffmpeg` and `ffprobe` on the daemon host PATH; missing tools skip before download and consume no provider tokens, produce an operator-only installation hint, and do not affect daemon readiness, chat, images, or sticker sending;
- telemetry, raw updates, and immutable message events default to 90, 30, and 365 days. Old message events are pruned only after every known bot cursor consumed them and no direct-reply obligation references them.

Changing model, reasoning, cache policy, persona, tools, serializer, or another cache-visible field produces a new context fingerprint. The next controlled restart preserves the old session file but starts a new session before restoration, so stale context is never resumed under a new identity.

`tools` controls:

- `send`: Markdown text converted locally to Telegram message entities, plus static, animated, and video sticker delivery; ordinary prose keeps ordinary weight;
- `search`: enables bounded TinyFish search and single-page retrieval through one tool; it requires the TinyFish key selected by `tinyfish_key_env` in `.env`;
- `run_js`: constrained deterministic computation; it is off by default because model-provided JavaScript still has a residual sandbox risk.

Search and `run_js` are disabled unless their fields are explicitly `true`; there is no legacy default. Before enabling search, add the TinyFish credential to `.env` (the default key name is `tiny_fish_api_key`); it is unrelated to Pi model authentication. Once enabled, the agent can search explicitly or read one public HTTP(S) page when an answer needs its contents. It never eagerly fetches every group link and does not support authenticated, private, or local targets.

## Routing and administrative commands

- Mention > reply > configured name > probability. Bot messages never trigger bot-to-bot runs.
- `routing_p` controls a normal human message's **response opportunity**, not a quota for final group posts. Each eligible message produces one deterministic value and enters at most one cumulative bucket. When the sum is 1, every eligible message has exactly one probability target.
- `sampling_cooldown_ms` applies only to probability routing; it defaults to 2000, and 0 disables cooldown.
- A busy or cooling probability target is skipped without reassignment. Mentions, replies, and configured names use the explicit path. Even after a run starts, the persona may remain silent and delivery may fail, so public-message ratios need not equal `routing_p`.
- Empty `telegram_admins` denies Telegram `compact`/`set`. When needed, prefer your own positive numeric user ID; never copy a placeholder ID.
- Telegram `/set <routing_p|cooldown_ms> <value>` writes through to `telegram.config.ts` (atomic write plus full validation; any failure rolls the file back). The in-memory effective value updates immediately and survives restarts.

Use `bun run debug` for read-only deployment diagnostics (see [Operations](operations.md) and [Troubleshooting](troubleshooting.md)).

## Multiple groups

One deployment has one `group_peer_id`. Multiple groups require isolated working directories and data/session/database/PID/socket resources. Do not run a second group in one checkout by only switching configuration files.

Next: [Chat and observe in Pi](using-pi.md).
