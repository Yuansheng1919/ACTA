// verify.mjs —— 表驱动装配 vs 参照实现，逐字比对
//
// 判据：差一个字就是不合格。做法：
//   ① 同一份请求，跑一遍「表驱动装配」，跑一遍「参照实现」
//   ② 字符级 + UTF-8 字节级全等
//   ③ 产物每个字符都必须归属到某一节（覆盖率），节间只允许声明过的分隔符
//   ④ 统计口径一致；同请求跑 3 次结果一致
//
// 用法：node verify.mjs        （退出码 0 = 通过）
// 可用环境变量改路径：TABLE / REQUEST / JOB_DIR

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { assemble, loadTable, renderTemplate } from "./assembler.mjs";
import { assemblePayload } from "./reference.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TABLE = process.env.TABLE ?? join(HERE, "tables", "play.example.json");
const REQUEST = process.env.REQUEST ?? join(HERE, "samples", "request.example.json");
const JOB_DIR = process.env.JOB_DIR ?? join(HERE, "_job");

const md5 = (s) => createHash("md5").update(s, "utf8").digest("hex");
const read = (p) => readFileSync(resolve(HERE, p), "utf8");

const table = loadTable(TABLE);
const baseReq = JSON.parse(readFileSync(REQUEST, "utf8"));

/** 把表里声明的运行态（素材文本、注入标记、通道档位、指令）交给参照实现 */
function ctxFromTable(t, jobDir) {
  return {
    jobDir,
    injectMark: t.layout.injectMark,
    cardChannel: t.channels.card,
    sliceChannel: t.channels.slices,
    allowCardInUser: Boolean(t.channels.allowCardInUser),
    sliceMax: Number(t.channels.sliceMax ?? 4),
    safeRules: read(t.sources.safeRules.path),
    poolMd: read(t.sources.slicePool.path),
    dropMd: read(t.sources.presetDrop.path),
    instruction: renderTemplate(resolve(HERE, t.sources.instruction.path), {}, { jobDir }),
  };
}

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

function cmp(name, mine, theirs) {
  const d = firstDiff(mine, theirs);
  return {
    name,
    equal: d === -1,
    lenMine: mine.length,
    lenTheirs: theirs.length,
    md5Mine: md5(mine),
    md5Theirs: md5(theirs),
    byteEqual: Buffer.from(mine, "utf8").equals(Buffer.from(theirs, "utf8")),
    at: d,
    ctxMine: d >= 0 ? JSON.stringify(mine.slice(Math.max(0, d - 40), d + 40)) : "",
    ctxTheirs: d >= 0 ? JSON.stringify(theirs.slice(Math.max(0, d - 40), d + 40)) : "",
  };
}

function coverage(res, doc, sepLen = 1) {
  const text = res[doc] ?? "";
  const spans = res.spans?.[doc] ?? [];
  const problems = [];
  if (spans.length) {
    if (spans[0].start !== 0) problems.push("首节起点不是 0");
    if (spans[spans.length - 1].end !== text.length) problems.push("末节终点不等于全文长度");
    for (let i = 1; i < spans.length; i++) if (spans[i].start < spans[i - 1].end) problems.push(`第 ${i} 节与前节重叠`);
    const covered = spans.reduce((n, s) => n + (s.end - s.start), 0);
    if (text.length - covered !== sepLen * (spans.length - 1)) problems.push("节间分隔符数量与节数不匹配");
  } else if (text.length) problems.push("产物非空但无归属");
  return { ok: problems.length === 0, problems, sections: spans.length };
}

const cases = [
  { name: "example", request: baseReq },
  {
    name: "memory",
    request: {
      ...baseReq,
      messages: [
        { role: "user", content: "<!--MEM_START-->【事件】前情摘要。\n【状态】当前状态摘要。\n【未收线索】待收线索。<!--MEM_END-->" },
        ...baseReq.messages,
      ],
    },
  },
  { name: "no-last-user", request: { ...baseReq, messages: baseReq.messages.slice(0, -1).concat([{ role: "assistant", content: "她把门带上了。" }]) } },
  { name: "empty-card", request: { ...baseReq, system: "" } },
];

let allOk = true;
const rows = [];
for (const c of cases) {
  const mine = assemble(table, { body: c.request, jobDir: JOB_DIR });
  const ref = assemblePayload(c.request, ctxFromTable(table, JOB_DIR));
  const ci = cmp("inputMd", mine.inputMd, ref.inputMd);
  const ct = cmp("taskText", mine.taskText, ref.taskText);
  const cvi = coverage(mine, "inputMd", (table.documents.inputMd.join ?? "").length);
  const cvt = coverage(mine, "taskText", (table.documents.taskText.join ?? "").length);
  const ok = ci.equal && ct.equal && cvi.ok && cvt.ok;
  allOk &&= ok;
  rows.push({ name: c.name, ok, ci, ct, cvi, cvt, chars: mine.inputMd.length });
}

/* 确定性 */
const runs = [0, 1, 2].map(() => assemble(table, { body: baseReq, jobDir: JOB_DIR }).inputMd);
const deterministic = runs.every((x) => x === runs[0]);

console.log("# 表驱动装配 vs 参照实现 · 逐字比对\n");
console.log("| 用例 | inputMd | taskText | 覆盖率 | 结论 |");
console.log("|---|---|---|---|---|");
for (const r of rows) {
  const i = r.ci.equal ? `同 ${r.ci.lenMine} 字` : `差@${r.ci.at}（${r.ci.lenMine}/${r.ci.lenTheirs}）`;
  const t = r.ct.equal ? `同 ${r.ct.lenMine} 字` : `差@${r.ct.at}`;
  console.log(`| ${r.name} | ${i} | ${t} | ${r.cvi.ok && r.cvt.ok ? "满" : "漏"} | ${r.ok ? "PASS" : "FAIL"} |`);
}
console.log(`\n- 确定性（同请求 3 次）：${deterministic ? "一致" : "不一致"}`);
console.log(`- 结论：${allOk && deterministic ? "PASS · 逐字相同（字符级 + 字节级）" : "FAIL"}`);

if (!allOk) {
  for (const r of rows.filter((x) => !x.ok)) {
    console.log(`\n## 失败：${r.name}`);
    for (const v of [r.ci, r.ct]) {
      if (!v.equal) {
        console.log(`- ${v.name}：表 ${v.lenMine} 字 / 参照 ${v.lenTheirs} 字，首个差异 @${v.at}`);
        console.log(`  - 表：${v.ctxMine}`);
        console.log(`  - 参照：${v.ctxTheirs}`);
      }
    }
    for (const cv of [r.cvi, r.cvt]) if (!cv.ok) console.log(`- 覆盖问题：${cv.problems.join("；")}`);
  }
}

process.exit(allOk && deterministic ? 0 : 1);
