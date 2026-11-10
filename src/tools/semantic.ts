// Semantic recall over the group archive. Consecutive messages are cut into closed conversation
// windows (deterministic, no LLM), embedded once with Gemini, and ranked in memory by cosine
// similarity. Only window text leaves the host; logs carry counts and categories, never content.

import { setImmediate, setTimeout as sleep } from "node:timers/promises";
import { transaction, type Database } from "../db/db.ts";
import { errorCategory, log } from "../observability/log.ts";

export const EMBEDDING_MODEL = "gemini-embedding-2";
const DIMENSIONS = 768;
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:batchEmbedContents`;
/** A window closes after this much silence; open windows are not indexed yet. */
export const WINDOW_GAP_SEC = 30 * 60;
// Measured on the production archive: 800-char windows (~20 messages) ranked better than 1500 or 3000.
const WINDOW_MAX_CHARS = 800;
const WINDOW_MAX_MESSAGES = 40;
const LINE_MAX_CHARS = 500;
const BATCH_SIZE = 100; // API maximum per batchEmbedContents request
// The embed quota (~1M tokens/min at ~0.62 tokens/char) is shared with queries; backfill leaves half of it.
const INDEX_CHARS_PER_MIN = 800_000;
const DEFAULT_RETRY_MS = 60_000;
const SCAN_PAGE = 2_000;
const INDEX_INTERVAL_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 60_000;

export type SemanticFailureCategory = "timeout" | "network" | "http_429" | "http_4xx" | "http_5xx" | "invalid_response";

export class SemanticError extends Error {
	constructor(
		readonly category: SemanticFailureCategory,
		/** Server-requested wait on 429. */
		readonly retryAfterMs?: number,
	) {
		// Surfaces as the tool error the model reads; it carries no request content.
		super(`semantic search unavailable (${category}); retry later or use text_contains`);
		this.name = "SemanticError";
	}
}

export interface ConversationWindow {
	firstId: number;
	lastId: number;
	text: string;
}

export interface SemanticMatch {
	firstId: number;
	lastId: number;
	score: number;
}

interface ScanRow {
	message_id: number;
	date: number;
	display_name: string | null;
	username: string | null;
	sender_id: number | null;
	text: string | null;
	media_kind: string | null;
	vision: string | null;
}

function line(row: ScanRow): string | null {
	const parts: string[] = [];
	const body = row.text?.replace(/\s+/g, " ").trim();
	if (row.media_kind) {
		let description: string | null = null;
		if (row.vision) {
			const parsed = JSON.parse(row.vision) as { text?: unknown };
			description = typeof parsed.text === "string" ? parsed.text.replace(/\s+/g, " ").trim() : null;
		}
		parts.push(description ? `[${row.media_kind}: ${description}]` : `[${row.media_kind}]`);
	}
	if (body) parts.push(body);
	if (parts.length === 0) return null;
	const name = row.display_name ?? (row.username ? `@${row.username}` : String(row.sender_id ?? "?"));
	return `${name}: ${parts.join(" ")}`.slice(0, LINE_MAX_CHARS);
}

interface OpenWindow {
	firstId: number;
	lastId: number;
	lastDate: number;
	count: number;
	chars: number;
	lines: string[];
}

/**
 * Closed windows after `afterId`, in id order. A window ends at a silence longer than
 * WINDOW_GAP_SEC or at the size caps; the trailing window stays open until `now` passes its gap.
 */
export function closedWindows(
	db: Database,
	chatId: number,
	afterId: number,
	now: number,
	max: number,
): ConversationWindow[] {
	const select = db.prepare(
		`SELECT m.message_id, m.date, m.display_name, m.username, m.sender_id, COALESCE(m.text, m.caption) AS text,
		        json_extract(m.media, '$.kind') AS media_kind, md.vision
		 FROM messages m
		 LEFT JOIN telegram_control_messages c ON c.chat_id = m.chat_id AND c.message_id = m.message_id
		 LEFT JOIN media md ON m.media IS NOT NULL
		      AND md.file_unique_id = CAST(json_extract(m.media, '$.file_unique_id') AS TEXT)
		 WHERE m.chat_id = ? AND m.message_id > ? AND c.message_id IS NULL
		 ORDER BY m.message_id LIMIT ?`,
	);
	const out: ConversationWindow[] = [];
	let open: OpenWindow | null = null;
	// Windows without any text (e.g. only service messages) carry nothing to embed.
	const close = (window: OpenWindow) => {
		if (window.lines.length > 0)
			out.push({ firstId: window.firstId, lastId: window.lastId, text: window.lines.join("\n") });
	};
	let cursor = afterId;
	while (true) {
		const rows = select.all(chatId, cursor, SCAN_PAGE) as unknown as ScanRow[];
		for (const row of rows) {
			const text = line(row);
			if (
				open &&
				(row.date - open.lastDate > WINDOW_GAP_SEC ||
					open.count >= WINDOW_MAX_MESSAGES ||
					open.chars + (text?.length ?? 0) > WINDOW_MAX_CHARS)
			) {
				close(open);
				open = null;
				if (out.length >= max) return out;
			}
			open ??= { firstId: row.message_id, lastId: row.message_id, lastDate: row.date, count: 0, chars: 0, lines: [] };
			open.lastId = row.message_id;
			open.lastDate = row.date;
			open.count++;
			if (text) {
				open.lines.push(text);
				open.chars += text.length + 1;
			}
		}
		if (rows.length < SCAN_PAGE) break;
		cursor = rows.at(-1)!.message_id;
	}
	if (open && now - open.lastDate > WINDOW_GAP_SEC) close(open);
	return out;
}

export async function embedTexts(
	apiKey: string,
	texts: string[],
	task: "document" | "query",
	signal?: AbortSignal,
): Promise<Float32Array[]> {
	// gemini-embedding-2 takes its retrieval task as an input prefix, not a taskType field.
	const requests = texts.map((text) => ({
		model: `models/${EMBEDDING_MODEL}`,
		content: {
			parts: [{ text: task === "query" ? `task: search result | query: ${text}` : `title: none | text: ${text}` }],
		},
		outputDimensionality: DIMENSIONS,
	}));
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	let response: Response;
	try {
		response = await fetch(ENDPOINT, {
			method: "POST",
			headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
			body: JSON.stringify({ requests }),
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
	} catch (error) {
		if (signal?.aborted) throw error;
		throw new SemanticError(timeout.aborted ? "timeout" : "network");
	}
	if (response.status === 429) {
		const body = (await response.json().catch(() => null)) as {
			error?: { details?: { retryDelay?: unknown }[] };
		} | null;
		const delay = body?.error?.details?.find((d) => typeof d.retryDelay === "string")?.retryDelay as string | undefined;
		const seconds = delay ? Number.parseFloat(delay) : Number.NaN;
		throw new SemanticError("http_429", Number.isFinite(seconds) ? Math.ceil(seconds * 1000) : undefined);
	}
	if (!response.ok) {
		await response.body?.cancel();
		throw new SemanticError(response.status >= 500 ? "http_5xx" : "http_4xx");
	}
	const body = (await response.json().catch(() => null)) as { embeddings?: { values?: unknown }[] } | null;
	const vectors = body?.embeddings?.map(({ values }) =>
		Array.isArray(values) && values.length === DIMENSIONS ? Float32Array.from(values as number[]) : null,
	);
	if (!vectors || vectors.length !== texts.length || vectors.some((v) => v == null))
		throw new SemanticError("invalid_response");
	return vectors.map((v) => normalize(v!));
}

function normalize(v: Float32Array): Float32Array {
	let sum = 0;
	for (const x of v) sum += x * x;
	const norm = Math.sqrt(sum) || 1;
	for (let i = 0; i < v.length; i++) v[i]! /= norm;
	return v;
}

/** In-memory copy of the window index; the indexer appends, queries scan it. */
export class SemanticIndex {
	private firstIds: number[] = [];
	private lastIds: number[] = [];
	// Grows by doubling so a full backfill does not copy the matrix once per batch.
	private vectors = new Float32Array(0);
	private loaded = false;
	private timer: NodeJS.Timeout | null = null;
	private running: Promise<void> | null = null;
	private readonly stopper = new AbortController();

	constructor(
		private readonly db: Database,
		private readonly chatId: number,
		private readonly apiKey: string,
	) {}

	start(): void {
		const tick = () => {
			this.running ??= this.indexPending()
				.catch((error: unknown) => {
					if (this.stopper.signal.aborted) return;
					log.warn("semantic_index", "index_failed", {
						category: error instanceof SemanticError ? error.category : errorCategory(error),
					});
				})
				.finally(() => {
					this.running = null;
				});
		};
		tick();
		this.timer = setInterval(tick, INDEX_INTERVAL_MS);
		this.timer.unref();
	}

	async stop(): Promise<void> {
		if (this.timer) clearInterval(this.timer);
		this.stopper.abort();
		await this.running;
	}

	/** Windows ranked by similarity; `candidate` restricts them to ranges holding matching messages. */
	async search(
		query: string,
		limit: number,
		candidate: ((firstId: number, lastId: number) => boolean) | null,
		signal?: AbortSignal,
	): Promise<SemanticMatch[]> {
		const [q] = await embedTexts(this.apiKey, [query], "query", signal);
		this.load();
		const scored: SemanticMatch[] = [];
		for (let i = 0; i < this.firstIds.length; i++) {
			if (candidate && !candidate(this.firstIds[i]!, this.lastIds[i]!)) continue;
			let dot = 0;
			const base = i * DIMENSIONS;
			for (let d = 0; d < DIMENSIONS; d++) dot += q![d]! * this.vectors[base + d]!;
			scored.push({ firstId: this.firstIds[i]!, lastId: this.lastIds[i]!, score: dot });
		}
		return scored.sort((a, b) => b.score - a.score).slice(0, limit);
	}

	/** Newest message id the index covers; later messages are still in an open window. */
	indexedThrough(): number | null {
		this.load();
		return this.lastIds.at(-1) ?? null;
	}

	private load(): void {
		if (this.loaded) return;
		this.loaded = true;
		// A model change makes old vectors incomparable; drop them and re-index.
		this.db.prepare("DELETE FROM message_chunks WHERE chat_id = ? AND model != ?").run(this.chatId, EMBEDDING_MODEL);
		const rows = this.db
			.prepare("SELECT first_id, last_id, embedding FROM message_chunks WHERE chat_id = ? ORDER BY first_id")
			.all(this.chatId) as { first_id: number; last_id: number; embedding: Uint8Array }[];
		this.append(
			rows.map((row) => ({
				firstId: row.first_id,
				lastId: row.last_id,
				vector: new Float32Array(row.embedding.slice().buffer),
			})),
		);
	}

	private append(rows: { firstId: number; lastId: number; vector: Float32Array }[]): void {
		const used = this.firstIds.length * DIMENSIONS;
		const needed = used + rows.length * DIMENSIONS;
		if (needed > this.vectors.length) {
			const next = new Float32Array(Math.max(needed, this.vectors.length * 2));
			next.set(this.vectors.subarray(0, used));
			this.vectors = next;
		}
		rows.forEach((row, i) => {
			this.vectors.set(row.vector, used + i * DIMENSIONS);
			this.firstIds.push(row.firstId);
			this.lastIds.push(row.lastId);
		});
	}

	private async indexPending(): Promise<void> {
		this.load();
		const insert = this.db.prepare(
			"INSERT INTO message_chunks (chat_id, first_id, last_id, model, embedding) VALUES (?, ?, ?, ?, ?)",
		);
		let total = 0;
		while (!this.stopper.signal.aborted) {
			const now = Math.floor(Date.now() / 1000);
			const windows = closedWindows(this.db, this.chatId, this.indexedThrough() ?? 0, now, BATCH_SIZE);
			if (windows.length === 0) break;
			const texts = windows.map((w) => w.text);
			const started = Date.now();
			let vectors: Float32Array[];
			try {
				vectors = await embedTexts(this.apiKey, texts, "document", this.stopper.signal);
			} catch (error) {
				if (!(error instanceof SemanticError && error.category === "http_429")) throw error;
				const wait = error.retryAfterMs ?? DEFAULT_RETRY_MS;
				log.info("semantic_index", "rate_limited", { retry_ms: wait });
				await sleep(wait, undefined, { signal: this.stopper.signal });
				continue;
			}
			transaction(this.db, () => {
				for (const [i, w] of windows.entries())
					insert.run(this.chatId, w.firstId, w.lastId, EMBEDDING_MODEL, new Uint8Array(vectors[i]!.buffer));
			});
			this.append(windows.map((w, i) => ({ firstId: w.firstId, lastId: w.lastId, vector: vectors[i]! })));
			total += windows.length;
			const chars = texts.reduce((sum, text) => sum + text.length, 0);
			const paced = (chars / INDEX_CHARS_PER_MIN) * 60_000 - (Date.now() - started);
			if (paced > 0) await sleep(paced, undefined, { signal: this.stopper.signal });
			else await setImmediate();
		}
		if (total > 0)
			log.info("semantic_index", "windows_indexed", { windows: total, indexed_windows: this.firstIds.length });
	}
}
