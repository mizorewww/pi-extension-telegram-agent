import { randomUUID } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";

/**
 * Pi session files only grow: everything before the latest compaction's kept window is dead for
 * the provider but is still parsed and held in memory on every start. On resume, rewrite the file
 * with just the live window (plus the latest model / thinking-level entries Pi derives settings
 * from), keeping the same session id. The rewrite is only installed when Pi builds a byte-identical
 * context from it; the original file is kept beside it as `<file>.pre-trim-<time>`.
 */
export function trimSessionBeforeCompaction(sessionFile: string, sessionDir: string, cwd: string): boolean {
	const source = SessionManager.open(sessionFile, sessionDir, cwd);
	const branch = source.getBranch();
	const compaction = branch.findLast((entry) => entry.type === "compaction");
	if (!compaction) return false;
	const firstKept = branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
	if (firstKept <= 0) return false;
	const dropped = branch.slice(0, firstKept);
	const settings = (["model_change", "thinking_level_change"] as const)
		.map((type) => dropped.findLast((entry) => entry.type === type))
		.filter((entry): entry is SessionEntry => entry != null);
	// Already trimmed: only the carried-over settings precede the kept window.
	if (dropped.length === settings.length) return false;
	let parentId: string | null = null;
	const entries = [...settings, ...branch.slice(firstKept).filter((entry) => entry.type !== "label")].map((entry) => {
		const rechained = { ...entry, parentId };
		parentId = entry.id;
		return rechained;
	});
	const temporary = `${sessionFile}.trim-${randomUUID()}`;
	writeFileSync(temporary, [source.getHeader(), ...entries].map((line) => `${JSON.stringify(line)}\n`).join(""), {
		flag: "wx",
		mode: 0o600,
	});
	const trimmed = SessionManager.open(temporary, sessionDir, cwd);
	if (JSON.stringify(trimmed.buildSessionContext()) !== JSON.stringify(source.buildSessionContext())) {
		rmSync(temporary, { force: true });
		return false;
	}
	renameSync(sessionFile, `${sessionFile}.pre-trim-${new Date().toISOString().replace(/[:.]/g, "-")}`);
	renameSync(temporary, sessionFile);
	return true;
}
