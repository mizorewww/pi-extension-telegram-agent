import { createHash } from "node:crypto";
import { canonicalJson } from "./extensions/cache-observer.ts";

export interface ContextFingerprintInput {
	piVersion: string;
	provider: string;
	api: string;
	model: string;
	contextWindow: number;
	reasoningEffort: string;
	cacheRetention: string;
	cacheSchemaVersion: number;
	commonPromptSha256: string;
	personaSha256: string;
	serializerVersion: number;
	compactionPromptSha256: string;
	compactionModel: string;
	stickerCatalogSnapshotSha256: string;
	/** Media handling mode ("vision" | "context"); changes placeholder semantics and payload shape. */
	mediaMode: string;
	extensionOrder: readonly string[];
	tools: readonly { name: string; description: string; parameters: unknown }[];
}

export function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function buildContextFingerprint(input: ContextFingerprintInput): string {
	return sha256(canonicalJson(input));
}

export interface ResumableContextManifest {
	contextFingerprint: string;
	sessionFile: string;
}

/** Resume is all-or-nothing: byte identity and the retained session file must both match. */
export function canResumeContextSession(
	manifest: ResumableContextManifest | null,
	expectedFingerprint: string,
	sessionFileExists: boolean,
): boolean {
	return manifest?.contextFingerprint === expectedFingerprint && sessionFileExists;
}
