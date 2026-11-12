// Whether an unaddressed slice of the group deserves a turn. A Pi classifier model reads only the
// recent lines; it never sees the bot's context, so it adds nothing to the main provider prefix.
// Labelled examples are deployment data in a separate markdown file (decider.examples_path), not
// code. Wording was tuned on 150 hand-labelled real slices. The default threshold is set for a warm bot: on 356 slices labelled "a chatty member would join",
// 0.15 gives reply precision 0.52 / recall 0.57 and admits about a third of ambient messages.
import { readFileSync } from "node:fs";
import type { ClassifierBoolQuestion } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { DeciderConfig } from "../config.ts";
import { log } from "../observability/log.ts";

export const DEFAULT_DECIDER_THRESHOLD = 0.15;

const INSTRUCTIONS =
	"你在替群聊里的 bot「{name}」判断：读完 state 里的群聊片段后，{name} 现在要不要主动说话。{name} 爱捧场，对技术和新鲜事好奇，但有分寸：没话说就安静围观，不抢话、不刷屏。片段格式：[时间] #消息id 名字 (@用户名 · bot): 内容；带「· bot」的是机器人，{name} 自己的消息也会出现。state.earlier 是上下文，state.recent 是新消息。只根据新消息判断。";

const CRITERIA = {
	true: "新消息里有向全群提出、还没人回答的问题或求助；有人在接着 {name} 之前的话聊或追问；有人分享成果或好消息值得夸，或情绪低落需要安慰且还没人接；出现 {name} 感兴趣、能帮上忙而群里还没人回应的话题。",
	false:
		"群友之间在聊，或话是对特定的人、另一个 bot 说的；问题已经被别的 bot 或群友回答；只有 bot 在互相接话（会造成刷屏循环）；只是表情、附和、单独的链接或无意义内容；{name} 刚说过话且没人接话；话题低俗、敏感或已经冷掉。",
};

export type Decider = (slice: { earlier: string; recent: string }) => Promise<number | null>;

/** Startup fails when the configured classifier is unknown or unauthenticated. */
export function createDecider(runtime: ModelRuntime, config: DeciderConfig, name: string): Decider {
	const model = runtime.getModelOfType("classifier", config.provider, config.model);
	if (!model) throw new Error(`decider model not found: ${config.provider}/${config.model}`);
	if (!runtime.hasConfiguredAuth(config.provider))
		throw new Error(`decider provider is not authenticated: ${config.provider}`);
	const fill = (text: string) => text.replaceAll("{name}", name);
	const examples = config.examplesPath ? readFileSync(config.examplesPath, "utf8").trim() : "";
	const question: ClassifierBoolQuestion = {
		type: "bool",
		instructions: fill(examples ? `${INSTRUCTIONS}\n\n下面是判断示例：\n\n${examples}` : INSTRUCTIONS),
		criteria: { true: fill(CRITERIA.true), false: fill(CRITERIA.false) },
	};
	return async ({ earlier, recent }) => {
		const result = await runtime.classify(model, { state: { earlier, recent }, questions: { reply: question } });
		const answer = result.answers.reply;
		if (result.stopReason !== "stop" || answer?.type !== "bool") {
			log.warn("decider", "failed", { outcome: result.stopReason });
			return null;
		}
		return answer.probability;
	};
}
