// Cross-bot media acquisition and Pi attach presentation invariants.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createConnection, createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Tui from "@earendil-works/pi-tui";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { activityComponent, itemComponent } from "../.pi/extensions/tg-extension.ts";
import { openDb } from "../src/db/db.ts";
import { IpcServer } from "../src/daemon/ipc-server.ts";
import {
	encodeFrame,
	FrameDecoder,
	type EvtItem,
	type AgentActivity,
	type MsgItem,
	type ServerMessage,
	type TimelineItem,
	type UsageRun,
} from "../src/ipc.ts";
import {
	ensureLocalMedia,
	isVisionMedia,
	reconcileMediaCachePaths,
	type MediaDownloadApi,
} from "../src/media/local-cache.ts";
import { MediaCacheQueue } from "../src/media/media-cache.ts";
import { listReferencedMissingDisplayMediaIds, pruneUnreferencedMediaCache } from "../src/media/lifecycle.ts";
import { ensureStickerCatalog } from "../src/media/sticker-catalog.ts";
import { ensureContextMedia } from "../src/media/context-media.ts";
import {
	createPiVisionExecutor,
	ensureVision,
	type VisionDescribeInput,
	type VisionExecutor,
} from "../src/media/vision.ts";
import { VisionScheduler } from "../src/media/vision-scheduler.ts";
import { extractVideoFrames, sampleVideoFrameFractions, type VideoCommandRunner } from "../src/media/video-frames.ts";
import { setLogSink } from "../src/observability/log.ts";
import { readMediaImage, TimelineClient, type TimelineEvent } from "../src/plugin/timeline.ts";
import { BotApi } from "../src/telegram/api.ts";
import { normalizeMessage } from "../src/telegram/normalize.ts";

const temporaryDirectories = new Set<string>();
const logLines: string[] = [];
let restoreLogSink: (() => void) | null = null;

beforeAll(() => {
	initTheme("dark");
	restoreLogSink = setLogSink((line) => logLines.push(line));
});

afterAll(() => {
	restoreLogSink?.();
});

afterEach(() => {
	Tui.resetCapabilitiesCache();
	logLines.length = 0;
	for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
	temporaryDirectories.clear();
});

function temporaryDirectory(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	temporaryDirectories.add(directory);
	return directory;
}

function message(overrides: Partial<MsgItem> = {}): MsgItem {
	return {
		kind: "msg",
		ts: 1_786_251_069_000,
		chatId: -1001,
		messageId: 22662,
		senderName: "user",
		username: null,
		isBot: false,
		botId: null,
		text: null,
		mediaKind: "photo",
		stickerEmoji: null,
		mediaPath: null,
		fileUniqueId: "shared-photo",
		replyTo: null,
		edited: false,
		...overrides,
	};
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | null = null;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(label)), milliseconds);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

