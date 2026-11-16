# Encrypted bid protocol v1

Implemented 1 November 2026 for the local constructBlock capstone prototype. The browser and server share `backend/src/bid-protocol.ts`. No Solidity change is required: the existing three-field Evidence tuple is used.

## Context and framing

The package is canonical JSON with this property order:

- `protocol`: `constructBlock-bid-v1`
- `context`: `chainId`, `workflow`, `tenderId`, `bidder`, `version`
- `parts`: ascending part numbers (0 initial, 1 technical, 2 financial); exactly [0,2] or [0,1,2].

Chain, tender and version numbers are exact decimal strings; workflow and bidder addresses are lowercase. Version is the existing on-chain bidder version plus one. Each part contains `part`, `keyFingerprint`, `nonce`, `ciphertext`, `wrapped`, `evidence`. Evidence contains `commitment`, `ciphertextHash`, `wrappedPackageHash`. Unknown fields and noncanonical encodings are rejected. Binary values use standard padded base64. Digests are lowercase 0x-prefixed SHA-256 values.

Part context bytes are UTF-8 JSON of this array:

```
["constructBlock-bid-v1", chainId, workflow, tenderId, bidder, partNumber, version]
```

`frame(a,b,...)` concatenates a four-byte unsigned big-endian byte length followed by each byte string. This avoids ambiguous concatenation.

## Encryption and commitments

1. Read the TenderPublished event from the configured workflow. The event must be unique for the tender. This existing contract emits opening key fingerprints but does not retain them in the Tender struct.
2. Retrieve the public key from `/api/opening-keys/:fingerprint`. Verify SHA-256 over the RSA 3072 SPKI DER bytes against the corresponding published fingerprint. The browser independently checks this even when the backend returns a key.
3. Encode the file as UTF-8 JSON `{ "name": filename, "type": mediaType, "data": base64(fileBytes) }`. Filenames and media types therefore stay inside encryption.
4. Generate a fresh random 32-byte AES key, 32-byte commitment salt and 12-byte nonce for each part. Encrypt with AES-256-GCM, the context bytes as additional authenticated data and a 128-bit authentication tag. WebCrypto returns ciphertext followed by the tag; this combined byte string is stored as `ciphertext`.
5. Encrypt `AES key || salt` using RSA-OAEP with SHA-256. The result is the 384-byte `wrapped` value. No unwrapped key, salt or plaintext is sent to the API.
6. Compute `commitment = SHA256(frame(context, salt, plaintext))`; `ciphertextHash = SHA256(frame(context, nonce, ciphertextWithTag))`; `wrappedPackageHash = SHA256(wrapped)`.

This wire format is distinct from the original `constructBlock-demo-v1` walkthrough, which uses a different context and separately frames the GCM tag. Do not mix their hashes or packages. Independent Node RSA/AES decryption tests verify the browser format without relying on the browser encryption implementation to decrypt itself.

A server can verify schema, encrypted-part hashes, published key fingerprints and authorization. It cannot prove a submitted ciphertext is meaningful or verify the plaintext commitment without the protected opening process. Authenticated decryption and commitment verification must be performed at opening.

## Signed storage operations

`POST /api/storage/bids` accepts only the canonical encrypted bundle. It uses `X-Storage-Timestamp` and `X-Storage-Signature` headers. The wallet signs the exact message returned by `storageMessage('upload', context, contentId, timestamp)`. The message binds the action, deployment chain/workflow, bidder, tender, version, SHA-256 of the full canonical bundle and issuance time. Only timestamps within five minutes of server time are accepted.

The backend checks the current BIDDER_ROLE, deployment, open tender, chain deadline, pause state, next version, required parts and published fingerprints. An accepted upload returns `{ contentId, stored: true, acceptedOnChain: false }`. A repeated identical upload is idempotent while the same version remains eligible. Replays cannot change the payload. Once the bid version advances, that upload authorization cannot advance a new version.

`POST /api/storage/:contentId/retrieve` takes the canonical context as JSON and requires a separate `download` signature. Only the owning wallet with a current bidder role can retrieve its package, including after a deadline. Retrieval revalidates object hashes. There is no public static file route. A separate opening-service endpoint was added on 3 November; see Protected_Opening_Service.md for its signed, stage-restricted policy.

