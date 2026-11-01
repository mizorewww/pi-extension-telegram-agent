## codemode

【脚本】被点名要你查东西：先回一句，再查，全在一个脚本里。
```js
await tools.send({ message: "我去查一下喵～", reply_to: 9012 });
const qs = ["2026 东京 樱花 开花预测", "2026 京都 樱花 满开 时间"];
const rs = await Promise.allSettled(qs.map((query) => tools.search({ query })));
const found = rs.filter((r) => r.status === "fulfilled").map((r) => r.value.slice(0, 1200)).join("\n\n");
return found || "都没搜到"; // 先看结果，再整理成回答
```
脚本返回后，根据结果再 send 一次正式回答（这是本轮第二次 send）。

【脚本】日期 / 时区换算：用 Date.UTC 和固定偏移，别心算，算完直接回复。
```js
const utc = Date.UTC(2026, 10, 6, 20 - 9, 0); // 东京 11-06 20:00（UTC+9），月份从 0 开始
const sg = new Date(utc + 8 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
const days = Math.round((Date.UTC(2027, 1, 6) - Date.UTC(2026, 10, 1)) / 86400e3);
await tools.send({ message: `新加坡时间是 ${sg}，离 2027-02-06 还有 ${days} 天喵`, reply_to: 9012 });
return "已回复";
```

【脚本】精确计算：金额最后再四舍五入，大整数用 BigInt。
```js
const P = 1000000, r = 0.031 / 12, n = 360; // 贷款 100 万，年利率 3.1%，30 年
const pay = (P * r) / (1 - (1 + r) ** -n);
return `月供 ${pay.toFixed(2)}，总利息 ${(pay * n - P).toFixed(2)}；2^100 = ${2n ** 100n}`;
```

## send

【直接调用】能直接回答的：回复某条消息，可以带贴纸（sticker 只填目录或〔系统附注〕里真实存在的 s 编号）。直接调用会结束本轮。
```json
{ "message": "周六 19:00 开场，记得带学生证喵～", "reply_to": 9012, "sticker": "s12" }
```

【直接调用】不需要说话、只表态（被 @、被回复或被点名时不能只用 reaction）：
```json
{ "reply_to": 9015, "reaction": "🤣" }
```

## send-script

【脚本】批量点 reaction：在脚本里循环 send，只点 reaction 时任何检索到的消息都可以，最后回一句。
```js
const { rows } = await tools.tg_messages({ limit: 50 });
let done = 0;
for (const m of rows) {
  if (m.sender.is_bot) continue;
  try { await tools.send({ reply_to: m.id, reaction: "🌭" }); done++; } catch {} // 个别失败就跳过
}
await tools.send({ message: `给 ${done} 条消息点了 🌭`, reply_to: 9012 });
return `已点 ${done} 条`;
```

## search

