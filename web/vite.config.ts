// @ts-nocheck -- the silo-public-css-urls plugin hook below is untyped on purpose: this file is also run as plain JavaScript by tests/braces-depth-guard.test.mjs, so it cannot carry TypeScript syntax.
import { verifyBracesGuard } from "./scripts/braces-depth-guard.mjs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig(async () => {
  verifyBracesGuard();
  const { default: vinext } = await import("vinext");
  process.env.CLOUDFLARE_CF_FETCH_ENABLED ??= "false";
  process.env.WRANGLER_SEND_METRICS ??= "false";
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  const { cloudflare } = await import("@cloudflare/vite-plugin");
  const commit = process.env.GITHUB_SHA || null;
  if (commit && !/^[a-f0-9]{40}$/.test(commit)) throw Error("Expected a full GitHub commit SHA.");
  if (process.env.GITHUB_ACTIONS === "true" && !commit) throw Error("Missing GitHub checkout SHA.");
  return {
    server: {host: '0.0.0.0', allowedHosts: ['terminal.local']},
    define: { __GRAINPAD_COMMIT__: JSON.stringify(commit) },
    resolve: { alias: [
      // Test-network signing (a devnet Silo key signing reviewed devnet layouts) is compiled in only when a test build asks for
      // it; a production build resolves the module to its held stand-in, so no such path exists in the mainnet beta.
      ...(process.env.SILO_BUILD_TEST_NETWORK_SIGNING === "true" ? [] : [{ find: /^(\.\/|@\/lib\/silo\/)native-keyring-testnet\.mjs$/, replacement: fileURLToPath(new URL("./lib/silo/native-keyring-testnet.held.mjs", import.meta.url)) }]),
      { find: /^@\/lib\/research\/regtest-(report|state)\.json$/, replacement: fileURLToPath(new URL("./data/lab-display.json", import.meta.url)) },
      { find: /^buffer$/, replacement: fileURLToPath(new URL("./node_modules/buffer/index.js", import.meta.url)) },
      { find: /^bigint-buffer$/, replacement: fileURLToPath(new URL("./vendor/bigint-buffer-js/index.cjs", import.meta.url)) },
      // Share cards: satori's yoga loads from a compiled wasm module (Workers forbid runtime wasm compilation).
      { find: /^yoga-layout\/load$/, replacement: fileURLToPath(new URL("./lib/og/yoga-load.mjs", import.meta.url)) },
      { find: /^grainpad-yoga-binary$/, replacement: fileURLToPath(new URL("./node_modules/yoga-layout/dist/binaries/yoga-wasm-base64-esm.js", import.meta.url)) },
      { find: /^grainpad-yoga-wrap$/, replacement: fileURLToPath(new URL("./node_modules/yoga-layout/dist/src/wrapAssembly.js", import.meta.url)) },
      { find: /^grainpad-yoga-enums$/, replacement: fileURLToPath(new URL("./node_modules/yoga-layout/dist/src/generated/YGEnums.js", import.meta.url)) },
    ] },
    plugins: [vinext(), {
      // vinext's renderBuiltUrl rewrites every CSS url() to /_next/static/... plus ?dpl=<id> once NEXT_DEPLOYMENT_ID is set (the
      // deploy workflow sets it). Files that live in public/ (fonts, brand images, coin icons) are not emitted there, so the
      // live wallet got 404 for every font and fell back to a system face (6 Nov 2026). Point those urls back at the public file.
      name: "silo-public-css-urls",
      enforce: "post",
      generateBundle(_options, bundle) {
        for (const file of Object.values(bundle)) {
          if (file.type !== "asset" || !file.fileName.endsWith(".css")) continue;
          const text = typeof file.source === "string" ? file.source : Buffer.from(file.source).toString("utf8");
          const fixed = text.replace(/\/_next\/static\/(fonts|brand|silo-icons)\/([A-Za-z0-9_.-]+)(?:\?dpl=[A-Za-z0-9._-]+)?/g, "/$1/$2");
          if (fixed !== text) file.source = fixed;
        }
      },
    }, cloudflare({
      viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
      inspectorPort: false,
      configPath: process.env.GRAINPAD_WORKER_CONFIG || "./wrangler.jsonc",
    })],
  };
});
