// check-import-matrix.mjs —— 抽检③：五张合成卡的导入矩阵 + round-trip
// 用法：node check-import-matrix.mjs <ACTA 仓库根> [卡目录]
// 设计：不假设他的导出名；先独立解析出"期望"，再尝试调用他的引擎比对。
//       引擎没交付/导出名不匹配时，如实报告"未验证"，绝不假装通过。
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.argv[2] || process.cwd();
const DIR = process.argv[3] || join(ROOT, "acceptance", "samples");
const EXPECT_FILE = "engine/import.mjs";

/* ---------- 独立解析（我方基线，不依赖他的代码） ---------- */
function blocks(pngPath) {
  const png = readFileSync(pngPath);
  let off = 8; const found = {};
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString("ascii", off + 4, off + 8);
    const data = png.subarray(off + 8, off + 8 + len);
    if (type === "tEXt") {
      const z = data.indexOf(0);
      const key = data.toString("latin1", 0, z);
      if (key === "chara" || key === "ccv3") {
        try { found[key] = JSON.parse(Buffer.from(data.toString("latin1", z + 1), "base64").toString("utf8")); }
        catch { found[key] = null; }
      }
    }
    off += 12 + len;
  }
  return found;
}
const body = (o) => (o?.data ? o.data : o) ?? {};
const TEXTS = ["description", "personality", "scenario", "first_mes", "mes_example"];

function expectOf(file) {
  const b = blocks(join(DIR, file));
  const primary = b.ccv3 ?? b.chara ?? {};
  const d = body(primary);
  const probe = (JSON.stringify(b).match(/ACTA-PROBE-[A-E]\d/g) || [])[0] ?? "";
  return {
    file,
    blocks: Object.keys(b).join("+"),
    mismatch: b.chara && b.ccv3 ? JSON.stringify(b.chara) !== JSON.stringify(b.ccv3) : null,
    name: d.name ?? "",
    textsOk: TEXTS.every((k) => typeof d[k] === "string" && d[k].length > 0),
    bookEntries: (d.character_book?.entries ?? []).length,
    ext: Object.keys(d.extensions ?? {}).join("/"),
    probe,
  };
}

/* ---------- 他的引擎（若已交付） ---------- */
let engine = null;
if (existsSync(join(ROOT, EXPECT_FILE))) {
  try { engine = await import(pathToFileURL(join(ROOT, EXPECT_FILE)).href); }
  catch (e) { console.log("引擎导入失败：" + e.message); }
} else {
  console.log(`未找到 ${EXPECT_FILE} —— ③ 导入通道尚未交付，本项标记「未验证」。`);
}

const files = readdirSync(DIR).filter((f) => f.endsWith(".png")).sort();
const rows = files.map(expectOf);

console.log("\n=== 我方基线（期望观测）===");
console.log("卡".padEnd(22), "块".padEnd(11), "一致", "名字".padEnd(12), "书", "扩展".padEnd(28), "五段", "探针");
for (const r of rows) {
  console.log(
    r.file.padEnd(22), r.blocks.padEnd(11),
    (r.mismatch === null ? "—" : r.mismatch ? "否" : "是").padEnd(4),
    r.name.padEnd(12), String(r.bookEntries).padEnd(2),
    r.ext.padEnd(28), r.textsOk ? "是" : "否", r.probe,
  );
}

/* ---------- 调用他的实现（导出名不假设） ---------- */
if (engine) {
  const names = Object.keys(engine);
  console.log("\n他的引擎导出：" + (names.join(", ") || "(无)"));
  const fnName = names.find((n) => /^(parseCard|readCard|importCard|parse)$/i.test(n));
  if (!fnName) {
    console.log(`无法调用：未找到 parseCard/readCard/importCard 之一。请他在 ${EXPECT_FILE} 导出 parseCard(bufferOrPath) → {spec, texts, book, diff, extensions}`);
  } else {
    console.log(`\n=== 调用 ${fnName}() 比对 ===`);
    let pass = 0, fail = 0;
    for (const r of rows) {
      const p = join(DIR, r.file);
      let got;
      try {
        const input = engine[fnName].length && /path|string/i.test(String(engine[fnName])) ? p : readFileSync(p);
        got = await engine[fnName](input);
      } catch (e) { got = { error: e?.code ?? e?.message ?? "throw" }; }
      const name = got?.spec?.name ?? got?.texts?.name ?? got?.error;
      const ok = String(name ?? "") === String(r.name);
      ok ? pass++ : fail++;
      console.log(`${r.file.padEnd(22)} ${ok ? "OK " : "DIFF"}  期望名字=${r.name}  得到=${name ?? "(空)"}`);
    }
    console.log(`\n比对结果：通过 ${pass} / 不一致 ${fail}`);
    process.exitCode = fail ? 1 : 0;
  }
}
