# Maker build verification: what the hash is, how to compute it, what it proves

Status: draft, 11 Nov 2026. Published with the maker source. Nothing here changes the running maker, and nothing here shows that the published code is what the running maker executes.
Tool: `web/prototypes/xmr-sol-atomic-swap/maker/release-hash.mjs` (tests: `release-hash.test.mjs`).

## In one paragraph

The swap maker is one program run by us. We can compute a single value, the release hash, from the maker's code files. Anyone who has the public code can compute the same value and check that it equals the value we publish. That shows which discovered manifest and file bytes the published value stands for. It is not exhaustive coverage of everything that executes, and it does not show the identity of the code that runs: it does not show that the maker running today is that code. Only we can see the host, and a hash the maker or its operator reports about itself proves nothing by itself. The page that shows the value must say "not proven" next to it until evidence beyond a self-report exists.

## What is hashed

The release set is found by reading the files, not from a fixed list:

- the entry points `maker/maker.mjs` and `maker/quiesce-check.mjs`,
- the files the tool discovers from them by the supported import syntax (maker modules and the client modules the maker imports); completeness is not established, a file loaded by any other route is not discovered,
- `maker/package.deploy.json` and `maker/package-lock.deploy.json`.

The manifest is one line per file, sorted by path in JavaScript string order (UTF-16 code units), which equals byte order only for ASCII names; the tool only accepts names made of `A-Z a-z 0-9 . _ -`, so that holds here. Each line is the digest, two spaces, the path relative to the root and a line feed. It resembles `sha256sum` output but has no `sha256sum` filename escaping. The release hash is `sha256:` followed by the sha256 of that manifest text. File bytes are hashed as they are, so LF and CRLF give different digests. Test files, `release-hash.mjs` itself and `README.md` are excluded from the extra-file reporting only; a file the entry points reach stays in the set even if its name looks like one of these.

The root is a directory that holds `maker/` and `client/` side by side: `web/prototypes/xmr-sol-atomic-swap` in the public repository `silo-wallet`, and the release directory on the maker host.

Immediate entries of `maker/` and `client/` that the entry points do not reach, except tooling files and `node_modules`, are listed as "extra (not hashed)", by name only. The tool does not open them and makes no recursive inventory of sub-directories. Add `--fail-on-extra` to turn any such entry into exit code 2.

The tool stops with an error (it fails closed) on: a symbolic link in any path component below the root, a resolved path outside the root, imports that leave `maker/` and `client/`, packages that `package.deploy.json` does not list, imports without a file extension, a reached file whose extension is not `.mjs` or `.js` (the two package files are the only data files allowed, any other `.json`, `.env` or key file is refused), a file name with characters outside `A-Z a-z 0-9 . _ -`, a reached file whose content looks like a secret (private key block, byte-array key, `NAME_TOKEN=value` style line, a file that is one long token), and any loading form the import reader does not support: `require`, `createRequire`, `eval`, `new Function`, `.constructor(`, a dynamic `import()` whose argument is not a plain string literal (a template literal counts as computed), `import.meta` other than a comparison with `import.meta.url`, a specifier written with an escape sequence, the Node modules `vm`, `module` and `worker_threads`, source the reader cannot finish tokenizing, and a `/` that it cannot classify with certainty as division or regular expression (see the scanner paragraph below). The secret checks are heuristics, not proof that a file holds no secret. This list is the whole refusal assurance: the scanner is a token rule, not a full ECMAScript parser, and any ECMAScript form not listed here is not certified.

Value for the 23 maker release files published in this repository with this document: `sha256:210960c027a503c3ad71492de375c918036262ef7c4e1a79021db47e9cc19dcb`. Recompute it with the recipe below at the commit you read; the recipe, not this line, is what counts. This is a statement about the published files only. It is not a statement about the running maker: the published code is not proven equal to the running maker.

## How anyone computes it from the public code at a commit

You need Node.js 20 or newer and `git`. After a checkout there is no install step, no network use and nothing is run besides the tool. Cloning uses the network, and `--from-git` runs the local `git` program.

```
git clone https://github.com/graindotfun/silo-wallet
cd silo-wallet
node web/prototypes/xmr-sol-atomic-swap/maker/release-hash.mjs web/prototypes/xmr-sol-atomic-swap --from-git <commit> --hash-only
```

