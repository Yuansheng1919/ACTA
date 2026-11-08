// check-startup-fail.mjs —— 抽检①：坏配置的两种正确归宿
//   正确 A：启动即失败，非 0 退出、不监听
//   正确 B：能解析（如带 BOM），启动后**凭据可用**（不是静默变成"无凭据"）
//   错误：起来了但凭据不可用（等于每请求 500/401，且没人知道配置坏了）
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import http from "node:http";

const ROOT = process.argv[2] || process.cwd();
const PORT = 18993;

const probePort = (port) => new Promise((r) => {
  const s = net.connect({ host: "127.0.0.1", port }, () => { s.destroy(); r(true); });
  s.on("error", () => r(false)); s.setTimeout(600, () => { s.destroy(); r(false); });
});
const authWorks = (token) => new Promise((r) => {
  const q = http.request({ host: "127.0.0.1", port: PORT, path: "/v1/card/build", method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } }, (s) => { s.resume(); r(s.statusCode !== 401); });
  q.on("error", () => r(false)); q.write("{}"); q.end();
});

async function runCase(label, { tokenContent, token, env = {} }) {
  const dir = mkdtempSync(join(tmpdir(), "acta-boot-"));
  mkdirSync(join(dir, "data"), { recursive: true });
  const tokenFile = join(dir, "tokens.json");
  writeFileSync(tokenFile, tokenContent, "utf8");
  const child = spawn(process.execPath, ["http/start.mjs"], {
    cwd: ROOT,
    env: { ...process.env, ...env, ACTA_DATA: join(dir, "data"), ACTA_TOKEN_FILE: tokenFile,
      ACTA_HMAC_KEY: env.ACTA_HMAC_KEY ?? "k", ACTA_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "", err = "";
  child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (err += d));
  const settled = await new Promise((res) => {
    const t = setTimeout(() => res({ exited: false }), 4000);
    child.on("close", (code) => { clearTimeout(t); res({ exited: true, code }); });
  });
  const listening = await probePort(PORT);
  let usable = null;
  if (listening && token) usable = await authWorks(token);
  child.kill("SIGKILL");
  const text = (out + err).replace(/\s+/g, " ").slice(-90);
  /* 判定 */
  let verdict;
  if (settled.exited && (settled.code ?? 0) !== 0 && !listening) verdict = "通过（快速失败）";
  else if (listening && usable === true) verdict = "通过（能解析且凭据可用）";
  else if (listening && usable === false) verdict = "不合格（起来了但凭据不可用）";
  else if (listening && usable === null) verdict = "不合格（起来了，无法确认凭据）";
  else verdict = "不合格（未退出也没监听）";
  return { label, verdict, listening, code: settled.code ?? "-", text };
}

const rows = [];
rows.push(await runCase("BOM 的 token 文件", { tokenContent: '\uFEFF["t-1"]', token: "t-1" }));
rows.push(await runCase("坏 JSON", { tokenContent: '["t-1"', token: "t-1" }));
rows.push(await runCase("空数组（无凭据）", { tokenContent: "[]", token: "t-1" }));
rows.push(await runCase("缺 HMAC 密钥", { tokenContent: '["t-1"]', token: "t-1", env: { ACTA_HMAC_KEY: "" } }));

console.log("用例".padEnd(22), "判定".padEnd(26), "码", "监听");
for (const r of rows) console.log(r.label.padEnd(22), r.verdict.padEnd(26), String(r.code).padEnd(3), r.listening);
const bad = rows.filter((r) => r.verdict.startsWith("不合格"));
console.log("\n判定：" + (bad.length ? `不合格 ${bad.length}/${rows.length}` : "全部通过"));
process.exitCode = bad.length ? 1 : 0;
