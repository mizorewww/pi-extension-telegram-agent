// Pure Pi extension and cache-identity contracts from review-260808.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	findCutPoint,
	SessionManager,
	sessionEntryToContextMessages,
	type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import {
	buildContextFingerprint,
	canResumeContextSession,
	type ContextFingerprintInput,
} from "../src/agent/context-fingerprint.ts";
import {
	assertBotModelConfigured,
	createInstalledPiModelRuntime,
	inspectModelReasoning,
} from "../src/agent/model-runtime.ts";
import {
	NO_SEND_MARKER,
	TELEGRAM_EXTENSION_ORDER,
	applyAssistantPersistencePolicy,
	contextImageBytes,
	estimateCacheReadFromPrefix,
	compactionTextBudget,
	observeProviderPayload,
	projectTelegramContext,
} from "../src/agent/extensions/index.ts";
import { CONTEXT_IMAGE_TOKEN_ESTIMATE } from "../src/agent/token-packer.ts";
import { fitContextBreakdown } from "../src/observability/usage.ts";
import { inspectProviderContext } from "../src/observability/provider-context.ts";
import { setSessionManifest } from "../src/db/message-events.ts";
import { readFileSync } from "node:fs";
import type { DebugDeploymentIdentity } from "../src/config.ts";

function fingerprintInput(): ContextFingerprintInput {
	return {
		piVersion: "0.86.0",
		provider: "openai-codex",
		api: "responses",
		model: "gpt-5.6-luna",
		contextWindow: 65_536,
		reasoningEffort: "off",
		cacheRetention: "short",
		cacheSchemaVersion: 8,
		commonPromptSha256: "common",
		personaSha256: "persona-a",
		serializerVersion: 2,
		compactionPromptSha256: "compact",
		compactionModel: "openai-codex/gpt-5.6-luna:low",
		stickerCatalogSnapshotSha256: "catalog",
		mediaMode: "vision",
		extensionOrder: TELEGRAM_EXTENSION_ORDER,
		tools: [
			{ name: "send", description: "send", parameters: { type: "object" } },
			{ name: "search", description: "search", parameters: { type: "object" } },
		],
	};
}

