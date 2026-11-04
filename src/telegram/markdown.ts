import { Marked, type Token, type Tokens } from "@earendil-works/pi-tui";
import { parsePublicHttpUrl } from "../net/public-url.ts";

const MARKED = new Marked();
const MAX_CODE_POINTS = 4096;
const MAX_TOKEN_NODES = 4096;

export interface TelegramFormattedMessage {
	text: string;
	html: string;
}

export type TelegramMarkdownErrorCategory = "empty" | "too_long" | "too_complex" | "invalid";
export class TelegramMarkdownError extends Error {
	constructor(public readonly category: TelegramMarkdownErrorCategory) {
		super(`telegram_markdown_${category}`);
	}
}

const escapeHtml = (text: string) =>
	text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

function literal(text: string, styles: readonly string[] = []): TelegramFormattedMessage {
	return { text, html: text ? styles.reduceRight((html, tag) => `<${tag}>${html}</${tag}>`, escapeHtml(text)) : "" };
}

function join(parts: readonly TelegramFormattedMessage[], separator: string): TelegramFormattedMessage {
	const nonempty = parts.filter((part) => part.text);
	return {
		text: nonempty.map((part) => part.text).join(separator),
		html: nonempty.map((part) => part.html).join(separator),
	};
}

/** Telegram forbids links/quotes nesting with each other or code; retain their content. */
function surround(part: TelegramFormattedMessage, tag: string, attributes = ""): TelegramFormattedMessage {
	return !part.text || /<(?:a|blockquote|code|pre)\b/.test(part.html)
		? part
		: { text: part.text, html: `<${tag}${attributes}>${part.html}</${tag}>` };
}

class Renderer {
	private nodes = 0;

	render(tokens: readonly Token[], separator = "\n\n", styles: readonly string[] = []): TelegramFormattedMessage {
		return join(
			tokens.map((token) => this.token(token, styles)),
			separator,
		);
	}

	private token(token: Token, styles: readonly string[]): TelegramFormattedMessage {
		if (++this.nodes > MAX_TOKEN_NODES) throw new TelegramMarkdownError("too_complex");
		switch (token.type) {
			case "space":
			case "def":
				return literal("");
			case "paragraph":
				return this.render((token as Tokens.Paragraph).tokens, "", styles);
			case "heading":
			case "strong":
			case "em":
			case "del": {
				const tag = token.type === "em" ? "i" : token.type === "del" ? "s" : "b";
				return this.render((token as Tokens.Strong).tokens, "", [...styles, tag]);
			}
			case "text": {
				const text = token as Tokens.Text;
				return text.tokens ? this.render(text.tokens, "", styles) : literal(text.text, styles);
			}
			case "escape":
			case "html":
				return literal((token as Tokens.Text).text, styles);
			case "br":
				return literal("\n");
			case "hr":
				return literal("———");
			case "checkbox":
				return literal((token as Tokens.Checkbox).checked ? "[x] " : "[ ] ", styles);
			case "code":
			case "codespan": {
				const code = token as Tokens.Code;
				const part = literal(code.text);
				if (!part.text) return part;
				const language = code.lang?.trim().split(/\s+/, 1)[0];
				const attribute = language && /^[A-Za-z0-9_+-]{1,64}$/.test(language) ? ` class="language-${language}"` : "";
				return {
					text: part.text,
					html:
						token.type === "code" ? `<pre><code${attribute}>${part.html}</code></pre>` : `<code>${part.html}</code>`,
				};
			}
			case "link": {
				const link = token as Tokens.Link;
				const label = this.render(link.tokens, "", styles);
				const url = parsePublicHttpUrl(link.href);
				return url ? surround(label, "a", ` href="${escapeHtml(url.url)}"`) : label;
			}
			case "image": {
				const image = token as Tokens.Image;
				return image.tokens?.length ? this.render(image.tokens, "", styles) : literal(image.text, styles);
			}
			case "blockquote":
				return surround(this.render((token as Tokens.Blockquote).tokens), "blockquote");
			case "list": {
				const list = token as Tokens.List;
				const start = typeof list.start === "number" ? list.start : 1;
				return join(
					list.items.map((item, index) => {
						if (++this.nodes > MAX_TOKEN_NODES) throw new TelegramMarkdownError("too_complex");
						const part = this.render(item.tokens, "\n");
						const marker = list.ordered ? `${start + index}. ` : "• ";
						return {
							text: marker + part.text.replaceAll("\n", "\n  "),
							html: marker + part.html.replaceAll("\n", "\n  "),
						};
					}),
					"\n",
				);
			}
			case "table": {
				const table = token as Tokens.Table;
				return join(
					[table.header, ...table.rows].map((row, index) =>
						join(
							row.map((cell) => this.render(cell.tokens, "", index === 0 ? ["b"] : [])),
							" | ",
						),
					),
					"\n",
				);
			}
			default: {
				const generic = token as Tokens.Generic;
				return generic.tokens?.length
					? this.render(generic.tokens, "", styles)
					: literal(typeof generic.text === "string" ? generic.text : generic.raw, styles);
			}
		}
	}
}

/** Markdown syntax is local; Telegram parses formatting and computes UTF-16 entity offsets. */
export function formatTelegramMarkdown(markdown: string): TelegramFormattedMessage {
	if (!markdown.trim()) throw new TelegramMarkdownError("empty");
	if ([...markdown].length > MAX_CODE_POINTS) throw new TelegramMarkdownError("too_long");
	try {
		const rendered = new Renderer().render(MARKED.Lexer.lex(markdown, { gfm: true, breaks: false }));
		if (!rendered.text.trim()) throw new TelegramMarkdownError("empty");
		if ([...rendered.text].length > MAX_CODE_POINTS) throw new TelegramMarkdownError("too_long");
		return rendered;
	} catch (error) {
		if (error instanceof TelegramMarkdownError) throw error;
		throw new TelegramMarkdownError("invalid");
	}
}