A storage authorization is not a blockchain transaction and not a backend login session. The API holds no wallet signer or government decryption key. The actual bid is accepted only after a successful matching BidSubmitted receipt. The opening-service role now has a separate signed retrieval endpoint; commission document access still needs its own restricted design.

## Persistence and linkage

Each canonical encrypted bundle is stored as `backend/storage/<contentId>.json` by default, where `contentId = SHA256(canonicalBundleBytes)`. The same bytes produce the same identifier. The package permanently contains its deployment/tender/bidder/version context and every part's exact Evidence tuple. Those tuples are also emitted and stored by submitBid. This is the relationship between a stored package and a contract bid; the full-package content ID itself is not stored in the unchanged contract.

The backend writes a temporary file, flushes its contents and publishes it using a hard link without overwriting an existing object. This prevents readers observing a half-written object. The current single-process service serializes quota checks and writes. Default limits: 1 MiB per plaintext file, one file per required part, 6 MiB per canonical bundle, 8 MiB HTTP JSON parsing, 256 MiB stored objects and 1000 packages. Storage requests are limited to 30 per minute per remote IP. A failed/rejected wallet transaction can leave an unsubmitted package; there is no automatic deletion or retention policy.

The bidder can save the encrypted bundle as a backup, recompute its identifier, restore it for an eligible version, and retrieve the stored copy. The protected opening endpoint now discovers matching parts using a bounded scan of objects and the on-chain Evidence. A durable index and automatic receipt reconciliation remain subsequent work. Do not remove an object merely because its upload has not yet been reconciled to a transaction.

## Key setup and trust boundary

Run `npm --prefix backend run keys:generate` from the project root. It writes public SPKI files to `backend/opening-keys` and private PKCS8 files to a unique folder under `.constructblock-custody` outside the API storage roots. The command prints only public fingerprints and the custody path. Files use restrictive filesystem permissions and the generated directories are ignored by Git. Copy the public fingerprints into a newly published tender. Existing placeholder fingerprints cannot be repaired without publishing a new tender.

The helper is for local development. Private keys are unencrypted files readable by the local operator, not split custody, HSM storage or threshold decryption. The keys remain under government key management and are used only after commission-authorized opening checks. Do not upload keys or private material to the storage API. The API must never be pointed at the custody directory.

## Current limitations

Local loopback service only; no production hosting, TLS termination, general login sessions, malware scanning, object-store replication, offsite backups, durable database index, retention/cleanup jobs, multi-worker quotas, deployed production custody infrastructure or retrieval for revoked bidders. A Vault provider and separate restricted commission viewer are now implemented; see Restricted_Documents_and_Key_Custody.md. Signed requests authorize a narrowly defined storage action, not general government identity verification. Server compromise still threatens availability and object replacement (detected by independent hash checks); development custody keys on the same laptop are not isolated from an operator compromise.

The browser tracks public transaction metadata in localStorage and supports manual receipt checks without resubmitting. Dropped or replaced transaction recovery remains a manual wallet activity check. Bid replacement uses the next version; withdrawal currently remains a contract/script operation. Production review is needed before using real procurement documents.

## Verification

`npm test` covers schema, key substitution, independent decryption, tampering, signatures, role revocation, owner-only retrieval, persistence, quotas and HTTP handling. `npm run test:storage` exercises browser wallet functions, signed HTTP, disk persistence and actual contracts on an isolated Hardhat EVM. Its retained report is `contracts/reports/bid-storage-smoke.json`.

Technical references: [W3C Web Cryptography API](https://www.w3.org/TR/webcrypto-1/) and [ethers message signing](https://docs.ethers.org/v6/getting-started/). These describe primitives and APIs; the package format and authorization rules above are project-specific.

## Protected opening extension added 3 November 2026

The separate opening endpoint returns only the authorized part after current role and stage checks. An operator worker, not the HTTP server, loads the matching private key, verifies in memory and records the non-sensitive outcome digest. See [Protected_Opening_Service.md](Protected_Opening_Service.md). This preserves the encryption format above and adds no contract change. The development custody files are still not cryptographic threshold custody.

## OrbitDB adapter added 13 November 2026

Encrypted persistence can now be selected with `STORAGE_PROVIDER=orbitdb`. The adapter stores actual encrypted part contents in database records and uses a separate local owner process shared by the API and restricted viewer. There is no replication workflow. Filesystem storage remains explicitly selected while external dependency installation and live validation are pending. See [setup and verification](OrbitDB_Encrypted_Storage.md).
