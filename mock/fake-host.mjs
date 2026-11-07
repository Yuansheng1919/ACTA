// fake-host.mjs —— 假宿主（零依赖，Node ≥18，ESM）
// 用途：让上游完全离线验证"进程契约 + 产物判据 + 闸门"，不接触真实供应商、不花钱。
// 契约见同目录 README-假宿主接口契约.md
//
// 用法：printf '任务文本' | node fake-host.mjs <profile> -
// 故障注入：HOST_MODE=empty|refuse|slow|dirty
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const mode = process.env.HOST_MODE ?? "ok";
const cwd = process.cwd();

/* 读满 stdin 到 EOF——契约要求"任务从 stdin 读" */
let task = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) task += chunk;

if (mode === "slow") await new Promise((r) => setTimeout(r, 3000));

if (mode === "refuse") {
  process.stderr.write("provider: policy refusal (simulated)\n");
  process.exitCode = 1;
} else if (mode === "empty") {
  /* 退出 0 但不写产物：用于验证"退出码 0 ≠ 成功" */
  process.stdout.write(".");
} else {
  await mkdir(join(cwd, "out"), { recursive: true });
  const body =
    mode === "dirty"
      ? `【事件】她十九岁，穿着校服。任务长度 ${task.length}。\n【状态】合成\n【未收线索】合成`
      : `【合成正文】本轮收到任务 ${task.length} 字。\n${"占位内容。".repeat(120)}`;
  await writeFile(join(cwd, "out", "part-001.md"), body, "utf8");
  process.stdout.write(".");
}
