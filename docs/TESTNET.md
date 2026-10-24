# The cycle on Zcash testnet

The bridge's whole cycle, run on Zcash testnet on 2026-10-24 against a collections ledger index following testnet,
for item #5484 of a bridged 10,000 item collection. The marketplace has no testnet, so its public API and its escrow
account were played by stand-ins (`demo/standin-venue.ts` and the operator's escrow book); everything on the ledger
side is real testnet transactions.

| | |
|---|---|
| Network | Zcash testnet |
| Ledger protocol id | `aa2605bbbda40d28…` |
| Bridged collection | `0a0dd2c6ee1d45ee…`: 10,001 copies (ids 0 to 10,000), all held by the custody key at its start |
| Custody key | `048afb52608c012edd6e91fbb507a27febeda6c8c33a5a1728d105fca6cf5206` |
| Holder key | `bbd8bfbb778a6fc1408800199979210706fb4f0938ffdd51005ef3441bcf0fc7` |

## Steps

| Step | Command | Result |
|---|---|---|
| The ledger starts | (the ledger's own protocol and collection start) | txids `6abb95c57c93e69c0788cff16782ff52a20cb6031edbdd4712cd40e2e16271b3`, `289c50f773770ff31f4a0288627b567a5bd1534338de1bb9598471a80df38a78` |
| Copy #5484 in custody | ledger index `GET /v1/zcash/tokens/0a0dd2c6ee1d45ee/5484` | holder: the custody key, sq 0 |
| Deposit ticket | `bridge deposit open 5484 <holder key>` | challenge ask 8888888.97338335 |
| Listing binding | the holder lists #5484 at the challenge ask; `bridge deposit prove 5484` | proven |
| Into escrow | the item reaches the escrow; `bridge escrow received 5484 --from ZR-TEST-0001`; `bridge deposit receive 5484`; the escrow lists it at the marker ask | received |
| Issuance | `bridge deposit issue 5484`, its memo sent as a zero-value shielded output to the protocol inbox; `bridge deposit check 5484` | txid `f317fec60109ed45df33e0c231499952d1340c9c931e891429a74965571c1a46`, block 4,535,181: copy #5484 held by the holder key |
| Backing proof | `bridge proof --attest` | issued [5484], marked [5484], unbacked [], backed, signed by the custody key |
| Redemption | `bridge holder sign-redeem …`; `bridge redeem request 5484 ZR-TEST-0001 <signature>` | requested |
| Return | `bridge holder transfer … <custody key> …` sent the same way; `bridge redeem check 5484` | txid `64120875675933fc1e78033481fac39ca0bb3b08242395702d82516bf6b02a89`, block 4,535,187: copy #5484 back in custody, the holder's next move |
| Release | the escrow sends #5484 to ZR-TEST-0001; `bridge escrow released 5484`; `bridge redeem release 5484` | released |
| Backing proof after | `bridge proof` | issued [], marked [], backed |

The transactions are on testnet for anyone to see; their memos are shielded, readable with the ledger's viewing key,
which its index uses to replay them.
