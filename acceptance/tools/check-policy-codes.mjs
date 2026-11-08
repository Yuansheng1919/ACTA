// check-policy-codes.mjs —— 抽检②：blocked / patterns / templates 三个拒绝码不许串
// 用法：node check-policy-codes.mjs <ACTA 仓库根>
// 说明：直接打引擎的公开函数，不经过 HTTP，结果更干净。
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const ROOT = process.argv[2] || process.cwd();
const gatesUrl = pathToFileURL(join(ROOT, "engine", "gates.mjs")).href;
let gates;
try { gates = await import(gatesUrl); }
catch (e) { console.error("导入引擎失败：" + e.message); process.exit(2); }

const policy = {
  version: "probe-1",
  locations: ["home.living"], phases: ["早", "晚"],
  blocked: ["未成年"],                                  /* 子串段 */
  patterns: ["\\d{1,3}\\s*岁", "小[学初高]生|校服|书包"], /* 正则段 */
  templates: ["【场外点名】"],                            /* 点名模板段 */
  lengths: { description: [1, 999999], personality: [1, 999999], scenario: [1, 999999], first_mes: [1, 999999], mes_example: [1, 999999] },
  sentenceWarn: 45, similePer100: 4,
};

/* 若引擎还没实现 patterns，会退化到 templates；这里如实报告，不假装通过 */
const hasPatterns = /patterns/.test(String(gates.checkProse)) || /patterns/.test(JSON.stringify(gates.examplePolicy ?? {}));

/* 正文闸先判字数区间，测试文本必须落在区间内，否则只会得到 verdict.len_over */
const pad = (s) => {
  const filler = "她把碗放进水池，拧开水龙头，水声响了一会儿。";
  let out = s;
  while ([...out].length < 1300) out += filler;
  return out;
};

const cases = [
  ["命中 blocked（子串）", pad("她未成年。"), "verdict.blocked"],
  ["命中 patterns（正则-数字年龄）", pad("她十九岁，坐在床边。"), "verdict.pattern"],
  ["命中 patterns（正则-校园物）", pad("她穿着校服。"), "verdict.pattern"],
  ["命中 templates（点名）", pad("【场外点名】隔壁的人在敲门。"), "verdict.template"],
  ["干净文本（应通过）", pad(""), null],
];

function codeOf(fn) {
  try { fn(); return { ok: true, code: null }; }
  catch (e) { return { ok: false, code: e?.code ?? "(无 code)", status: e?.status }; }
}

console.log("引擎是否支持 patterns 段：", hasPatterns ? "是" : "否（将退化到 templates）");
console.log("");
console.log("用例".padEnd(30), "得到", "期望");
const rows = [];
for (const [label, text, expect] of cases) {
  const r = codeOf(() => gates.checkProse(text, policy));
  rows.push({ label, got: r.code, expect, ok: expect === null ? r.ok : r.code === expect });
  console.log(label.padEnd(30), String(r.code ?? "(通过)").padEnd(18), String(expect ?? "(通过)"));
}

const bad = rows.filter((r) => !r.ok);
console.log("\n判定：" + (bad.length ? `不合格 ${bad.length}/${rows.length}（拒绝码串了或未实现 patterns）` : "全部通过"));
process.exitCode = bad.length ? 1 : 0;
