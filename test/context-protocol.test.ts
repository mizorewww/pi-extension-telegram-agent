// Pure Pi extension and cache-identity contracts from review-260808.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import {
	buildContextFingerprint,
	canResumeContextSession,
	type ContextFingerprintInput,
} from "../src/agent/context-fingerprint.ts";
import {
	configureBotModelRuntime,
	createInstalledPiModelRuntime,
	inspectModelReasoning,
} from "../src/agent/model-runtime.ts";
import {
	NO_SEND_MARKER,
	TELEGRAM_EXTENSION_ORDER,
	applyAssistantPersistencePolicy,
	estimateCacheReadFromPrefix,
	observeProviderPayload,
	projectTelegramContext,
} from "../src/agent/extensions/index.ts";
import { CONTEXT_IMAGE_TOKEN_ESTIMATE } from "../src/agent/token-packer.ts";
import { fitContextBreakdown } from "../src/observability/usage.ts";

function fingerprintInput(): ContextFingerprintInput {
	return {
		piVersion: "0.84.1",
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
	test("loads user-installed provider extensions into the daemon model runtime", async () => {
		const root = mkdtempSync(join(tmpdir(), "tg-provider-extension-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "workspace");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		const extensionPath = join(root, "provider.ts");
		writeFileSync(
			extensionPath,
			`export default function (pi) {
	pi.registerProvider("fixture-provider", {
		name: "Fixture Provider",
		baseUrl: "http://127.0.0.1:1/v1",
		api: "openai-completions",
		apiKey: "fixture-key",
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
		};

		expect(inspectModelReasoning(model, "medium")).toEqual({
			provider: "fixture",
			model: "fixture-reasoning-model",
			requested: "medium",
			effective: "high",
			supported: ["off", "low", "high", "max"],
			valid: false,
		});
		await expect(
			configureBotModelRuntime(
				{
					provider: "fixture",
					model: "fixture-reasoning-model",
					thinkingLevel: "medium",
					purpose: "bot:A",
				},
				runtime,
			),
		).rejects.toMatchObject({
			category: "unsupported_reasoning_effort",
			purpose: "bot:A",
			reasoning: { requested: "medium", effective: "high", supported: ["off", "low", "high", "max"] },
		});
		expect(
			await configureBotModelRuntime(
				{ provider: "fixture", model: "fixture-reasoning-model", thinkingLevel: "high" },
				runtime,
			),
		).toBe(runtime);
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
});