describe("Pi context protocol", () => {
	test("provider inspection reports image availability without bytes and ignores summary model metadata", () => {
		const root = mkdtempSync(join(tmpdir(), "tg-inspect-context-"));
		const db = new Database(":memory:");
		db.exec(readFileSync("src/db/schema.sql", "utf8"));
		mkdirSync(join(root, "media"));
		writeFileSync(join(root, "media", "present.png"), "image-bytes-canary");
		writeFileSync(join(root, "persona.md"), "persona-canary");
		const manager = SessionManager.create(root, join(root, "sessions", "A"));
		manager.appendCustomMessageEntry("telegram_context_v2", "body-canary", false, {
			version: 4,
			consumedSeq: 1,
			providerText: "body-canary",
			visibleMessageIds: [1],
			events: [],
			stickerCandidates: "",
			blocks: [
				{ type: "text", text: "body-canary" },
				...["present.png", "missing.png"].map((name) => ({ type: "image", name, mime: "image/png" })),
			],
		});
		manager.appendMessage({
			role: "assistant",
			content: [],
			api: "openai-completions",
			provider: "chat",
			model: "chat",
			usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { total: 0 } },
			stopReason: "stop",
			timestamp: 1,
		} as never);
		setSessionManifest(db, {
			botId: "A",
			sessionId: manager.getSessionId(),
			sessionFile: manager.getSessionFile()!,
			contextFingerprint: "fixture",
			createdAt: 1,
		});
		db.query(
			`INSERT INTO llm_runs (bot_id, ts, model, epoch, api, tools_hash, compaction) VALUES ('A', 1, 'chat', 1, 'chat-api', 'chat-tools', 0), ('A', 2, 'summary', 2, 'summary-api', '', 1)`,
		).run();
		const deployment = {
			dataDir: root,
			bots: [
				{
					id: "A",
					personaPath: join(root, "persona.md"),
					provider: "chat",
					model: "chat",
					tools: { send: true, search: false, runJs: false },
					stickerSets: [],
					cacheRetention: "short",
				},
			],
		} as unknown as DebugDeploymentIdentity;
		try {
			const report = inspectProviderContext(db, deployment, "A");
			expect(report.images).toMatchObject({ referenced: 2, available: 1, missing: 1 });
			expect(report.messages[0]?.content_types).toEqual(["text", "image"]);
			expect(report.request_metadata).toMatchObject({ api: "chat-api", last_observed_tools_hash: "chat-tools" });
			for (const canary of ["image-bytes-canary", "body-canary", "persona-canary", "present.png"])
				expect(JSON.stringify(report)).not.toContain(canary);
		} finally {
			db.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
	test("loads user-installed providers and executes their normalized transcript stream", async () => {
		const root = mkdtempSync(join(tmpdir(), "tg-provider-extension-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "workspace");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		const extensionPath = join(root, "provider.ts");
		writeFileSync(
			extensionPath,
			`import { collapseSystemMessages, getCurrentSystemPrompt, getCurrentTools, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
export default function (pi) {
	pi.registerProvider("fixture-provider", {
		name: "Fixture Provider",
		baseUrl: "http://127.0.0.1:1/v1",
		api: "fixture-transcript-api",
		apiKey: "fixture-key",
		streamSimple(model, context) {
			const transcript = collapseSystemMessages(context);
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "done", reason: "stop", message: {
				role: "assistant", api: model.api, provider: model.provider, model: model.id,
				content: [{ type: "text", text: JSON.stringify({
					prompt: getCurrentSystemPrompt(transcript.messages),
					tools: getCurrentTools(transcript.messages).map(tool => tool.name),
					lastRole: transcript.messages.at(-1)?.role
				}) }],
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop", timestamp: 1
			} });
			return stream;
		},
		models: [{
			id: "fixture-model",
			name: "Fixture Model",
			reasoning: false,
			input: ["text"],
			contextWindow: 4096,
			maxTokens: 1024,
			cost: { input: 1.25, output: 2.5, cacheRead: 0.25, cacheWrite: 0 }
		}]
	});
}\n`,
		);
		writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({ extensions: [extensionPath] })}\n`);

		try {
			const runtime = await createInstalledPiModelRuntime({ cwd, agentDir });
			const model = runtime.getModel("fixture-provider", "fixture-model");
			expect(model?.cost).toEqual({ input: 1.25, output: 2.5, cacheRead: 0.25, cacheWrite: 0 });
			expect(runtime.hasConfiguredAuth("fixture-provider")).toBe(true);
			const result = await runtime.completeSimple(model!, {
				systemPrompt: "fixture system",
				tools: [
					{ name: "fixture-tool", description: "Fixture", parameters: { type: "object", properties: {} } as any },
				],
				messages: [{ role: "user", content: "fixture user", timestamp: 1 }],
			});
			expect(result.stopReason).toBe("stop");
			expect(result.content).toEqual([
				{
					type: "text",
					text: JSON.stringify({
						prompt: "fixture system",
						tools: ["fixture-tool"],
						lastRole: "user",
					}),
				},
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects a model-specific reasoning level that Pi would silently clamp", async () => {
		// Fixture model keeps this test hermetic: reasoning capabilities must not depend on the
		// ambient Pi catalog in ~/.pi, which is absent on CI runners. supported levels are a pure
		// function of reasoning + thinkingLevelMap (pi-ai getSupportedThinkingLevels).
		const model: Model<"openai-completions"> = {
			id: "fixture-reasoning-model",
			name: "Fixture Reasoning Model",
			api: "openai-completions",
			provider: "fixture",
			baseUrl: "http://127.0.0.1:1/v1",
			reasoning: true,
			thinkingLevelMap: { minimal: null, medium: null, max: "max" },
			input: ["text"],
			cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		};
		const runtime = {
			getModel: (provider: string, modelId: string) =>
				provider === "fixture" && modelId === "fixture-reasoning-model" ? model : undefined,
			hasConfiguredAuth: () => true,
			getProviderAuthStatus: () => ({ configured: true, source: "test" }),
		} as unknown as ModelRuntime;

		expect(inspectModelReasoning(model, "medium")).toEqual({
			provider: "fixture",
			model: "fixture-reasoning-model",
			requested: "medium",
			effective: "high",
			supported: ["off", "low", "high", "max"],
			valid: false,
		});
		let rejected: unknown;
		try {
			assertBotModelConfigured(
				{ provider: "fixture", model: "fixture-reasoning-model", thinkingLevel: "medium", purpose: "bot:A" },
				runtime,
			);
		} catch (error) {
			rejected = error;
		}
		expect(rejected).toMatchObject({
			category: "unsupported_reasoning_effort",
			purpose: "bot:A",
			reasoning: { requested: "medium", effective: "high", supported: ["off", "low", "high", "max"] },
		});
		expect(() =>
			assertBotModelConfigured(
				{ provider: "fixture", model: "fixture-reasoning-model", thinkingLevel: "high" },
				runtime,
			),
		).not.toThrow();
	});

	test("fingerprint changes and missing files prevent session resume", () => {
		const original = buildContextFingerprint(fingerprintInput());
		const changed = buildContextFingerprint({ ...fingerprintInput(), personaSha256: "persona-b" });
		const manifest = { contextFingerprint: original, sessionFile: "/retained/session.jsonl" };

		expect(canResumeContextSession(manifest, original, true)).toBe(true);
		expect(canResumeContextSession(manifest, changed, true)).toBe(false);
		expect(canResumeContextSession(manifest, original, false)).toBe(false);
	});

	test("tool and extension order participate in the context fingerprint", () => {
		const input = fingerprintInput();
		expect(buildContextFingerprint({ ...input, tools: [...input.tools].reverse() })).not.toBe(
			buildContextFingerprint(input),
		);
		expect(buildContextFingerprint({ ...input, extensionOrder: [...input.extensionOrder].reverse() })).not.toBe(
			buildContextFingerprint(input),
		);
	});

	test("media mode participates in the context fingerprint", () => {
		// Switching media.mode changes placeholder semantics, so a resumed session must not
		// inherit the other mode's context.
		const input = fingerprintInput();
		expect(buildContextFingerprint({ ...input, mediaMode: "context" })).not.toBe(buildContextFingerprint(input));
	});

	test("provider payload observations are deterministic and redact content", () => {
		const first = observeProviderPayload(
			{
				model: "m",
				tools: [{ name: "send", parameters: { b: 2, a: 1 } }],
				messages: [
					{ role: "system", content: "protocol" },
					{ role: "user", content: "hello" },
				],
			},
			"local-hmac-key",
		);
		const reordered = observeProviderPayload(
			{
				messages: [
					{ content: "protocol", role: "system" },
					{ content: "hello", role: "user" },
				],
				tools: [{ parameters: { a: 1, b: 2 }, name: "send" }],
				model: "m",
			},
			"local-hmac-key",
			first,
		);
		const changed = observeProviderPayload(
			{
				model: "m",
				tools: [{ name: "send", parameters: { a: 1, b: 2 } }],
				messages: [
					{ role: "system", content: "protocol" },
					{ role: "user", content: "changed" },
				],
			},
			"local-hmac-key",
			reordered,
		);

		expect(reordered.fullPayloadHash).toBe(first.fullPayloadHash);
		expect(reordered.firstDivergentSegment).toBeNull();
		expect(changed.firstDivergentSegment).toBe("messages");
		expect(changed.firstDivergentMessageIndex).toBe(0);
		expect(changed.firstDivergentByteOffset).toBeGreaterThan(0);
		expect(JSON.stringify(changed)).not.toContain("changed");
	});

	test("image content parts are charged a flat estimate, never their base64 byte size", () => {
		// Regression: context-mode payloads carry data-URL images; counting raw base64 bytes
		// inflated the messages estimate ~1000x and fitContextBreakdown then scaled the
		// system/tools breakdown to zero (Status panel showed both as gone).
		const base64 = "A".repeat(400_000);
		const observation = observeProviderPayload(
			{
				model: "m",
				tools: [{ name: "send", parameters: { type: "object" } }],
				messages: [
					{ role: "system", content: "protocol" },
					{
						role: "user",
						content: [
							{ type: "text", text: "[图片]" },
							{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64}` } },
						],
					},
				],
			},
			"local-hmac-key",
		);
		expect(observation.tokenEstimate.messages).toBeLessThan(CONTEXT_IMAGE_TOKEN_ESTIMATE + 64);
		expect(observation.tokenEstimate.messages).toBeGreaterThanOrEqual(CONTEXT_IMAGE_TOKEN_ESTIMATE);
		// The scaled breakdown must keep system/tools visible next to an image-bearing turn.
		const fitted = fitContextBreakdown(observation.tokenEstimate, 20_000);
		expect(fitted.system).toBeGreaterThan(0);
		expect(fitted.messages).toBeGreaterThan(fitted.system);

		// Anthropic messages API serializes images as image + base64 source parts.
		const anthropic = observeProviderPayload(
			{
				model: "m",
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: "[图片]" },
							{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64 } },
						],
					},
				],
			},
			"local-hmac-key",
		);
		expect(anthropic.tokenEstimate.messages).toBeLessThan(CONTEXT_IMAGE_TOKEN_ESTIMATE + 64);
		expect(anthropic.tokenEstimate.messages).toBeGreaterThanOrEqual(CONTEXT_IMAGE_TOKEN_ESTIMATE);
	});

	test("a developer-role system prompt is attributed to the system segment", () => {
		// Regression: Pi's chat-completions adapter sends the system prompt as role "developer"
		// for reasoning models. Production status then showed system=0 and every prefix token
		// under "messages", and the system hash never distinguished prompt changes.
		const payload = (role: string) => ({
			model: "m",
			tools: [{ name: "send", parameters: { type: "object" } }],
			messages: [
				{ role, content: "protocol ".repeat(200) },
				{ role: "user", content: "hello" },
			],
		});
		const system = observeProviderPayload(payload("system"), "local-hmac-key");
		const developer = observeProviderPayload(payload("developer"), "local-hmac-key");
		// The role literal itself differs by a few bytes; attribution must not.
		expect(Math.abs(developer.tokenEstimate.system - system.tokenEstimate.system)).toBeLessThan(4);
		expect(developer.tokenEstimate.messages).toBe(system.tokenEstimate.messages);
		expect(developer.messageHashes).toHaveLength(1);
		expect(developer.tokenEstimate.system).toBeGreaterThan(developer.tokenEstimate.messages);
	});

	test("compaction cut charges context images so keepRecentTokens bounds the retained window", () => {
		// Regression: images live in custom-message details and are only materialized at
		// projection, so Pi's chars/4 cut point counted them as zero and retained an unbounded
		// image tail; production compacted after nearly every turn without shrinking.
		const manager = SessionManager.inMemory("/tmp/unused");
		const contextEntry = (text: string, images: number) =>
			manager.appendCustomMessageEntry("telegram_context_v2", text, false, {
				version: 4,
				consumedSeq: 1,
				providerText: text,
				blocks: [
					{ type: "text", text },
					...Array.from({ length: images }, (_, index) => ({
						type: "image",
						name: `img-${index}.jpg`,
						mime: "image/jpeg",
					})),
				],
				stickerCandidates: "",
				visibleMessageIds: [1],
				events: [],
			});
		const reply = () =>
			manager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				api: "openai-completions",
				provider: "test",
				model: "test",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
				stopReason: "stop",
				timestamp: 1,
			} as never);
		contextEntry("old text ".repeat(50), 0);
		reply();
		const firstImageBatch = contextEntry("photo album", 8);
		reply();
		contextEntry("more photos", 8);
		reply();
		const latest = contextEntry("latest", 0);
		reply();
		const entries = manager.getBranch();
		// Pi's own cut keeps the whole tail: text alone is far below 20k estimated tokens.
		const piCut = findCutPoint(entries, 0, entries.length, 20_000);
		expect(entries[piCut.firstKeptEntryIndex]!.id).toBe(entries[0]!.id);
		// 16 images ≈ 17.6k charged tokens plus text: still under 20k, so Pi's cut stands.
		expect(compactionTextBudget(entries, 20_000)).toBe(20_000);
		const budget = compactionTextBudget(entries, 6_000);
		expect(budget).toBeLessThan(6_000);
		const cut = findCutPoint(entries, 0, entries.length, budget);
		// ~5 images fit; the cut moves past the first album and the discarded turns are summarized.
		const keptIndex = cut.firstKeptEntryIndex;
		expect(keptIndex).toBeGreaterThan(entries.findIndex((entry) => entry.id === firstImageBatch));
		expect(keptIndex).toBeLessThanOrEqual(entries.findIndex((entry) => entry.id === latest));
		const summarized = entries.slice(0, keptIndex).flatMap(sessionEntryToContextMessages);
		expect(summarized.length).toBeGreaterThanOrEqual(3);
		expect(JSON.stringify(summarized)).toContain("old text");
		expect(JSON.stringify(summarized)).toContain("photo album");
		// Never earlier than Pi's cut, and the summary covers every discarded entry once.
		expect(keptIndex).toBeGreaterThanOrEqual(piCut.firstKeptEntryIndex);
		expect(summarized.length).toBe(
			entries.slice(0, keptIndex).filter((entry) => entry.type === "message" || entry.type === "custom_message").length,
		);
	});

	test("estimates cache reuse only for an exact observed payload prefix", () => {
		const first = observeProviderPayload(
			{
				model: "m",
				tools: [{ name: "send", parameters: { type: "object" } }],
				messages: [
					{ role: "system", content: "protocol" },
					{ role: "user", content: "hello" },
				],
			},
			"local-hmac-key",
		);
		const appended = observeProviderPayload(
			{
				model: "m",
				tools: [{ name: "send", parameters: { type: "object" } }],
				messages: [
					{ role: "system", content: "protocol" },
					{ role: "user", content: "hello" },
					{ role: "assistant", content: "hi" },
				],
			},
			"local-hmac-key",
			first,
		);
		const rewritten = observeProviderPayload(
			{
				model: "m",
				tools: [{ name: "send", parameters: { type: "object" } }],
				messages: [
					{ role: "system", content: "protocol" },
					{ role: "user", content: "changed" },
				],
			},
			"local-hmac-key",
			appended,
		);

		expect(
			estimateCacheReadFromPrefix(
				appended,
				{
					systemHash: first.systemHash,
					toolsHash: first.toolsHash,
					messageHashes: first.messageHashes,
					contextTokens: 70_820,
				},
				71_354,
			),
		).toBe(70_820);
		expect(
			estimateCacheReadFromPrefix(
				rewritten,
				{
					systemHash: appended.systemHash,
					toolsHash: appended.toolsHash,
					messageHashes: appended.messageHashes,
					contextTokens: 71_354,
				},
				72_000,
			),
		).toBeNull();
		expect(
			estimateCacheReadFromPrefix(
				appended,
				{
					systemHash: first.systemHash,
					toolsHash: first.toolsHash,
					messageHashes: first.messageHashes,
					contextTokens: 80_000,
				},
				71_354,
			),
		).toBeNull();
	});

	test("structured Telegram entries project without parsing their display text", () => {
		const projected = projectTelegramContext([
			{
				role: "custom",
				customType: "telegram_context_v2",
				content: "stale-display",
				display: false,
				details: {
					version: 4,
					consumedSeq: 9,
					providerText: "canonical-provider-text",
					blocks: [{ type: "text", text: "canonical-provider-text" }],
					stickerCandidates: "candidate",
					visibleMessageIds: [42],
					events: [{ ingestSeq: 9, kind: "message", chatId: -1001, messageId: 42, fullMessageVisible: true }],
				},
				timestamp: 1,
			},
			{
				role: "custom",
				customType: "telegram_context_v2",
				content: "stale-display-2",
				display: false,
				details: {
					version: 4,
					consumedSeq: 10,
					providerText: "newest-provider-text",
					blocks: [{ type: "text", text: "newest-provider-text" }],
					stickerCandidates: "newest-candidate",
					visibleMessageIds: [43],
					events: [{ ingestSeq: 10, kind: "message", chatId: -1001, messageId: 43, fullMessageVisible: true }],
				},
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "send",
				content: [{ type: "text", text: "ok" }],
				details: { sent: [100, 101] },
				isError: false,
				timestamp: 3,
			},
		] as never);

		expect((projected[0] as { content: string }).content).toBe("canonical-provider-text");
		// Regression lock: the candidate tail is projection-only and only ever rides the LAST
		// context message. Older messages must not carry it, and persisted content stays clean
		// (runtime persists packed.text; compaction reads persisted bytes directly).
		expect((projected[0] as { content: string }).content).not.toContain("candidate");
		expect((projected[1] as { content: string }).content).toBe("newest-provider-text\n\nnewest-candidate");
		expect(JSON.stringify(projected[2])).toContain("sent_message_ids=#100,#101");
	});

	test("v4 details project interleaved image blocks through the resolver", () => {
		const entry = {
			role: "custom",
			customType: "telegram_context_v2",
			content: "stale-display",
			display: false,
			details: {
				version: 4,
				consumedSeq: 11,
				providerText: "before\n[图片]\nafter",
				blocks: [
					{ type: "text", text: "before\n[图片]" },
					{ type: "image", name: "abc.png", mime: "image/png" },
					{ type: "image", name: "missing.jpg", mime: "image/jpeg" },
					{ type: "text", text: "after" },
				],
				stickerCandidates: "cand",
				visibleMessageIds: [44],
				events: [{ ingestSeq: 11, kind: "message", chatId: -1001, messageId: 44, fullMessageVisible: true }],
			},
			timestamp: 1,
		} as never;
		// Without a resolver the projection stays the historical exact string.
		const plain = projectTelegramContext([entry]);
		expect((plain[0] as { content: string }).content).toBe("before\n[图片]\nafter\n\ncand");
		// With a resolver, images materialize as content blocks; unresolvable refs drop out.
		const projected = projectTelegramContext([entry], (ref) =>
			ref.name === "abc.png" ? { type: "image", data: "Zm9v", mimeType: ref.mime } : null,
		);
		expect((projected[0] as { content: unknown[] }).content).toEqual([
			{ type: "text", text: "before\n[图片]" },
			{ type: "image", data: "Zm9v", mimeType: "image/png" },
			{ type: "text", text: "after\n\ncand" },
		]);
	});

	test("unpublished assistant prose is absent from the next context", () => {
		let unpublished = "";
		let displayed: unknown = null;
		const result = applyAssistantPersistencePolicy(
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "real chain of thought" },
					{ type: "text", text: "private draft that was never sent" },
				],
			} as never,
			(text) => {
				unpublished = text;
			},
			(message) => {
				displayed = message.content;
			},
		);

		expect(unpublished).toBe("private draft that was never sent");
		expect(displayed).toEqual([
			{ type: "thinking", thinking: "real chain of thought" },
			{ type: "text", text: "private draft that was never sent" },
		]);
		expect((result as { content: unknown }).content).toEqual([{ type: "text", text: NO_SEND_MARKER }]);
		expect(JSON.stringify(result)).not.toContain("private draft");
	});

	test("contextImageBytes sums on-disk bytes of referenced images only", () => {
		const root = mkdtempSync(join(tmpdir(), "tg-ctx-bytes-"));
		try {
			writeFileSync(join(root, "a.jpg"), new Uint8Array(1000));
			writeFileSync(join(root, "b.jpg"), new Uint8Array(2000));
			const manager = SessionManager.inMemory(root);
			const entry = (consumedSeq: number, imageNames: string[]) =>
				manager.appendCustomMessageEntry("telegram_context_v2", "text", false, {
					version: 4,
					consumedSeq,
					providerText: "text",
					blocks: [
						{ type: "text", text: "text" },
						...imageNames.map((name) => ({ type: "image", name, mime: "image/jpeg" })),
					],
					stickerCandidates: "",
					visibleMessageIds: [consumedSeq],
					events: [],
				});
			entry(1, ["a.jpg", "missing.jpg"]);
			entry(2, ["b.jpg"]);
			const entries = manager.buildContextEntries();
			expect(contextImageBytes(entries, root)).toBe(3000);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
