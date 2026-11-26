import { availableParallelism } from "node:os";
import { northwindResponse } from "./test/fixtures/iris/outbound.ts";
import { buildSync } from "esbuild";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The brain's `DESK` service binding needs a Worker named northlight-desk. It is the real desk (desk/index.ts) bundled
// here, as an auxiliary Worker: the same RPC, bindings and checks as production, with the test credentials below and
// an outbound service that answers every request it would have sent with an echo of it (no real API is called).
const DESK_BUNDLE = ".wrangler/desk-test/index.mjs";
buildSync({
  entryPoints: ["test/fixtures/iris/desk.ts"], outfile: DESK_BUNDLE, bundle: true, format: "esm", platform: "neutral", target: "es2023",
  conditions: ["workerd", "worker", "browser"], mainFields: ["module", "main"], external: ["cloudflare:*", "node:*"], logLevel: "error",
});

// Test-only values; real ones live in .dev.vars / desk/.dev.vars or Cloudflare secrets. The desk's names, not the brain's.
const DESK_SECRETS = {
  OPENAI_DESK_API_KEY: "test-openai-desk-key", GITHUB_TOKEN: "ghp_desk_test_secret_value",
  R2_MEDIA_ACCESS_KEY_ID: "test-media-access-key-id", R2_MEDIA_SECRET_ACCESS_KEY: "test-media-secret-access-key", R2_MEDIA_ACCOUNT_ID: "testaccount0123",
};

export default defineConfig({
  test: {
    name: "brain",
    // Synthetic test-only clients and agents (acme, beacon; helper, second) beside the real kestrel/iris.
    setupFiles: ["./test/fixtures/setup.ts"],
    // Each test file starts an isolated Workers runtime with a separate desk service.
    maxWorkers: availableParallelism() > 4 ? 4 : undefined,
  },
  plugins: [
    cloudflareTest({
      // The installed pool otherwise defaults to remote proxies for AI (even with a Wrangler login present).
      remoteBindings: false,
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          CLIENT_TOKEN_NORTHWIND: "test-northwind-0123456789abcdef",
          USER_SIGNING_KEY_NORTHWIND: "test-user-northwind-0123456789abcdef",
          APPROVER_SIGNING_KEY_NORTHWIND: "test-approver-northwind-0123456789abcdef",
          ACCESS_SIGNING_KEY_NORTHWIND: "test-access-northwind-0123456789abcdef",
          CLIENT_TOKEN_KESTREL: "test-token-kestrel-0123456789abcdef",
          USER_SIGNING_KEY_KESTREL: "test-signing-key-kestrel-0123456789abcdef",
          DASHBOARD_SIGNING_KEY_KESTREL: "test-dashboard-key-kestrel-0123456789abcdef",
          APPROVER_SIGNING_KEY_KESTREL: "test-approver-key-kestrel-0123456789abcdef",
          ACCESS_SIGNING_KEY_KESTREL: "test-access-key-kestrel-0123456789abcdef",
          CLIENT_TOKEN_TEST: "test-token-test-0123456789abcdef",
          CLIENT_TOKEN_ACME: "test-token-acme-0123456789abcdef",
          USER_SIGNING_KEY_ACME: "test-signing-key-acme-0123456789abcdef",
          DASHBOARD_SIGNING_KEY_ACME: "test-dashboard-key-acme-0123456789abcdef",
          APPROVER_SIGNING_KEY_ACME: "test-approver-key-acme-0123456789abcdef",
          ACCESS_SIGNING_KEY_ACME: "test-access-key-acme-0123456789abcdef",
          CLIENT_TOKEN_BEACON: "test-token-beacon-0123456789abcdef",
          USER_SIGNING_KEY_BEACON: "test-signing-key-beacon-0123456789abcdef",
          DASHBOARD_SIGNING_KEY_BEACON: "test-dashboard-key-beacon-0123456789abcdef",
          APPROVER_SIGNING_KEY_BEACON: "test-approver-key-beacon-0123456789abcdef",
          ACCESS_SIGNING_KEY_BEACON: "test-access-key-beacon-0123456789abcdef",
          BEACON_SLACK_SIGNING_SECRET: "test-slack-signing-secret-0123456789",
          BEACON_PHONE_CALLERS: JSON.stringify({ "+15550001111": "Jess", "+15550002222": "Alex" }),
          DEEPSEEK_API_KEY: "test-model-key",
          OPENAI_API_KEY: "test-openai-key",
          ANTHROPIC_API_KEY: "test-claude-key",
          // The lead intake's key.
          LEADS_SIGNING_KEY: "test-leads-signing-key-0123456789abcdef",
        },
        workers: [{
          name: "northlight-desk", modules: true, scriptPath: DESK_BUNDLE, compatibilityDate: "2026-10-01", compatibilityFlags: ["nodejs_compat"],
          bindings: DESK_SECRETS,
          r2Buckets: { IMAGES: "northlight-images" },
          // The brain's Dashboard object lives in the test runner Worker (named after the project above).
          durableObjects: {
            DASHBOARD: { className: "Dashboard", scriptName: "vitest-plugin-runner-brain" },
          },
          outboundService: async request => {
            const fixture = northwindResponse(request);
            if (fixture) return fixture;
            return Response.json({ url: request.url, method: request.method, headers: Object.fromEntries(request.headers), body: await request.text() });
          },
        }],
      },
    }),
  ],
});
