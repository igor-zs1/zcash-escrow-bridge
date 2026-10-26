#!/usr/bin/env node
/**
 * bridge: the operator's and the holder's command line.
 *
 * Operator (reads bridge.config.json):
 *   bridge deposit open <item> <holderKey> [--from ZR-XXXX-XXXX]   a deposit ticket (its challenge ask, or the sender)
 *   bridge deposit prove <item>                                    the holder's listing at the challenge ask, seen
 *   bridge escrow received <item> [--from ZR-XXXX-XXXX]            the operator saw it arrive in the escrow account
 *   bridge deposit receive <item>                                  the escrow holds it, from the bound depositor
 *   bridge deposit issue <item>                                    the issuance transfer: a memo and a zcash: request
 *   bridge deposit check <item>                                    the ledger shows the copy with the holder
 *   bridge redeem request <item> <ZR-XXXX-XXXX> <signature>        a redemption, signed by the copy's holder
 *   bridge redeem check <item>                                     the copy is back in custody, the holder's next move
 *   bridge escrow released <item>                                  the operator sent the original back
 *   bridge redeem release <item>                                   the redemption is done
 *   bridge proof [--attest]                                        the public backing proof (and the signed attestation)
 *   bridge release due                                             automatic release: every redemption that is due goes
 *                                                                  back, through the escrow account's own session
 *                                                                  (escrowSessionFile, read only when acting; may be
 *                                                                  /dev/stdin); prints one JSON event per redemption
 *
 * Holder (no config):
 *   bridge keygen <file>                                           a new Ed25519 key (secret to the file, 0600)
 *   bridge holder sign-redeem <pid> <item> <ZR-XXXX-XXXX> <secret file>
 *   bridge holder transfer <pid> <cid> <item> <sq> <toKey> <inbox> <secret file>
 *
 * Secrets are read from files and never printed. The custody key is read only by the commands that sign with it
 * (deposit issue, proof --attest); its file may be /dev/stdin, so it can stream from a credential store and never touch
 * a disk. The config names its public half (custodyKey) for everything else.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { Bridge, FileStore, redemptionDigest } from "./bridge.ts";
import { ManualEscrow } from "./escrow.ts";
import { releaseDue } from "./release.ts";
import { ZilkRoadEscrow } from "./zilkroad.ts";
import { HttpLedger } from "./ledger.ts";
import { attest, backing } from "./proof.ts";
import { publicKey, signTransfer } from "./transfer.ts";
import { HttpVenue, type AsksName } from "./venue.ts";
import { MESSAGE_ZAT, paymentUri } from "./zip321.ts";

type Config = { ledger: string; venue: string; pid: string; cid: string; inbox: string; custodyKey: string; custodySecretFile: string; maxItem: number; binding: "sender" | "listing"; asks?: AsksName; escrowAccount?: string; escrowBase?: string; escrowSessionFile?: string; state: string; escrowBook: string };

const secretFrom = (path: string): Uint8Array => {
  const hex = readFileSync(path, "utf8").trim();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`${path} does not hold a 32-byte secret in hex`);
  return hexToBytes(hex);
};
const flag = (args: string[], name: string): string | null => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? null) : null;
};
const num = (s: string | undefined): number => {
  if (!s || !/^(0|[1-9][0-9]*)$/.test(s)) throw new Error(`not a whole number: ${s}`);
  return Number(s);
};
const out = (x: unknown) => console.log(typeof x === "string" ? x : JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));

function operator() {
  const c = JSON.parse(readFileSync(process.env.BRIDGE_CONFIG ?? "bridge.config.json", "utf8")) as Config;
  const escrow = new ManualEscrow(c.escrowBook);
  const ledger = new HttpLedger(c.ledger);
  const venue = new HttpVenue(c.venue);
  const custodySecret = () => secretFrom(c.custodySecretFile);
  const bridge = new Bridge({ ledger, venue, escrow, store: new FileStore(c.state), pid: c.pid, cid: c.cid, inbox: c.inbox, custodyKey: c.custodyKey, custodySecret, maxItem: c.maxItem, binding: c.binding, asks: c.asks });
  // the asks setting changes only while no ticket is open and the escrow marks nothing (refuses, and says why)
  bridge.assertAsks(escrow.held());
  return { c, escrow, ledger, venue, bridge, custodySecret, asks: bridge.asks };
}

async function main(argv: string[]): Promise<void> {
  const [a, b, ...rest] = argv;
  if (a === "keygen" && b) {
    const secret = randomBytes(32);
    writeFileSync(b, `${bytesToHex(secret)}\n`, { mode: 0o600, flag: "wx" });
    return out({ publicKey: publicKey(secret), file: b });
  }
  if (a === "holder" && b === "sign-redeem") {
    const [pid, item, to, file] = rest;
    if (!pid || !to || !file) throw new Error("bridge holder sign-redeem <pid> <item> <ZR-XXXX-XXXX> <secret file>");
    return out({ item: num(item), to, signature: bytesToHex(ed25519.sign(redemptionDigest(pid, num(item), to), secretFrom(file))) });
  }
  if (a === "holder" && b === "transfer") {
    const [pid, cid, item, sq, to, inbox, file] = rest;
    if (!pid || !cid || !to || !inbox || !file) throw new Error("bridge holder transfer <pid> <cid> <item> <sq> <toKey> <inbox> <secret file>");
    const memo = signTransfer({ pid, cid, id: num(item), sq: num(sq), to, secret: secretFrom(file) });
    return out({ memo, request: paymentUri([{ address: inbox, zat: MESSAGE_ZAT, memo }]) });
  }
  const { c, escrow, ledger, venue, bridge, custodySecret, asks } = operator();
  const item = () => num(rest[0]);
  if (a === "proof") {
    const p = await backing({ ledger, venue, pid: c.pid, cid8: c.cid.slice(0, 16), custodyKey: bridge.custodyKey, marker: asks.marker });
    if (!argv.includes("--attest")) return out(p);
    const secret = custodySecret();
    if (publicKey(secret) !== bridge.custodyKey) throw new Error("the custody secret given is not the custody key's: nothing signed");
    return out({ ...p, attestation: attest(p, secret) });
  }
  if (a === "release" && b === "due") {
    if (!c.escrowAccount || !c.escrowSessionFile) throw new Error("automatic release needs escrowAccount and escrowSessionFile in the config");
    let session: string | null = null; // read once, only when the escrow is first asked
    const live = new ZilkRoadEscrow({ base: c.escrowBase ?? c.venue, account: c.escrowAccount, session: () => (session ??= readFileSync(c.escrowSessionFile!, "utf8").trim()) });
    const auto = new Bridge({ ledger, venue, escrow: live, store: new FileStore(c.state), pid: c.pid, cid: c.cid, inbox: c.inbox, custodyKey: c.custodyKey, custodySecret: () => { throw new Error("automatic release never signs"); }, maxItem: c.maxItem, binding: c.binding, asks: c.asks });
    const events = await releaseDue(auto, { recordReleased: (item, to) => escrow.confirmReleased(item, to) });
    for (const e of events) out(e);
    if (events.length === 0) out({ outcome: "idle", why: "no redemption is due", at: new Date().toISOString(), alert: false });
    return;
  }
  switch (`${a} ${b}`) {
    case "deposit open": {
      const d = await bridge.openDeposit(item(), rest[1] ?? "", flag(rest, "--from"));
      return out({ ...d, todo: `list #${d.item} at ${d.ask} ZEC, then run: bridge deposit prove ${d.item}${d.binding === "sender" ? `; then send #${d.item} from ${d.sender} to the escrow account` : ""}` });
    }
    case "deposit prove":
      return out(await bridge.proveListing(item()));
    case "escrow received":
      escrow.confirmReceived(item(), flag(rest, "--from"));
      return out({ item: item(), received: true, todo: `list #${item()} at the marker ask ${asks.marker} from the escrow account` });
    case "deposit receive":
      return out(await bridge.confirmReceived(item()));
    case "deposit issue": {
      const { deposit, payment } = await bridge.issue(item());
      return out({ state: deposit.state, memo: payment.memo, request: paymentUri([payment]) });
    }
    case "deposit check":
      return out(await bridge.confirmIssued(item()));
    case "redeem request":
      return out(await bridge.requestRedemption(item(), rest[1] ?? "", rest[2] ?? ""));
    case "redeem check":
      return out(await bridge.confirmReturned(item()));
    case "escrow released": {
      const r = bridge.redemption(item());
      if (!r) throw new Error(`#${item()} has no redemption`);
      escrow.confirmReleased(item(), r.to);
      return out({ item: item(), releasedTo: r.to });
    }
    case "redeem release":
      return out(await bridge.release(item()));
    default:
      throw new Error("unknown command (see the header of src/cli.ts)");
  }
}

main(process.argv.slice(2)).catch((e: Error) => {
  console.error(`bridge: ${e.message}`);
  process.exit(1);
});
