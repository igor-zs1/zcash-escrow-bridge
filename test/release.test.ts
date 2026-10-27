import { test } from "node:test";
import assert from "node:assert/strict";
import { Bridge, MemoryStore } from "../src/bridge.ts";
import { MemoryLedger } from "../src/ledger.ts";
import { releaseDue } from "../src/release.ts";
import { publicKey } from "../src/transfer.ts";
import { MARKER_ASK, MemoryVenue } from "../src/venue.ts";
import { ZilkRoadEscrow } from "../src/zilkroad.ts";

const PID = "11".repeat(32);
const CID = "2a".repeat(32);
const custody = new Uint8Array(32).fill(9);
const holder = new Uint8Array(32).fill(3);
const ESCROW = "ZR-ESCR-0001";
const HOME = "ZR-AAAA-BBBB";

/** A stand-in of the marketplace's signed-in API: accounts, their items and listings, sessions, a transfer log. */
class FakeVenue {
  accounts = new Map<string, { snarks: { id: string; collection: string; tokenNumber: number }[]; listings: { id: string; snarkId: string; priceZec: string }[]; canTransfer: boolean }>();
  sessions = new Map<string, string>();
  transfers: { snarkId: string; toAccountId: string }[] = [];
  cancels: string[] = [];
  offline = false;
  dropAfterTransfer = false; // the transfer happens, its answer is lost
  refuseNextTransfer = 0; // the next transfer is answered with this status and not acted on (403: a challenge page)
  serverErrorNextTransfer = false; // the next transfer is answered 502 and not acted on (the bridge cannot know that)
  onCancel?: () => void;
  account(id: string) {
    if (!this.accounts.has(id)) this.accounts.set(id, { snarks: [], listings: [], canTransfer: true });
    return this.accounts.get(id)!;
  }
  give(id: string, item: number, listedAt?: string) {
    const a = this.account(id);
    const snarkId = `snark-${item}`;
    a.snarks.push({ id: snarkId, collection: "main", tokenNumber: item });
    if (listedAt) a.listings.push({ id: `listing-${item}`, snarkId, priceZec: listedAt });
  }
  holds(id: string, item: number) {
    return this.account(id).snarks.some((s) => s.tokenNumber === item);
  }
  fetcher = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
    if (this.offline) throw new TypeError("fetch failed");
    const u = new URL(String(url));
    const who = this.sessions.get(new Headers(init?.headers).get("cookie") ?? "");
    const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
    if (!who) return json(401, { error: "signed out" });
    const a = this.account(who);
    if (init?.method === "GET" && u.pathname === "/api/me") return json(200, { accountId: who, address: "u1x", canTransfer: a.canTransfer, snarks: a.snarks, listings: a.listings });
    const cancel = /^\/api\/market\/listings\/([^/]+)\/cancel$/.exec(u.pathname);
    if (init?.method === "POST" && cancel) {
      a.listings = a.listings.filter((l) => l.id !== decodeURIComponent(cancel[1]!));
      this.cancels.push(decodeURIComponent(cancel[1]!));
      this.onCancel?.();
      return json(200, { ok: true });
    }
    if (init?.method === "POST" && u.pathname === "/api/market/transfers") {
      if (this.refuseNextTransfer) {
        const code = this.refuseNextTransfer;
        this.refuseNextTransfer = 0;
        return new Response("<!doctype html><title>Just a moment...</title>", { status: code, headers: { "content-type": "text/html" } });
      }
      if (this.serverErrorNextTransfer) {
        this.serverErrorNextTransfer = false;
        return json(502, { error: "bad gateway" });
      }
      const b = JSON.parse(String(init.body)) as { snarkId: string; toAccountId: string };
      const s = a.snarks.find((x) => x.id === b.snarkId);
      if (!s) return json(400, { error: "you do not hold this zkSNARK" });
      a.snarks = a.snarks.filter((x) => x !== s);
      a.listings = a.listings.filter((l) => l.snarkId !== s.id);
      this.account(b.toAccountId).snarks.push(s);
      this.transfers.push(b);
      if (this.dropAfterTransfer) {
        this.dropAfterTransfer = false;
        throw new TypeError("fetch failed");
      }
      return json(200, { ok: true });
    }
    return json(404, {});
  }) as typeof fetch;
}

