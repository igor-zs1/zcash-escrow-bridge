import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519";
import { bytesToHex } from "@noble/hashes/utils";
import { Bridge, MemoryStore, redemptionDigest } from "../src/bridge.ts";
import { ManualEscrow, StandInEscrow } from "../src/escrow.ts";
import { MemoryLedger } from "../src/ledger.ts";
import { attest, backing, verifyAttestation } from "../src/proof.ts";
import { publicKey, signTransfer } from "../src/transfer.ts";
import { DEFAULT_ASKS, FALLBACK_ASKS, MARKER_ASK, MemoryVenue, asksNamed } from "../src/venue.ts";

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
  const bridge = new Bridge({ ledger, venue, escrow, store: new MemoryStore(), pid: PID, cid: CID, inbox: "utest1inbox", custodyKey: publicKey(custody), custodySecret: () => custody, maxItem: 10, binding, now: () => new Date(clock) });
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
  assert.equal(payment.zat, 10_000n); // 0.0001 ZEC: wallets may refuse a zero amount
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

test("a deposit bound to the sender's account proves its holder by the challenge listing too, then takes the item only from that account", async () => {
  const { venue, escrow, bridge, tick, at } = world("sender");
  await assert.rejects(bridge.openDeposit(2, publicKey(holder)), /name the account/);
  const d = await bridge.openDeposit(2, publicKey(holder), HOLDER_ACCOUNT);
  escrow.receive(2, HOLDER_ACCOUNT);
  await assert.rejects(bridge.confirmReceived(2), /challenge listing proves the holder first/, "no receipt before the listing proof, in sender binding too");
  tick();
  venue.list(2, d.ask, at());
  assert.equal((await bridge.proveListing(2)).state, "proven");
  venue.delist(2);
  escrow.receive(2, "ZR-CCCC-DDDD");
  await assert.rejects(bridge.confirmReceived(2), /did not come from ZR-AAAA-BBBB/);
  escrow.receive(2, HOLDER_ACCOUNT);
  assert.equal((await bridge.confirmReceived(2)).state, "received");
});

