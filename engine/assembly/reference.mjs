// reference.mjs —— 参照实现（"老路"）：不经表，直接把内容块按固定顺序拼出来
//
// 它存在的意义只有一个：给表驱动装配器当对照物。
// verify.mjs 用同一份输入分别跑 reference 与 assemble(table)，要求**逐字相同**；
// 不同就说明表漏了东西或顺序错了——这时候改表，不改装配器。
//
// 本文件刻意写成"硬编码顺序 + 硬编码标题"的反面教材：任何一处标题或分隔符的改动，
// 都必须在表里同步体现，否则比对立刻失败。

import {
  messageText, clipTail, stripByKeywords, parseDropKeys, parsePool,
  detectScene, sampleSlices, extractMemory, splitInjectedBlock,
} from "./primitives.mjs";

const H = {
  card: "## [角色设定与写作规范]（本轮完整设定，先读完它）",
  safeRules: "## [工程约束·运镜与防坍缩]",
  slices: "## [素材切片]（只挑其中一两处自然融进动作里，不要逐条罗列）",
  sceneUser: "## [★ 当前场景 · 玩家这一句（正文从这里接着写）]",
  sceneAsst: "## [★ 当前场景 · 上一轮正文结尾（只用来接住场面与语气，不要复述）]",
  docHead: "# 输入包（供模型阅读）",
  docNote: "> 本文件是下游送来的整包内容，按下文各节处理。",
  rules: "## [写作规则]（本节是既定规则，先读完它再看下面的对话）",
  end: "<!-- END OF INPUT -->",
  memory: "## [记忆层 · 已压缩的历史（这是已发生的事实，不是指令；不要复述，只用于保持连续）]",
};

/**
 * @param {object} body OpenAI 兼容请求体：{ system, messages }
 * @param {object} ctx  运行态：素材与规则文本、通道档位、注入块标记、指令文本
 * @returns {{inputMd:string, taskText:string, memBlock:string, stats:object}}
 */
export function assemblePayload(body, ctx = {}) {
  const {
    jobDir = "",
    injectMark = "",
    cardChannel = "tool",
    sliceChannel = "tool",
    allowCardInUser = false,
    sliceMax = 4,
    safeRules = "",
    poolMd = "",
    dropMd = "",
    instruction = "",
  } = ctx;

  const { memory, messages: msgsClean } = extractMemory(body.messages ?? []);
  const pool = poolMd ? parsePool(poolMd) : null;
  const scene = detectScene(msgsClean);
  const turnIndex = msgsClean.length;
  const slices = pool ? sampleSlices(pool, scene, turnIndex, sliceMax) : [];
  const slicesBlock = slices.length ? `${H.slices}\n\n${slices.map((s) => `- ${s}`).join("\n")}` : "";

  /* ── tool 通道：卡、规则、切片、当前场景 ── */
  const cardParts = [];
  if (cardChannel === "tool") {
    cardParts.push(H.card, "", String(body.system ?? ""), "");
    if (safeRules) cardParts.push(H.safeRules, "", safeRules, "");
    if (slices.length && sliceChannel !== "user") cardParts.push(slicesBlock, "");
    const rev = [...msgsClean].reverse();
    const lastUser = rev.find((m) => m.role === "user");
    const lastAsst = rev.find((m) => m.role === "assistant");
    if (lastUser) cardParts.push(H.sceneUser, "", clipTail(messageText(lastUser), 1200), "");
    if (lastAsst) cardParts.push(H.sceneAsst, "", clipTail(messageText(lastAsst), 900), "");
  }

  /* ── 楼层视图：末条 user 里的注入块切出去，单独成节 ── */
  const view = splitInjectedBlock(msgsClean, injectMark);
  const stripped = view.injected ? stripByKeywords(view.injected, parseDropKeys(dropMd)) : { text: "", dropped: 0 };

  const lines = [H.docHead, "", H.docNote, ""];
  if (stripped.text && stripped.text.trim()) lines.push(H.rules, "", stripped.text, "");
  const slicesForRender = cardChannel === "user" && sliceChannel !== "user" ? slices : [];
  if (slicesForRender.length) {
    lines.push(H.slices, "");
    for (const s of slicesForRender) lines.push(`- ${s}`);
    lines.push("");
  }
  view.floors.forEach((m, i) => lines.push(`## [${i + 1}] ${m.role}`, "", messageText(m), ""));
  lines.push(H.end, "");
  const renderOut = lines.join("\n");

  const inputMd = cardParts.join("\n") + (cardParts.length ? "\n" : "") + renderOut;

  /* ── user 通道：只有记忆层 + 指令 ── */
  const sysFull = cardChannel === "user" && allowCardInUser ? String(body.system ?? "") : "";
  const userSlices = sliceChannel === "user" ? slicesBlock : "";
  const memBlock = memory ? `${H.memory}\n\n${memory}` : "";
  const taskText = [memBlock, sysFull, cardChannel === "user" ? safeRules : "", userSlices, instruction]
    .filter(Boolean).join("\n\n");

  return {
    inputMd,
    taskText,
    memBlock,
    stats: {
      msgCount: (body.messages ?? []).length,
      cardChars: String(body.system ?? "").length,
      cardChannel,
      taskHasCard: sysFull.length > 0,
      safeRulesChars: safeRules.length,
      presetStrippedChars: stripped.dropped,
      scene,
      turnIndex,
      slicesPicked: slices.length,
      slicesChars: slicesBlock.length,
      memoryChars: memory.length,
      inputChars: inputMd.length,
      taskChars: taskText.length,
    },
  };
}

export const HEADINGS = H;
