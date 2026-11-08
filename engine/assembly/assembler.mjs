// assembler.mjs —— 表驱动装配器
//
// 输入：一张表（AssemblyTable/1）+ 一次请求（OpenAI 兼容的 {system, messages}）+ 作业目录
// 输出：inputMd（tool 通道，长文上下文）+ taskText（user 通道，只有指令 + 记忆层）
//
// 表负责"哪个内容块放哪条通道、排第几、多少字"；代码只负责"照表执行"。
// 通道判定写在表里（channels），不写在装配器的 if 里——这是本模块存在的唯一理由。

import { readFileSync, existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  messageText, clipTail, stripByKeywords, parseDropKeys, parsePool,
  detectScene, sampleSlices, extractMemory, splitInjectedBlock,
} from "./primitives.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/* ── 条件求值：when 只允许结构化判定，不允许写 JS ─────────────────── */
function condFail(when, facts) {
  if (!when) return null;
  if (Array.isArray(when.all)) {
    for (const c of when.all) { const r = condFail(c, facts); if (r) return r; }
    return null;
  }
  if (Array.isArray(when.any)) {
    const rs = when.any.map((c) => condFail(c, facts));
    return rs.every(Boolean) ? `any(${rs.join(" | ")})` : null;
  }
  if (when.not) return condFail(when.not, facts) ? null : `not(...)`;
  const v = facts[when.fact];
  if ("eq" in when && v !== when.eq) return `${when.fact}=${JSON.stringify(v)} ≠ ${JSON.stringify(when.eq)}`;
  if ("ne" in when && v === when.ne) return `${when.fact} 等于被排除值`;
  if ("gt" in when && !(v > when.gt)) return `${when.fact}=${JSON.stringify(v)} ≤ ${when.gt}`;
  if ("gte" in when && !(v >= when.gte)) return `${when.fact} < ${when.gte}`;
  if ("lt" in when && !(v < when.lt)) return `${when.fact} ≥ ${when.lt}`;
  if ("lte" in when && !(v <= when.lte)) return `${when.fact} > ${when.lte}`;
  if ("truthy" in when && Boolean(v) !== when.truthy) return `${when.fact} 不为 ${when.truthy}`;
  return null;
}

function absPath(p) {
  if (!p) return p;
  return isAbsolute(p) ? p : resolve(HERE, p);
}

function readText(p) {
  try { return existsSync(p) ? readFileSync(p, "utf8") : ""; } catch { return ""; }
}

/** 模板末尾那个换行只是编辑器习惯，不计入产物 */
export function renderTemplate(path, vars, ctx) {
  let t = readText(absPath(path)).replace(/\r\n/g, "\n");
  if (!t) return "";
  if (t.endsWith("\n")) t = t.slice(0, -1);
  const all = {
    ...vars,
    JOB_DIR: ctx.jobDir ?? "",
    INPUT_MD: join(ctx.jobDir ?? "", "input.md"),
    OUT_DIR: join(ctx.jobDir ?? "", "out"),
  };
  return t.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, k) => (k in all ? String(all[k]) : `{{${k}}}`));
}

/* ── 源装载 ─────────────────────────────────────────────────────── */
function loadSources(table, ctx) {
  const body = ctx.body ?? {};
  const jobDir = ctx.jobDir ?? join(HERE, "_job");
  const files = {};
  for (const [name, spec] of Object.entries(table.sources ?? {})) {
    if (spec?.from === "file") files[name] = readText(absPath(spec.path));
    else if (spec?.from === "template") files[name] = renderTemplate(absPath(spec.path), spec.vars ?? {}, { jobDir });
  }

  const sys = String(body.system ?? "");
  const mem = extractMemory(Array.isArray(body.messages) ? body.messages : []);
  const mark = table.layout?.injectMark ?? "";
  const view = splitInjectedBlock(mem.messages, mark);

  const poolMd = files.slicePool ?? "";
  const pool = poolMd ? parsePool(poolMd) : null;
  const scene = detectScene(view.floors);
  const turnIndex = view.floors.length;
  const sliceMax = Number(table.channels?.sliceMax ?? 4);
  const slices = pool ? sampleSlices(pool, scene, turnIndex, sliceMax) : [];
  const dropKeys = files.presetDrop ? parseDropKeys(files.presetDrop) : [];
  const stripped = view.injected ? stripByKeywords(view.injected, dropKeys) : { text: "", dropped: 0 };

  return {
    body, jobDir, files, sys,
    memory: mem.memory, poisoned: mem.poisoned,
    msgsRaw: mem.messages,      // 未切注入块的楼层（★场景块用）
    floors: view.floors,        // 切掉注入块的楼层（楼层节用）
    rulesText: stripped.text,
    presetStripped: stripped.dropped,
    scene, turnIndex, slices,
    slicesBlock: slices.length
      ? `${table.layout?.slicesHeading ?? "## [素材切片]"}\n\n${slices.map((s) => `- ${s}`).join("\n")}`
      : "",
  };
}