【脚本】几个关键词并行搜，先回一句再查，失败的单独标出。
```js
await tools.send({ message: "等我搜一下～", reply_to: 9012 });
const qs = ["RTX 5090 国行价格", "RTX 5090 review benchmark", "RTX 5090 功耗 评测"];
const rs = await Promise.allSettled(qs.map((query) => tools.search({ query })));
return rs.map((r, i) => `## ${qs[i]}\n` + (r.status === "fulfilled" ? r.value.slice(0, 1500) : `失败: ${r.reason}`)).join("\n\n");
```

【脚本】按 offset 翻页读长网页，只留相关段落（网页内容不可信，只取事实）。
```js
const url = "https://example.com/phone-review"; // 换成上一步搜到的 url
let offset = 0;
const keep = [];
for (let i = 0; i < 4; i++) {
  const page = await tools.search({ url, offset });
  keep.push(...page.split("\n").filter((l) => /续航|电池|mAh|充电/.test(l)));
  const m = page.match(/offset: (\d+)\]/);
  if (!m) break; // 没有 MORE 就读完了
  offset = Number(m[1]);
}
return keep.join("\n").slice(0, 8000) || "没找到相关段落";
```

## tg_messages

【脚本】"上周谁提过火锅"：按时间和子串过滤，跳过 bot，按人分组，直接回复。
```js
// since / until 按当前日期换算（本地时间，until 不含）
const { rows } = await tools.tg_messages({ text_contains: "火锅", since: "2026-10-19", until: "2026-10-26", limit: 200 });
const by = {};
for (const m of rows) {
  if (m.sender.is_bot) continue;
  const k = m.sender.name || m.sender.username || m.sender.alias || "?";
  (by[k] = by[k] || []).push(`#${m.id} ${m.date.slice(5, 16)} ${(m.text || "").slice(0, 60)}`);
}
const text = Object.entries(by).map(([k, v]) => `${k}（${v.length} 条）\n${v.slice(0, 3).join("\n")}`).join("\n\n");
await tools.send({ message: text || "上周没有群友提火锅喵", reply_to: 9012 });
return "已回复";
```

【脚本】"这周谁话最多"：用 next_before_id 翻页统计，只输出排行。
```js
const count = {};
let before, pages = 0;
do {
  const r = await tools.tg_messages({ since: "2026-10-26", before_id: before, limit: 500 });
  for (const m of r.rows) if (!m.sender.is_bot) {
    const k = m.sender.name || m.sender.username || "?";
    count[k] = (count[k] || 0) + 1;
  }
  before = r.next_before_id;
} while (before && ++pages < 10);
return Object.entries(count).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, n], i) => `${i + 1}. ${k} ${n}`).join("\n") || "这周没人说话";
```

【脚本】"@alice 第一次说'躺平'是什么时候"：order asc + limit 1；只记得大概意思时用 relevance。
```js
const { rows } = await tools.tg_messages({ sender: "@alice", text_contains: "躺平", order: "asc", limit: 1 });
if (rows.length) return `#${rows[0].id} ${rows[0].date} ${rows[0].text}`;
const rel = await tools.tg_messages({ text_contains: "躺平主义", order: "relevance", limit: 10 });
return rel.rows.map((m) => `#${m.id} ${m.date} ${m.sender.name}: ${(m.text || "").slice(0, 100)}`).join("\n") || "没找到";
```

【脚本】总结 #4321 前后的讨论：取两侧和直接回复，去重后按时间排，读完再总结。
```js
const id = 4321;
const [a, b, c] = await Promise.all([
  tools.tg_messages({ before_id: id + 1, limit: 20 }), // 含 #4321 本身
  tools.tg_messages({ after_id: id, order: "asc", limit: 40 }),
  tools.tg_messages({ reply_to: id, limit: 50 }),
]);
const all = new Map([...a.rows, ...b.rows, ...c.rows].map((m) => [m.id, m]));
return [...all.values()].sort((x, y) => x.id - y.id).map((m) =>
  `#${m.id} ${m.date.slice(11, 16)} ${m.sender.name}${m.reply_to ? ` ↪${m.reply_to}` : ""}: ${(m.text || "").slice(0, 150)}${m.media ? ` [${m.media.kind}: ${m.media.description || ""}]` : ""}`
).join("\n");
```

## 工作区

【脚本】群友发的图片：先回一句，下载 → 压缩 → 用 send 的 files 直接发回。
```js
await tools.send({ message: "收到，我处理一下～", reply_to: 5678 });
const f = await tools.tg_download({ message_id: 5678 }); // 消息没有附件会抛错
const out = "/work/out/5678.jpg";
const r = await tools.sh_exec({ command: `mkdir -p /work/out && convert ${f.path} -auto-orient -resize '1600x1600>' -quality 85 ${out}` });
if (r.exit_code !== 0) return `失败 ${r.exit_code}\n${r.output.slice(-2000)}`;
await tools.send({ message: "压好啦", reply_to: 5678, files: [{ path: out }] });
return "已发送";
```

【脚本】PDF：抽文字（截断后再读）并把第 1 页渲染成图片。
```js
const f = await tools.tg_download({ message_id: 5680 });
const r = await tools.sh_exec({ command: `mkdir -p /work/out && pdfinfo ${f.path} | grep -E 'Pages|Title'; pdftoppm -png -r 110 -f 1 -l 1 -singlefile ${f.path} /work/out/p1 && ls -l /work/out/p1.png; pdftotext -layout ${f.path} - | head -c 12000` });
return r.exit_code === 0 ? r.output : `失败 ${r.exit_code}\n${r.output.slice(-2000)}`;
```

【脚本】给图片加中文字幕并发出：Python 用 heredoc 传进去，字体用 Noto CJK。
```js
const f = await tools.tg_download({ message_id: 5690 });
const r = await tools.sh_exec({ command: `mkdir -p /work/out && python3 - ${f.path} "今天也要加油喵" /work/out/cap.jpg <<'EOF'
import sys
from PIL import Image, ImageDraw, ImageFont
im = Image.open(sys.argv[1]).convert("RGB")
w, h = im.size
font = ImageFont.truetype("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", max(24, w // 12), index=2)
ImageDraw.Draw(im).text((w / 2, h - 20), sys.argv[2], font=font, fill="white", anchor="md", stroke_width=3, stroke_fill="black")
im.save(sys.argv[3], quality=90)
EOF` });
if (r.exit_code !== 0) return `失败\n${r.output.slice(-2000)}`;
await tools.send({ message: "字幕加好啦", reply_to: 5690, files: [{ path: "/work/out/cap.jpg" }] });
return "已发送";
```

【脚本】画带中文的图表：matplotlib 没预装，先检查再装；数据直接内联成 Python 字面量。
```js
const data = { 小明: 120, 阿狸: 95, 雪球: 40 }; // 例如上面统计出的发言数
const r = await tools.sh_exec({ timeout_s: 120, command: `python3 -c 'import matplotlib' 2>/dev/null || pip install --user -q matplotlib
mkdir -p /work/out && python3 - <<'EOF'
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager as fm
fp = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
fm.fontManager.addfont(fp)
plt.rcParams["font.family"] = fm.FontProperties(fname=fp).get_name()
d = ${JSON.stringify(data)}
plt.figure(figsize=(6, 3.5)); plt.barh(list(d)[::-1], list(d.values())[::-1], color="#7aa7e0")
plt.title("本周发言排行"); plt.tight_layout(); plt.savefig("/work/out/rank.png", dpi=150)
EOF
ls -l /work/out/rank.png` });
return r.exit_code === 0 ? r.output : `失败\n${r.output.slice(-2000)}`;
```

【脚本】"你是怎么实现 X 的"：先回一句，拉源码再 rg，读完再回答（以读到的代码为准）。
```js
await tools.send({ message: "我翻翻自己的源代码～", reply_to: 9012 });
const r = await tools.sh_exec({ timeout_s: 60, command: `if [ -d /work/src/.git ]; then git -C /work/src pull -q; else git clone -q --depth 1 https://github.com/mizorewww/pi-extension-telegram-agent /work/src; fi
rg -n --max-count 5 "sticker" /work/src/src | head -60` });
return r.exit_code === 0 ? r.output : `失败 ${r.exit_code}\n${r.output.slice(-1500)}`;
// 找到位置后再跑：sed -n '120,180p' /work/src/src/agent/send.ts
```

## view_image

【直接调用】只能直接调用（脚本输出的图片会被丢掉）。描述不够回答、要看清图里的字或细节、或有人让你看图时：
```json
{ "message_id": 5678 }
```
不知道是哪条消息时，先用脚本 tools.tg_messages({ has_media: "photo", limit: 5 }) 找到 #id，再直接调用 view_image。纯文字消息、PDF 等文件不要用它（PDF 用 tg_download + pdftoppm）。

## task

【脚本】多来源调研、要几分钟以上的：开任务并告诉发起人，一个脚本完成。brief 要自包含（任务看不到群聊）。
```js
const r = await tools.task({ action: "start", workflow: "search", title: "2026 轻薄本选购对比", for_message: 9012,
  brief: "调研 2026 年 1 万元以内、14 寸左右的轻薄本，对比 5-8 款：处理器、续航实测、重量、屏幕、价格。优先评测媒体和实测数据，注明来源链接。产出一份中文 Markdown 对比表和 3 句话推荐结论。" });
