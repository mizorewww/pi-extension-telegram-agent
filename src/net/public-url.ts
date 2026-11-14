import { isIP } from "node:net";

export interface PublicHttpUrl {
	url: string;
	hostname: string;
}

function parseIpv4(hostname: string): [number, number, number, number] | undefined {
	if (isIP(hostname) !== 4) return undefined;
	const octets = hostname.split(".").map(Number);
	if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
	return octets as [number, number, number, number];
}

function isBlockedIpv4([a, b, c]: [number, number, number, number]): boolean {
	return (
		a === 0 ||
		a === 10 ||
		(a === 100 && b >= 64 && b <= 127) ||
		a === 127 ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 0 && c === 0) ||
		(a === 192 && b === 0 && c === 2) ||
		(a === 192 && b === 168) ||
		(a === 198 && (b === 18 || b === 19)) ||
		(a === 198 && b === 51 && c === 100) ||
		(a === 203 && b === 0 && c === 113) ||
		a >= 224
	);
}

function parseIpv6(hostname: string): number[] | undefined {
	let value = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (value.includes("%") || isIP(value) !== 6) return undefined;
	if (value.includes(".")) {
		const colon = value.lastIndexOf(":");
		const ipv4 = parseIpv4(value.slice(colon + 1));
		if (!ipv4) return undefined;
		value = `${value.slice(0, colon)}:${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
	}
	const halves = value.split("::");
	if (halves.length > 2) return undefined;
	const left = halves[0] ? halves[0].split(":") : [];
	const right = halves[1] ? halves[1].split(":") : [];
	const missing = 8 - left.length - right.length;
	if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return undefined;
	const words = [...left, ...Array(missing).fill("0"), ...right].map((word) => Number.parseInt(word, 16));
	if (words.length !== 8 || words.some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff))
		return undefined;
	return words;
}

function isBlockedIpv6(words: number[]): boolean {
	const allZero = words.every((word) => word === 0);
	const loopback = words.slice(0, 7).every((word) => word === 0) && words[7] === 1;
	if (allZero || loopback) return true;
	if ((words[0] & 0xfe00) === 0xfc00 || (words[0] & 0xffc0) === 0xfe80 || (words[0] & 0xffc0) === 0xfec0) return true;
	if ((words[0] & 0xff00) === 0xff00) return true;
	if (words[0] === 0x2001 && (words[1] === 0x0db8 || words[1] === 0x0000 || (words[1] === 0x0002 && words[2] === 0)))
		return true;
	if (words[0] === 0x0064 && words[1] === 0xff9b && (words[2] === 1 || words.slice(2, 6).every((w) => w === 0)))
		return true;
	if (words[0] === 0x2002) return isBlockedIpv4([words[1]! >> 8, words[1]! & 0xff, words[2]! >> 8, words[2]! & 0xff]);

	const embeddedIpv4 =
		words.slice(0, 6).every((word) => word === 0) ||
		(words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) ||
		(words.slice(0, 4).every((word) => word === 0) && words[4] === 0xffff && words[5] === 0);
	if (embeddedIpv4) return isBlockedIpv4([words[6]! >> 8, words[6]! & 0xff, words[7]! >> 8, words[7]! & 0xff]);
	return false;
}

/** Parse one literal public HTTP(S) URL without DNS resolution or network access. */
export function parsePublicHttpUrl(input: string, maxChars = 2_048): PublicHttpUrl | null {
	if (!input || input.length > maxChars) return null;
	let parsed: URL;
	try {
		parsed = new URL(input);
	} catch {
		return null;
	}
	if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) return null;
	const hostname = parsed.hostname
		.replace(/^\[|\]$/g, "")
		.replace(/\.$/, "")
		.toLowerCase();
	if (
		!hostname ||
		hostname === "localhost" ||
		hostname.endsWith(".localhost") ||
		hostname === "local" ||
		hostname.endsWith(".local")
	)
		return null;
	const ipv4 = parseIpv4(hostname);
	if (ipv4 && isBlockedIpv4(ipv4)) return null;
	const ipv6 = parseIpv6(hostname);
	if (ipv6 && isBlockedIpv6(ipv6)) return null;
	return { url: parsed.toString(), hostname };
}