/* ── 取正文 ─────────────────────────────────────────────────────── */
function pickBody(sec, S) {
  const b = sec.body ?? {};
  switch (b.from) {
    case "const": return b.value ?? "";
    case "request": return String(S.body?.[b.path] ?? "");
    case "file": return S.files[b.ref] ?? "";
    case "sample": return S.slices.length ? S.slices.map((s) => `- ${s}`).join("\n") : "";
    case "rulesText": return S.rulesText;
    case "memory": return S.memory;
    case "template": return S.files[b.ref] ?? "";
    case "msg": {
      const list = S.msgsRaw;
      const sel = b.select ?? "last";
      let m;
      if (sel === "last") {
        for (let i = list.length - 1; i >= 0; i--) if (!b.role || list[i].role === b.role) { m = list[i]; break; }
      } else if (sel === "first") {
        m = list.find((x) => !b.role || x.role === b.role);
      }
      if (!m) return "";
      const t = messageText(m);
      return b.tail ? clipTail(t, b.tail) : t;
    }
    default:
      throw new Error(`节 ${sec.id} 的 body.from 未知：${b.from}`);
  }
}

function fragOf(shape, heading, bodyText) {
  switch (shape) {
    case "block": return `${heading ?? ""}\n\n${bodyText}\n`;
    case "line": return `${heading ?? ""}\n`;
    case "seg": return bodyText;
    case "seg-inline": return `${heading ?? ""}\n\n${bodyText}`;
    default: throw new Error(`未知 shape：${shape}`);
  }
}

function expandSection(sec, S, L) {
  const shape = sec.shape ?? "block";
  const heading = sec.heading ?? (sec.headingRef ? L?.[sec.headingRef] : undefined);
  if (sec.repeat === "msgs") {
    const tpl = sec.headingTemplate ?? "## [{{index}}] {{role}}";
    return S.floors.map((m, i) => ({
      text: fragOf("block", tpl.replace(/\{\{index\}\}/g, String(i + 1)).replace(/\{\{role\}\}/g, m.role), messageText(m)),
      key: `${sec.id}#${i + 1}`,
    }));
  }
  const bodyText = shape === "line" ? "" : pickBody(sec, S);
  if (bodyText === "" && sec.empty === "drop") return [];
  return [{ text: fragOf(shape, heading, bodyText), key: sec.id }];
}

/* ── 主入口 ─────────────────────────────────────────────────────── */
export function assemble(table, ctx = {}) {
  if (!table?.documents) throw new Error("表缺 documents 段");
  const S = loadSources(table, ctx);
  const facts = {
    cardChannel: table.channels?.card ?? "tool",
    sliceChannel: table.channels?.slices ?? "tool",
    allowCardInUser: Boolean(table.channels?.allowCardInUser),
    safeRulesChars: (S.files.safeRules ?? "").length,
    slicesPicked: S.slices.length,
    memoryChars: S.memory.length,
    presetChars: S.rulesText.length,
    hasLastUser: S.msgsRaw.some((m) => m.role === "user"),
    hasLastAssistant: S.msgsRaw.some((m) => m.role === "assistant"),
    floorCount: S.floors.length,
  };

  const out = {};
  const spans = {};
  const fragments = {};
  const skipped = [];

  for (const [docName, doc] of Object.entries(table.documents)) {
    const frags = [];
    for (const id of doc.order) {
      const sec = table.sections.find((s) => s.id === id);
      if (!sec) throw new Error(`documents.${docName} 引用了不存在的节：${id}`);
      const why = condFail(sec.when, facts);
      if (why) { skipped.push({ doc: docName, id, why }); continue; }
      for (const f of expandSection(sec, S, table.layout)) frags.push(f);
    }
    const sep = doc.join ?? "";
    out[docName] = frags.map((f) => f.text).join(sep);
    fragments[docName] = frags.map((f) => ({ key: f.key, chars: f.text.length, text: f.text }));
    let at = 0;
    spans[docName] = frags.map((f, i) => {
      const s = { key: f.key, start: at, end: at + f.text.length };
      at += f.text.length + (i < frags.length - 1 ? sep.length : 0);
      return s;
    });
  }

  return {
    ...out,
    stats: {
      msgCount: (S.body.messages ?? []).length,
      cardChars: S.sys.length,
      cardChannel: facts.cardChannel,
      safeRulesChars: facts.safeRulesChars,
      presetStrippedChars: S.presetStripped,
      scene: S.scene,
      turnIndex: S.turnIndex,
      slicesPicked: S.slices.length,
      slicesChars: S.slicesBlock.length,
      memoryChars: S.memory.length,
      inputChars: (out.inputMd ?? "").length,
      taskChars: (out.taskText ?? "").length,
    },
    spans, fragments, skipped,
  };
}

export function loadTable(path) {
  return JSON.parse(readFileSync(absPath(path), "utf8"));
}
