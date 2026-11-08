// check-startup-fail.mjs —— 抽检①：配置损坏必须"启动即失败"，而不是每请求 500
// 用法：node check-startup-fail.mjs <ACTA 仓库根>
// 判定：四种坏配置都必须 (a) 非 0 退出  (b) 打印可读原因  (c) 不监听端口
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";

const ROOT = process.argv[2] || process.cwd();
const PORT = 18990;

function runOnce(label, { tokenContent, env = {} }) {
  return new Promise((resolve) => {
    const dir = mkdtempSync(join(tmpdir(), "acta-boot-"));
    const data = join(dir, "data"); mkdirSync(data, { recursive: true });
    const tokenFile = join(dir, "tokens.json");
    writeFileSync(tokenFile, tokenContent, "utf8");   // 故意按原样写（可含 BOM / 坏 JSON）
    const child = spawn(process.execPath, ["http/start.mjs"], {
      cwd: ROOT,
      env: {
        ...process.env,
        ...env,
        ACTA_DATA: data,
        ACTA_TOKEN_FILE: tokenFile,
        ACTA_HMAC_KEY: env.ACTA_HMAC_KEY ?? "k",
        ACTA_PORT: String(PORT),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => {
      /* 5 秒还没退出 => 视为"启动了但没失败"，先探端口再收摊 */
      probe(PORT).then((listening) => {
        child.kill("SIGKILL");
        resolve({ label, exited: false, listening, text: (out + err).slice(-400) });
      });
    }, 5000);
    child.on("close", async (code) => {
      clearTimeout(timer);
      const listening = await probe(PORT);
      resolve({ label, exited: true, code, listening, text: (out + err).slice(-400) });
    });
  });
}

function probe(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port }, () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
    s.setTimeout(600, () => { s.destroy(); resolve(false); });
  });
}

const cases = [
  ["BOM 的 token 文件", { tokenContent: '\uFEFF["t-1"]' }],
  ["坏 JSON", { tokenContent: '["t-1"' }],
  ["空数组（无任何凭据）", { tokenContent: "[]" }],
  ["缺 HMAC 密钥", { tokenContent: '["t-1"]', env: { ACTA_HMAC_KEY: "" } }],
];

const rows = [];
for (const [label, cfg] of cases) rows.push(await runOnce(label, cfg));

console.log("用例".padEnd(24), "退出", "码", "监听", "原因片段");
for (const r of rows) {
  console.log(
    r.label.padEnd(24),
    String(r.exited ? "是" : "否").padEnd(4),
    String(r.code ?? "-").padEnd(3),
    String(r.listening).padEnd(5),
    (r.text.replace(/\s+/g, " ") || "(无输出)").slice(0, 70),
  );
}

const bad = rows.filter((r) => r.listening || !r.exited || (r.code ?? 0) === 0);
console.log("\n判定：" + (bad.length ? `不合格 ${bad.length}/${rows.length}（应启动即失败且不监听）` : "全部通过"));
process.exitCode = bad.length ? 1 : 0;
