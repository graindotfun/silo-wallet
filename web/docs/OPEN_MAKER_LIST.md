# Signed maker list (format `silo-maker-list/1`)

Status: specification and verifier library (`web/lib/silo/maker-list/`, tests in `web/tests/silo-maker-list.test.mjs`). No list is published and no signing key exists. The wallet does not read a list yet.

## What this is, in plain words

A maker list is a short file that says "these makers are known, with these limits and fees". The wallet and the standalone client check the file's signature against public keys built into the software, then use it to label makers as listed or unlisted.

**The list makes the signer a trusted labeller.** Whoever holds the signing key decides which makers carry the "listed" label, and what limits, fees and build hashes that label displays. That is a real trust assumption and the product must say so wherever the label appears. The list is a label, not a gate: a user can always type a maker URL and use it, shown as unlisted. So the signer cannot stop anyone from using any maker. The signer can only stop labelling it, and can mislabel one. A false label is the harm to plan for, see the threats below.

Today there is one maker, run by us, and quotes go through our servers. This list is part of an experiment toward more than one maker and has a stop condition set by the operator. It is not a claim that the market is open.

## Envelope

```json
{
  "payload": "<standard base64 of the exact payload bytes>",
  "signatures": [ { "keyId": "silo-list-1", "alg": "ed25519", "sig": "<base64 of 64 bytes>" } ]
}
```

- The signature covers the exact decoded payload bytes. The signing tool emits the payload once and signs those bytes.
- Strict byte rules (so two verifiers in two languages cannot read one payload two ways): the bytes must be printable ASCII (0x20 to 0x7e, so no newline, no raw control or direction-override character, no look-alike letters); after parsing, no key or string may hold a control, format or direction-override character, which catches escaped ones such as `\u202e`; and the bytes must equal the compact `JSON.stringify` of the parsed content. That last rule refuses spacing, duplicate keys, number spellings like `5.0` or `1e2`, and redundant escapes, even when correctly signed. Amounts are decimal strings and every number is a plain integer. Refusals: `non-ascii`, `bad-characters`, `non-canonical`.
- Base64 is strict: standard alphabet, padding, no whitespace or line breaks.
- The verifier checks signatures before it parses the payload.
- Limits: payload at most 65536 bytes, 1 to 8 signatures, at most 64 makers. Unknown fields anywhere are refused. Changing the shape means a new format string (`silo-maker-list/2`), which an old client refuses by name.

## Payload

```json
{
  "format": "silo-maker-list/1",
  "version": 5,
  "issuedAt": "2026-11-11T00:00:00Z",
  "expiresAt": "2026-12-11T00:00:00Z",
  "network": "mainnet-beta",
  "programId": "<base58 swap program id>",
  "makers": [ {
    "id": "maker-one",
    "url": "https://maker-one.example",
    "solanaAddress": "<base58>",
    "caps": { "minXmr": "0.001", "maxXmrPerSwap": "0.05", "maxXmrPerDay": "0.3", "maxOpenSwaps": 3 },
    "spreadBps": 200,
    "buildHash": null,
    "buildHashStatus": "not proven",
    "contact": "ops@maker-one.example"
  } ]
}
```