`--from-git` reads the committed bytes of the selected input files of that commit, so local edits in your checkout do not change the result. The revision is resolved once to a commit id (printed on stderr and in `--json` output) and every file is read from that id, so a branch or tag that moves during the run cannot mix two commits. Pass a full commit id when you publish a value. 

You do not have to trust the tool. Print the file list with `--list` (or read the imports yourself) and recompute with standard programs, in the root directory:

```
node maker/release-hash.mjs . --list | tr '\n' '\0' | xargs -0 shasum -a 256 | shasum -a 256
```

The output starts with the hex part of the release hash. The recipe matches simple file names. A plain `xargs` without `-0` is unsafe for names with whitespace, quotes or backslashes, which is why the recipe splits on NUL; the tool also refuses such names in the set. On Linux use `sha256sum` in place of `shasum -a 256` (it prints a `-` after the digest; compare the digest only). A test in the tool's test file runs this recipe and compares.

## How the operator computes it on the host

Assumption, taken from the operator's runbook (not published): a release is a directory under `/opt/swapmaker/releases/`, named by the commit it was made from, holding `maker/` and `client/` as in the repository (the quiesce check is started as `node maker/quiesce-check.mjs` from that directory), with the deploy package files under their repository names. We can not see the host from here, so the operator must confirm this layout. If the name of an included path differs on the host, the hash will differ and the difference shows in the manifest. Renaming an excluded or unreached file need not change it.

```
cd /opt/swapmaker/releases/<release>
node <path to a copy of release-hash.mjs from the public repo> . --hash-only
node <same> .                      # full manifest, to diff against the public manifest
```

Run it as a user that can read the release directory. It needs no state directory, no environment file and no keys, and it prints only file names and hashes. Compare the output with the public manifest line by line; a difference names the file.

## Where the published value appears

In the glass box JSON (`format: "silo-glass-box/1"`) as two fields: `buildHash` (the string `sha256:<64 hex>`) and `buildHashStatus`. The status is `not proven` unless evidence beyond the operator's own statement exists, and the glass box page shows both together. The same two fields exist for each maker in the signed maker list (`buildHash`, `buildHashStatus`). The operator fills them; this document does not define more status words than that.

The running maker does not report a build hash today. A change that would let `/v1/health` return one is a possible change that is not made here, and it would not change what this document says: such a value is the maker describing itself.

## What a third party can check today

1. That the public code at a given commit gives a given release hash. This needs the code and the value to be published, and it is a check about the code, not about the host.
2. That the on-chain escrow program id is the one the page names, and who the upgrade authority is. Both are read from chain with any Solana RPC (for example `solana program show <program id>`). If the dated chain read shows an upgrade authority that is an owner wallet, then whoever holds that wallet can replace the program; that is a conclusion from the read, not something this tool establishes. This tool establishes neither that an authority exists nor who owns it. The glass box page states the result next to the address, read from chain with a date, not copied.
3. That the program's own build can be reproduced from public source. That needs separate public source and build instructions and reproducibility evidence; it is not covered by this hash. The public v2 repository and its workflow exist since 11 Nov 2026: on that date the workflow in graindotfun/silo-wallet PR 3 printed FULL MATCH. Cite it only as that dated fact, not as a standing guarantee.
4. What happens on chain: an observer can inspect public Solana lock, claim and refund activity. Addresses and transaction metadata may be linkable to users through other information; this hash provides no privacy guarantee.

## What a third party can not check today

- That the maker process runs the published code. The host is ours. A different or edited maker can print any hash string, and a maker that hashes its own files at start is the code being measured vouching for itself.
- That the directory that was hashed is the one that runs. Files can change after the hash, or the service can start from another path.
- Node.js version, the installed `node_modules` (the lockfile pins versions and integrity values, 58 of its 59 package entries carry an integrity value, but nothing here hashes the installed files), the Monero wallet program, the operating system.
- The maker's configuration: caps, spread, API token, sweep address, and which of the two directions is switched on.
- What the host logs or keeps. Swap records hold the user's Solana address, and the operator can read them. Quotes pass through our servers today, because only the Silo server holds the maker token.

## What would raise the bar, and what it costs

None of this is promised or scheduled. Each item says what it would add and what it would not.