/** a redemption of #item, signed at sequence 1, whose copy is back in custody at `sq` (2 = the holder's next move) */
function world(opts: { item?: number; sq?: number; returned?: boolean; session?: string } = {}) {
  const item = opts.item ?? 4;
  const ledger = new MemoryLedger(PID, CID);
  ledger.reserve(11, publicKey(custody));
  ledger.byId.set(item, { cid8: CID.slice(0, 16), id: item, holder: opts.returned === false ? publicKey(holder) : publicKey(custody), sq: opts.sq ?? 2 });
  const venue = new FakeVenue();
  venue.sessions.set("zr_session=escrow", ESCROW);
  venue.sessions.set("zr_session=someone", "ZR-OTHR-0002");
  venue.give(ESCROW, item, MARKER_ASK);
  const store = new MemoryStore();
  store.save({ deposits: {}, redemptions: { [item]: { item, to: HOME, holderKey: publicKey(holder), sq: 1, sig: "00".repeat(64), requestedAt: "2026-10-26T00:00:00.000Z", state: "requested" } } } as never);
  let reads = 0;
  const escrow = new ZilkRoadEscrow({ base: "https://venue.test", account: ESCROW, session: () => (reads++, opts.session ?? "zr_session=escrow"), fetcher: venue.fetcher });
  const recorded: [number, string][] = [];
  const bridge = new Bridge({ ledger, venue: new MemoryVenue(), escrow, store, pid: PID, cid: CID, inbox: "utest1inbox", custodyKey: publicKey(custody), custodySecret: () => { throw new Error("never signs"); }, maxItem: 10, binding: "listing" });
  const run = () => releaseDue(bridge, { recordReleased: (i, to) => recorded.push([i, to]) });
  return { item, ledger, venue, store, bridge, run, recorded, reads: () => reads };
}

test("a returned redemption goes back by itself: delisted, the exact item to the exact account, once", async () => {
  const w = world();
  const events = await w.run();
  assert.deepEqual(events.map((e) => [e.item, e.outcome, e.alert]), [[4, "released", true]]);
  assert.deepEqual(w.venue.cancels, ["listing-4"]);
  assert.deepEqual(w.venue.transfers, [{ snarkId: "snark-4", toAccountId: HOME }]);
  assert.ok(w.venue.holds(HOME, 4) && !w.venue.holds(ESCROW, 4));
  assert.equal(w.bridge.redemption(4)?.state, "released");
  assert.deepEqual(w.recorded, [[4, HOME]]);
  assert.deepEqual(await w.run(), [], "a released redemption is never released again");
  assert.equal(w.venue.transfers.length, 1);
});

test("nothing is sent while the copy has not come back, and a copy that moved some other way stops the run", async () => {
  const waiting = world({ returned: false, sq: 1 });
  assert.deepEqual((await waiting.run()).map((e) => [e.outcome, e.alert]), [["waiting", false]]);
  assert.equal(waiting.venue.transfers.length, 0);
  const sold = world({ sq: 3 }); // back in custody, but not as the signer's next move
  const e = await sold.run();
  assert.deepEqual(e.map((x) => [x.outcome, x.alert]), [["stopped", true]]);
  assert.match(e[0]!.why, /moved again after its holder signed/);
  assert.equal(sold.venue.transfers.length, 0);
});

