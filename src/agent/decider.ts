// Whether an unaddressed slice of the group deserves a turn. A Pi classifier model reads only the
// recent lines; it never sees the bot's context, so it adds nothing to the main provider prefix.
// Wording and examples were tuned on 150 hand-labelled real slices; the examples are invented. The
// default threshold is set for a warm bot: on 356 slices labelled "a chatty member would join",
// 0.15 gives reply precision 0.52 / recall 0.57 and admits about a third of ambient messages.
import type { ClassifierBoolQuestion } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { DeciderConfig } from "../config.ts";
import { log } from "../observability/log.ts";

export const DEFAULT_DECIDER_THRESHOLD = 0.15;

const INSTRUCTIONS =
	"你在替群聊里的 bot「{name}」判断：读完 state 里的群聊片段后，{name} 现在要不要主动说话。{name} 爱捧场，对技术和新鲜事好奇，但有分寸：没话说就安静围观，不抢话、不刷屏。片段格式：[时间] #消息id 名字 (@用户名 · bot): 内容；带「· bot」的是机器人，{name} 自己的消息也会出现。state.earlier 是上下文，state.recent 是新消息。只根据新消息判断。";

/** Rendered in the runtime line format; `{name}` is the bot, everyone else a placeholder. */
const EXAMPLES: readonly (readonly [chat: string, reply: boolean, why: string])[] = [
	[
		"[21:40:02] #1001 群友A (@user_a): 有人知道容器里的时区怎么改吗？试了好几种都不生效",
		true,
		"向全群提出的技术问题，还没人回答",
	],
	[
		"[14:02:10] #2001 群友A (@user_a): [图片] 这个报错是什么意思\n[14:02:25] #2002 某个bot (@bot_x · bot): 看着是证书过期了，先把系统时间校准再试试\n[14:02:40] #2003 群友A (@user_a): 好 我试试",
		false,
		"问题已经被别的 bot 回答，提问者正在处理",
	],
	[
		"[23:10:01] #3001 某个bot (@bot_x · bot): 今晚月亮好圆\n[23:10:05] #3002 另一个bot (@bot_y · bot): 适合熬夜写代码（\n[23:10:12] #3003 某个bot (@bot_x · bot): 熬夜伤身喵",
		false,
		"只有 bot 在互相接话，再加入会变成 bot 刷屏循环",
	],
	[
		"[19:20:11] #4001 群友A (@user_a): 你周末去哪玩了\n[19:20:30] #4002 群友B (@user_b): 去爬山了 腿废了\n[19:20:41] #4003 群友A (@user_a): 哈哈哈早说我也去",
		false,
		"两个群友之间的闲聊，没有留出插话的空间",
	],
	[
		"[10:05:02] #5001 群友A (@user_a): 显示器突然闪屏\n[10:05:20] #5002 {name} (@self_bot · bot): 先换根线试试？很多时候是线松了\n[10:07:45] #5003 群友A (@user_a): 换了线还是闪，会是显卡的问题吗",
		true,
		"在接着 {name} 刚才的话追问",
	],
	["[16:30:00] #6001 群友A (@user_a): @bot_x 帮我查下明天天气", false, "点名让另一个 bot 做事"],
	[
		"[01:12:30] #7001 群友A (@user_a): 面试又挂了…感觉自己什么都做不好\n[01:13:10] #7002 群友A (@user_a): [sticker 😢]",
		true,
		"情绪低落，没人接，适合安慰",
	],
	["[20:15:00] #8001 群友A (@user_a): [图片] 折腾了一周的小项目终于跑起来了！", true, "分享成果，值得捧场"],
	[
		"[12:00:01] #9001 {name} (@self_bot · bot): 午饭记得吃点好的\n[12:00:20] #9002 群友A (@user_a): 哈哈\n[12:00:22] #9003 群友B (@user_b): [sticker 👍]",
		false,
		"{name} 刚说过话，后面只有附和和表情",
	],
	["[18:44:10] #10001 群友A (@user_a): https://example.com/post/123", false, "只有一个链接，没有话题"],
	[
		"[15:20:00] #11001 群友A (@user_a): 刚发现某个新模型写中文推理比英文快一倍，有点意思",
		true,
		"{name} 感兴趣的新发现，群里还没人接",
	],
	[
		"[22:01:00] #12001 群友A (@user_a): 这个币还能拿吗\n[22:01:08] #12002 某个bot (@bot_x · bot): 看你的止损线，别追高\n[22:01:12] #12003 另一个bot (@bot_y · bot): 短线波动大，仓位控制好\n[22:01:30] #12004 群友B (@user_b): 我已经割了",
		false,
		"已经有多个 bot 回应过，再说就是刷屏",
	],
	["[11:11:00] #13001 群友C (@user_c): 群里这些 bot 能看图片吗？", true, "新人向全群提问，没人回答"],
	[
		"[09:30:00] #14001 群友A (@user_a): 早\n[09:30:40] #14002 群友B (@user_b): 早 你今天几点下班\n[09:31:05] #14003 群友A (@user_a): 六点吧",
		false,
		"两人之间的问答，问题是问特定的人",
	],
];

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
	const examples = EXAMPLES.map(
		([chat, reply, why], index) => `例${index + 1}：\n${chat}\n→ ${reply ? "应该发言" : "不发言"}（${why}）`,
	);
	const question: ClassifierBoolQuestion = {
		type: "bool",
		instructions: fill(`${INSTRUCTIONS}\n\n下面是判断示例：\n\n${examples.join("\n\n")}`),
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
