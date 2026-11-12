// Whether an unaddressed slice of the group deserves a turn. A classifier model reads only the
// recent lines (and, for Gemini, their images); it never sees the bot's context, so it adds nothing
// to the main provider prefix. Labelled examples are deployment data in a separate markdown file
// (decider.examples_path), not code. The default threshold is set for a warm bot: on 400 real
// slices labelled "a chatty member would join", 0.18 admits about 30% of ambient messages for both
// gemini-decision-1 with images and no examples (P 0.45 / R 0.81) and pplx-decider-v1.2 (0.44 / 0.79).
import { readFileSync } from "node:fs";
import type { ClassifierBoolQuestion } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { DeciderConfig } from "../config.ts";
import type { PreparedImage } from "../media/prepare-images.ts";
import { log } from "../observability/log.ts";

export const DEFAULT_DECIDER_THRESHOLD = 0.18;

const INSTRUCTIONS =
	"你在替群聊里的 bot「{name}」判断：读完 state 里的群聊片段后，{name} 现在要不要主动说话。{name} 爱捧场，对技术和新鲜事好奇，但有分寸：没话说就安静围观，不抢话、不刷屏。片段格式：[时间] #消息id 名字 (@用户名 · bot): 内容；带「· bot」的是机器人，{name} 自己的消息也会出现。state.earlier 是上下文，state.recent 是新消息。只根据新消息判断。";

const CRITERIA = {
	true: "新消息里有向全群提出、还没人回答的问题或求助；有人在接着 {name} 之前的话聊或追问；有人分享成果或好消息值得夸，或情绪低落需要安慰且还没人接；出现 {name} 感兴趣、能帮上忙而群里还没人回应的话题。",
	false:
		"群友之间在聊，或话是对特定的人、另一个 bot 说的；问题已经被别的 bot 或群友回答；只有 bot 在互相接话（会造成刷屏循环）；只是表情、附和、单独的链接或无意义内容；{name} 刚说过话且没人接话；话题低俗、敏感或已经冷掉。",
};

/** Images of one recent message, labelled with its #id in the slice. */
export interface DeciderMedia {
	messageId: number;
	kind: string;
	images: PreparedImage[];
}
export interface DeciderSlice {
	earlier: string;
	recent: string;
	media: DeciderMedia[];
}
export interface Decider {
	/** Whether the model looks at `media`; the runtime only prepares images when it does. */
	readonly seesImages: boolean;
	decide(slice: DeciderSlice): Promise<number | null>;
}

/** Pi 1.5 has no Gemini classifier; `google/<model>` calls the Gemini Decisions API directly. */
export const GEMINI_DECIDER_PROVIDER = "google";
const GEMINI_DECISIONS_URL = "https://generativelanguage.googleapis.com/v1beta/decisions";
const GEMINI_TIMEOUT_MS = 10_000;
const MEDIA_NOTE = "recent 里的图片、sticker 和视频截帧附在后面，每组前标明所属消息 #id；判断时结合画面内容。";

/** Startup fails when the configured classifier is unknown or unauthenticated. */
export function createDecider(
	runtime: ModelRuntime,
	config: DeciderConfig,
	name: string,
	geminiApiKey: string,
): Decider {
	const gemini = config.provider === GEMINI_DECIDER_PROVIDER;
	const fill = (text: string) => text.replaceAll("{name}", name);
	const examples = config.examplesPath ? readFileSync(config.examplesPath, "utf8").trim() : "";
	const question: ClassifierBoolQuestion = {
		type: "bool",
		instructions: fill(
			[INSTRUCTIONS, gemini ? MEDIA_NOTE : "", examples ? `下面是判断示例：\n\n${examples}` : ""]
				.filter(Boolean)
				.join(gemini ? "\n" : "\n\n"),
		),
		criteria: { true: fill(CRITERIA.true), false: fill(CRITERIA.false) },
	};
	if (gemini) {
		if (!geminiApiKey) throw new Error("decider provider google needs gemini_api_key in .env");
		return { seesImages: true, decide: (slice) => geminiDecision(geminiApiKey, config.model, question, slice) };
	}
	const model = runtime.getModelOfType("classifier", config.provider, config.model);
	if (!model) throw new Error(`decider model not found: ${config.provider}/${config.model}`);
	if (!runtime.hasConfiguredAuth(config.provider))
		throw new Error(`decider provider is not authenticated: ${config.provider}`);
	return {
		seesImages: false,
		decide: async ({ earlier, recent }) => {
			const result = await runtime.classify(model, { state: { earlier, recent }, questions: { reply: question } });
			const answer = result.answers.reply;
			if (result.stopReason !== "stop" || answer?.type !== "bool") {
				log.warn("decider", "failed", { outcome: result.stopReason });
				return null;
			}
			return answer.probability;
		},
	};
}

const MEDIA_LABEL: Record<string, string> = { photo: "图片", sticker: "sticker" };

async function geminiDecision(
	apiKey: string,
	model: string,
	question: ClassifierBoolQuestion,
	{ earlier, recent, media }: DeciderSlice,
): Promise<number | null> {
	let outcome: string;
	try {
		const response = await fetch(GEMINI_DECISIONS_URL, {
			method: "POST",
			headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
			body: JSON.stringify({
				model,
				// The instructions address the slice as state.earlier / state.recent, as Pi's classifier does.
				input: [
					{ type: "text", text: JSON.stringify({ state: { earlier, recent } }) },
					...media.flatMap(({ messageId, kind, images }) => [
						{ type: "text", text: `#${messageId} 的${MEDIA_LABEL[kind] ?? `${kind} 截帧`}：` },
						...images.map((image) => ({
							type: "image",
							mime_type: image.mimeType,
							data: Buffer.from(image.bytes).toString("base64"),
						})),
					]),
				],
				questions: {
					reply: {
						type: "noul",
						instructions: question.instructions,
						criteria: { true_description: question.criteria.true, false_description: question.criteria.false },
					},
				},
			}),
			signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
		});
		if (response.ok) {
			const body = (await response.json().catch(() => null)) as { answers?: { reply?: { noul?: unknown } } } | null;
			const probability = body?.answers?.reply?.noul;
			if (typeof probability === "number" && probability >= 0 && probability <= 1) return probability;
			outcome = "invalid_response";
		} else {
			await response.body?.cancel();
			outcome = response.status === 429 ? "http_429" : response.status >= 500 ? "http_5xx" : "http_4xx";
		}
	} catch (error) {
		outcome = error instanceof DOMException && error.name === "TimeoutError" ? "timeout" : "network";
	}
	log.warn("decider", "failed", { outcome });
	return null;
}