describe("cross-bot media acquisition", () => {
	test("preserves static, animated, and video sticker formats and sends their original file ids", async () => {
		const db = new Database(":memory:");
		db.exec(readFileSync("src/db/schema.sql", "utf8"));
		const catalogApi = {
			call: async () => ({
				name: "MixedSet",
				title: "Mixed",
				stickers: [
					{ file_id: "static-file", file_unique_id: "static-unique", emoji: "🖼️" },
					{ file_id: "animated-file", file_unique_id: "animated-unique", emoji: "✨", is_animated: true },
					{ file_id: "video-file", file_unique_id: "video-unique", emoji: "🎞️", is_video: true },
				],
			}),
		};
		try {
			await ensureStickerCatalog(db, catalogApi as never, "A", ["MixedSet"]);
			expect(db.query("SELECT file_unique_id, mime FROM media ORDER BY rowid").all()).toEqual([
				{ file_unique_id: "static-unique", mime: "image/webp" },
				{ file_unique_id: "animated-unique", mime: "application/x-tgsticker" },
				{ file_unique_id: "video-unique", mime: "video/webm" },
			]);

			const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
			const sendApi = new BotApi("unused");
			sendApi.call = async <T>(method: string, params: Record<string, unknown> = {}) => {
				sent.push({ method, params });
				return {} as T;
			};
			const rows = db
				.query(
					`SELECT mapping.file_id
					   FROM media
					   JOIN media_file_ids mapping USING (file_unique_id)
					  WHERE mapping.bot_id = 'A'
					  ORDER BY media.rowid`,
				)
				.all() as { file_id: string }[];
			for (const row of rows) await sendApi.sendSticker(-1001, row.file_id);
			expect(sent).toEqual([
				{ method: "sendSticker", params: { chat_id: -1001, sticker: "static-file" } },
				{ method: "sendSticker", params: { chat_id: -1001, sticker: "animated-file" } },
				{ method: "sendSticker", params: { chat_id: -1001, sticker: "video-file" } },
			]);
		} finally {
			db.close();
		}
	});

	test("normalizes animated and video stickers outside configured catalogs", () => {
		const telegramMessage = (sticker: Record<string, unknown>) =>
			normalizeMessage({
				chat: { id: -1001 },
				message_id: 1,
				date: 1,
				sticker: { file_id: "file", file_unique_id: "unique", ...sticker },
			});
		expect(telegramMessage({ is_animated: true }).media?.mime).toBe("application/x-tgsticker");
		expect(telegramMessage({ is_video: true }).media?.mime).toBe("video/webm");
		expect(isVisionMedia("sticker", "application/x-tgsticker")).toBe(false);
		expect(isVisionMedia("sticker", "video/webm")).toBe(true);
		const note = normalizeMessage({
			chat: { id: -1001 },
			message_id: 2,
			date: 1,
			video_note: { file_id: "note-file", file_unique_id: "note-unique", mime_type: "video/mp4" },
		});
		expect(note.media).toMatchObject({ kind: "video_note", mime: "video/mp4" });
	});

	test("coalesces concurrent context preparation across bots and reuses the persisted refs", async () => {
		const directory = temporaryDirectory("tg-context-singleflight-");
		const cacheDir = join(directory, "media");
		const db = openDb(join(directory, "agent.db"));
		const calls: string[] = [];
		const api = (botId: string): MediaDownloadApi => ({
			getFile: async (fileId) => {
				calls.push(`${botId}:get:${fileId}`);
				return { file_path: `${botId}.jpg` };
			},
			downloadFile: async (filePath) => {
				calls.push(`${botId}:download:${filePath}`);
				return new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
			},
		});
		const apiA = api("A");
		const apiB = api("B");
		const apis = new Map([
			["A", apiA],
			["B", apiB],
		]);
		let resizeCalls = 0;
		let resizeOptions: unknown = null;
		const options = {
			cacheDir,
			botApis: apis,
			resize: async (bytes: Uint8Array, mimeType: string, resizeOpts?: unknown) => {
				resizeCalls++;
				resizeOptions = resizeOpts;
				return {
					data: Buffer.from(bytes).toString("base64"),
					mimeType,
					originalWidth: 1,
					originalHeight: 1,
					width: 1,
					height: 1,
					wasResized: false,
				};
			},
		};

		try {
			db.query("INSERT INTO media (file_unique_id, kind, mime) VALUES ('shared-photo', 'photo', 'image/jpeg')").run();
			db.query(
				"INSERT INTO media_file_ids (bot_id, file_id, file_unique_id) VALUES ('A', 'file-a', 'shared-photo'), ('B', 'file-b', 'shared-photo')",
			).run();
			const first = ensureContextMedia(db, apiA, "A", "shared-photo", options);
			const second = ensureContextMedia(db, apiB, "B", "shared-photo", options);
			expect(first).toBe(second);
			const refs = await first;
			expect(await second).toEqual(refs);
			expect(refs).toHaveLength(1);
			expect(refs?.[0]?.mime).toBe("image/jpeg");
			expect(refs?.[0]?.name.endsWith(".jpg")).toBe(true);
			expect(existsSync(join(cacheDir, refs?.[0]?.name ?? ""))).toBe(true);
			expect(calls).toEqual(["A:get:file-a", "A:download:A.jpg"]);
			expect(resizeCalls).toBe(1);
			expect(resizeOptions).toEqual({
				maxWidth: 1024,
				maxHeight: 1024,
				maxBytes: 200_000,
				jpegQuality: 80,
			});
			expect(
				JSON.parse(
					(
						db.query("SELECT context_files FROM media WHERE file_unique_id = 'shared-photo'").get() as {
							context_files: string;
						}
					).context_files,
				),
			).toEqual(refs);

			const bypassed: MediaDownloadApi = {
				getFile: async () => {
					throw new Error("persisted context refs were bypassed");
				},
				downloadFile: async () => {
					throw new Error("persisted context refs were bypassed");
				},
			};
			expect(await ensureContextMedia(db, bypassed, "B", "shared-photo", options)).toEqual(refs);
			expect(calls).toEqual(["A:get:file-a", "A:download:A.jpg"]);
			expect(resizeCalls).toBe(1);
		} finally {
			db.close();
		}
	});

	test("coalesces video sampling across bots and persists every derived frame file", async () => {
		const directory = temporaryDirectory("tg-context-video-");
		const cacheDir = join(directory, "media");
		const db = openDb(join(directory, "agent.db"));
		const apiB: MediaDownloadApi = {
			getFile: async (fileId) => {
				expect(fileId).toBe("video-file-b");
				return { file_path: "videos/clip.mp4" };
			},
			downloadFile: async () => new Uint8Array([0, 1, 2, 3]),
		};
		const apiA: MediaDownloadApi = {
			getFile: async () => {
				throw new Error("A has no mapping");
			},
			downloadFile: async () => new Uint8Array(),
		};
		const apis = new Map([
			["A", apiA],
			["B", apiB],
		]);
		let extractCalls = 0;
		try {
			db.query("INSERT INTO media (file_unique_id, kind, mime) VALUES ('shared-video', 'video', 'video/mp4')").run();
			db.query(
				"INSERT INTO media_file_ids (bot_id, file_id, file_unique_id) VALUES ('B', 'video-file-b', 'shared-video')",
			).run();
			const options = {
				cacheDir,
				botApis: apis,
				extractFrames: async () => {
					extractCalls++;
					return {
						ok: true as const,
						durationSeconds: 12,
						frames: [0.2, 0.5, 0.8].map((position, index) => ({
							bytes: new Uint8Array([0xff, 0xd8, index, 0xff, 0xd9]),
							mimeType: "image/jpeg" as const,
							position,
						})),
					};
				},
			};
			const first = ensureContextMedia(db, apiA, "A", "shared-video", options);
			const second = ensureContextMedia(db, apiB, "B", "shared-video", options);
			expect(first).toBe(second);
			const refs = await first;
			expect(await second).toEqual(refs);
			expect(extractCalls).toBe(1);
			expect(refs?.map((ref) => ref.mime)).toEqual(["image/jpeg", "image/jpeg", "image/jpeg"]);
			expect(new Set(refs?.map((ref) => ref.name)).size).toBe(3);
			for (const ref of refs ?? []) {
				expect(ref.name.endsWith(".jpg")).toBe(true);
				expect(existsSync(join(cacheDir, ref.name))).toBe(true);
			}
			expect(
				JSON.parse(
					(
						db.query("SELECT context_files FROM media WHERE file_unique_id = 'shared-video'").get() as {
							context_files: string;
						}
					).context_files,
				),
			).toEqual(refs);
			const cached = db.query("SELECT local_path FROM media WHERE file_unique_id = 'shared-video'").get() as {
				local_path: string;
			};
			expect(cached.local_path.endsWith(".mp4")).toBe(true);
			expect(existsSync(join(cacheDir, cached.local_path))).toBe(true);
		} finally {
			db.close();
		}
	});

	test("returns null for a video without a transcoder before any download", async () => {
		const directory = temporaryDirectory("tg-context-transcoder-");
		const db = openDb(join(directory, "agent.db"));
		let telegramCalls = 0;
		const api: MediaDownloadApi = {
			getFile: async () => {
				telegramCalls++;
				return { file_path: "videos/clip.mp4" };
			},
			downloadFile: async () => {
				telegramCalls++;
				return new Uint8Array([0, 1, 2, 3]);
			},
		};
		let extractionAttempts = 0;
		const options = {
			cacheDir: join(directory, "media"),
			videoTranscoder: { ffmpeg: false, ffprobe: false },
			extractFrames: async () => {
				extractionAttempts++;
				return { ok: false as const, outcome: "video_transcoder_unavailable" as const };
			},
		};
		try {
			db.query("INSERT INTO media (file_unique_id, kind, mime) VALUES ('gated-video', 'video', 'video/mp4')").run();
			db.query(
				"INSERT INTO media_file_ids (bot_id, file_id, file_unique_id) VALUES ('A', 'gated-file', 'gated-video')",
			).run();
			expect(await ensureContextMedia(db, api, "A", "gated-video", options)).toBeNull();
			expect(await ensureContextMedia(db, api, "A", "gated-video", options)).toBeNull();
			expect(telegramCalls).toBe(0);
			expect(extractionAttempts).toBe(0);
			expect(
				(
					db.query("SELECT context_files FROM media WHERE file_unique_id = 'gated-video'").get() as {
						context_files: string | null;
					}
				).context_files,
			).toBeNull();
		} finally {
			db.close();
		}
	});

	test("does not persist a failed preparation and retries on the next call", async () => {
		const directory = temporaryDirectory("tg-context-retry-");
		const cacheDir = join(directory, "media");
		const db = openDb(join(directory, "agent.db"));
		let telegramCalls = 0;
		const api: MediaDownloadApi = {
			getFile: async () => {
				telegramCalls++;
				return { file_path: "videos/retry.mp4" };
			},
			downloadFile: async () => {
				telegramCalls++;
				return new Uint8Array([0, 1, 2, 3]);
			},
		};
		let extractionAttempts = 0;
		const options = {
			cacheDir,
			videoTranscoder: { ffmpeg: true, ffprobe: true },
			extractFrames: async () => {
				extractionAttempts++;
				if (extractionAttempts === 1) return { ok: false as const, outcome: "video_frame_extraction_failed" as const };
				return {
					ok: true as const,
					durationSeconds: 1,
					frames: [{ bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), mimeType: "image/jpeg" as const, position: 0.5 }],
				};
			},
		};
		try {
			db.query("INSERT INTO media (file_unique_id, kind, mime) VALUES ('retry-video', 'video', 'video/mp4')").run();
			db.query(
				"INSERT INTO media_file_ids (bot_id, file_id, file_unique_id) VALUES ('A', 'retry-file', 'retry-video')",
			).run();
			expect(await ensureContextMedia(db, api, "A", "retry-video", options)).toBeNull();
			expect(
				(
					db.query("SELECT context_files FROM media WHERE file_unique_id = 'retry-video'").get() as {
						context_files: string | null;
					}
				).context_files,
			).toBeNull();
			const refs = await ensureContextMedia(db, api, "A", "retry-video", options);
			expect(refs).toHaveLength(1);
			// The source download from the failed attempt is reused from the local cache.
			expect(telegramCalls).toBe(2);
			expect(extractionAttempts).toBe(2);
		} finally {
			db.close();
		}
	});

	test("returns null for media that can never become context images", async () => {
		const directory = temporaryDirectory("tg-context-unsupported-");
		const db = openDb(join(directory, "agent.db"));
		const api: MediaDownloadApi = {
			getFile: async () => {
				throw new Error("unsupported media must not be downloaded");
			},
			downloadFile: async () => {
				throw new Error("unsupported media must not be downloaded");
			},
		};
		try {
			const insert = db.query("INSERT INTO media (file_unique_id, kind, mime) VALUES (?, ?, ?)");
			insert.run("voice-note", "voice", "audio/ogg");
			insert.run("audio-track", "audio", "audio/mpeg");
			insert.run("tgs-sticker", "sticker", "application/x-tgsticker");
			insert.run("pdf-document", "document", "application/pdf");
			for (const id of ["voice-note", "audio-track", "tgs-sticker", "pdf-document"]) {
				expect(await ensureContextMedia(db, api, "A", id, { cacheDir: join(directory, "media") })).toBeNull();
			}
			expect(db.query("SELECT COUNT(*) count FROM media WHERE context_files IS NOT NULL").get()).toEqual({
				count: 0,
			});
		} finally {
			db.close();
		}
	});

	test("coalesces concurrent vision for two bots and reuses the persisted description", async () => {
		const directory = temporaryDirectory("tg-vision-singleflight-");
		const db = openDb(join(directory, "agent.db"));
		const calls: string[] = [];
		const api = (botId: string): MediaDownloadApi => ({
			getFile: async (fileId) => {
				calls.push(`${botId}:get:${fileId}`);
				return { file_path: `${botId}.jpg` };
			},
			downloadFile: async (filePath) => {
				calls.push(`${botId}:download:${filePath}`);
				return new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
			},
		});
		const apiA = api("A");
		const apiB = api("B");
		const apis = new Map([
			["A", apiA],
			["B", apiB],
		]);
		let describeCalls = 0;
		let release!: () => void;
		let markEntered!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const entered = new Promise<void>((resolve) => {
			markEntered = resolve;
		});
		const executor: VisionExecutor = {
			modelRef: "test/vision:low",
			provider: "test",
			model: "vision",
			readinessFailure: null,
			describe: async () => {
				describeCalls++;
				markEntered();
				await gate;
				return {
					text: "one shared description",
					telemetry: {
						kind: "photo",
						sourceBytesBucket: "lt_32_kib",
						convertedBytesBucket: "unavailable",
						latencyMs: 1,
						inputTokens: 1,
						outputTokens: 1,
						reasoningTokens: 0,
						cost: 0,
						outcome: "ok",
					},
				};
			},
		};

		try {
			db.query("INSERT INTO media (file_unique_id, kind) VALUES ('shared-vision', 'photo')").run();
			db.query(
				"INSERT INTO media_file_ids (bot_id, file_id, file_unique_id) VALUES ('A', 'file-a', 'shared-vision'), ('B', 'file-b', 'shared-vision')",
			).run();
			const first = ensureVision(db, apiA as never, "A", "shared-vision", executor, {
				cacheDir: join(directory, "media"),
				botApis: apis,
			});
			const second = ensureVision(db, apiB as never, "B", "shared-vision", executor, {
				cacheDir: join(directory, "media"),
				botApis: apis,
			});
			expect(first).toBe(second);
			await entered;
			expect(describeCalls).toBe(1);
			release();
			expect(await Promise.all([first, second])).toEqual(["one shared description", "one shared description"]);

			const cachedExecutor = {
				...executor,
				describe: async () => {
					describeCalls++;
					throw new Error("persisted vision cache was bypassed");
				},
			} satisfies VisionExecutor;
			expect(
				await ensureVision(db, apiB as never, "B", "shared-vision", cachedExecutor, {
					cacheDir: join(directory, "media"),
					botApis: apis,
				}),
			).toBe("one shared description");
			expect(describeCalls).toBe(1);
			expect(
				JSON.parse(
					(db.query("SELECT vision FROM media WHERE file_unique_id = 'shared-vision'").get() as { vision: string })
						.vision,
				).text,
			).toBe("one shared description");
		} finally {
			release();
			db.close();
		}
	});

	test("coalesces video preparation across bots and sends three ordered frames in one vision call", async () => {
		const directory = temporaryDirectory("tg-video-singleflight-");
		const db = openDb(join(directory, "agent.db"));
		const apiB: MediaDownloadApi = {
			getFile: async (fileId) => {
				expect(fileId).toBe("video-file-b");
				return { file_path: "videos/clip.mp4" };
			},
			downloadFile: async () => new Uint8Array([0, 1, 2, 3]),
		};
		const apiA: MediaDownloadApi = {
			getFile: async () => {
				throw new Error("A has no mapping");
			},
			downloadFile: async () => new Uint8Array(),
		};
		const apis = new Map([
			["A", apiA],
			["B", apiB],
		]);
		let extractCalls = 0;
		let describeCalls = 0;
		const described: VisionDescribeInput[] = [];
		const executor: VisionExecutor = {
			modelRef: "test/vision:off",
			provider: "test",
			model: "vision",
			readinessFailure: null,
			describe: async (input) => {
				describeCalls++;
				described.push(input);
				return {
					text: "人物从左侧走到画面中央",
					telemetry: {
						kind: "video",
						sourceBytesBucket: "lt_32_kib",
						convertedBytesBucket: "lt_32_kib",
						latencyMs: 1,
						inputTokens: 1,
						outputTokens: 1,
						reasoningTokens: 0,
						cost: 0,
						outcome: "ok",
						frames: 3,
					},
				};
			},
		};
		try {
			db.query("INSERT INTO media (file_unique_id, kind, mime) VALUES ('shared-video', 'video', 'video/mp4')").run();
			db.query(
				"INSERT INTO media_file_ids (bot_id, file_id, file_unique_id) VALUES ('B', 'video-file-b', 'shared-video')",
			).run();
			const options = {
				cacheDir: join(directory, "media"),
				botApis: apis,
				extractFrames: async () => {
					extractCalls++;
					return {
						ok: true as const,
						durationSeconds: 12,
						frames: [0.31, 0.5, 0.74].map((position, index) => ({
							bytes: new Uint8Array([0xff, 0xd8, index, 0xff, 0xd9]),
							mimeType: "image/jpeg" as const,
							position,
						})),
					};
				},
			};
			const first = ensureVision(db, apiA as never, "A", "shared-video", executor, options);
			const second = ensureVision(db, apiB as never, "B", "shared-video", executor, options);
			expect(first).toBe(second);
			expect(await Promise.all([first, second])).toEqual(["人物从左侧走到画面中央", "人物从左侧走到画面中央"]);
			expect(extractCalls).toBe(1);
			expect(describeCalls).toBe(1);
			expect(described[0]?.kind).toBe("video");
			expect(described[0]?.images.map((image) => image.position)).toEqual([0.31, 0.5, 0.74]);
			const cached = db.query("SELECT local_path FROM media WHERE file_unique_id = 'shared-video'").get() as {
				local_path: string;
			};
			expect(cached.local_path.endsWith(".mp4")).toBe(true);
			expect(existsSync(join(directory, "media", cached.local_path))).toBe(true);
		} finally {
			db.close();
		}
	});

	test("does not persist a missing transcoder as a terminal video result", async () => {
		const directory = temporaryDirectory("tg-video-transcoder-retry-");
		const db = openDb(join(directory, "agent.db"));
		let telegramCalls = 0;
		const api: MediaDownloadApi = {
			getFile: async () => {
				telegramCalls++;
				return { file_path: "videos/retry.mp4" };
			},
			downloadFile: async () => {
				telegramCalls++;
				return new Uint8Array([0, 1, 2, 3]);
			},
		};
		let extractionAttempts = 0;
		let describeCalls = 0;
		const executor: VisionExecutor = {
			modelRef: "test/vision:low",
			provider: "test",
			model: "vision",
			readinessFailure: null,
			describe: async () => {
				describeCalls++;
				throw new Error("provider must not run");
			},
		};
		try {
			db.query("INSERT INTO media (file_unique_id, kind, mime) VALUES ('retry-video', 'video', 'video/mp4')").run();
			db.query(
				"INSERT INTO media_file_ids (bot_id, file_id, file_unique_id) VALUES ('A', 'retry-file', 'retry-video')",
			).run();
			const options = {
				cacheDir: join(directory, "media"),
				videoTranscoder: { ffmpeg: false, ffprobe: false },
				extractFrames: async () => {
					extractionAttempts++;
					return { ok: false as const, outcome: "video_transcoder_unavailable" as const };
				},
			};
			expect(await ensureVision(db, api as never, "A", "retry-video", executor, options)).toBeNull();
			expect(await ensureVision(db, api as never, "A", "retry-video", executor, options)).toBeNull();
			expect(telegramCalls).toBe(0);
			expect(extractionAttempts).toBe(0);
			expect(describeCalls).toBe(0);
			expect(
				(db.query("SELECT vision FROM media WHERE file_unique_id = 'retry-video'").get() as { vision: string | null })
					.vision,
			).toBeNull();
		} finally {
			db.close();
		}
	});

	test("globally gates each video pipeline before download and extraction", async () => {
		const directory = temporaryDirectory("tg-video-global-gate-");
		const db = openDb(join(directory, "agent.db"));
		const scheduler = new VisionScheduler(1);
		const started: string[] = [];
		let active = 0;
		let peak = 0;
		let releaseFirst!: () => void;
		let firstEntered!: () => void;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const entered = new Promise<void>((resolve) => {
			firstEntered = resolve;
		});
		const telegramCalls: string[] = [];
		const api: MediaDownloadApi = {
			getFile: async (fileId) => {
				telegramCalls.push(`get:${fileId}`);
				return { file_path: `videos/${fileId}.mp4` };
			},
			downloadFile: async (filePath) => {
				telegramCalls.push(`download:${filePath}`);
				return new Uint8Array([0, 1, 2, 3]);
			},
		};
		const executor: VisionExecutor = {
			modelRef: "test/vision:off",
			provider: "test",
			model: "vision",
			readinessFailure: null,
			describe: async (input) => ({
				text: `description-${input.images[0]?.position}`,
				telemetry: {
					kind: "video",
					sourceBytesBucket: "lt_32_kib",
					convertedBytesBucket: "lt_32_kib",
					latencyMs: 1,
					inputTokens: 1,
					outputTokens: 1,
					reasoningTokens: 0,
					cost: 0,
					outcome: "ok",
					frames: 1,
				},
			}),
		};
		try {
			for (const id of ["video-one", "video-two"]) {
				db.query("INSERT INTO media (file_unique_id, kind, mime) VALUES (?, 'video', 'video/mp4')").run(id);
				db.query("INSERT INTO media_file_ids (bot_id, file_id, file_unique_id) VALUES ('A', ?, ?)").run(
					`${id}-file`,
					id,
				);
			}
			const options = {
				cacheDir: join(directory, "media"),
				scheduler,
				videoTranscoder: { ffmpeg: true, ffprobe: true },
				extractFrames: async () => {
					started.push(`video-${started.length + 1}`);
					active++;
					peak = Math.max(peak, active);
					if (started.length === 1) {
						firstEntered();
						await firstGate;
					}
					active--;
					return {
						ok: true as const,
						durationSeconds: 1,
						frames: [
							{ bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), mimeType: "image/jpeg" as const, position: 0.5 },
						],
					};
				},
			};
			const first = ensureVision(db, api as never, "A", "video-one", executor, options);
			await entered;
			const second = ensureVision(db, api as never, "A", "video-two", executor, options);
			await new Promise<void>((resolve) => queueMicrotask(resolve));
			expect(started).toEqual(["video-1"]);
			expect(telegramCalls).toEqual(["get:video-one-file", "download:videos/video-one-file.mp4"]);
			releaseFirst();
			expect(await Promise.all([first, second])).toEqual(["description-0.5", "description-0.5"]);
			expect(started).toEqual(["video-1", "video-2"]);
			expect(telegramCalls).toEqual([
				"get:video-one-file",
				"download:videos/video-one-file.mp4",
				"get:video-two-file",
				"download:videos/video-two-file.mp4",
			]);
			expect(peak).toBe(1);
		} finally {
			releaseFirst();
			db.close();
		}
	});

	test("uses the receiving bot's file_id with the matching Bot API", async () => {
		const db = new Database(":memory:");
		db.exec(`
			CREATE TABLE media (
				file_unique_id TEXT PRIMARY KEY,
				kind TEXT NOT NULL,
				mime TEXT,
				local_path TEXT
			);
			CREATE TABLE media_file_ids (
				bot_id TEXT NOT NULL,
				file_id TEXT NOT NULL,
				file_unique_id TEXT NOT NULL
			);
		`);
		db.query("INSERT INTO media (file_unique_id, kind) VALUES (?, 'photo')").run("shared-photo");
		db.query("INSERT INTO media_file_ids (bot_id, file_id, file_unique_id) VALUES ('B', 'file-from-B', ?)").run(
			"shared-photo",
		);

		const calls: string[] = [];
		const apiA: MediaDownloadApi = {
			getFile: async () => {
				calls.push("A:getFile");
				throw new Error("A must not receive B's file_id");
			},
			downloadFile: async () => {
				calls.push("A:downloadFile");
				return new Uint8Array();
			},
		};
		const apiB: MediaDownloadApi = {
			getFile: async (fileId) => {
				calls.push(`B:getFile:${fileId}`);
				return { file_path: "photos/shared.jpg" };
			},
			downloadFile: async (filePath) => {
				calls.push(`B:downloadFile:${filePath}`);
				return new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
			},
		};

		try {
			const result = await ensureLocalMedia(db, apiA, "A", "shared-photo", {
				botApis: new Map([
					["A", apiA],
					["B", apiB],
				]),
				cacheDir: join(temporaryDirectory("tg-media-source-"), "media"),
			});
			expect(result.ok).toBe(true);
			expect(calls).toEqual(["B:getFile:file-from-B", "B:downloadFile:photos/shared.jpg"]);
		} finally {
			db.close();
		}
	});

	test("rebases migrated sticker paths and projects bot media from the current cache", () => {
		const directory = temporaryDirectory("tg-media-rebase-");
		const mediaDir = join(directory, "media");
		mkdirSync(mediaDir, { recursive: true });
		writeFileSync(join(mediaDir, "bot-sticker.webp"), new Uint8Array([1, 2, 3, 4]));
		const db = openDb(join(directory, "agent.db"));
		try {
			db.query(
				"INSERT INTO media (file_unique_id, kind, local_path) VALUES ('bot-sticker', 'sticker', '/Users/old/project/data/media/bot-sticker.webp')",
			).run();
			db.query(
				`INSERT INTO messages
					(chat_id, message_id, date, sender_id, display_name, is_bot, media, first_seen_by)
				 VALUES (?, 42, 100, 777, 'bot', 1, ?, 'A')`,
			).run(-1001, JSON.stringify({ kind: "sticker", file_unique_id: "bot-sticker", sticker_emoji: "😺" }));

			expect(reconcileMediaCachePaths(db, mediaDir)).toEqual({ migrated: 1, invalidated: 0 });
			const stored = db.query("SELECT local_path FROM media WHERE file_unique_id = 'bot-sticker'").get() as {
				local_path: string;
			};
			expect(stored.local_path).toBe("bot-sticker.webp");

			const ipc = new IpcServer(db, join(directory, "daemon.sock"), new Map([["A", "bot"]]), new Map([["A", 777]]));
			const row = db.query("SELECT * FROM messages WHERE message_id = 42").get() as never;
			const item = ipc.msgToItem(row);
			expect(item.isBot).toBe(true);
			expect(item.mediaPath).toBe(join(mediaDir, "bot-sticker.webp"));
			expect(readMediaImage(item)?.filename).toBe(join(mediaDir, "bot-sticker.webp"));
		} finally {
			db.close();
		}
	});

	test("prepares an outgoing bot sticker through the shared display-media queue", async () => {
		const directory = temporaryDirectory("tg-bot-sticker-cache-");
		const db = openDb(join(directory, "agent.db"));
		const calls: string[] = [];
		const api: MediaDownloadApi = {
			getFile: async (fileId) => {
				calls.push(`get:${fileId}`);
				return { file_path: "stickers/sent.webp" };
			},
			downloadFile: async (filePath) => {
				calls.push(`download:${filePath}`);
				return new Uint8Array([1, 2, 3, 4]);
			},
		};
		const readyEvents: { fileUniqueId: string; mediaPath: string }[] = [];
		const queue = new MediaCacheQueue(db, new Map([["A", api]]), {
			cacheDir: join(directory, "media"),
			onReady: (fileUniqueId, mediaPath) => {
				readyEvents.push({ fileUniqueId, mediaPath });
			},
		});
		try {
			db.query("INSERT INTO media (file_unique_id, kind) VALUES ('sent-sticker', 'sticker')").run();
			db.query(
				"INSERT INTO media_file_ids (bot_id, file_id, file_unique_id) VALUES ('A', 'bot-file-id', 'sent-sticker')",
			).run();
			expect(
				queue.scheduleMessage("A", {
					media: JSON.stringify({ kind: "sticker", file_unique_id: "sent-sticker" }),
				}),
			).toBe(true);
			await queue.whenIdle();
			expect(calls).toEqual(["get:bot-file-id", "download:stickers/sent.webp"]);
			expect(readyEvents[0]?.fileUniqueId).toBe("sent-sticker");
			expect(readyEvents[0]?.mediaPath.startsWith(join(directory, "media"))).toBe(true);
			const stored = db.query("SELECT local_path FROM media WHERE file_unique_id = 'sent-sticker'").get() as {
				local_path: string;
			};
			expect(stored.local_path).not.toContain("/");
		} finally {
			await queue.stop();
			db.close();
		}
	});
});

