// Sets up browser calls to Iris in one go: Iris's private voice agent on ElevenLabs, and the console's call settings on
// Vercel. ElevenLabs does the listening and speaking; every answer comes from the brain's /v1/chat/completions as Iris.
//
// Usage, in your own terminal, from agent/:
//   node scripts/elevenlabs-iris.mjs
// It asks for the ElevenLabs API key (ElevenLabs Agents: Write) without showing it, or reads ELEVENLABS_API_KEY.
// It reads the brain's client token from ../.secrets/agent-secrets.json (CLIENT_TOKEN_KESTREL) and stores it in
// ElevenLabs as a workspace secret, so the voice agent can call the brain. Then, unless --no-vercel is given, it sets the
// console's IRIS_CALL_HISTORY_KEY (the same key, as a Vercel secret), IRIS_CALL_AGENT_ID and IRIS_CALL_BROWSER=on for
// production with the Vercel CLI. Redeploy the console afterwards. Run it again to update everything in place.
// It prints the voice agent's id and nothing secret.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BRAIN = (process.env.BRAIN_URL ?? "https://northlight-agent.latczar.workers.dev").replace(/\/+$/, "");
const API = "https://api.elevenlabs.io/v1/convai";
const NAME = "Iris (Northlight)";
const SECRET_NAME = "northlight-client-token-kestrel";
// "Alice", a British voice from ElevenLabs' default library (free on every plan). Override with IRIS_VOICE_ID.
const VOICE = process.env.IRIS_VOICE_ID ?? "Xb7hH8MSUJpSbSDYk0k2";
const CONSOLE = fileURLToPath(new URL("../../console/", import.meta.url));