test("a session that is not the escrow account's, or an account that cannot transfer, stops before anything moves", async () => {
  const wrong = world({ session: "zr_session=someone" });
  const e = await wrong.run();
  assert.deepEqual(e.map((x) => [x.outcome, x.alert]), [["stopped", true]]);
  assert.match(e[0]!.why, /not the escrow account's/);
  assert.equal(wrong.venue.transfers.length, 0);
  const frozen = world();
  frozen.venue.account(ESCROW).canTransfer = false;
  const f = await frozen.run();
  assert.match(f[0]!.why, /cannot transfer right now/);
  assert.equal(frozen.venue.transfers.length, 0);
  assert.equal(frozen.bridge.redemption(4)?.releasingSince, undefined, "refused before the transfer: certain nothing was sent, so the next run sends it");
  frozen.venue.account(ESCROW).canTransfer = true;
  assert.deepEqual((await frozen.run()).map((x) => x.outcome), ["released"]);
  assert.equal(frozen.venue.transfers.length, 1);
});

test("the venue unreachable holds quietly and completes when it is back; an ended session holds and says so", async () => {
  const w = world();
  w.venue.offline = true;
  assert.deepEqual((await w.run()).map((e) => [e.outcome, e.alert]), [["held", false]]);
  assert.equal(w.bridge.redemption(4)?.state, "returned", "the return is confirmed, the release waits");
  w.venue.offline = false;
  assert.deepEqual((await w.run()).map((e) => e.outcome), ["released"]);
  const ended = world({ session: "zr_session=expired" });
  const e = await ended.run();
  assert.deepEqual(e.map((x) => [x.outcome, x.alert]), [["held", true]]);
  assert.match(e[0]!.why, /session has ended: the account holder signs in again/);
  assert.equal(ended.venue.transfers.length, 0);
});

test("a release interrupted after the transfer finishes without a second send; an item gone without a started release stops", async () => {
  const w = world();
  w.venue.dropAfterTransfer = true;
  assert.deepEqual((await w.run()).map((e) => e.outcome), ["held"]);
  assert.equal(w.venue.transfers.length, 1);
  assert.deepEqual((await w.run()).map((e) => e.outcome), ["released"]);
  assert.equal(w.venue.transfers.length, 1, "never sent twice");
  const gone = world();
  gone.venue.account(ESCROW).snarks = []; // moved out by hand, no release started
  const e = await gone.run();
  assert.deepEqual(e.map((x) => [x.outcome, x.alert]), [["stopped", true]]);
  assert.match(e[0]!.why, /not in the escrow, and no release of it was started/);
});

test("the escrow adapter sends only a held item, only to another well formed account, and reads the session only when it acts", async () => {
  const w = world();
  const escrow = new ZilkRoadEscrow({ base: "https://venue.test", account: ESCROW, session: () => "zr_session=escrow", fetcher: w.venue.fetcher });
  await assert.rejects(escrow.release(4, ESCROW), /never goes to the escrow account itself/);
  await assert.rejects(escrow.release(4, "ZR-bad"), /not an account id/);
  await assert.rejects(escrow.release(7, HOME), /does not hold #7/);
  assert.throws(() => new ZilkRoadEscrow({ base: "x", account: "nope", session: () => "" }), /account id/);
  assert.equal(w.reads(), 0, "building the bridge reads no session");
  assert.equal(w.venue.transfers.length, 0);
});

test("a lost answer with the item back in the escrow is never sent again: the run stops until a person resolves it", async () => {
  const w = world();
  w.venue.dropAfterTransfer = true;
  assert.deepEqual((await w.run()).map((e) => e.outcome), ["held"]);
  assert.equal(w.venue.transfers.length, 1);
  w.venue.give(ESCROW, 4); // the item comes back to the escrow before the next run, by someone else
  const e = await w.run();
  assert.deepEqual(e.map((x) => [x.outcome, x.alert]), [["stopped", true]]);
  assert.match(e[0]!.why, /was started and may have been sent.*bridge release resolve 4 sent\|not-sent/);
  assert.deepEqual((await w.run()).map((x) => x.outcome), ["stopped"], "it stays stopped, run after run");
  assert.equal(w.venue.transfers.length, 1, "never sent twice");
  w.bridge.resolveRelease(4, true); // the escrow account's transfers show the first one went through
  assert.equal(w.bridge.redemption(4)?.state, "released");
  assert.deepEqual(await w.run(), []);
  assert.equal(w.venue.transfers.length, 1);
  assert.throws(() => w.bridge.resolveRelease(4, false), /no started release to resolve/);
});

test("a transfer the venue refuses (its protection's challenge page) was not sent: the next run sends it once", async () => {
  const w = world();
  w.venue.refuseNextTransfer = 403;
  const e = await w.run();
  assert.deepEqual(e.map((x) => [x.outcome, x.alert]), [["stopped", true]]);
  assert.match(e[0]!.why, /refused POST \/market\/transfers \(403\)/);
  assert.equal(w.venue.transfers.length, 0);
  assert.ok(w.venue.holds(ESCROW, 4) && w.venue.account(ESCROW).listings.length === 0, "delisted, still held: the backing proof shows it");
  assert.equal(w.bridge.redemption(4)?.releasingSince, undefined);
  assert.deepEqual((await w.run()).map((x) => x.outcome), ["released"]);
  assert.deepEqual(w.venue.transfers, [{ snarkId: "snark-4", toAccountId: HOME }]);
});

test("a server error on the transfer may have sent it: the release stays started and is never resent until resolved", async () => {
  const w = world();
  w.venue.serverErrorNextTransfer = true;
  assert.deepEqual((await w.run()).map((x) => [x.outcome, x.alert]), [["stopped", true]]);
  assert.notEqual(w.bridge.redemption(4)?.releasingSince, undefined);
  const e = await w.run();
  assert.match(e[0]!.why, /may have been sent/);
  assert.equal(w.venue.transfers.length, 0);
  w.bridge.resolveRelease(4, false); // the escrow account's transfers show none went out
  assert.deepEqual((await w.run()).map((x) => x.outcome), ["released"]);
  assert.equal(w.venue.transfers.length, 1);
});

test("the session is checked again right before the transfer: one that changed account sends nothing", async () => {
  const w = world();
  w.venue.onCancel = () => w.venue.sessions.set("zr_session=escrow", "ZR-OTHR-0002");
  const e = await w.run();
  assert.deepEqual(e.map((x) => [x.outcome, x.alert]), [["stopped", true]]);
  assert.match(e[0]!.why, /not the escrow account's/);
  assert.equal(w.venue.transfers.length, 0);
  assert.equal(w.bridge.redemption(4)?.releasingSince, undefined, "refused before the transfer");
});

test("any other 4xx on the transfer may have sent it: the release stays started and is never resent until resolved", async () => {
  for (const code of [409, 429]) {
    const w = world();
    w.venue.refuseNextTransfer = code;
    const e = await w.run();
    assert.deepEqual(e.map((x) => [x.outcome, x.alert]), [["stopped", true]]);
    assert.match(e[0]!.why, new RegExp(`answered ${code} to POST /market/transfers`));
    assert.notEqual(w.bridge.redemption(4)?.releasingSince, undefined, `${code}: not taken as not sent`);
    assert.match((await w.run())[0]!.why, /may have been sent/);
    assert.equal(w.venue.transfers.length, 0);
    w.bridge.resolveRelease(4, false);
    assert.deepEqual((await w.run()).map((x) => x.outcome), ["released"]);
    assert.equal(w.venue.transfers.length, 1);
  }
});