- Remote attestation of the host (a measured boot or a confidential virtual machine that signs a statement about what it runs). It would let a third party check a signed measurement instead of our word. It needs hosting that supports it, which an ordinary virtual server usually does not, plus a way to publish and verify the statements. Attestation authenticates measurements under a verifier policy. Binding the maker, its dependencies, its configuration and its launch to that measurement needs a concrete design that does not exist yet. It does not show what the operator does with the data, and it adds trust in the hardware vendor.
- A fully reproducible release image (the maker, Node.js and the dependencies built from public source into one image with a published digest, started by digest). It makes "what runs" a single checkable value and covers `node_modules` and the Node.js binary. It still needs attestation or an outside operator to make the host report believable.
- A third party operating a maker from the public code. The operator, not us, then knows what runs, and users who choose that operator trust them instead of us. Cost: onboarding a person, a small float, and support. The public maker network is a plan and an experiment with a stop condition, not something that exists.
- Black-box probes by an outside party: request quotes over time and compare them with what the public quote code would produce, and watch refund counts on chain. This catches some misbehaviour and proves no code identity.

## What it proves and what it does not

It proves one thing: that a selected-source manifest can be recomputed, and that two parties who read the same input files get the same value. It does not prove:

- an independent reproduction of a complete release artifact,
- a binding to the running service. A matching hash reported by the operator proves nothing about what runs,
- anything about installed dependencies, the `node` binary and version, runtime configuration, the Monero wallet software, the host and operating system, logs and state, the launch identity, or the on-chain program.

## Canonicality

What the hash depends on, so that two implementations agree:

- Order: JavaScript string (UTF-16 code unit) order of the relative paths. Equal to byte order for ASCII names only; names outside `A-Z a-z 0-9 . _ -` are refused, and there is no Unicode or case normalization policy.
- Framing: for each file, the file digest, two spaces, the path, a line feed. The release hash is the sha256 of that text. No `sha256sum` filename escaping.
- Content: raw bytes. LF and CRLF files give different digests. Permissions and timestamps are not part of the hash.
- Symbolic links: refused in every path component below the root. The root argument itself is resolved with its real path.
- Paths: lexical normalization of import specifiers, then a check of every component with `lstat` and of the resolved real path against the root.
- Reads are sequential and not atomic: a file can change between two reads on a live directory. In git mode the revision is resolved to one commit id before any read and every read uses it.

## Limits of the tool itself

It reads selected files; secret avoidance rests on content and file system constraints (the checks above), not on never reading a file. The files it reaches are read and their sha256 is printed, so nothing secret may be in the release set: the digest of a file with a low-entropy secret in it (a short password, a guessable token) can be checked against guesses offline.

Imports are found by a tokenizer that skips comments, strings, template literals (code inside `${ }` is read) and regular expression literals. Static `import` and `export ... from` statements and `import()` with a plain string literal are followed, with or without import attributes (`with { ... }`). A mention inside a comment, string, template or regular expression is ignored, never followed and never an error, with one exception: a line that starts with `import` or `export` but was not read as code stops the tool, because the reader prefers an error to a guess. A `/` is classified by the token before it, without guessing. Regular expression: at the start, after an operator or opening punctuation, after `return`, `typeof`, `in`, `instanceof`, `new`, `delete`, `void`, `throw`, `case`, `do`, `else`, `extends`, after `${` in a template and after the head of `if`, `while`, `for` or `with`. Division: after a number, string, template end, regular expression, `]`, a plain `)`, a private name (`#word`, read as one token) and an ordinary identifier (also a keyword-like property name after `.`). A private name spelled like a keyword, a contextual keyword or a name the tool watches (`#return`, `#if`, `#of`, `#eval`, `#require`) stops the tool. In every other case the tool stops with an error that names the line: after `}` (it cannot tell a block end from an object or function expression end), after `++` or `--`, and after `of`, `yield` or `await`. So a computed import hidden behind a division such as `{} / import(p) / 1` is refused instead of skipped. The scanner fails closed on the forms listed here, and on nothing else. It is a token rule, not a full ECMAScript parser, and any ECMAScript form not listed is not certified: no claim is made about code outside the listed rules, and a full guarantee is not claimed. The tool's test file compares it with a real ECMAScript parser, used only as a test oracle (the tool needs no install), over generated valid modules; the tool must match the parser or stop. That is evidence for the generated cases, not proof for every program. Where a form is in doubt the design choice is to stop, and valid code that trips an ambiguous case must be rewritten (for example with a semicolon or parentheses). Files that are read at run time by other means (for example data files opened with `fs`, child processes, workers) are not discovered; the maker opens none from the release directory today, which this tool does not check.