test("sender binding: a ticket naming someone else's account never issues their item to another key", async () => {
  const { ledger, escrow, bridge, tick } = world("sender");
  // the attacker opens a ticket for the victim's #5, naming the victim's account and the attacker's own key
  await bridge.openDeposit(5, publicKey(buyer), HOLDER_ACCOUNT);
  tick();
  await assert.rejects(bridge.proveListing(5), /is not listed at/, "only the item's holder can list it at the ticket's challenge ask");
  // the victim's item arrives from the victim's account: it still does not count for the attacker's ticket
  escrow.receive(5, HOLDER_ACCOUNT);
  await assert.rejects(bridge.confirmReceived(5), /challenge listing proves the holder first/);
  await assert.rejects(bridge.issue(5), /has no received deposit/);
  assert.equal((await ledger.token(bridge.cid8, 5))?.holder, bridge.custodyKey, "the copy stays in custody");
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
  // until the operator confirms the issuance (deposit check), the deposit is still under way: no redemption yet
  await assert.rejects(bridge.requestRedemption(7, HOLDER_ACCOUNT, redeemSig(holder, 7, HOLDER_ACCOUNT)), /deposit under way \(issuing\)/);
  await bridge.confirmIssued(7);
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

test("the custody secret is read only to sign an issuance, and a wrong one signs nothing", async () => {
  const ledger = new MemoryLedger(PID, CID);
  ledger.reserve(11, publicKey(custody));
  const venue = new MemoryVenue();
  for (let id = 1; id <= 10; id++) venue.byId.set(id, { id, listed: false, ask: null, listedAt: null, purged: false });
  const escrow = new StandInEscrow(true);
  let reads = 0;
  let secret = new Uint8Array(32).fill(7); // not the custody key's
  const bridge = new Bridge({ ledger, venue, escrow, store: new MemoryStore(), pid: PID, cid: CID, inbox: "utest1inbox", custodyKey: publicKey(custody), custodySecret: () => (reads++, secret), maxItem: 10, binding: "sender" });
  const d2 = await bridge.openDeposit(2, publicKey(holder), HOLDER_ACCOUNT);
  venue.list(2, d2.ask, new Date(Date.now() + 1000).toISOString());
  await bridge.proveListing(2);
  escrow.receive(2, HOLDER_ACCOUNT);
  await bridge.confirmReceived(2);
  assert.equal(reads, 0, "opening, proving and receiving a deposit never read the secret");
  await assert.rejects(bridge.issue(2), /not the custody key's: nothing signed/);
  assert.equal((await ledger.token(bridge.cid8, 2))?.holder, publicKey(custody));
  secret = custody;
  const { payment } = await bridge.issue(2);
  assert.equal(ledger.apply(payment.memo!), null);
  assert.equal(reads, 2);
  assert.throws(() => new Bridge({ ledger, venue, escrow, store: new MemoryStore(), pid: PID, cid: CID, inbox: "x", custodyKey: "nope", custodySecret: () => custody, maxItem: 10, binding: "sender" }), /custody key is an Ed25519 public key/);
});

test("the fallback asks: a ticket's challenge and the marker the proof counts both follow the config", async () => {
  const ledger = new MemoryLedger(PID, CID);
  ledger.reserve(11, publicKey(custody));
  const venue = new MemoryVenue();
  for (let id = 1; id <= 10; id++) venue.byId.set(id, { id, listed: false, ask: null, listedAt: null, purged: false });
  const escrow = new StandInEscrow(false);
  let clock = Date.parse("2026-10-25T12:00:00Z");
  const bridge = new Bridge({ ledger, venue, escrow, store: new MemoryStore(), pid: PID, cid: CID, inbox: "utest1inbox", custodyKey: publicKey(custody), custodySecret: () => custody, maxItem: 10, binding: "listing", asks: "fallback", now: () => new Date(clock) });
  const d = await bridge.openDeposit(6, publicKey(holder));
  assert.match(d.ask!, /^6666666\.[0-9]{8}$/);
  clock += 60_000;
  venue.list(6, d.ask!, new Date(clock).toISOString());
  assert.equal((await bridge.proveListing(6)).state, "proven");
  venue.list(6, FALLBACK_ASKS.marker); // the escrow marks it at the fallback marker
  venue.list(7, MARKER_ASK); // an item at the default marker does not count under the fallback
  const p = await backing({ ledger, venue, pid: PID, cid8: bridge.cid8, custodyKey: bridge.custodyKey, marker: FALLBACK_ASKS.marker });
  assert.deepEqual(p.marked, [6]);
  assert.deepEqual(asksNamed(undefined), DEFAULT_ASKS);
  assert.deepEqual(asksNamed("fallback"), FALLBACK_ASKS);
  assert.throws(() => asksNamed("lower"), /"default" or "fallback"/);
  assert.ok(Number(FALLBACK_ASKS.marker) < Number(DEFAULT_ASKS.marker) && Number(FALLBACK_ASKS.challenge) < Number(DEFAULT_ASKS.challenge));
});

test("the asks setting cannot change while a ticket is open or the escrow marks an item, and the CLI says why", async () => {
  const ledger = new MemoryLedger(PID, CID);
  ledger.reserve(11, publicKey(custody));
  const venue = new MemoryVenue();
  for (let id = 1; id <= 10; id++) venue.byId.set(id, { id, listed: false, ask: null, listedAt: null, purged: false });
  const escrow = new StandInEscrow(false);
  const store = new MemoryStore();
  let clock = Date.parse("2026-10-25T12:00:00Z");
  const make = (asks: "default" | "fallback") => new Bridge({ ledger, venue, escrow, store, pid: PID, cid: CID, inbox: "utest1inbox", custodyKey: publicKey(custody), custodySecret: () => custody, maxItem: 10, binding: "listing", asks, now: () => new Date(clock) });
  await make("default").openDeposit(3, publicKey(holder));
  assert.equal(store.load().asks, "default", "the first ticket records the setting");
  const fallback = make("fallback");
  assert.throws(() => fallback.assertAsks([]), /uses the "default" asks and the config says "fallback".*open tickets: 3; in escrow: none/);
  await assert.rejects(fallback.openDeposit(5, publicKey(holder)), /uses the "default" asks/);
  clock += 25 * 3_600_000; // the ticket expires unused
  assert.throws(() => fallback.assertAsks([4]), /open tickets: none; in escrow: 4/);
  fallback.assertAsks([]); // nothing open, nothing marked: the change is recorded
  assert.equal(store.load().asks, "fallback");
  assert.match((await fallback.openDeposit(5, publicKey(holder))).ask, /^6666666\./);
  make("fallback").assertAsks([]); // the same setting again: nothing to refuse

  // the escrow book's holdings: received and not released since
  const dir = mkdtempSync(join(tmpdir(), "bridge-"));
  const book = new ManualEscrow(join(dir, "escrow.json"));
  book.confirmReceived(4, HOLDER_ACCOUNT);
  book.confirmReceived(5, HOLDER_ACCOUNT);
  book.confirmReleased(5, HOLDER_ACCOUNT);
  assert.deepEqual(book.held(), [4]);

  // the CLI refuses before anything else runs, and says why
  writeFileSync(join(dir, "state.json"), JSON.stringify({ deposits: {}, redemptions: {}, asks: "default" }));
  const config = { ledger: "http://127.0.0.1:9", venue: "http://127.0.0.1:9", pid: PID, cid: CID, inbox: "utest1inbox", custodyKey: publicKey(custody), custodySecretFile: join(dir, "none.hex"), maxItem: 10, binding: "listing", asks: "fallback", state: join(dir, "state.json"), escrowBook: join(dir, "escrow.json") };
  writeFileSync(join(dir, "config.json"), JSON.stringify(config));
  const r = spawnSync(process.execPath, [fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "proof"], { env: { ...process.env, BRIDGE_CONFIG: join(dir, "config.json") }, encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /uses the "default" asks and the config says "fallback".*in escrow: 4/);
});

test("an item never has a deposit and a redemption under way at once", async () => {
  const { ledger, venue, escrow, bridge, tick, at } = world("listing");
  const deposit = async (item: number, key: Uint8Array) => {
    const d = await bridge.openDeposit(item, publicKey(key));
    tick();
    venue.list(item, d.ask, at());
    await bridge.proveListing(item);
    venue.delist(item);
    escrow.receive(item, HOLDER_ACCOUNT);
    await bridge.confirmReceived(item);
    venue.list(item, MARKER_ASK, at());
    const { payment } = await bridge.issue(item);
    assert.equal(ledger.apply(payment.memo!), null);
    await bridge.confirmIssued(item);
  };
  await deposit(4, holder);
  await bridge.requestRedemption(4, HOLDER_ACCOUNT, redeemSig(holder, 4, HOLDER_ACCOUNT));
  await assert.rejects(bridge.openDeposit(4, publicKey(buyer)), /redemption under way \(requested\)/);
  const t = (await ledger.token(bridge.cid8, 4))!;
  assert.equal(ledger.apply(signTransfer({ pid: PID, cid: CID, id: 4, sq: t.sq, to: bridge.custodyKey, secret: holder })), null);
  await bridge.confirmReturned(4);
  // the copy is back in custody and the original still in escrow: the double-issue window, now closed
  await assert.rejects(bridge.openDeposit(4, publicKey(buyer)), /redemption under way \(returned\): it is released before any deposit/);
  venue.delist(4);
  await bridge.release(4);
  const again = await bridge.openDeposit(4, publicKey(buyer)); // released: a new deposit of #4 is fine
  assert.equal(again.state, "open");
});

test("the in-flight guard holds in every direction, whatever state was written", async () => {
  const ledger = new MemoryLedger(PID, CID);
  ledger.reserve(11, publicKey(custody));
  const venue = new MemoryVenue();
  for (let id = 1; id <= 10; id++) venue.byId.set(id, { id, listed: false, ask: null, listedAt: null, purged: false });
  const escrow = new StandInEscrow(false);
  const store = new MemoryStore();
  const clock = Date.parse("2026-10-25T12:00:00Z");
  const bridge = new Bridge({ ledger, venue, escrow, store, pid: PID, cid: CID, inbox: "utest1inbox", custodyKey: publicKey(custody), custodySecret: () => custody, maxItem: 10, binding: "listing", now: () => new Date(clock) });
  const iso = (ms: number) => new Date(clock + ms).toISOString();
  const dep = (item: number, state: string) => ({ item, holderKey: publicKey(holder), binding: "listing", sender: null, code: "00000001", ask: "8888888.00000001", openedAt: iso(-60_000), expiresAt: iso(3_600_000), state });
  const red = (item: number, state: string) => ({ item, to: HOLDER_ACCOUNT, holderKey: publicKey(holder), sq: 1, sig: "00".repeat(64), requestedAt: iso(-30_000), state });
  // a proven deposit and a returned redemption of #7 at once (as a crash or an operator's hand could leave them)
  store.save({ deposits: { 7: dep(7, "proven"), 8: dep(8, "received"), 9: dep(9, "open") }, redemptions: { 7: red(7, "returned"), 8: red(8, "requested") } } as never);
  escrow.receive(7, HOLDER_ACCOUNT);
  escrow.receive(8, HOLDER_ACCOUNT);
  await assert.rejects(bridge.confirmReceived(7), /redemption under way \(returned\)/);
  await assert.rejects(bridge.issue(8), /redemption under way \(requested\)/);
  // a deposit under way blocks a redemption, even with its copy out
  ledger.byId.set(9, { cid8: bridge.cid8, id: 9, holder: publicKey(holder), sq: 1 });
  escrow.receive(9, HOLDER_ACCOUNT);
  await assert.rejects(bridge.requestRedemption(9, HOLDER_ACCOUNT, redeemSig(holder, 9, HOLDER_ACCOUNT)), /deposit under way \(open\)/);
});