| Field | Type and limit |
|---|---|
| `format` | exactly `silo-maker-list/1` |
| `version` | integer, at least 1, only grows. A client refuses a version below the `minVersion` compiled into its release (`below-minimum`) and a jump of more than `maxVersionJump` (default 50) above the highest version it has seen, or above `minVersion` on a fresh install (`version-jump`) |
| `issuedAt`, `expiresAt` | UTC `YYYY-MM-DDTHH:MM:SSZ`; expiry after issue, at most 90 days apart; issue not more than 5 minutes in the future |
| `network` | `mainnet-beta` or `devnet`; must equal the client's network |
| `programId` | Solana address; must equal the client's swap program id |
| `id` | `[a-z0-9][a-z0-9-]{2,31}`, unique in the list |
| `url` | `https` only, host name (no IP literal, no `localhost`), no credentials, query or fragment, at most 200 chars, unique after normalising case and trailing slash. Test mode alone allows `http` on localhost |
| `solanaAddress` | base58 that decodes to 32 bytes |
| `caps.*Xmr` | decimal strings, at most 12 decimals, `0 < minXmr <= maxXmrPerSwap <= maxXmrPerDay`; strings, so no float rounding |
| `caps.maxOpenSwaps` | integer 1 to 1000 |
| `spreadBps` | integer basis points, 0 to 2000 |
| `buildHash` | `null` or `sha256:<64 hex>` (the publish part's script defines how it is computed) |
| `buildHashStatus` | `not proven` or `proven`; `proven` is refused when `buildHash` is null. Use `not proven` unless evidence exists |
| `contact` | short printable text, 3 to 200 chars |

Caps and spread in the list are what the maker advertises. The maker's own quote is what applies. The wallet shows both and flags a quote above the listed spread. The list may be older than the maker's current limits.

## Verifier

`lib/silo/maker-list/verify.mjs` (plain `.mjs`, browser and Node, no network, no storage, no clock of its own). `verifyMakerList(envelope, { pinnedKeys, threshold, now, lastSeenVersion, network, programId, testMode })` returns `{ ok: true, list, signedBy }` or `{ ok: false, reason, detail }`. Signatures use ed25519 from `@noble/curves`, already used by `lib/silo/atomic-swap/keys.mjs`.

Pinned keys: one `keyId` once, and one public key under one `keyId` only (`loadPinnedKeys` checks this at load; the verifier checks again), so no signer counts twice toward the threshold. Extra options: `minVersion` (the lowest list version compiled into this release, shipped next to the pinned keys, which closes the fresh-install rollback) and `maxVersionJump`. Refusal reasons: `non-ascii`, `bad-characters`, `non-canonical`, `below-minimum`, `version-jump`, `bad-options`, `bad-envelope`, `payload-too-large`, `bad-base64`, `bad-signature-field`, `below-threshold`, `bad-json`, `unknown-format`, `bad-fields`, `wrong-network`, `wrong-program`, `rollback`, `not-yet-valid`, `expired`, `bad-maker`, `duplicate-maker`.

`makerMatchesEscrow(listEntry, counterpartyKey)` is the pure check for the rule below.

`classifyMaker(url, list)` returns `listed` (with the maker), `unlisted`, or `invalid-url`. It never blocks.

## Who signs (operator decision, open)

The signing key does not exist yet. Nobody should create it before the operator chooses. Options:

| Option | What it costs | What it protects against |
|---|---|---|
| A. One offline key (hardware wallet or air-gapped machine), the operator holds it, one backup in a second place | Cheapest and simplest. Loss of the key means a new key must ship in a wallet release. Theft of the key lets an attacker label a malicious maker as listed until a release pins a new key | A server break-in (the key is never online) |
| B. Two-of-three keys, threshold 2 in the verifier, three holders (for example the operator, a second trusted person, a backup in escrow) | Needs two other humans and a signing ceremony per list update, slower revisions. Verifier support already exists (`threshold`) | One stolen or lost key does not let anyone label, and one lost key does not stop updates |
| C. Online key in a CI job | Not recommended. Fast but the key is exposed to the same server that serves the list | Nothing against a server break-in |

Recommendation for the experiment: A for the initial list (one maker, nothing to mislabel yet) and B before a second maker run by someone else is listed. This is the operator's decision. The wallet release that pins keys must name the key ids and fingerprints in its notes so anyone can compare.

## Pinned keys and rotation

- Public keys are compiled into the wallet and the standalone client. They are not fetched.
- A new list signed by a still-pinned key may not introduce new keys by itself. The payload has no key field on purpose. Reason: if a list could add keys, one stolen key (or one stolen quorum) could add attacker keys and keep control after the operator rotates, and clients would have no way to tell a legitimate rotation from a takeover. Key changes ship as a wallet or client release, which is open source and reviewable, and which users get through the same channel as the code they already trust.
- Overlap: a release pins the old and the new key together for at least one full list lifetime (up to 90 days) and publishes lists signed by both. A later release drops the old key.
- Old clients that still pin only a retired key refuse new lists with `below-threshold`. They keep the last list they accepted, shown as stale after its expiry, and the user can still type any maker URL. They are not silently broken, and not silently trusted either.
- Emergency (key compromise): publish a new release pinning the new key, tell users to update, and publish a notice. Until a client updates, it trusts the compromised key. This is a limitation, not a solved problem.

## Rollback, expiry, revocation

- **Rollback protection.** The client remembers the highest `version` it accepted and passes it as `lastSeenVersion`. A lower version is refused (`rollback`). The same version is accepted. Without this, an attacker who serves an old signed list could re-list a revoked maker. The remembered value is local to the client and the caller must store it: the verifier keeps no state, so rollback protection holds only as far as the caller saves and passes back `lastSeenVersion`. With nothing remembered and no `minVersion`, the initial list must still be within `maxVersionJump` of 0. A fresh install has no memory, so each release also ships a `minVersion` next to the pinned keys, and the initial list it accepts must be at least that. Ship the current list in each release.
- **Expiry.** An expired list is refused with `expired`, and the result carries the signature-checked and parsed `staleList`. The UI shows it with a clear "list out of date" line and the date. Makers are not silently dropped and not silently trusted as current. Lists live at most 90 days.
- **Revocation.** To remove a maker, publish a higher `version` without it. A client that has the new version shows that maker as unlisted. A client that is offline or never fetched keeps showing the old one until its list expires. Revocation does not stop a swap already in progress, and does not stop anyone from using the maker as unlisted.

## What "unlisted" means in the UI

A maker URL the user typed, or one removed from the list, is allowed and labelled **unlisted**, with a plain line such as "Not on the Silo maker list. Silo has not checked this maker." Never blocked. Listed means only "the signer put it on the list". It does not mean independently reviewed, safe or proven, and the build hash line stays `not proven` until evidence exists.

## Privacy of fetching the list

Fetching a file from a host tells that host this IP uses the feature and when. Mitigations, in order of preference:

1. Ship the list inside the wallet release. No separate request at all.
2. If it is fetched, fetch it with the app's own static assets, from the same origin and in the same request pattern as everything else the wallet loads, so it adds no new signal.
3. Never fetch it per swap, and never send anything (no maker id, no amount) with the fetch. Refresh at most once a day and not at the moment a user starts a swap.

The list host still sees the fetch. It does not see which maker a user picks, because the pick happens later in the browser. See `docs/OPEN_MAKER_QUOTE_COMPARISON.md` for what the makers see.

## Client rule: bind the listed maker key

When the user chooses a listed maker, the client must refuse to start or continue a swap whose escrow counterparty key (the maker's refunder or claimer key in the escrow) is not the `solanaAddress` of the list entry the user chose. Use `makerMatchesEscrow`. Without it a listed maker can rotate its key to hide its refund history, and a hijacked URL can stand in for a listed maker. For an unlisted maker there is nothing to bind, and the UI says so. Conformance tests for clients must include a counterparty key mismatch.

## Design only, not built

- **Public hash of each list version.** The signer publishes the SHA-256 of each list version in a Solana memo transaction from a signer-controlled address, as the claim app does for its fingerprint. The client fetches the memo for the version it holds and refuses a payload with a different hash. Two different lists with one version number then become publicly visible instead of hidden from users. It costs one transaction per list version and needs an RPC read in the client, which tells that RPC host the client checks the list, so it should be optional and run on user action or through the user's own node.
- **User-added signer keys.** A user (or a group of Monero operators) adds their own signer public key, and the client then shows labels from that list too, kept apart from the Silo list ("Silo list: listed", "Your list: listed"). It spreads the labeller role and removes the single signer for users who care. It needs a settings screen, a clear warning that the user is trusting that key, and the same verifier with that key pinned locally.

## Known limits of format 1

- **Same version, different lists.** The verifier does not detect two different lists carrying the same version number, so a signer (or someone holding the key) could serve different lists to different users. A possible addition, not built: the client remembers the hash of the last accepted payload and refuses a different payload with the same version (the public hash in a Solana memo, above, would make it visible to everyone). Clients could also compare hashes out of band. Until then, treat the signer as able to equivocate.
- **No onion makers.** List entries must be https host names. Makers reachable only as Tor onion services, which some Monero operators may prefer, cannot be listed in format 1. Allowing them needs a new format version (or a field) that permits `.onion` URLs, client support for reaching them (Tor in the browser is not available, so mainly the standalone client), and a decision on how plain `http` over onion is labelled. Users can still type such a URL as unlisted where the client can reach it.

## Not covered here

Whether a listed maker behaves honestly (stalling, refusing swaps, a false build hash) is not something a signature can show. The list only carries claims. See the threat model once written, and the glass box page for what a maker publishes about itself.
