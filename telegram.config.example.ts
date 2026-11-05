// /etc/pi-telegram-agent/telegram.config.ts (or TG_CONFIG_DIR). Secrets live beside it in .env (`key: value`);
// this file only names the .env key of the bot token. Restart the daemon to apply changes;
// the admin group command `/model` writes back into this file. Unknown or misspelled
// fields are rejected at startup.
// Relative persona and workflow paths are relative to this configuration directory.
// No imports from the installed program are needed; startup validates every field.
export default {
	// ===== Required =====

	// Target Telegram supergroup id. Bare, negative, and -100-prefixed forms are accepted.
	group_peer_id: 1234567890,
	// Display name in the group; also the trigger word when addressed by name.
	name: "Mochi",
	// .env key holding the bot token.
	token_env: "telegram_bot_token",
	// Persona file. Copy a public template to an ignored local file before personalizing.
	persona_path: "personas/template.en.md",

	// ===== Joining in =====
	// Mentions, replies and the name from a human always get a reply. Every other message (other
	// bots included) is judged by this Pi classifier model, which needs Pi auth for its provider;
	// without a decider every message gets a turn. A higher threshold makes the bot quieter.
	// decider: { model: "openrouter/perplexity/pplx-decider-v1.2", threshold: 0.45 },

	// ===== Models (omit provider/model to inherit Pi's /login + /model defaults) =====

	provider: "openai-codex",
	model: "gpt-5.6-luna",
	// Thinking level. Defaults to off; must be a level the model supports (see Pi /model),
	// otherwise startup fails instead of silently using another level.
	reasoning_effort: "off",
	// Provider prompt cache retention: none / short / long.
	cache_retention: "short",

	// ===== Context (every field has a default; shown for visibility) =====

	// Most context the main model uses (also clamps the Pi catalog value).
	context_window: 65_536,
	// Summarize once the context passes this many tokens. Defaults to half of context_window
	// and may be at most context_window - 16_384.
	compaction_threshold: 32_768,
	// Recent tokens kept verbatim after a summary (about 1-2 turns at 20K).
	compaction_keep_recent: 20_000,
	// Quiet time after a turn before unaddressed messages are judged again.
	cooldown_ms: 2_000,
	// Per-attempt provider timeout and extra retries (backoff 10s/20s/40s ...).
	provider_timeout_ms: 300_000,
	provider_retries: 2,

	// ===== Work box for tools.sandbox (host setup: README.md) =====
	// sandbox: { image: "tg-box:4", docker_host: "unix:///run/tgbox/docker.sock", memory: "1g", cpus: 2, pids: 256, network: true },

	// Each workflow directory contains AGENTS.md instructions for a native Pi child conversation.
	// tasks: { workflows: { search: "~/pi-tasks/search" }, max_running: 2, timeout_minutes: 45 },

	// ===== Media: how images and videos reach a model =====
	// "off" (default): media are text placeholders such as [photo].
	// "hybrid" (recommended): vision_model describes each new image / video once as text (shared by
	//   the deployment), and a view_image tool lets the bot look at one message's actual image when the
	//   description is not enough; the main model must accept image input.
	// Voice, audio, files and TGS animated stickers stay placeholders. Videos need ffmpeg.
	media: {
		mode: "off",
		vision_model: "openai-codex/gpt-5.6-luna:low", // "hybrid" only
		max_per_turn: 2, // new media described per turn (default 2)
		concurrency: 2, // parallel vision calls or downloads / frame extractions
	},

	// ===== Retention in days =====
	raw_update_retention_days: 30, // raw Telegram updates
	message_event_retention_days: 365, // message events

	// Numeric Telegram user ids allowed to use /model, /new, /compact and /box (usernames can
	// change hands, so they are not accepted). Empty denies those commands to everyone.
	telegram_admins: [],

	// Sticker sets baked into the system prompt; the bot sends them by short id.
	sticker_sets: [],
	tools: {
		send: true,
		search: false, // needs tiny_fish_api_key in .env
		codemode: false, // Pi-native JavaScript scripts that can call the other tools; off by default
		sandbox: false, // native Pi file/shell tools in a Linux work box (needs sandbox section)
		tasks: false, // native Pi background tasks using the work box (needs sandbox and tasks)
	},
};