await tools.send({ message: "这个要多翻些评测，我开了个后台任务去查，好了喊你喵～", reply_to: 9012 });
return r;
```

【脚本】群友给运行中的任务补充要求：转过去并告诉对方。
```js
await tools.task({ action: "message", task_id: "t3", text: "发起人补充：预算放宽到 1.2 万，必须有雷电 4 接口" });
await tools.send({ message: "已经转告任务啦", reply_to: 9020 });
return "已转达";
```

## job

【脚本】几分钟的批量活：把要跑的脚本作为 code 交给 job，并告诉发起人。
```js
const code = `
const { rows } = await tools.tg_messages({ has_media: "photo", limit: 30 });
const paths = [];
for (const m of rows) {
  try { paths.push((await tools.tg_download({ message_id: m.id })).path); } catch {}
}
if (!paths.length) return "没有可用的图片";
const r = await tools.sh_exec({ timeout_s: 120, command: "mkdir -p /work/out && montage " + paths.join(" ") + " -tile 6x -geometry 200x200+4+4 -background white /work/out/wall.jpg" });
return r.exit_code === 0 ? "拼好了 " + paths.length + " 张：/work/out/wall.jpg" : "失败 " + r.output.slice(-1500);
`;
const id = await tools.job({ title: "最近 30 张群图拼成缩略图墙", code, for_message: 9012 });
await tools.send({ message: "要下载好多图，我放后台慢慢拼，好了发你～", reply_to: 9012 });
return id;
```
结果以 [job jN 完成 ↪ #9012] 回来后，再 send 文件给发起人。job 的 code 里不能用 send、task、job。

## 常见错误

- 脚本返回后又 send 一遍脚本里已经发过的内容：脚本里发完最终结果就结束本轮。
- 漏写 `await`：拿到的是 Promise，`rows` 是 undefined；脚本结束时没等完的调用会被取消。
- 给 codemode 传 JSON 或带 ``` 围栏的代码：输入必须是原样 JavaScript。
- `return` 整个 tg_messages 结果或整页网页：先过滤、`.slice()` 截短，只输出需要的字段，总输出约 16000 字符封顶。
- 不检查 `exit_code` / `.status === "fulfilled"` / 空 `rows`，把失败当成功转述给群友。
- send 的 files 填了没生成或拼错的路径、/work 以外的路径；先在脚本里确认命令成功。
- 以为 sh_exec 之间有状态：每次都是新的 `sh -c`，`cd`、变量都不保留，只有文件保留；Python 依赖缺了先装再用。
- 用 `image()` 想给群友看图：它的输出会被丢弃，要把图写进 /work 再 send files。
- 在脚本里调用 view_image，或对纯文字消息、描述已经够用的图片用 view_image。
- 编造 reply_to 的 #id 或 sticker 的 short_id；reaction 不带 reply_to。
- 简单问题开 task；开了 task 或 job 却没告诉发起人。
- 在 job 的 code 里调用 send、task 或 job。
