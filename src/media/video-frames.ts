import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const VIDEO_FRAME_MAX = 3;
const VIDEO_COMMAND_TIMEOUT_MS = 30_000;
const VIDEO_FRAME_MAX_BYTES = 5 * 1024 * 1024;

export type VideoFrameOutcome =
	| "video_transcoder_unavailable"
	| "video_probe_failed"
	| "video_frame_extraction_failed"
	| "video_no_frames";

export interface VideoFrame {
	bytes: Uint8Array;
	mimeType: "image/jpeg";
	/** Normalized position in the source duration, from 0 to 1. */
	position: number;
}

export type VideoFrameResult =
	| { ok: true; durationSeconds: number; frames: VideoFrame[] }
	| { ok: false; outcome: VideoFrameOutcome };

export interface VideoFrameInput {
	sourcePath: string | null;
	sourceBytes: Uint8Array;
	sourceExtension: string;
}

export interface VideoCommandRunner {
	which(command: "ffmpeg" | "ffprobe"): string | null;
	run(argv: readonly string[]): Promise<{ exitCode: number; stdout: string }>;
}

export interface ExtractVideoFramesOptions {
	runner?: VideoCommandRunner;
}

const defaultRunner: VideoCommandRunner = {
	which: (command) => Bun.which(command),
	async run(argv) {
		try {
			const child = Bun.spawn([...argv], {
				stdin: "ignore",
				stdout: "pipe",
				stderr: "ignore",
				timeout: VIDEO_COMMAND_TIMEOUT_MS,
				maxBuffer: 1024 * 1024,
			});
			const stdout = await new Response(child.stdout).text();
			return { exitCode: await child.exited, stdout };
		} catch {
			return { exitCode: 1, stdout: "" };
		}
	},
};

export interface VideoTranscoderAvailability {
	ffmpeg: boolean;
	ffprobe: boolean;
}

export function inspectVideoTranscoder(runner: VideoCommandRunner = defaultRunner): VideoTranscoderAvailability {
	return { ffmpeg: runner.which("ffmpeg") != null, ffprobe: runner.which("ffprobe") != null };
}

/** Human-facing operator warning; absence never blocks chat or daemon readiness. */
export function videoTranscoderAdvisory(required: boolean, availability: VideoTranscoderAvailability): string | null {
	if (!required || (availability.ffmpeg && availability.ffprobe)) return null;
	const missing = [!availability.ffmpeg ? "ffmpeg" : null, !availability.ffprobe ? "ffprobe" : null].filter(
		(value): value is string => value != null,
	);
	return `warning: video frame sampling is disabled because ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} unavailable; install the FFmpeg package and restart (it is used only to sample video frames for the model context; chat, images, and sticker sending continue normally)`;
}

/** Fixed representative positions keep extraction deterministic and explainable. */
export function sampleVideoFrameFractions(requested = VIDEO_FRAME_MAX): number[] {
	const count = Math.min(VIDEO_FRAME_MAX, Math.max(0, Math.floor(requested)));
	if (count === 1) return [0.5];
	if (count === 2) return [1 / 3, 2 / 3];
	return count === 3 ? [0.2, 0.5, 0.8] : [];
}

function frameCount(durationSeconds: number): number {
	if (durationSeconds < 1) return 1;
	if (durationSeconds < 3) return 2;
	return VIDEO_FRAME_MAX;
}

function parseDuration(stdout: string): number | null {
	try {
		const value = JSON.parse(stdout) as {
			format?: { duration?: unknown };
			streams?: Array<{ duration?: unknown }>;
		};
		const candidates = [value.streams?.[0]?.duration, value.format?.duration];
		for (const candidate of candidates) {
			const duration = typeof candidate === "number" ? candidate : Number(candidate);
			if (Number.isFinite(duration) && duration > 0) return duration;
		}
	} catch {
		// Fixed failure outcome below; probe output is untrusted and never logged.
	}
	return null;
}

function safeExtension(extension: string): string {
	const normalized = extension.toLowerCase();
	return /^[a-z0-9]{1,8}$/.test(normalized) ? normalized : "bin";
}

/** Probe and extract ordered JPEG frames. Commands use argv directly; no shell or stderr escapes this module. */
export async function extractVideoFrames(
	input: VideoFrameInput,
	options: ExtractVideoFramesOptions = {},
): Promise<VideoFrameResult> {
	const runner = options.runner ?? defaultRunner;
	const ffmpeg = runner.which("ffmpeg");
	const ffprobe = runner.which("ffprobe");
	if (!ffmpeg || !ffprobe) return { ok: false, outcome: "video_transcoder_unavailable" };

	const directory = mkdtempSync(join(tmpdir(), "pi-tg-video-"));
	chmodSync(directory, 0o700);
	try {
		let sourcePath = input.sourcePath;
		if (!sourcePath) {
			sourcePath = join(directory, `source.${safeExtension(input.sourceExtension)}`);
			writeFileSync(sourcePath, input.sourceBytes, { mode: 0o600 });
		}
		const probe = await runner.run([
			ffprobe,
			"-v",
			"error",
			"-select_streams",
			"v:0",
			"-show_entries",
			"format=duration:stream=duration",
			"-of",
			"json",
			sourcePath,
		]);
		if (probe.exitCode !== 0) return { ok: false, outcome: "video_probe_failed" };
		const durationSeconds = parseDuration(probe.stdout);
		if (durationSeconds == null) return { ok: false, outcome: "video_probe_failed" };

		const positions = sampleVideoFrameFractions(frameCount(durationSeconds));
		const frames: VideoFrame[] = [];
		for (let index = 0; index < positions.length; index++) {
			const position = positions[index]!;
			const outputPath = join(directory, `frame-${index}.jpg`);
			const extraction = await runner.run([
				ffmpeg,
				"-nostdin",
				"-hide_banner",
				"-loglevel",
				"error",
				"-ss",
				(durationSeconds * position).toFixed(3),
				"-i",
				sourcePath,
				"-map",
				"0:v:0",
				"-frames:v",
				"1",
				"-vf",
				"scale=1280:1280:force_original_aspect_ratio=decrease",
				"-q:v",
				"3",
				"-y",
				outputPath,
			]);
			if (extraction.exitCode !== 0) return { ok: false, outcome: "video_frame_extraction_failed" };
			try {
				const stat = statSync(outputPath);
				if (!stat.isFile() || stat.size <= 0 || stat.size > VIDEO_FRAME_MAX_BYTES) {
					return { ok: false, outcome: "video_frame_extraction_failed" };
				}
				frames.push({ bytes: new Uint8Array(readFileSync(outputPath)), mimeType: "image/jpeg", position });
			} catch {
				return { ok: false, outcome: "video_frame_extraction_failed" };
			}
		}
		return frames.length > 0 ? { ok: true, durationSeconds, frames } : { ok: false, outcome: "video_no_frames" };
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}
