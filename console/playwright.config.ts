import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  use: { baseURL: "http://127.0.0.1:3316", trace: "retain-on-failure" },
  webServer: [
    { command: "node scripts/fake-services.mjs", port: 54346, env: { FAKE_PORT: "54346", FAKE_APP_URL: "http://127.0.0.1:3316" } },
    { command: "node scripts/fake-app.mjs build && node scripts/fake-app.mjs start -p 3316 -H 127.0.0.1", port: 3316, env: {
      FAKE_PORT: "54346",
      NODE_OPTIONS: `--require "${resolve("scripts/fake-call-provider.cjs").replaceAll("\\", "/")}"`,
      IRIS_CALL_HISTORY_KEY: "history-test-only",
      IRIS_CALL_AGENT_ID: "agent_demo_iris_0001",
      IRIS_CALL_BRANCH_ID: "agtbrch_demo_iris_0001",
      IRIS_CALL_LINE: "+441632960001",
      IRIS_CALL_LINE_LABEL: "01632 960001",
      KESTREL_HISTORY_CALLERS: JSON.stringify([
        { userId: "00000000-0000-4000-8000-000000000001", phone: "+441632960101", since: 1700000000 },
        { userId: "00000000-0000-4000-8000-000000000002", phone: "+441632960102", since: 1700000000 },
      ]),
    }, timeout: 120_000 },
  ],
});

