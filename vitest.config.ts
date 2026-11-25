import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

// The vars wrangler.jsonc ships, for test/clone-surface.test.ts. Its comments
// are whole lines, so dropping them leaves JSON.
const SHIPPED_VARS = JSON.stringify((JSON.parse(
  readFileSync("wrangler.jsonc", "utf8").replace(/^\s*\/\/.*$/gm, ""),
) as { vars: Record<string, string> }).vars);

// Test-only: base64 of "test-only".
const TEST_WEBHOOK_SECRET = "whsec_dGVzdC1vbmx5"; // gitleaks:allow
const TEST_SECRETS = {
  RELAY_AGENT_TOKEN: "relay-test-token",
  RELAY_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
  CLOUDFLARE_AI_GATEWAY_TOKEN: "gateway-test-token",
  AI_GATEWAY_ID: "test-gateway",
  VERTEX_PROJECT_ID: "test-project",
};
Object.assign(process.env, TEST_SECRETS);

export default defineConfig({
  // Prompt .md files are Text modules (wrangler.jsonc rules). In tests the
  // pool hands them to workerd under that rule, but `vitest related` walks the
  // import graph with Vite's import analysis first; mark them as non-JS there.
  assetsInclude: ["**/*.md"],
  plugins: [
    cloudflareTest({
      remoteBindings: false,
      additionalExports: {
        ThinkMessengerStateAgent: "DurableObject",
      },
      wrangler: {
        // No AI or Vectorize bindings: all model and source-search calls are mocked.
        configPath: "./test/wrangler.jsonc",
      },
      miniflare: {
        bindings: {
          // Generic transport fixtures use @lovelace handles. Group gate tests
          // enable the gate explicitly.
          RELAY_AGENT_HANDLE: "lovelace",
          RELAY_EVERY_GROUP_MESSAGE: "false",
          RELAY_SPEAK_GATE: "",
          SHIPPED_VARS,
          ...TEST_SECRETS,
        },
        durableObjects: {
          ThinkMessengerState: {
            className: "ThinkMessengerStateAgent",
            useSQLite: true,
          },
        },
      },
    }),
  ],
  test: {
    maxWorkers: 2,
    include: ["test/**/*.test.ts"],
  },
});
