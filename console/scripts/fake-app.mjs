// Launch Next with fake-only settings (scripts/fake.env) without creating .env.local. Example: node scripts/fake-app.mjs start -p 3310 -H 127.0.0.1
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const fake = parseEnv(readFileSync(new URL("./fake.env", import.meta.url), "utf8"));
// Browser tests use a separate local fixture server so the demo can stay open.
if (process.env.FAKE_PORT) {
  const port = Number(process.env.FAKE_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid fake service port.");
  fake.NEXT_PUBLIC_SUPABASE_URL = fake.AGENT_BRAIN_URL = "http://127.0.0.1:" + port;
}
const child = spawn(process.execPath, [require.resolve("next/dist/bin/next"), ...process.argv.slice(2)], {
  cwd: fileURLToPath(new URL("../", import.meta.url)), env: { ...process.env, ...fake }, stdio: "inherit",
});
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
