# Verify the Silo web app

This page explains how to compare the wallet app that https://silo.trading serves with the source in `web/`, what we
measured, and what you cannot check yet.

## Result, measured on 2026-11-09

- The live wallet page `https://silo.trading/app` is served by Cloudflare Worker `grain-silo`, version
  `732d4c5f-df6c-4c92-8b1e-13269af60a1a`. It was built from source commit `6dd7023cb3203dbdaac82b9af68bd2a016ad607b`. The
  page itself names that commit: search the page source for `6dd7023cb3203dbdaac82b9af68bd2a016ad607b`.
- The page, and the scripts and stylesheets it loads, refer to 143 static files that the site serves: JavaScript,
  stylesheets, fonts, icons, and the Monero and Zcash engines that run in the browser.
- We rebuilt that commit from a clean copy with the recipe below. All 143 files had the same sha256 as the files the site
  serves. A second rebuild, with hidden source maps turned on so we could see which source file ends up in which served
  file, again gave the same bytes for all 143.
- Two files in `web/` differ from the commit, in comments only (see "What was changed"). A third rebuild with those two
  edited files also gave the same bytes for all 143. Comments are removed when the code is minified.
- The served pages contain router data that names 127 more files, for other pages of the same codebase. The wallet Worker
  refuses to serve those (it answers 404, by design: it only serves an allowlist of wallet files). The script lists them
  for information.

What this shows: the files the site serves on that date are exactly what that commit builds to, on our machine. What it
does not show yet: that you can rebuild them yourself. Read the next section.

## What you can check yourself, and what you cannot yet

You can:

1. Check that the site still serves the files we recorded for commit `6dd7023c`
   (`docs/verify-app/expected-6dd7023c.json`). Run the script below. After a new deploy the files change, and this check
   reports mismatches until a new expected file is published for the new commit.
2. Read the source of everything in those files. `docs/verify-app/chunk-sources-6dd7023c.json` lists, for every served
   JavaScript file, the source files in `web/` and the npm packages that went into it.
