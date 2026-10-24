/**
 * The whole cycle in one process, with a stand-in for the marketplace and its escrow account and an in-memory ledger
 * that applies transfers as the index does: deposit by listing proof, issuance to the holder's key, a sale of the copy
 * on the ledger, the backing proof, and the buyer's redemption back to their own account.
 *
 *   node demo/standin-cycle.ts
 */
import { ed25519 } from "@noble/curves/ed25519";
import { bytesToHex } from "@noble/hashes/utils";
import { Bridge, MemoryStore, redemptionDigest } from "../src/bridge.ts";
import { StandInEscrow } from "../src/escrow.ts";
import { MemoryLedger } from "../src/ledger.ts";
import { attest, backing, verifyAttestation } from "../src/proof.ts";
import { publicKey, signTransfer } from "../src/transfer.ts";
import { MARKER_ASK, MemoryVenue } from "../src/venue.ts";
import { paymentUri } from "../src/zip321.ts";

const PID = "11".repeat(32);
const CID = "2a".repeat(32);
const custody = new Uint8Array(32).fill(9);
const alice = new Uint8Array(32).fill(3); // holds #42 at the marketplace
const bob = new Uint8Array(32).fill(4); // buys the copy on the ledger
const ALICE = "ZR-ALIC-E001";
const BOB = "ZR-BOBB-0002";
const say = (step: string, detail = "") => console.log(`\n▸ ${step}${detail ? `\n  ${detail}` : ""}`);

const ledger = new MemoryLedger(PID, CID);
ledger.reserve(101, publicKey(custody));
const venue = new MemoryVenue();
for (let id = 1; id <= 100; id++) venue.byId.set(id, { id, listed: false, ask: null, listedAt: null, purged: false });
const escrow = new StandInEscrow(false);
const bridge = new Bridge({ ledger, venue, escrow, store: new MemoryStore(), pid: PID, cid: CID, inbox: "utest1protocolinbox", custodySecret: custody, maxItem: 100, binding: "listing" });
const apply = (memo: string) => {
  const err = ledger.apply(memo);
  if (err) throw new Error(err);
};

say("copies in custody", `all 100 copies start with the custody key ${bridge.custodyKey.slice(0, 16)}…`);

const d = await bridge.openDeposit(42, publicKey(alice));
say("alice opens a deposit for #42", `her challenge ask: ${d.ask} ZEC (only #42's holder can list it there)`);

venue.list(42, d.ask);
await bridge.proveListing(42);
venue.delist(42);
say("alice lists #42 at the challenge ask, the bridge sees it in the public API, she delists");

escrow.receive(42, ALICE);
await bridge.confirmReceived(42);
venue.list(42, MARKER_ASK);
say("alice transfers #42 to the escrow account", `the escrow marks it: listed at ${MARKER_ASK} ZEC, which nobody pays`);

const { payment } = await bridge.issue(42);
say("the custody key signs the issuance transfer", `${paymentUri([payment]).slice(0, 96)}…`);
apply(payment.memo!);
await bridge.confirmIssued(42);
say("copy #42 belongs to alice's key on the ledger", `holder ${(await ledger.token(bridge.cid8, 42))!.holder.slice(0, 16)}…`);

let t = (await ledger.token(bridge.cid8, 42))!;
apply(signTransfer({ pid: PID, cid: CID, id: 42, sq: t.sq, to: publicKey(bob), secret: alice }));
say("alice sells the copy to bob on the ledger (a transfer signed by her key)");

const p = await backing({ ledger, venue, pid: PID, cid8: bridge.cid8, custodyKey: bridge.custodyKey });
const a = attest(p, custody);
say("the public backing proof", `issued ${JSON.stringify(p.issued)}, marked ${JSON.stringify(p.marked)}, unbacked ${JSON.stringify(p.unbacked)}; attestation verifies: ${verifyAttestation(a.text, a.sig, bridge.custodyKey)}`);

await bridge.requestRedemption(42, BOB, bytesToHex(ed25519.sign(redemptionDigest(PID, 42, BOB), bob)));
t = (await ledger.token(bridge.cid8, 42))!;
apply(signTransfer({ pid: PID, cid: CID, id: 42, sq: t.sq, to: bridge.custodyKey, secret: bob }));
await bridge.confirmReturned(42);
venue.delist(42);
await bridge.release(42);
say("bob redeems: signs for his account, returns the copy to custody, the escrow sends #42 to him", `#42 went to ${escrow.sentBack.get(42)}; the copy is back in custody`);

const q = await backing({ ledger, venue, pid: PID, cid8: bridge.cid8, custodyKey: bridge.custodyKey });
say("the proof after", `issued ${JSON.stringify(q.issued)}, marked ${JSON.stringify(q.marked)}, backed: ${q.backed}`);
