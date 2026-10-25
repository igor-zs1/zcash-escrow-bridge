# zcash-escrow-bridge

Bring a collectible held on a Zcash marketplace onto a shielded Zcash collections ledger as well, one for one, and
take it back at any time.

**Built for zkSNARKs on Zilk Road.** Built by the Sapling team ([sapling.cash](https://sapling.cash)).

Some Zcash collections are held and traded on their marketplace. This bridge gives each item a copy on a collections
ledger that runs on Zcash itself, so its holder can also hold it under a key they control, move it with shielded memos,
and trade it anywhere the ledger is used, while anyone can check the whole state with the ledger's public viewing keys.
The original sits in an escrow account at the marketplace for as long as its copy is out; the copy can be held, sold
and transferred like any item on the ledger, and whoever holds it can redeem the original whenever they want.

It was built for zkSNARKs, whose items are held and transferred on the Zilk Road marketplace.

## How it works

```
 marketplace (original)                 Zcash (copy, on the collections ledger)
 ─────────────────────                  ──────────────────────────────────────
 holder's account ── transfer ──▶ escrow account        custody key ── transfer ──▶ holder's key
                                  (lists it at the                     (issuance, signed by the custody key)
                                   marker ask)
 holder's account ◀── transfer ── escrow account        custody key ◀── transfer ── copy's holder
                                                                       (redemption, signed by the holder)
```

* **The copies.** The bridged collection on the ledger has one copy per item, numbered as the marketplace numbers them,
  and all of them start held by the bridge's custody key. Issuing a copy is a transfer from custody to the holder; a
  redemption is the holder's transfer back. Copies of items the marketplace burned never leave custody.
* **A transfer** is a shielded memo sent to the ledger's protocol inbox (`src/transfer.ts`): the collection, the token,
  its sequence number, the new holder key, and the current holder's Ed25519 signature. The ledger's index applies it in
  block order; anyone can run the index and replay it.
* **Deposit** (`src/bridge.ts`). The holder opens a deposit ticket naming the item and the key that will hold its copy.
  The deposit has to be bound to the person making it, or someone could open a ticket for an item they do not hold and
  collect the copy when its real holder deposits: if the escrow's view shows who sent an item, the ticket names the
  holder's account; if it does not, the holder first lists the item at the ticket's one-time challenge ask (8,888,888
  ZEC and an 8 digit code), which only the item's holder can do, and the bridge sees it in the marketplace's public
  API. The holder then transfers the item to the escrow account, the operator confirms it arrived, and the custody key
  signs the issuance transfer.
* **Redemption.** The copy's holder signs a redemption naming the marketplace account the original goes back to, and
  transfers the copy back to custody. The return must be that holder's very next move on the copy, so a copy sold after
  its holder signed cannot send the original to the seller. Then the original leaves the escrow for the named account.

## The proof that every copy is backed

Anyone can run it (`bridge proof`, `src/proof.ts`), with no account:

* **issued**: copies outside custody, read from the ledger index;
* **marked**: items the marketplace's public API shows listed at the escrow's marker ask (9,999,999.31415926 ZEC,
  which nobody pays): the escrow keeps every item it holds listed there, because the marketplace publishes listings
  but not holdings;
* **unbacked**: issued but not marked. It should always be empty.

The custody key also signs each report (`bridge proof --attest`), so the operator's own word is on the record beside
the public data.

## Trust model

The Zcash side is trustless: nobody, the bridge included, can move a holder's copy; who holds each copy and every transfer are
public by viewing key. The marketplace side is custody: holders trust the marketplace to keep honouring the escrow
account and its transfers, and the bridge operator to keep originals in escrow and to process every redemption. The
proof makes a breach visible; it cannot prevent one.

## Privacy

* Copies are held by keys, not by addresses or accounts; a holder can use a fresh key for each item.
* Every transfer is a shielded memo; amounts, senders and wallets stay shielded. The ledger's state (which key holds
  which copy) is public by design, as who holds an item is on any public collection ledger.
* The bridge never needs a holder's Zcash address. A redemption's marketplace account id is kept by the operator to
  send the original back, never put on chain.
* What is public on purpose: which items are bridged (the marker listings), and, with the listing binding, that the
  holder of an item listed it at a challenge ask shortly before its copy was issued.

## Failure cases

| Case | What happens |
|---|---|
| Marketplace down | Deposits and redemptions wait; copies keep trading on the ledger; the proof shows backing unchecked |
| Escrow account frozen | Redemptions are impossible while frozen, and the proof page says so; copies keep trading |
| Marketplace changes its rules or stops transfers | Deposits stop; redemptions continue while transfers work; if they stop for good the copies are the items' only working record |
| Marketplace closes | The originals' title ends with it; the copies remain on Zcash |
| Custody key stolen | Copies still in custody could be issued unbacked: the key signs nothing but issuance, every issuance needs a confirmed deposit, and the proof shows an unbacked copy at once |
| Redemption to a wrong account | Marketplace transfers are final: the account is signed by the holder, shown back in full and format checked |
| Two claims on one deposit | One ticket per item at a time; the binding decides |
| Item burned at the marketplace | Its copy never leaves custody |

## Run it

Node 24 or later.

```bash
npm install
npm test
node demo/standin-cycle.ts
```

The demo runs the whole cycle in one process against a stand-in marketplace and an in-memory ledger that applies
transfers as the index does. `docs/TESTNET.md` walks the same cycle on Zcash testnet with the transactions it made.

The operator's command line (`src/cli.ts`) reads `bridge.config.json`:

```json
{
  "ledger": "http://127.0.0.1:18471",
  "venue": "https://zilkroad.com",
  "pid": "<the ledger's protocol id>",
  "cid": "<the bridged collection's id>",
  "inbox": "<the protocol inbox address>",
  "custodyKey": "<the custody key's public half>",
  "custodySecretFile": "keys/custody.hex",
  "maxItem": 10000,
  "binding": "listing",
  "asks": "default",
  "state": "state/bridge.json",
  "escrowBook": "state/escrow.json"
}
```

`asks` picks the challenge and marker asks: `default` (8,888,888.<code> and 9,999,999.31415926 ZEC) or `fallback`
(6,666,666.<code> and 7,654,321.31415926 ZEC) for a venue that refuses asks that large. Change it only while the escrow
marks nothing: an item listed at the old marker no longer counts in the proof.

The custody key's secret is read only by the commands that sign with it (`deposit issue`, `proof --attest`), and only
after checking it is the configured key; its file may be `/dev/stdin`, so it can stream from a credential store and
never touch a disk. Every message's payment request carries 0.0001 ZEC, since some wallets refuse a zero amount.

Holders sign redemptions and their own transfers with `bridge holder sign-redeem` and `bridge holder transfer`, which
print a memo and a `zcash:` payment request any memo-capable wallet can send.

## License

MIT