describe("video frame sampling", () => {
	test("uses fixed representative frame positions", () => {
		expect(sampleVideoFrameFractions(0)).toEqual([]);
		expect(sampleVideoFrameFractions(1)).toEqual([0.5]);
		expect(sampleVideoFrameFractions(2)).toEqual([1 / 3, 2 / 3]);
		expect(sampleVideoFrameFractions(3)).toEqual([0.2, 0.5, 0.8]);
	});

	test("probes once, extracts at most three frames, and removes temporary output", async () => {
		const directory = temporaryDirectory("tg-video-extract-");
		const sourcePath = join(directory, "source.mp4");
		writeFileSync(sourcePath, new Uint8Array([0, 1, 2, 3]));
		const commands: string[][] = [];
		const runner: VideoCommandRunner = {
			which: (command) => `/usr/bin/${command}`,
			run: async (argv) => {
				commands.push([...argv]);
				if (argv[0]?.endsWith("ffprobe")) {
					return { exitCode: 0, stdout: JSON.stringify({ format: { duration: "10" }, streams: [{}] }) };
				}
				writeFileSync(argv.at(-1)!, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
				return { exitCode: 0, stdout: "" };
			},
		};
		const result = await extractVideoFrames(
			{ sourcePath, sourceBytes: new Uint8Array(), sourceExtension: "mp4" },
			{ runner },
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.frames).toHaveLength(3);
		expect(commands.filter((argv) => argv[0]?.endsWith("ffprobe"))).toHaveLength(1);
		expect(commands.filter((argv) => argv[0]?.endsWith("ffmpeg"))).toHaveLength(3);
		expect(result.frames.every((frame) => frame.bytes.byteLength === 4)).toBe(true);
		expect(commands.every((argv) => !argv.includes("sh") && !argv.includes("-c"))).toBe(true);
		expect(commands.slice(1).every((argv) => !existsSync(argv.at(-1)!))).toBe(true);
	});

	test("builds one Pi request containing all sampled frames", async () => {
		let calls = 0;
		let captured: unknown = null;
		const runtime = {
			getModel: () => ({ input: ["text", "image"] }),
			completeSimple: async (_model: unknown, context: unknown) => {
				calls++;
				captured = context;
				return {
					role: "assistant",
					content: [{ type: "text", text: "video description" }],
					stopReason: "stop",
					usage: { input: 3, output: 2, reasoning: 0, cost: { total: 0 } },
				};
			},
		};
		const executor = createPiVisionExecutor(runtime as never, "test/vision:low");
		const result = await executor.describe({
			kind: "video",
			sourceBytes: 100,
			images: [0.2, 0.5, 0.8].map((position) => ({
				bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
				mimeType: "image/jpeg" as const,
				position,
			})),
		});
		expect(result.text).toBe("video description");
		expect(calls).toBe(1);
		const content = (captured as { messages: Array<{ content: Array<{ type: string }> }> }).messages[0]!.content;
		expect(content.filter((item) => item.type === "image")).toHaveLength(3);
	});
});

describe("post-compaction media cache pruning", () => {
	test("media reference checks seek by identity instead of scanning message history per file", () => {
		const db = openDb(":memory:");
		const query = db.query.bind(db);
		const plans: string[][] = [];
		db.query = ((sql: string) => {
			if (sql.includes("FROM messages message")) {
				const rows = query(`EXPLAIN QUERY PLAN ${sql}`).all('["A","B"]', 100) as { detail: string }[];
				plans.push(rows.map((row) => row.detail));
			}
			return query(sql);
		}) as typeof db.query;
		try {
			listReferencedMissingDisplayMediaIds(db, ["A", "B"], 100);
			pruneUnreferencedMediaCache(db, "/unused", ["A", "B"]);
			expect(plans).toHaveLength(2);
			for (const plan of plans)
				expect(plan.some((detail) => /SEARCH message .*idx_messages_media_identity/.test(detail))).toBe(true);
		} finally {
			db.close();
		}
	});

	test("deletes only unreferenced files and does not backfill them on restart", async () => {
		const directory = temporaryDirectory("tg-media-prune-");
		const mediaDir = join(directory, "media");
		mkdirSync(mediaDir, { recursive: true });
		const db = openDb(join(directory, "agent.db"));
		const chatId = -1001;
		const cases = [
			"visible-a",
			"visible-b",
			"obligation",
			"unreferenced",
			"stale",
			"failed",
			"pending",
			"visible-missing",
		];
		const downloadCalls: string[] = [];
		const api: MediaDownloadApi = {
			getFile: async (fileId) => {
				downloadCalls.push(`get:${fileId}`);
				return { file_path: "photos/recovered.jpg" };
			},
			downloadFile: async (filePath) => {
				downloadCalls.push(`download:${filePath}`);
				return new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
			},
		};
		const queue = new MediaCacheQueue(db, new Map([["A", api]]), { cacheDir: mediaDir });
		try {
			for (let index = 0; index < cases.length; index++) {
				const id = cases[index]!;
				const filename = `${id}.jpg`;
				if (id !== "stale" && id !== "visible-missing") {
					writeFileSync(join(mediaDir, filename), new Uint8Array([index + 1]));
				}
				if (id === "unreferenced") writeFileSync(join(mediaDir, "unreferenced-ctx.jpg"), new Uint8Array([9]));
				db.query(
					"INSERT INTO media (file_unique_id, kind, mime, local_path, vision, context_files) VALUES (?, 'photo', 'image/jpeg', ?, ?, ?)",
				).run(
					id,
					id === "visible-missing" ? null : filename,
					JSON.stringify({ model: "test", kind: "photo", text: `vision-${id}` }),
					JSON.stringify([{ name: `${id}-ctx.jpg`, mime: "image/jpeg" }]),
				);
				db.query(
					`INSERT INTO messages
					  (chat_id, message_id, date, sender_id, display_name, is_bot, media, first_seen_by)
					 VALUES (?, ?, ?, ?, ?, 0, ?, 'A')`,
				).run(
					chatId,
					index + 1,
					index + 1,
					index + 10,
					id,
					JSON.stringify({ kind: "photo", file_unique_id: id, file_id: `${id}-file` }),
				);
			}
			for (const id of ["unreferenced", "stale", "visible-missing"]) {
				db.query("INSERT INTO media_file_ids (bot_id, file_id, file_unique_id) VALUES ('A', ?, ?)").run(
					`${id}-file`,
					id,
				);
			}
			const highWater = (db.query("SELECT MAX(ingest_seq) value FROM message_events").get() as { value: number }).value;
			db.query(
				"INSERT INTO bot_cursors (bot_id, chat_id, consumed_seq, updated_at) VALUES ('A', ?, ?, 1), ('B', ?, ?, 1)",
			).run(chatId, highWater, chatId, highWater - 2);
			db.query(
				"INSERT INTO bot_visible_messages (bot_id, chat_id, message_id, context_epoch) VALUES ('A', ?, 1, 2), ('B', ?, 2, 3), ('removed', ?, 4, 9), ('A', ?, 8, 2)",
			).run(chatId, chatId, chatId, chatId);
			db.query("INSERT INTO reply_obligations (bot_id, chat_id, message_id, created_at) VALUES ('A', ?, 3, 1)").run(
				chatId,
			);

			const first = pruneUnreferencedMediaCache(db, mediaDir, ["A", "B"], {
				remove: (path) => {
					if (path.endsWith("failed.jpg")) throw new Error("simulated unlink failure");
					try {
						unlinkSync(path);
						return "deleted";
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
						throw error;
					}
				},
			});
			expect(first).toEqual({ scanned: 3, deleted: 1, stale: 1, failed: 1 });
			expect(existsSync(join(mediaDir, "unreferenced.jpg"))).toBe(false);
			expect(existsSync(join(mediaDir, "unreferenced-ctx.jpg"))).toBe(false);
			expect(existsSync(join(mediaDir, "failed.jpg"))).toBe(true);
			expect(
				db.query("SELECT file_unique_id, local_path, vision, context_files FROM media ORDER BY rowid").all(),
			).toEqual([
				{
					file_unique_id: "visible-a",
					local_path: "visible-a.jpg",
					vision: expect.any(String),
					context_files: expect.any(String),
				},
				{
					file_unique_id: "visible-b",
					local_path: "visible-b.jpg",
					vision: expect.any(String),
					context_files: expect.any(String),
				},
				{
					file_unique_id: "obligation",
					local_path: "obligation.jpg",
					vision: expect.any(String),
					context_files: expect.any(String),
				},
				{ file_unique_id: "unreferenced", local_path: null, vision: expect.any(String), context_files: null },
				{ file_unique_id: "stale", local_path: null, vision: expect.any(String), context_files: null },
				{
					file_unique_id: "failed",
					local_path: "failed.jpg",
					vision: expect.any(String),
					context_files: expect.any(String),
				},
				{
					file_unique_id: "pending",
					local_path: "pending.jpg",
					vision: expect.any(String),
					context_files: expect.any(String),
				},
				{
					file_unique_id: "visible-missing",
					local_path: null,
					vision: expect.any(String),
					context_files: expect.any(String),
				},
			]);
			expect(queue.scheduleBackfill()).toBe(1);
			await queue.whenIdle();
			expect(downloadCalls).toEqual(["get:visible-missing-file", "download:photos/recovered.jpg"]);
			expect(
				(
					db.query("SELECT local_path FROM media WHERE file_unique_id = 'visible-missing'").get() as {
						local_path: string | null;
					}
				).local_path,
			).not.toBeNull();
			expect(
				db
					.query(
						"SELECT file_unique_id FROM media WHERE file_unique_id IN ('unreferenced', 'stale') AND local_path IS NOT NULL",
					)
					.all(),
			).toEqual([]);

			db.exec("DELETE FROM bot_visible_messages; DELETE FROM reply_obligations;");
			db.query("UPDATE bot_cursors SET consumed_seq = ?").run(highWater);
			expect(pruneUnreferencedMediaCache(db, mediaDir, ["A", "B"])).toEqual({
				scanned: 6,
				deleted: 6,
				stale: 0,
				failed: 0,
			});
			expect(db.query("SELECT COUNT(*) count FROM media WHERE local_path IS NOT NULL").get()).toEqual({ count: 0 });
			expect(db.query("SELECT COUNT(*) count FROM messages").get()).toEqual({ count: 8 });
			expect(db.query("SELECT COUNT(*) count FROM media WHERE vision IS NOT NULL").get()).toEqual({ count: 8 });
			expect(db.query("SELECT COUNT(*) count FROM media WHERE context_files IS NOT NULL").get()).toEqual({
				count: 0,
			});
		} finally {
			await queue.stop();
			db.close();
		}
	});
});

describe("Pi attach media presentation", () => {
	test("projects one activity card while retaining its raw diagnostic events", () => {
		const directory = temporaryDirectory("tg-activity-timeline-");
		const db = openDb(join(directory, "agent.db"));
		try {
			db.query("INSERT INTO agent_events (bot_id, ts, kind, payload) VALUES ('A', 1, 'tool_call', ?)").run(
				JSON.stringify({ tool: "send", activity_id: "A:1" }),
			);
			db.query("INSERT INTO agent_events (bot_id, ts, kind, payload) VALUES ('A', 2, 'tool_result', ?)").run(
				JSON.stringify({ tool: "send", isError: false, activity_id: "A:1" }),
			);
			db.query("INSERT INTO agent_events (bot_id, ts, kind, payload) VALUES ('A', 3, 'agent_activity', ?)").run(
				JSON.stringify({
					version: 1,
					activityId: "A:1",
					startedAt: 1,
					sections: [{ type: "event", kind: "tool_result", detail: '{"tool":"send","isError":false}' }],
					truncated: false,
				}),
			);
			const ipc = new IpcServer(db, join(directory, "daemon.sock"), new Map([["A", "bot A"]]), new Map());
			const items = (
				ipc as unknown as {
					loadTimeline(cursor: null, limit: number, filter: string | null): TimelineItem[];
				}
			).loadTimeline(null, 100, "A");
			expect(items.map((item) => (item.kind === "evt" ? item.evtKind : item.kind))).toEqual(["agent_activity"]);
			expect(
				db
					.query("SELECT kind FROM agent_events WHERE json_extract(payload, '$.activity_id') = 'A:1' ORDER BY id")
					.all(),
			).toEqual([{ kind: "tool_call" }, { kind: "tool_result" }]);
		} finally {
			db.close();
		}
	});

	test("renders real thinking, full assistant text, and send progress in one activity card", () => {
		const theme = {
			fg: (_color: string, value: string) => value,
			bg: (_color: string, value: string) => value,
			bold: (value: string) => value,
		} as Theme;
		const longText = `normal-output-start ${"x".repeat(700)} normal-output-end`;
		const activity: AgentActivity = {
			version: 1,
			activityId: "A:1",
			startedAt: 1_786_251_069_000,
			truncated: false,
			sections: [
				{
					type: "assistant",
					content: [
						{ type: "thinking", thinking: "real chain of thought" },
						{ type: "text", text: longText },
					],
					stopReason: "stop",
				},
				{ type: "event", kind: "tool_call", detail: '{"tool":"send","args":{"message":"hello"}}' },
				{ type: "event", kind: "tool_result", detail: '{"tool":"send","isError":false}' },
				{ type: "event", kind: "markdown_sent", detail: '{"message_id":42}' },
				{ type: "event", kind: "send", detail: '{"sent":[42]}' },
			],
		};

		const rendered = activityComponent("A", "bot A", activity, theme, "Activity", {
			ui: { requestRender() {} } as Tui.TUI,
			cwd: process.cwd(),
		})
			.render(100)
			.join("\n");
		expect(rendered).toContain("real chain of thought");
		expect(rendered).toContain("normal-output-start");
		expect(rendered).toContain("normal-output-end");
		expect(rendered).toContain("send");
		expect(rendered).toContain('"message": "hello"');
		expect(rendered).toContain("markdown sent");
		expect(rendered).toContain("bot A · Activity");
	});

	test("keeps Telegram usernames in both human and bot card headers", () => {
		const theme = {
			fg: (_color: string, value: string) => value,
			bg: (_color: string, value: string) => value,
			bold: (value: string) => value,
		} as Theme;
		const human = itemComponent(
			message({ senderName: "Alice Example", username: "alice", mediaKind: null, text: "hello" }),
			theme,
		).render(80);
		const bot = itemComponent(
			message({
				senderName: "Helpful Bot",
				username: "helpful_bot",
				isBot: true,
				botId: "friend",
				mediaKind: null,
				text: "hello",
			}),
			theme,
		).render(80);

		expect(human.join("\n")).toContain("Alice Example · @alice");
		expect(bot.join("\n")).toContain("Helpful Bot · @helpful_bot");
		expect(bot.join("\n")).toContain("#22662 · bot friend");
	});

	test("merges a media-ready update that arrives before a filtered feed message", async () => {
		const directory = temporaryDirectory("tg-media-ready-order-");
		const socketPath = join(directory, "timeline.sock");
		const server = createServer((socket) => {
			const decoder = new FrameDecoder();
			socket.on("data", (chunk) => {
				for (const frame of decoder.push(chunk) as Array<{ type?: string; filter?: string }>) {
					if (frame.type !== "hello") continue;
					expect(frame.filter).toBe("A");
					socket.write(
						encodeFrame({ type: "media_ready", fileUniqueId: "shared-photo", mediaPath: "/tmp/shared.png" }),
					);
					socket.write(encodeFrame({ type: "append", item: message() }));
				}
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(socketPath, resolve);
		});

		let resolveItem!: (item: TimelineItem) => void;
		const received = new Promise<TimelineItem>((resolve) => {
			resolveItem = resolve;
		});
		const client = new TimelineClient(socketPath, "A", {
			onEvent: (event: TimelineEvent) => {
				if (event.type === "append" && event.items[0]) resolveItem(event.items[0]);
			},
		});
		try {
			expect(await client.connect()).toBe(true);
			const item = await withTimeout(received, 1_000, "filtered media-ready update timed out");
			expect(item.kind).toBe("msg");
			if (item.kind === "msg") expect(item.mediaPath).toBe("/tmp/shared.png");
		} finally {
			client.dispose();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	test("merges a shared vision update that arrives before a filtered feed message", async () => {
		const directory = temporaryDirectory("tg-vision-order-");
		const socketPath = join(directory, "timeline.sock");
		const server = createServer((socket) => {
			const decoder = new FrameDecoder();
			socket.on("data", (chunk) => {
				for (const frame of decoder.push(chunk) as Array<{ type?: string; filter?: string }>) {
					if (frame.type !== "hello") continue;
					expect(frame.filter).toBe("A");
					socket.write(encodeFrame({ type: "vision_update", fileUniqueId: "shared-photo", text: "recognized" }));
					socket.write(encodeFrame({ type: "append", item: message() }));
				}
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(socketPath, resolve);
		});

		let resolveItem!: (item: TimelineItem) => void;
		const received = new Promise<TimelineItem>((resolve) => {
			resolveItem = resolve;
		});
		const client = new TimelineClient(socketPath, "A", {
			onEvent: (event: TimelineEvent) => {
				if (event.type === "append" && event.items[0]) resolveItem(event.items[0]);
			},
		});
		try {
			expect(await client.connect()).toBe(true);
			const item = await withTimeout(received, 1_000, "filtered vision update timed out");
			expect(item.kind).toBe("msg");
			if (item.kind === "msg") expect(item.mediaDesc).toBe("recognized");
		} finally {
			client.dispose();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	test("rejects a stale bot filter instead of silently opening the global view", async () => {
		const directory = temporaryDirectory("tg-filter-scope-");
		const db = openDb(join(directory, "agent.db"));
		const ipc = new IpcServer(db, join(directory, "daemon.sock"), new Map([["A", "bot A"]]), new Map([["A", 1]]));
		ipc.start();
		const events: TimelineEvent[] = [];
		let resolveDisconnected!: () => void;
		const disconnected = new Promise<void>((resolve) => {
			resolveDisconnected = resolve;
		});
		const client = new TimelineClient(join(directory, "daemon.sock"), "stale", {
			onEvent: (event) => {
				events.push(event);
				if (event.type === "disconnected") resolveDisconnected();
			},
		});
		try {
			expect(await client.connect()).toBe(true);
			await withTimeout(disconnected, 1_000, "stale filter was accepted as a global view");
			expect(events.some((event) => event.type === "append" || event.type === "stats")).toBe(false);
			expect(logLines.some((line) => line.includes('"event":"unknown_filter"'))).toBe(true);
		} finally {
			client.dispose();
			ipc.stop();
			db.close();
		}
	});

	test("keeps a listener silent until hello establishes its bot scope", async () => {
		const directory = temporaryDirectory("tg-filter-handshake-");
		const socketPath = join(directory, "daemon.sock");
		const db = openDb(join(directory, "agent.db"));
		const ipc = new IpcServer(db, socketPath, new Map([["A", "bot A"]]), new Map([["A", 1]]));
		ipc.start();
		const socket = createConnection(socketPath);
		const decoder = new FrameDecoder();
		const frames: ServerMessage[] = [];
		let resolveSnapshot!: () => void;
		let resolveMediaReady!: () => void;
		const snapshot = new Promise<void>((resolve) => {
			resolveSnapshot = resolve;
		});
		const mediaReady = new Promise<void>((resolve) => {
			resolveMediaReady = resolve;
		});
		socket.on("data", (chunk) => {
			for (const frame of decoder.push(chunk) as ServerMessage[]) {
				frames.push(frame);
				if (frame.type === "snapshot") resolveSnapshot();
				if (frame.type === "media_ready") resolveMediaReady();
			}
		});
		await new Promise<void>((resolve, reject) => {
			socket.once("error", reject);
			socket.once("connect", resolve);
		});

		const event: EvtItem = {
			kind: "evt",
			ts: 1,
			evtId: 1,
			botId: "B",
			botName: "bot B",
			evtKind: "assistant_text",
			payload: "{}",
		};
		const usage: UsageRun = {
			id: 1,
			botId: "B",
			ts: 1,
			model: "test",
			epoch: 0,
			contextTokens: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cacheMiss: 0,
			outputTokens: 0,
			reasoningTokens: 0,
			latencyMs: null,
			cost: 0,
		};
		try {
			ipc.broadcast(event);
			ipc.broadcastUsage(usage);
			ipc.broadcastMediaReady({ fileUniqueId: "shared-photo", mediaPath: "/tmp/shared.png" });
			socket.write(encodeFrame({ type: "hello", filter: "A" }));
			await withTimeout(snapshot, 1_000, "valid hello did not receive a snapshot");
			expect(frames.map((frame) => frame.type)).toEqual(["snapshot"]);

			frames.length = 0;
			ipc.broadcast(event);
			ipc.broadcastUsage(usage);
			ipc.broadcastMediaReady({ fileUniqueId: "shared-photo", mediaPath: "/tmp/shared.png" });
			await withTimeout(mediaReady, 1_000, "shared media-ready was not broadcast after hello");
			expect(frames.map((frame) => frame.type)).toEqual(["media_ready"]);
		} finally {
			socket.destroy();
			ipc.stop();
			db.close();
		}
	});
});
