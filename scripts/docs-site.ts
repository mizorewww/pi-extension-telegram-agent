import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

export const MDBOOK_VERSION = "0.5.4";
export const PAGES_ORIGIN = "https://mizorewww.github.io";
export const PAGES_PATH_PREFIX = "/pi-extension-telegram-agent/";

const BOOKS = [
	{ language: "zh", root: "docs/user-guide/zh" },
	{ language: "en", root: "docs/user-guide/en" },
] as const;

const LANDING_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pi Telegram Agent guides</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { display: grid; min-height: 100vh; margin: 0; place-items: center; }
    main { max-width: 40rem; padding: 2rem; text-align: center; }
    nav { display: flex; flex-wrap: wrap; gap: 1rem; justify-content: center; }
    a { border: 1px solid currentColor; border-radius: .5rem; padding: .75rem 1rem; }
  </style>
</head>
<body>
  <main>
    <h1>Pi Telegram Agent</h1>
    <p>Choose a language · 选择语言</p>
    <nav aria-label="Documentation languages">
      <a href="./zh/" lang="zh-CN">中文用户指南</a>
      <a href="./en/" lang="en">English user guide</a>
    </nav>
  </main>
</body>
</html>
`;

export interface CommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

function run(command: readonly string[], cwd: string): Promise<CommandResult> {
	return new Promise((resolve) => {
		execFile(command[0]!, command.slice(1), { cwd, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
			resolve({ exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
		});
	});
}

export interface LinkIssue {
	file: string;
	href: string;
	reason: string;
}

export interface LinkReport {
	files: number;
	links: number;
	issues: LinkIssue[];
}

function walkFiles(root: string, predicate: (path: string) => boolean): string[] {
	if (!existsSync(root)) return [];
	const files: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) files.push(...walkFiles(path, predicate));
		else if (entry.isFile() && predicate(path)) files.push(path);
	}
	return files.sort();
}

function within(root: string, target: string): boolean {
	const path = relative(root, target);
	return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

function decodeHtml(value: string): string {
	return value
		.replaceAll("&amp;", "&")
		.replaceAll("&quot;", '"')
		.replaceAll("&#39;", "'")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">");
}

function decodePath(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function extractMarkdownHrefs(source: string): string[] {
	const hrefs: string[] = [];
	const markdown = /!?\[[^\]]*\]\(\s*(<[^>]+>|[^)\s]+)(?:\s+["'][^"']*["'])?\s*\)/g;
	const html = /\bhref\s*=\s*["']([^"']+)["']/gi;
	for (const match of source.matchAll(markdown)) {
		hrefs.push(match[1]!.replace(/^<|>$/g, ""));
	}
	for (const match of source.matchAll(html)) hrefs.push(decodeHtml(match[1]!));
	return hrefs;
}

function isExternalHref(href: string): boolean {
	return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href);
}

export function checkMarkdownLinks(rootDir: string, files: readonly string[]): LinkReport {
	const issues: LinkIssue[] = [];
	let links = 0;
	for (const file of files) {
		for (const href of extractMarkdownHrefs(readFileSync(file, "utf8"))) {
			links += 1;
			if (href.startsWith("#") || isExternalHref(href)) continue;
			const pathPart = decodePath(href.split("#", 1)[0]!.split("?", 1)[0]!);
			if (!pathPart) continue;
			const target = resolve(dirname(file), pathPart);
			if (!within(rootDir, target)) {
				issues.push({ file: relative(rootDir, file), href, reason: "escapes repository root" });
			} else if (!existsSync(target)) {
				issues.push({ file: relative(rootDir, file), href, reason: "target does not exist" });
			}
		}
	}
	return { files: files.length, links, issues };
}

export function checkRepositoryMarkdownLinks(rootDir: string): LinkReport {
	const files = [
		resolve(rootDir, "README.md"),
		resolve(rootDir, "README.en.md"),
		...BOOKS.flatMap((book) => walkFiles(resolve(rootDir, book.root, "src"), (path) => path.endsWith(".md"))),
	];
	return checkMarkdownLinks(rootDir, files);
}

function extractHtmlHrefs(source: string): string[] {
	return [...source.matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi)].map((match) => decodeHtml(match[1]!));
}

function htmlIds(path: string, cache: Map<string, Set<string>>): Set<string> {
	const cached = cache.get(path);
	if (cached) return cached;
	const ids = new Set<string>();
	for (const match of readFileSync(path, "utf8").matchAll(/\b(?:id|name)\s*=\s*["']([^"']+)["']/gi)) {
		ids.add(decodeHtml(match[1]!));
	}
	cache.set(path, ids);
	return ids;
}

function localHtmlTarget(siteDir: string, sourceFile: string, href: string): { path: string; hash: string } | null {
	if (/^(?:mailto|tel|javascript|data):/i.test(href) || href.startsWith("//")) return null;
	const sourceRelative = relative(siteDir, sourceFile).split(sep).join("/");
	let url: URL;
	try {
		url = new URL(href, `https://generated.invalid/${sourceRelative}`);
	} catch {
		return { path: "", hash: "" };
	}

	let relativePath: string;
	if (url.origin === PAGES_ORIGIN) {
		if (!url.pathname.startsWith(PAGES_PATH_PREFIX)) return null;
		relativePath = url.pathname.slice(PAGES_PATH_PREFIX.length);
	} else if (url.origin === "https://generated.invalid") {
		relativePath = url.pathname.startsWith(PAGES_PATH_PREFIX)
			? url.pathname.slice(PAGES_PATH_PREFIX.length)
			: url.pathname.replace(/^\//, "");
	} else {
		return null;
	}

	let target = resolve(siteDir, decodePath(relativePath));
	if (!within(siteDir, target)) return { path: "", hash: decodePath(url.hash.slice(1)) };
	if (existsSync(target) && statSync(target).isDirectory()) target = join(target, "index.html");
	else if (!existsSync(target) && extname(target) === "" && existsSync(`${target}.html`)) target = `${target}.html`;
	return { path: target, hash: decodePath(url.hash.slice(1)) };
}

