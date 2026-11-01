// The single config file for this project (non-secret). Secrets live in .env (`key: value`);
// this file only names the .env key of each bot token. Restart the daemon to apply changes;
// admin group commands (`/set`, `/model`) write back into this file. Unknown or misspelled
// fields are rejected at startup.
import { defineConfig } from "./src/config.ts";

export default defineConfig({
	// ===== Required =====

	// Target Telegram supergroup id. Bare, negative, and -100-prefixed forms are accepted.
	group_peer_id: 1234567890,

	// ===== Models (omit provider/model to inherit Pi's /login + /model defaults) =====

	provider: "openai-codex",
	model: "gpt-5.6-luna",
	// Thinking level. Defaults to off; must be a level the model supports (see Pi /model),
	// otherwise startup fails instead of silently using another level.
	reasoning_effort: "off",
	// Provider prompt cache retention: none / short / long.
	cache_retention: "short",
	// Cheap model that summarizes old context (provider/model:thinking). A failed summary keeps
	// the old context; it never falls back to the bot's main model.
	compaction_model: "openai-codex/gpt-5.6-luna:low",

	// ===== Context (every field has a default; shown for visibility) =====

	// Most context the main model uses (also clamps the Pi catalog value).
	context_window: 65_536,
	// Summarize once the context passes this many tokens. Defaults to half of context_window
	// and may be at most context_window - 16_384.
	compaction_threshold: 32_768,
	// Recent tokens kept verbatim after a summary (about 1-2 turns at 20K).
	compaction_keep_recent: 20_000,
	// Pause after a spontaneous reply before the same bot may join in again.
	cooldown_ms: 2_000,
	// Per-attempt provider timeout and extra retries (backoff 10s/20s/40s ...).
	provider_timeout_ms: 300_000,
	provider_retries: 2,
	// Images in context are resent as base64 on every request; past this many bytes an extra
	// summary is made.
	context_image_budget_bytes: 10_000_000,
	max_suffix_tokens: 12_000, // new-message tokens per request
	max_message_tokens: 4_096, // tokens per single message

	// ===== Work box for tools.sandbox (host setup: docs/runbooks/sandbox.md) =====
	// sandbox: { image: "tg-box:2", docker_host: "unix:///run/tgbox/docker.sock", memory: "1g", cpus: 2, pids: 256, network: true },

	// tasks: { workflows: { search: "~/pi-tasks/search" }, max_running: 2, timeout_minutes: 45, memory: "3g", cpus: 2 },

	// ===== Media: how images and videos reach a model =====
	// "off" (default): media are text placeholders such as [photo].
	// "hybrid" (recommended): vision_model describes each new image / video once as text (shared by
	//   all bots), and a view_image tool lets the bot look at one message's actual image when the
	//   description is not enough; the main model must accept image input.
	// Voice, audio, files and TGS animated stickers stay placeholders. Videos need ffmpeg.
	media: {
		mode: "off",
		vision_model: "openai-codex/gpt-5.6-luna:low", // "hybrid" only
		max_per_turn: 2, // new media described per turn (default 2)
		concurrency: 2, // parallel vision calls or downloads / frame extractions
	},

	// ===== Retention in days =====
	telemetry_retention_days: 90, // usage and cost records
	raw_update_retention_days: 30, // raw Telegram updates
	message_event_retention_days: 365, // message events

	// Numeric Telegram user ids allowed to use /model, /new, /compact and /set (usernames can
	// change hands, so they are not accepted). Empty denies those commands to everyone.
	telegram_admins: [],

	// ===== Bots: one entry per bot; routing_p across all bots must total <= 1 =====
	// Any setting in the "Models" and "Context" sections above can also be overridden per bot.
	bots: [
		{
			// Stable id for Pi commands, sessions, routing, and telemetry. Do not rename later.
			id: "friend",
			// Display name in the group; also the trigger word when addressed by name.
			name: "Mochi",
			// .env key holding this bot's token.
			token_env: "telegram_bot_token",
			// Persona file. Copy a public template to an ignored local file before personalizing.
			persona_path: "personas/template.en.md",
			// Chance of joining an unaddressed human message; mentions, replies and the name always route.
			routing_p: 0.1,
			// Sticker sets baked into the system prompt; the bot sends them by short id.
			sticker_sets: [],
			tools: {
				send: true,
				search: false, // needs tiny_fish_api_key in .env
				codemode: false, // Pi-native JavaScript scripts that can call the other tools; off by default
				sandbox: false, // own Linux work box for scripts (needs codemode and the sandbox section)
				tasks: false, // background tasks running a Pi workflow in the box (needs sandbox and tasks)
			},
		},
	],
});
