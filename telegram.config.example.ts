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
	// Non-off levels only take effect when the model is registered with reasoning: true
	// in ~/.pi/agent/models.json — otherwise Pi clamps any level back to off.
	reasoning_effort: "off",
	// Provider prefix cache retention: none / short / long. "short" is the cheapest choice.
	cache_retention: "short",
	// Model used for context compaction (provider/model:thinking). Runs rarely; pick a cheap one.
	// If this model's request fails, compaction retries once with the bot's main model.
	compaction_model: "openai-codex/gpt-5.6-luna:low",
	// Vision model that describes images and sampled video frames for the chat model.
	// Only used in the default media mode ("vision") when vision.enabled is true.
	auxiliary_visual_model: "openai-codex/gpt-5.6-luna:low",

	// ===== Local behavior (every field has a default; shown for visibility) =====

	// Cap on the main model's effective context window (clamps the Pi catalog value).
	// compaction_threshold must stay <= context_window - 16_384 (Pi's response reserve).
	context_window: 65_536,
	compaction_threshold: 32_768, // compact early for underestimated CJK text and context images
	compaction_keep_recent: 20_000, // token budget kept verbatim after compaction (1 token keeps nothing; ~20K ≈ 1-2 turns)
	sampling_cooldown_ms: 2_000, // min interval between two unprompted replies per bot
	// Per-attempt provider call timeout in ms: a wedged upstream (no response head or
	// idle stream) aborts after this budget, then retries with exponential backoff
	// (10s/20s/40s …, capped at 60s) up to `provider_retries` extra attempts. When the
	// budget is exhausted the turn ends with an error instead of pinning the bot busy.
	// Defaults: 300_000 / 2. Bot-level overrides accepted per bot.
	provider_timeout_ms: 300_000,
	provider_retries: 2,
	// Total on-disk bytes of context images that triggers compaction. Images ship as base64
	// and provider billing undercounts them by orders of magnitude, so the text-token
	// threshold alone never fires on a photo-heavy group. Compaction summarizes the
	// history away and prunes the retained image files, keeping the context light.
	// Default: 10_000_000 (~50 resized photos; Gemini 3 bills a fixed ~532 tokens per
	// image at medium quality, so 50 images are only ~27K billed tokens — the binding
	// constraint is transport bytes, not billing).
	context_image_budget_bytes: 10_000_000,
	max_suffix_tokens: 12_000, // cap on new-message tokens attached per provider call
	max_message_tokens: 4_096, // per-message token cap

	// ===== Files and secret references =====

	db_path: "data/agent.db", // SQLite location
	// .env key for the routing HMAC secret (deterministic probability sampling).
	// Auto-generated and persisted by the daemon when absent; usually no need to set it.
	router_secret_env: "router_secret",
	// .env key for the TinyFish search API key. Required only when a bot enables tools.search.
	tinyfish_key_env: "tiny_fish_api_key",

	// ===== Media handling: how images/videos reach a model =====
	// mode "vision" (default): the auxiliary visual model describes each media item and the chat
	//   model reads the text description. Works with any chat model; costs one extra model call
	//   per new media item (cached per file, shared by all bots).
	// mode "context": photos and static stickers are attached to the chat model directly as
	//   images (~1.1K tokens each); videos (incl. video stickers and GIF animations) are sampled
	//   into 1-3 frames. No vision-model call is made. The chat model must accept image input
	//   (checked at startup). voice / audio / document / TGS animated stickers stay text
	//   placeholders in both modes.
	media: {
		mode: "vision", // "vision" (default) | "context" (main model must support image input)
		max_images_per_turn: 4, // context mode: images attached per provider call
		download_concurrency: 2, // context mode: parallel media downloads / frame extractions
	},

	// ===== Vision mode only (off by default; bounded when on) =====
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
