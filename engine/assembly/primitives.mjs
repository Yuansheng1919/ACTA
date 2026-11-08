// primitives.mjs —— 装配用的四个"内容变换"原语（纯函数，无 IO、无外部依赖）
//
// 这些是把"往上下文里装什么"变成可测试代码时需要的最小集合：
//   ① 消息取文（string / 分段数组两种上游形态）
//   ② 素材池解析（按 场景 → 类别 → 条目 三层）
//   ③ 按楼层号确定性抽样（同一轮可复现，相邻轮不撞）
//   ④ 按关键词整句剔除（把与设定冲突的注入句删掉，记字数）
// 装配器与参照实现都用这一份，避免"两套实现各写一遍"导致的口径漂移。

/** 取一条消息的文本；上游可能给字符串，也可能给 [{type:"text",text}] 分段数组 */
export function messageText(m) {
  if (typeof m?.content === "string") return m.content;
  if (Array.isArray(m?.content)) {
    return m.content.filter((p) => p?.type === "text").map((p) => p.text ?? "").join("\n");
  }
  return "";
}

/** 末 N 字截断；多出来的用一个省略号标记（下游据此知道这不是完整句） */
export function clipTail(t, n) {
  return t.length > n ? "…" + t.slice(-n) : t;
}

/**
 * 按关键词整句剔除。
 * 命中关键词后，从该句起点（上一个 。；\n 之后）删到句末（下一个 。；\n 之后）。
 * 只用于"外部注入的规则块"，不用于正文、不用于角色设定。
 * @returns {{text:string, dropped:number}} dropped = 删掉的字符数，写进日志供对账
 */
export function stripByKeywords(block, keys = []) {
  if (!block || !keys.length) return { text: block, dropped: 0 };
  let out = block;
  let dropped = 0;
  for (const k of keys) {
    let guard = 0;
    while (k && out.includes(k) && guard++ < 30) {
      const i = out.indexOf(k);
      let start = 0;
      for (let j = i - 1; j >= 0; j--) {
        const ch = out[j];
        if (ch === "。" || ch === "；" || ch === "\n") { start = j + 1; break; }
      }
      let end = out.length;
      for (let j = i + k.length; j < out.length; j++) {
        const ch = out[j];
        if (ch === "。" || ch === "；" || ch === "\n") { end = j + 1; break; }
      }
      dropped += end - start;
      out = out.slice(0, start) + out.slice(end);
    }
  }
  out = out.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+\n/g, "\n").trim();
  return { text: out, dropped };
}

/** 剔除关键词表：每行 `- 关键词`，空行与 # 注释忽略 */
export function parseDropKeys(md) {
  return (md ?? "").split("\n").map((l) => l.trim())
    .filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim()).filter(Boolean);
}

/**
 * 解析素材池：`## 场景` → `### 类别` → `- 条目`。
 * 太短的条目（<8 字）丢弃——它们通常是小标题误写成条目。
 * @returns {{common:Object, home:Object, hospital:Object}}
 */
export function parsePool(md) {
  const out = { common: {}, home: {}, hospital: {} };
  let scene = null, cat = null;
  for (const raw of (md ?? "").split("\n")) {
    const line = raw.trim();
    if (line.startsWith("## ")) {
      const s = line.slice(3).trim().toLowerCase();
      scene = (s === "home" || s === "hospital" || s === "common") ? s : null;
      cat = null;
      continue;
    }
    if (line.startsWith("### ")) { cat = line.slice(4).trim(); continue; }
    if (!scene || !cat || !line.startsWith("- ")) continue;
    const item = line.slice(2).trim();
    if (item.length < 8) continue;
    if (!out[scene][cat]) out[scene][cat] = [];
    out[scene][cat].push(item);
  }
  return out;
}

/** 从最近几条消息猜场域（判错只是素材偏一点，不影响链路） */
export function detectScene(messages) {
  const tail = (messages || []).slice(-6).map((m) => messageText(m)).join("\n");
  return /医院|病房|护士站|值班室|更衣室|开水房|走廊|输液|门诊|急诊|配药|呼叫铃|交班/.test(tail)
    ? "hospital" : "home";
}

/** 把各场域各类条目交错铺开：连续取 N 条必然落在 N 个不同类别上 */
function interleave(pool, scene) {
  const cats = [
    ...Object.entries(pool[scene] || {}),
    ...Object.entries(pool.common || {}),
  ].filter(([, items]) => items && items.length);
  if (!cats.length) return [];
  const maxLen = Math.max(...cats.map(([, items]) => items.length));
  const out = [];
  for (let i = 0; i < maxLen; i++) {
    for (const [, items] of cats) if (items[i]) out.push(items[i]);
  }
  return out;
}

/**
 * 按楼层号确定性滑窗抽样：不随机、不取模散列，直接从交错序列按 turnIndex*N 取连续 N 条。
 * 相邻轮次天然不撞（间隔恰好 N 条），循环周期 = 池长 / N。
 */
export function sampleSlices(pool, scene, turnIndex, maxTotal = 4) {
  const flat = interleave(pool, scene);
  if (!flat.length) return [];
  const start = ((turnIndex - 1) * maxTotal) % flat.length;
  const picked = [];
  for (let k = 0; k < maxTotal; k++) picked.push(flat[(start + k) % flat.length]);
  return picked;
}

/* ── 记忆层：<!--MEM_START-->…<!--MEM_END--> ───────────────────────────── */
const MEM_RE = /<!--MEM_START-->([\s\S]*?)<!--MEM_END-->/;
/* 含拒绝特征的一段不能当记忆层带进上下文：它会持续暗示"该内容应被拒绝" */
const MEM_REFUSAL_RE = /拒绝继续|拒绝回答|无法提供|不能提供|I can.t|I cannot|I won.t|inappropriate|not able to|抱歉/;

/**
 * 抽出记忆层并从楼层里摘掉（避免同一段内容在上下文里出现两次）。
 * @returns {{memory:string, messages:Array, poisoned:number}}
 */
export function extractMemory(messages) {
  let memory = "";
  const out = [];
  let poisoned = 0;
  for (const m of messages ?? []) {
    const t = messageText(m);
    const hit = t.match(MEM_RE);
    if (!hit) { out.push(m); continue; }
    const piece = hit[1].trim();
    if (MEM_REFUSAL_RE.test(piece)) poisoned++;
    else memory = (memory + "\n" + piece).trim();
    const rest = t.replace(MEM_RE, "").trim();
    if (rest) out.push({ ...m, content: rest });
  }
  return { memory, messages: out, poisoned };
}

/**
 * 楼层视图：末条 user 末尾可能被上游客户端追加了一段"规则注入块"（标记由配置给出）。
 * 这里把它切出来单独成节；楼层正文只留原话。
 * ★ 注意：末条消息的"原文末 N 字"取的是**切之前**的内容，与楼层视图不是同一份。
 */
export function splitInjectedBlock(messages, mark) {
  const floors = messages.map((m) => ({ ...m }));
  let injected = "";
  const last = floors[floors.length - 1];
  if (last && last.role === "user") {
    const t = messageText(last);
    const idx = mark ? t.indexOf(mark) : -1;
    if (idx > 0) {
      injected = t.slice(idx).trim();
      last.content = t.slice(0, idx).trim();
    }
  }
  return { floors, injected };
}
