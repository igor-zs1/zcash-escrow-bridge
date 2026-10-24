import { test } from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519";
import { bytesToHex } from "@noble/hashes/utils";
import { Bridge, MemoryStore, redemptionDigest } from "../src/bridge.ts";
import { StandInEscrow } from "../src/escrow.ts";
import { MemoryLedger } from "../src/ledger.ts";
import { attest, backing, verifyAttestation } from "../src/proof.ts";
import { publicKey, signTransfer } from "../src/transfer.ts";
import { MARKER_ASK, MemoryVenue } from "../src/venue.ts";

const PID = "11".repeat(32);
const CID = "2a".repeat(32);
const custody = new Uint8Array(32).fill(9);
const holder = new Uint8Array(32).fill(3);
const buyer = new Uint8Array(32).fill(4);
const HOLDER_ACCOUNT = "ZR-AAAA-BBBB";

function world(binding: "sender" | "listing" = "listing") {
  const ledger = new MemoryLedger(PID, CID);
  ledger.reserve(11, publicKey(custody)); // a 10 item collection: copies 0 … 10, all in custody
  const venue = new MemoryVenue();
  for (let id = 1; id <= 10; id++) venue.byId.set(id, { id, listed: false, ask: null, listedAt: null, purged: id === 10 });
  const escrow = new StandInEscrow(binding === "sender");
  let clock = Date.parse("2026-10-25T12:00:00Z");
  const bridge = new Bridge({ ledger, venue, escrow, store: new MemoryStore(), pid: PID, cid: CID, inbox: "utest1inbox", custodySecret: custody, maxItem: 10, binding, now: () => new Date(clock) });
  const tick = (ms = 60_000) => (clock += ms);
  const at = () => new Date(clock).toISOString();
  return { ledger, venue, escrow, bridge, tick, at };
}
const redeemSig = (secret: Uint8Array, item: number, to: string) => bytesToHex(ed25519.sign(redemptionDigest(PID, item, to), secret));

test("a deposit by listing proof, issued to the holder's key, and its redemption back to their account", async () => {
  const { ledger, venue, escrow, bridge, tick, at } = world("listing");
  const d = await bridge.openDeposit(4, publicKey(holder));
  tick();
  venue.list(4, d.ask, at()); // only #4's holder can list it at the ticket's ask
  await bridge.proveListing(4);
  venue.delist(4);
  escrow.receive(4, HOLDER_ACCOUNT);
  await bridge.confirmReceived(4);
  venue.list(4, MARKER_ASK, at()); // the escrow marks what it holds
  const { payment } = await bridge.issue(4);
  assert.equal(payment.address, "utest1inbox");
  assert.equal(payment.zat, 0n);
  assert.equal(ledger.apply(payment.memo!), null, "the index applies the issuance");
  assert.equal((await ledger.token(bridge.cid8, 4))?.holder, publicKey(holder));
  assert.equal((await bridge.confirmIssued(4)).state, "issued");
  assert.deepEqual((await backing({ ledger, venue, pid: PID, cid8: bridge.cid8, custodyKey: bridge.custodyKey })).unbacked, []);

  // redemption: the copy's holder signs, returns the copy, the original goes back
  await bridge.requestRedemption(4, HOLDER_ACCOUNT, redeemSig(holder, 4, HOLDER_ACCOUNT));
  const t = (await ledger.token(bridge.cid8, 4))!;
  assert.equal(ledger.apply(signTransfer({ pid: PID, cid: CID, id: 4, sq: t.sq, to: bridge.custodyKey, secret: holder })), null);
  await bridge.confirmReturned(4);
  venue.delist(4);
  await bridge.release(4);
  assert.equal(escrow.sentBack.get(4), HOLDER_ACCOUNT);
  assert.equal(await escrow.holds(4), false);
  // the item can come back again later
  assert.equal((await bridge.openDeposit(4, publicKey(buyer))).state, "open");
});

test("a deposit bound to the sender's account takes the item only from that account", async () => {
  const { escrow, bridge } = world("sender");
  await assert.rejects(bridge.openDeposit(2, publicKey(holder)), /name the account/);
  await bridge.openDeposit(2, publicKey(holder), HOLDER_ACCOUNT);
  escrow.receive(2, "ZR-CCCC-DDDD");
  await assert.rejects(bridge.confirmReceived(2), /did not come from ZR-AAAA-BBBB/);
  escrow.receive(2, HOLDER_ACCOUNT);
  assert.equal((await bridge.confirmReceived(2)).state, "received");
});

