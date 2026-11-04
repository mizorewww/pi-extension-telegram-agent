// ffmpeg is the only Telegram-specific image source Pi does not provide.
import { execFile } from "node:child_process";
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

export const VIDEO_FRAME_MAX = 3;
export type VideoFrameOutcome =
	| "video_transcoder_unavailable"
	| "video_probe_failed"
	| "video_frame_extraction_failed"
	| "video_no_frames";
export interface VideoFrame {
	bytes: Uint8Array;
	mimeType: "image/jpeg";
	position: number;
}
export type VideoFrameResult =
	| { ok: true; durationSeconds: number; frames: VideoFrame[] }
	| { ok: false; outcome: VideoFrameOutcome };
export interface VideoFrameInput {
	sourcePath: string | null;
	bytes: Uint8Array;
}
const exec = promisify(execFile);
function which(command: string): string | undefined {
	return (process.env.PATH ?? "/usr/bin:/bin")
		.split(delimiter)
		.map((dir) => join(dir, command))
		.find((path) => {
			try {
				accessSync(path, constants.X_OK);
				return true;
			} catch {
				return false;
			}
		});
}
export function inspectVideoTranscoder(): boolean {
	return Boolean(which("ffmpeg") && which("ffprobe"));
}
export function sampleVideoFrameFractions(count = VIDEO_FRAME_MAX): number[] {
	return count <= 0 ? [] : count === 1 ? [0.5] : count === 2 ? [1 / 3, 2 / 3] : [0.2, 0.5, 0.8];
}
async function run(command: string, args: string[]): Promise<string> {
	return (
		await exec(command, args, { timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, encoding: "utf8" })
	).stdout;
}
export async function extractVideoFrames(input: VideoFrameInput): Promise<VideoFrameResult> {
	const ffmpeg = which("ffmpeg"),
		ffprobe = which("ffprobe");
	if (!ffmpeg || !ffprobe) return { ok: false, outcome: "video_transcoder_unavailable" };
	const directory = mkdtempSync(join(tmpdir(), "pi-tg-video-"));
	try {
		const source = input.sourcePath ?? join(directory, "source.bin");
		if (!input.sourcePath) writeFileSync(source, input.bytes, { mode: 0o600 });
		let durationSeconds: number;
		try {
			const probe = JSON.parse(
				await run(ffprobe, [
					"-v",
					"error",
					"-select_streams",
					"v:0",
					"-show_entries",
					"format=duration:stream=duration",
					"-of",
					"json",
					source,
				]),
			) as { format?: { duration?: string }; streams?: { duration?: string }[] };
			durationSeconds =
				[probe.streams?.[0]?.duration, probe.format?.duration].map(Number).find((n) => Number.isFinite(n) && n > 0) ??
				0;
			if (!durationSeconds) return { ok: false, outcome: "video_probe_failed" };
		} catch {
			return { ok: false, outcome: "video_probe_failed" };
		}
		const frames: VideoFrame[] = [];
		for (const [i, position] of sampleVideoFrameFractions(
			durationSeconds < 1 ? 1 : durationSeconds < 3 ? 2 : VIDEO_FRAME_MAX,
		).entries()) {
			const output = join(directory, `frame-${i}.jpg`);
			try {
				await run(ffmpeg, [
					"-nostdin",
					"-hide_banner",
					"-loglevel",
					"error",
					"-ss",
					(durationSeconds * position).toFixed(3),
					"-i",
					source,
					"-map",
					"0:v:0",
					"-frames:v",
					"1",
					"-vf",
					"scale=1024:1024:force_original_aspect_ratio=decrease",
					"-q:v",
					"3",
					"-y",
					output,
				]);
				const bytes = readFileSync(output);
				if (!bytes.length) return { ok: false, outcome: "video_no_frames" };
				frames.push({ bytes, mimeType: "image/jpeg", position });
			} catch {
				return { ok: false, outcome: "video_frame_extraction_failed" };
			}
		}
		return { ok: true, durationSeconds, frames };
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}
