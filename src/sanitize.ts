// Terminal-safe text sanitization for TUI rendering.
// Group content (messages, usernames, sticker names, event payloads) is attacker-influenced:
// ANSI/OSC/DCS escape sequences could clear the screen, recolor text or write the clipboard
// (OSC 52) on the observer's terminal. \n and \t survive; everything else control-ish is removed.

export function sanitizeText(s: string): string {
	return s
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "") // OSC ... ST/BEL
		.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI sequences
		.replace(/\x1b[PX^_][\s\S]*?(?:\x1b\\|\x07|$)/g, "") // DCS/PM/APC/SOS
		.replace(/[\x00-\x08\x0b\x0c\x0d\x0e-\x1f\x7f]/g, ""); // remaining C0 + DEL
}

export function sanitize(v: string | null | undefined): string {
	return sanitizeText(v ?? "");
}