export function checkGeneratedHtmlLinks(siteDir: string): LinkReport {
	const files = walkFiles(siteDir, (path) => path.endsWith(".html"));
	const issues: LinkIssue[] = [];
	const ids = new Map<string, Set<string>>();
	let links = 0;

	for (const file of files) {
		for (const href of extractHtmlHrefs(readFileSync(file, "utf8"))) {
			links += 1;
			const target = localHtmlTarget(siteDir, file, href);
			if (!target) continue;
			if (!target.path || !existsSync(target.path)) {
				issues.push({ file: relative(siteDir, file), href, reason: "generated target does not exist" });
				continue;
			}
			if (target.hash && target.path.endsWith(".html") && !htmlIds(target.path, ids).has(target.hash)) {
				issues.push({ file: relative(siteDir, file), href, reason: `missing fragment #${target.hash}` });
			}
		}
	}

	return { files: files.length, links, issues };
}

function assertClean(report: LinkReport, label: string): void {
	if (report.issues.length === 0) return;
	const details = report.issues.map((issue) => `- ${issue.file}: ${issue.href} (${issue.reason})`).join("\n");
	throw new Error(`${label} found ${report.issues.length} broken link(s):\n${details}`);
}

function verifyLanguageSwitches(siteDir: string): void {
	const pairs = [
		["zh/index.html", `${PAGES_ORIGIN}${PAGES_PATH_PREFIX}en/`],
		["en/index.html", `${PAGES_ORIGIN}${PAGES_PATH_PREFIX}zh/`],
	] as const;
	for (const [page, href] of pairs) {
		const source = readFileSync(resolve(siteDir, page), "utf8");
		if (!source.includes(`href="${href}"`)) {
			throw new Error(`${page} does not link to the other published language.`);
		}
	}
}

async function requireMdBook(rootDir: string): Promise<string> {
	const binary = process.env.MDBOOK_BIN || "mdbook";
	const result = await run([binary, "--version"], rootDir);
	if (result.exitCode !== 0) {
		throw new Error(
			`mdBook ${MDBOOK_VERSION} is required. Install it with: cargo install mdbook --version ${MDBOOK_VERSION} --locked`,
		);
	}
	const output = `${result.stdout}\n${result.stderr}`;
	if (!new RegExp(`(?:^|\\D)v?${MDBOOK_VERSION.replaceAll(".", "\\.")}(?:\\D|$)`).test(output)) {
		throw new Error(`Expected mdBook ${MDBOOK_VERSION}, received: ${output.trim() || "unknown version"}`);
	}
	return binary;
}

function resetSiteDir(rootDir: string): string {
	const siteDir = resolve(rootDir, "build/docs");
	if (!within(rootDir, siteDir) || relative(rootDir, siteDir) !== join("build", "docs")) {
		throw new Error("Refusing to reset an unexpected documentation output path.");
	}
	rmSync(siteDir, { recursive: true, force: true });
	mkdirSync(siteDir, { recursive: true });
	return siteDir;
}

export async function buildDocumentation(rootDir: string): Promise<string> {
	const mdbook = await requireMdBook(rootDir);
	const siteDir = resetSiteDir(rootDir);
	for (const book of BOOKS) {
		const result = await run(
			[mdbook, "build", resolve(rootDir, book.root), "--dest-dir", resolve(siteDir, book.language)],
			rootDir,
		);
		if (result.exitCode !== 0) {
			throw new Error(`mdBook ${book.language} build failed:\n${result.stderr.trim() || result.stdout.trim()}`);
		}
	}
	writeFileSync(resolve(siteDir, "index.html"), LANDING_HTML);
	writeFileSync(resolve(siteDir, ".nojekyll"), "");
	return siteDir;
}

export async function checkDocumentation(rootDir: string): Promise<LinkReport[]> {
	const siteDir = await buildDocumentation(rootDir);
	const source = checkRepositoryMarkdownLinks(rootDir);
	const generated = checkGeneratedHtmlLinks(siteDir);
	assertClean(source, "Markdown source check");
	assertClean(generated, "Generated site check");
	verifyLanguageSwitches(siteDir);
	writeFileSync(
		resolve(siteDir, "verification.json"),
		`${JSON.stringify(
			{
				mdbookVersion: MDBOOK_VERSION,
				books: BOOKS.map((book) => book.language),
				source: { files: source.files, links: source.links },
				generated: { files: generated.files, links: generated.links },
			},
			null,
			2,
		)}\n`,
	);
	return [source, generated];
}

if (import.meta.main) {
	const rootDir = process.cwd();
	const command = process.argv[2] ?? "check";
	try {
		if (command === "build") {
			const siteDir = await buildDocumentation(rootDir);
			console.log(`Built zh/en documentation in ${relative(rootDir, siteDir)} with mdBook ${MDBOOK_VERSION}.`);
		} else if (command === "check") {
			const [source, generated] = await checkDocumentation(rootDir);
			console.log(
				`Documentation OK: ${source.files} Markdown files / ${source.links} links; ${generated.files} HTML files / ${generated.links} links.`,
			);
		} else {
			throw new Error("Usage: node dist/scripts/docs-site.js <build|check>");
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : "Documentation build failed.");
		process.exitCode = 1;
	}
}
