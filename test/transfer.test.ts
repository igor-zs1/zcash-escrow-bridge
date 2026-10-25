import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTransfer, publicKey, signTransfer, signingDigest, transferBody, verifyTransfer } from "../src/transfer.ts";
import { paymentUri } from "../src/zip321.ts";

const PID = "11".repeat(32);
const CID = "2a".repeat(32);
const alice = new Uint8Array(32).fill(1);
const bob = new Uint8Array(32).fill(2);

test("a transfer body is canonical, line by line", () => {
  assert.equal(transferBody({ cid8: "2a2a2a2a2a2a2a2a", id: 5484, sq: 3, to: publicKey(bob) }), `t:sapc\nv:1\nc:2a2a2a2a2a2a2a2a\nop:xfer\nid:5484\nsq:3\nto:${publicKey(bob)}`);
  assert.throws(() => transferBody({ cid8: "2A2A2A2A2A2A2A2A", id: 1, sq: 0, to: publicKey(bob) }));
  assert.throws(() => transferBody({ cid8: "2a2a2a2a2a2a2a2a", id: 1.5, sq: 0, to: publicKey(bob) }));
  assert.throws(() => transferBody({ cid8: "2a2a2a2a2a2a2a2a", id: 1, sq: 0, to: "zz" }));
});

test("a signed transfer verifies under its holder key only, and reads back", () => {
  const memo = signTransfer({ pid: PID, cid: CID, id: 7, sq: 0, to: publicKey(bob), secret: alice });
  assert.ok(verifyTransfer(memo, { pid: PID, cid: CID, holderKey: publicKey(alice) }));
  assert.ok(!verifyTransfer(memo, { pid: PID, cid: CID, holderKey: publicKey(bob) }));
  assert.ok(!verifyTransfer(memo, { pid: "22".repeat(32), cid: CID, holderKey: publicKey(alice) }), "another protocol");
  assert.deepEqual(parseTransfer(memo)?.to, publicKey(bob));
  assert.equal(parseTransfer(memo)?.id, 7);
});

test("anything not canonical is not a transfer", () => {
  const memo = signTransfer({ pid: PID, cid: CID, id: 7, sq: 0, to: publicKey(bob), secret: alice });
  for (const bad of [memo.replace("id:7", "id:07"), memo.replace("op:xfer", "op:list"), memo.replace("\nsg:", "\nsig:"), memo.replace("v:1", "v:2"), `${memo}\n`, memo.replace("sq:0", "sq:0\nsq:0")]) {
    assert.equal(parseTransfer(bad), null, bad.slice(0, 60));
  }
});

test("the digest is personalized and covers pid, cid and body", () => {
  const a = signingDigest(PID, CID, "x");
  assert.notDeepEqual(a, signingDigest(PID, CID, "y"));
  assert.notDeepEqual(a, signingDigest("22".repeat(32), CID, "x"));
  assert.equal(a.length, 32);
});

test("a payment request carries each output, the memo as base64url", () => {
  const uri = paymentUri([{ address: "utest1abc", zat: 0n, memo: "t:sapc" }, { address: "utest1def", zat: 150_000_000n }]);
  assert.equal(uri, `zcash:?address=utest1abc&amount=0&memo=${Buffer.from("t:sapc").toString("base64url")}&address.1=utest1def&amount.1=1.5`);
  assert.throws(() => paymentUri([{ address: "utest1abc", zat: 0n, memo: "x".repeat(513) }]));
  // one payment: the address in the path, as librustzcash writes it
  assert.equal(paymentUri([{ address: "utest1abc", zat: 10_000n, memo: "t:sapc" }]), `zcash:utest1abc?amount=0.0001&memo=${Buffer.from("t:sapc").toString("base64url")}`);
});