/** Reads one line from the terminal without showing it. A paste may arrive wrapped in bracketed-paste markers. */
function askHidden(question) {
  if (!process.stdin.isTTY) {
    console.error("Run this in a terminal, or set ELEVENLABS_API_KEY first.");
    process.exit(1);
  }
  process.stdout.write(question);
  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.resume();
  return new Promise(resolve => {
    let value = "";
    const done = () => {
      process.stdin.off("data", read);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
    };
    const read = chunk => {
      for (const char of chunk.replace(/\x1b\[20[01]~/g, "")) {
        if (char === "\u0003") { done(); process.exit(130); }
        if (char === "\r" || char === "\n") { done(); resolve(value.trim()); return; }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
    };
    process.stdin.on("data", read);
  });
}

const key = process.env.ELEVENLABS_API_KEY || await askHidden("Paste the ElevenLabs API key, then press Enter (it stays hidden): ");
if (!key) {
  console.error("No key given. Nothing was changed.");
  process.exit(1);
}
let token;
try {
  token = JSON.parse(readFileSync(new URL("../../.secrets/agent-secrets.json", import.meta.url), "utf8")).CLIENT_TOKEN_KESTREL;
} catch {
  // falls through to the message below
}
if (typeof token !== "string" || token.length < 32) {
  console.error("Could not read CLIENT_TOKEN_KESTREL from .secrets/agent-secrets.json.");
  process.exit(1);
}

/** One ElevenLabs request. Errors print the status and ElevenLabs' messages, never what was sent. */
async function call(method, path, body) {
  const response = await fetch(API + path, {
    method, headers: { "xi-api-key": key, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = data?.detail;
    const messages = Array.isArray(detail) ? detail.map(d => `${(d.loc ?? []).join(".")}: ${d.msg}`) : [detail?.message ?? detail?.status ?? "no detail"];
    console.error(`ElevenLabs refused ${method} ${path.split("?")[0]} (HTTP ${response.status}):\n  ${messages.join("\n  ")}`);
    if (response.status === 401) console.error("Check the key was pasted in full and has ElevenLabs Agents: Write.");
    process.exit(1);
  }
  return data;
}

// The brain's client token, as a workspace secret the voice agent sends as its API key (Authorization: Bearer).
const secrets = await call("GET", "/secrets");
const existing = (secrets.secrets ?? []).find(s => s.name === SECRET_NAME);
let secretId = existing?.secret_id;
if (secretId) await call("PATCH", `/secrets/${secretId}`, { type: "update", name: SECRET_NAME, value: token });
else secretId = (await call("POST", "/secrets", { type: "new", name: SECRET_NAME, value: token })).secret_id;

const agent = {
  name: NAME,
  tags: ["northlight"],
  conversation_config: {
    agent: {
      language: "en",
      first_message: "Hi, it's Iris. What would you like to look at on the Kestrel Garage website?",
      prompt: {
        // Not used: the brain answers with Iris's own instructions. ElevenLabs requires a prompt to be set.
        prompt: "You are Iris, the website manager for Kestrel Garage. Answers come from the Northlight brain.",
        llm: "custom-llm",
        custom_llm: { url: `${BRAIN}/v1`, model_id: "iris", api_key: { secret_id: secretId } },
      },
    },
    tts: { voice_id: VOICE },
    conversation: { max_duration_seconds: 300 },
  },
  platform_settings: {
    // Private: a call needs a one-time token from the console's server, so nobody else can start one.
    auth: { enable_auth: true },
    // The console passes the call's conversation id and the person's signed pass to the brain this way.
    overrides: { custom_llm_extra_body: true },
  },
};

const found = await call("GET", `/agents?search=${encodeURIComponent(NAME)}&page_size=10`);
const current = (found.agents ?? []).find(a => a.name === NAME);
const agentId = current
  ? (await call("PATCH", `/agents/${current.agent_id}`, agent), current.agent_id)
  : (await call("POST", "/agents/create", agent)).agent_id;

const saved = await call("GET", `/agents/${agentId}`);
const llm = saved.conversation_config?.agent?.prompt;
console.log(`${current ? "Updated" : "Created"} the voice agent "${NAME}".`);
console.log(`  Agent id:        ${agentId}`);
console.log(`  Answers from:    ${llm?.custom_llm?.url ?? "?"} as model ${llm?.custom_llm?.model_id ?? "?"} (${llm?.llm ?? "?"})`);
console.log(`  Private:         ${saved.platform_settings?.auth?.enable_auth === true ? "yes" : "NO"}`);
console.log(`  Extra body:      ${saved.platform_settings?.overrides?.custom_llm_extra_body === true ? "allowed" : "NOT allowed"}`);

if (process.argv.includes("--no-vercel") || !existsSync(new URL("../../console/.vercel/project.json", import.meta.url))) {
  console.log("Next: set IRIS_CALL_HISTORY_KEY (the key), IRIS_CALL_AGENT_ID (the id above) and IRIS_CALL_BROWSER=on for the console.");
  process.exit(0);
}

/** One production setting on the console's Vercel project. The value goes on stdin, never on the command line or screen. */
function setVercel(name, value, sensitive) {
  // One command string (the name and flags are fixed here), so Windows can run vercel.cmd through the shell.
  const result = spawnSync(`vercel env add ${name} production --force --yes ${sensitive ? "--sensitive" : "--no-sensitive"}`, {
    cwd: CONSOLE, input: value, encoding: "utf8", shell: true,
  });
  const ok = result.status === 0;
  console.log(`  Vercel ${name}: ${ok ? "set" : "FAILED"}`);
  if (!ok) console.error(`    ${(result.stderr || result.stdout || "").split("\n").filter(line => line.trim() && !line.includes(value)).slice(-3).join("\n    ")}`);
  return ok;
}
console.log("Console settings (production):");
const set = [setVercel("IRIS_CALL_HISTORY_KEY", key, true), setVercel("IRIS_CALL_AGENT_ID", agentId, false), setVercel("IRIS_CALL_BROWSER", "on", false)];
console.log(set.every(Boolean) ? "Done. Redeploy the console to switch Talk to Iris on." : "Some console settings failed: set them with `vercel env add` from console/.");