test("a deposit is refused for an item that does not exist, was burned, or whose copy is out, and while one is open", async () => {
  const { ledger, bridge } = world();
  await assert.rejects(bridge.openDeposit(11, publicKey(holder)), /no item #11/);
  await assert.rejects(bridge.openDeposit(10, publicKey(holder)), /does not exist/);
  await assert.rejects(bridge.openDeposit(1, bridge.custodyKey), /not the custody key/);
  await bridge.openDeposit(1, publicKey(holder));
  await assert.rejects(bridge.openDeposit(1, publicKey(buyer)), /open deposit/);
  ledger.byId.set(3, { cid8: bridge.cid8, id: 3, holder: publicKey(buyer), sq: 1 });
  await assert.rejects(bridge.openDeposit(3, publicKey(holder)), /not in custody/);
});

test("a listing proof counts only at the ticket's ask, listed after the ticket opened, before it expires", async () => {
  const { venue, bridge, tick, at } = world();
  const d = await bridge.openDeposit(5, publicKey(holder));
  venue.list(5, "8888888.00000001", at());
  await assert.rejects(bridge.proveListing(5), /not listed at/);
  venue.list(5, d.ask, new Date(Date.parse(d.openedAt) - 1000).toISOString());
  await assert.rejects(bridge.proveListing(5), /not listed at/);
  tick(25 * 3_600_000);
  venue.list(5, d.ask, at());
  await assert.rejects(bridge.proveListing(5), /expired/);
});

test("nothing is issued before the escrow holds the item, nor twice", async () => {
  const { ledger, venue, escrow, bridge, at } = world();
  const d = await bridge.openDeposit(6, publicKey(holder));
  await assert.rejects(bridge.issue(6), /no received deposit/);
  venue.list(6, d.ask, at());
  await bridge.proveListing(6);
  await assert.rejects(bridge.confirmReceived(6), /does not hold/);
  escrow.receive(6, HOLDER_ACCOUNT);
  await bridge.confirmReceived(6);
  const a = await bridge.issue(6);
  const b = await bridge.issue(6);
  assert.equal(a.payment.memo, b.payment.memo, "the same transfer, never a second");
  ledger.apply(a.payment.memo!);
  assert.equal(ledger.apply(b.payment.memo!), "a stale sequence number");
});

test("a redemption must be signed by the copy's holder, and its return must be that holder's next move", async () => {
  const { ledger, venue, escrow, bridge, at } = world();
  const d = await bridge.openDeposit(7, publicKey(holder));
  venue.list(7, d.ask, at());
  await bridge.proveListing(7);
  escrow.receive(7, HOLDER_ACCOUNT);
  await bridge.confirmReceived(7);
  ledger.apply((await bridge.issue(7)).payment.memo!);
  await assert.rejects(bridge.requestRedemption(7, HOLDER_ACCOUNT, redeemSig(buyer, 7, HOLDER_ACCOUNT)), /not signed by the copy's holder/);
  await assert.rejects(bridge.requestRedemption(7, "ZR-bad", redeemSig(holder, 7, "ZR-bad")), /not an account id/);
  await bridge.requestRedemption(7, HOLDER_ACCOUNT, redeemSig(holder, 7, HOLDER_ACCOUNT));
  // the holder sells the copy instead, and its buyer returns it: not the signed redemption's return
  let t = (await ledger.token(bridge.cid8, 7))!;
  ledger.apply(signTransfer({ pid: PID, cid: CID, id: 7, sq: t.sq, to: publicKey(buyer), secret: holder }));
  t = (await ledger.token(bridge.cid8, 7))!;
  ledger.apply(signTransfer({ pid: PID, cid: CID, id: 7, sq: t.sq, to: bridge.custodyKey, secret: buyer }));
  await assert.rejects(bridge.confirmReturned(7), /moved again/);
  await assert.rejects(bridge.release(7), /no returned redemption/);
  assert.equal(await escrow.holds(7), true);
});

test("the public proof finds an unbacked copy, and the custody key's attestation verifies", async () => {
  const { ledger, venue, bridge } = world();
  ledger.byId.set(8, { cid8: bridge.cid8, id: 8, holder: publicKey(holder), sq: 1 }); // out of custody, no marker
  venue.list(9, MARKER_ASK); // marked, copy still in custody
  const b = await backing({ ledger, venue, pid: PID, cid8: bridge.cid8, custodyKey: bridge.custodyKey });
  assert.deepEqual([b.unbacked, b.pending, b.backed], [[8], [9], false]);
  const a = attest(b, custody);
  assert.ok(verifyAttestation(a.text, a.sig, bridge.custodyKey));
  assert.ok(!verifyAttestation(a.text.replace('"backed":false', '"backed":true'), a.sig, bridge.custodyKey));
});