3. Rebuild the Monero engine from this repository alone and compare it with the served files (see "Rebuild the Monero
   engine"). We did this from a fresh copy of `web/` and got the same bytes for both files.
4. Run the tests in `web/tests/` (see "Run the tests").

You cannot yet:

- Rebuild the app's JavaScript and stylesheets from this repository alone. The wallet is compiled in one build together with the other pages,
  the server code and the build scripts of the private source tree. The bundler decides file boundaries and file names from
  the whole build, and the stylesheet generator collects class names from every source file of that tree, so a build of
  `web/` on its own would give different files, even with identical wallet code. To close this gap, either the wallet gets
  a build of its own or the full set of build inputs is published. Neither is done yet, and there is no date for it.
- Check the build on a second machine. The rebuilds above ran on one macOS machine (arm64) with Node 22.22.3 and
  `npm ci` from the commit's lockfile. A Linux build of this commit has not been compared.
- Compare the HTML. The page is rendered for each request and carries a fresh security nonce, so it differs every time.
  Only the files it loads are compared.

Not checked by us: the Zcash engine. Its build script (`web/scripts/silo/build-zec-core.sh`) needs a pinned Rust nightly
toolchain and wasm-bindgen; we did not run it for this check. Its served files match the recorded hashes, and the
expected values are pinned in `web/lib/silo/zec-sdk-manifest.json`.

## Run the check

Node 22 or later, no packages needed:

```bash
node scripts/verify-app.mjs --expected docs/verify-app/expected-6dd7023c.json
```

The script fetches `/app`, follows every script, stylesheet, font and engine file that the page and its scripts name on the
same origin, and hashes what it gets. For each file it prints one of:

| Result | Meaning |
|---|---|
| `match` | Same sha256 as every reference you gave (`--expected` and/or `--dist`) |
| `mismatch` | Served bytes differ from a reference |
| `missing-in-reference` | The site serves a file that the reference does not contain |
| `referenced-not-served` | Named inside the code but refused by this origin (other pages); information only |

The last line is a summary. Exit code 0 means no `mismatch` and no `missing-in-reference`. On 2026-11-09 the summary was:

```
{"origin":"https://silo.trading","documents":[{"page":"/app","status":200}],"files":270,"counts":{"referenced-not-served":127,"match":143}}
```

Other options: `--dist <dir>` compares with a local build output directory (`dist/client`), `--write <file>` records
what is served now, `--json` prints every row, `--origin` and `--page` choose another origin or page.

## The build recipe we ran

This is the recipe of the production deploy workflow, run locally. It needs the full private source tree at the commit,
which is why you cannot run it from this repository yet. It is written here so that reviewers who have that tree can repeat
it, and so you can see exactly which inputs and switches go into the build.

```bash
SHA=6dd7023cb3203dbdaac82b9af68bd2a016ad607b
# Node 22.22.3, a clean export of the commit
npm ci
# Close the five launch switches of the launchpad that shares this codebase. They are open in the commit and closed in
# every wallet build, so the wallet Worker never carries them. Only these five lines change:
#   lib/platform-settings.mjs          TOKEN_CREATION_ENABLED = false
#   lib/rewards-policy.mjs             REWARDS_OPERATIONAL = false
#   lib/official-launch-policy.mjs     OFFICIAL_LAUNCH_SIGNING_ENABLED = false
#   lib/official-launch-readiness.mjs  OFFICIAL_LAUNCH_READINESS_ACKNOWLEDGED = false
#   lib/official-lookup-extension.mjs  LOOKUP_EXTENSION_SIGNING_ENABLED = false
# Keep a non-wallet page out of the Worker's static files:
printf 'pet/\n' >> public/.assetsignore
# Build. NEXT_DEPLOYMENT_ID pins an id that is otherwise random per build. SOLANA_RPC_URL must not be set.
NEXT_DEPLOYMENT_ID=$SHA GITHUB_SHA=$SHA GRAINPAD_WORKER_CONFIG=wrangler.silo.jsonc npm run build
# Compare
node scripts/verify-app.mjs --dist dist/client --expected docs/verify-app/expected-6dd7023c.json
```

`lib/rewards-policy.mjs` and `lib/platform-settings.mjs` are in `web/` (the wallet imports them). They are published as
they are in the commit, with the switch set to `true`; the served files were built with `false`, as above.

Not built by this recipe: the Monero engine (`/silo-sdk/monero-sdk-*.js` and `/silo-sdk/monero-worker-*.js`) and the
Zcash engine (`/silo-sdk/zec-core-*/`). They are built once with their own scripts, committed as files, and served as they
are. Their sha256 values are pinned in `web/lib/silo/xmr-sdk-manifest.json` and `web/lib/silo/zec-sdk-manifest.json`.

## Rebuild the Monero engine

This one works from this repository alone. Node 22.22.3, network access to the npm registry:

```bash
cd web
npm ci --ignore-scripts        # installs the exact versions from the source lockfile; the install script of the private tree is not in web/
node scripts/silo/build-xmr-sdk.mjs                 # bundles lib/silo/xmr-sdk-entry.ts with monero-ts 0.11.20
node scripts/silo/build-experimental-xmr-worker.mjs # builds the browser worker from monero-ts 0.11.20 with the helpers in docs/security/proposals/
shasum -a 256 public/silo-sdk/monero-sdk-7b5da83603c012d3.js public/silo-sdk/monero-worker-2b5086070f76c982.js
```

Expected, and what the site serves (see `docs/verify-app/expected-6dd7023c.json`):

```
7b5da83603c012d3061a14ea9c091db9796bf4b243b431fb9ce2ab843f4a7c01  public/silo-sdk/monero-sdk-7b5da83603c012d3.js
2b5086070f76c98261a6fb0f322c5d6e2824f970a443d0f967a267cf0ff995f8  public/silo-sdk/monero-worker-2b5086070f76c982.js
```

The scripts name each file after the leading 16 hex characters of its sha256 and rewrite `lib/silo/xmr-sdk-manifest.json`;
after both steps that file is the same as the committed one. `build-xmr-sdk.mjs` also writes
`public/silo-sdk/monero-worker-fd2e8b51051fec39.js`, the unmodified upstream worker, which the site does not use. The
served worker is built from the upstream worker source with Node's `fs` and `crypto` replaced by stubs that refuse every
call (`web/docs/security/proposals/silo-sdk-worker-removal-20261014/`).

## What is in `web/`

Every file in `web/` is taken from commit `6dd7023c` at the same path. `PUBLIC_MANIFEST.json` lists each file with its
sha256 and its git blob id in that commit.

- `components/`, `hooks/`, `lib/`, `app/app/error.tsx`, `app/error.tsx`, `vendor/bigint-buffer-js/`: every source file
  that the source maps of the served JavaScript name. That is the whole code that runs in your browser, apart from npm
  packages and the engines above.
- Some of these files belong to the shared site frame (header, footer, theme, price tab) or to the launchpad that shares
  this codebase. They are here only because the wallet bundle imports them.
- `app/layout.tsx`, `app/app/page.tsx` and the stylesheets they load: the page entry points. These two `.tsx` files run on
  the server and are not sent to the browser. They are here to show which component and which stylesheets the page uses.
  The server modules they import are not published.
- `prototypes/xmr-sol-atomic-swap/maker/` and the six client files it imports: the swap maker code as it is in the same
  commit, with its tests. The maker runs as a separate service and is deployed on its own. This repository does not
  claim that the running maker process is identical to this code.
- `scripts/silo/`, `docs/security/proposals/silo-sdk-worker-removal-20261014/` (five build helper files only),
  `vendor/silo/zec-core/`, `lib/silo/xmr-sdk-entry.ts`: how the Monero and Zcash engines are built.
- `package.json`, `package-lock.json`, `vite.config.ts`, `tsconfig.json`, `next.config.ts`, `postcss.config.mjs`,
  `vendor/shadcn-tailwind-4.13.0.css`: build inputs, unchanged. The name, licence and repository fields in `package.json`
  describe the private source tree. In this repository the files in `web/` are under the licence stated in `NOTICE`.
- `tests/`: the 83 test files of the commit that import only files in `web/` and pass on their own (498 tests).

## Run the tests

```bash
cd web
npm ci --ignore-scripts
node --test tests/*.test.*                                     # 498 tests on 2026-11-09, all passing
node --test prototypes/xmr-sol-atomic-swap/maker/maker-core.test.mjs   # 13 maker tests
```

Use `node --test` directly: the `test` script in `web/package.json` belongs to the private tree and names files that are
not here.

## What is not in `web/`

- The server side of the Worker: API routes, server modules, the account and sync server, and the Worker configuration
  (`wrangler` files, variables, bindings) and its secrets.
- The deploy and release scripts of the private source tree.
- Pages and code of the launchpad that the wallet does not import.
- Binary files that the site serves (fonts, logos, coin icons, the engine files). Their sha256 values are in
  `docs/verify-app/expected-6dd7023c.json`.
- The other tests of the commit: those that import or read files outside `web/`, and 45 that drive a browser (they need
  Playwright).

## What was changed

Two files, comments only. Neither change alters a served byte (checked by the third rebuild above).

| File | Change |
|---|---|
| `web/lib/silo/revenue-policy.mjs` | Removed a person's name, email address and a quote from private business correspondence |
| `web/lib/fee-policy.mjs` | Replaced a person's given name with "owner" |

Comments that refer to internal review rounds were left as they are. They explain why a check exists.

## Notes

- A few stored identifiers contain the word "grain" (see the compatibility note in `README.md`).
