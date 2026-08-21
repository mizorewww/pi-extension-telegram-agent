// The single config file for this project (non-secret). Secrets live in .env; this file
// only names the .env keys. Apply changes with `bun run restart`; tuning from the group
// chat (`/set routing_p 0.5`, admin only) writes back into this file.
import { defineConfig } from "./src/config.ts";

export default defineConfig({
	// ===== Required =====

	// Target Telegram supergroup id. Bare, negative, and -100-prefixed forms are accepted.
	group_peer_id: 1234567890,

	// ===== Models (omit to inherit Pi's /login + /model defaults) =====

	provider: "openai-codex",
	model: "gpt-5.6-luna",
	// Thinking level: off / minimal / low / medium / high. Defaults to off.
	reasoning_effort: "off",
	// Provider prefix cache retention: none / short / long. "short" is the cheapest choice.
	cache_retention: "short",
	// Model used for context compaction (provider/model:thinking). Runs rarely; pick a cheap one.
	// If this model's request fails, compaction retries once with the bot's main model.
	compaction_model: "openai-codex/gpt-5.6-luna:low",
	// Vision model for understanding images and sampled video frames. Only called when vision.enabled is true.
	auxiliary_visual_model: "openai-codex/gpt-5.6-luna:low",

	// ===== Local behavior (every field has a default; shown for visibility) =====

	compaction_threshold: 32_768, // effective window is 64K; compact early for underestimated CJK text
	compaction_keep_recent: 20_000, // token budget kept verbatim after compaction (1 token keeps nothing; ~20K ≈ 1-2 turns)
	sampling_cooldown_ms: 2_000, // min interval between two unprompted replies per bot
	max_suffix_tokens: 12_000, // cap on new-message tokens attached per provider call
	max_message_tokens: 4_096, // per-message token cap

	// ===== Files and secret references =====

	db_path: "data/agent.db", // SQLite location
	// .env key for the routing HMAC secret (deterministic probability sampling).
	// Auto-generated and persisted by the daemon when absent; usually no need to set it.
	router_secret_env: "router_secret",
	// .env key for the TinyFish search API key. Required only when a bot enables tools.search.
	tinyfish_key_env: "tiny_fish_api_key",

	// ===== Vision (off by default; bounded when on) =====
	vision: {
		enabled: false,
		foreground_media_limit: 2, // media understood inline per bot turn
		concurrency: 2, // deployment-wide vision work; includes full video pipelines
	},

	// ===== Retention in days (defaults: 90 / 30 / 365) =====
	telemetry_retention_days: 90, // telemetry and cost records
	raw_update_retention_days: 30, // raw Telegram updates
	message_event_retention_days: 365, // message events

	// Admin Telegram usernames (@-prefixed). Only admins may use /compact and /set.
	// Empty means the admin-only group commands are denied for everyone.
	telegram_admins: [],

	// ===== Bots: add one entry per bot; keep routing_p sum <= 1 =====
	bots: [
		{
			// Stable id for Pi commands, sessions, routing, and telemetry. Do not rename later.
			id: "friend",
			// Display name in the group; also the trigger word when addressed by name.
			name: "Mochi",
			// .env holds the token value; this is only the key name.
			token_env: "telegram_bot_token",
			// Persona file. Copy a public template to an ignored local file before personalizing.
			persona_path: "personas/template.en.md",
			// Probability of joining an unaddressed human conversation.
			// Direct replies and name mentions always route regardless of this value.
			routing_p: 0.1,
			// Sticker sets baked into the system prompt; the bot sends them by short_id.
			sticker_sets: [],
			tools: {
				send: true,
				// Enable only after adding tiny_fish_api_key to .env.
				search: false,
				run_js: true,
			},
		},
	],
});
