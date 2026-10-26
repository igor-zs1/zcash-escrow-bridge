/**
 * The bridge: an item held at the marketplace comes onto the collections ledger as its copy, one for one, and goes
 * back at any time. Every copy starts held by the custody key (the collection's reserve); issuing one is a transfer
 * from custody to the holder's key, and a redemption is the holder's transfer back.
 *
 * Deposit:    open → proven (the challenge listing, in both bindings) → received → issuing → issued
 * Redemption: requested → returned → released
 * An item never has a deposit and a redemption under way at once.
 *
 * The invariant: every copy outside custody has its original in escrow (proof.ts checks it in public).
 */
import { randomInt } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519";
import { blake2b } from "@noble/hashes/blake2b";
import { hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import { ACCOUNT_ID, type Escrow } from "./escrow.ts";
import type { Ledger } from "./ledger.ts";
import { publicKey, signTransfer } from "./transfer.ts";
import { asksNamed, challengeAsk, sameAsk, type Asks, type AsksName, type Venue } from "./venue.ts";
import { MESSAGE_ZAT, type Payment } from "./zip321.ts";

export const DEPOSIT_TTL_MS = 24 * 3_600_000;
const KEY = /^[0-9a-f]{64}$/;

export type Deposit = {
  item: number;
  holderKey: string;
  /** how the deposit is bound to its depositor: always the holder's challenge listing; "sender" also checks the sending account */
  binding: "sender" | "listing";
  sender: string | null;
  code: string;
  ask: string;
  openedAt: string;
  expiresAt: string;
  provenAt?: string;
  state: "open" | "proven" | "received" | "issuing" | "issued" | "expired";
  memo?: string;
};
/** `sq`: the copy's sequence number when its holder signed; the return must be that holder's next move (sq + 1) */
export type Redemption = { item: number; to: string; holderKey: string; sq: number; sig: string; requestedAt: string; state: "requested" | "returned" | "released" };
/** `asks`: the asks setting the first ticket was opened with (venue.ts); it changes only while nothing is open (assertAsks) */
type State = { deposits: Record<string, Deposit>; redemptions: Record<string, Redemption>; asks?: AsksName };

/** Where the bridge keeps its state: a JSON file written whole, or memory. */
export interface Store {
  load(): State;
  save(s: State): void;
}
export class FileStore implements Store {
  private readonly path: string;
  constructor(path: string) {
    this.path = path;
  }
  load(): State {
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as State;
    } catch {
      return { deposits: {}, redemptions: {} };
    }
  }
  save(s: State): void {
    writeFileSync(`${this.path}.tmp`, JSON.stringify(s, null, 2));
    renameSync(`${this.path}.tmp`, this.path);
  }
}
export class MemoryStore implements Store {
  private s: State = { deposits: {}, redemptions: {} };
  load(): State {
    return structuredClone(this.s);
  }
  save(s: State): void {
    this.s = structuredClone(s);
  }
}

/** What a redemption's signer signs: the item, the account it goes back to, under the ledger's protocol id. */
export function redemptionDigest(pid: string, item: number, to: string): Uint8Array {
  return blake2b.create({ dkLen: 32, personalization: utf8ToBytes("ESCROWredeem_v1_") }).update(hexToBytes(pid)).update(utf8ToBytes(`item:${item}\nto:${to}`)).digest();
}

export type BridgeConfig = {
  ledger: Ledger;
  venue: Venue;
  escrow: Escrow;
  store: Store;
  /** the ledger's protocol id and the bridged collection's id (64 hex each) */
  pid: string;
  cid: string;
  /** the protocol inbox: where transfer memos are sent */
  inbox: string;
  /** the custody key's public half (hex): it holds every copy not issued */
  custodyKey: string;
  /** the custody key's secret, read only when an issuance is signed (so it can come from a credential store then) */
  custodySecret: () => Uint8Array;
  /** item ids run 1 … maxItem; the copy of item N is token N */
  maxItem: number;
  /** "sender" when the escrow's view shows who sent an item (checked on top of the challenge listing), else "listing" */
  binding: "sender" | "listing";
  /** the challenge and marker asks by name (venue.ts; "default" when left out) */
  asks?: AsksName;
  now?: () => Date;
};

export class Bridge {
  readonly custodyKey: string;
  readonly cid8: string;
  readonly asksName: AsksName;
  readonly asks: Asks;
  private readonly now: () => Date;
  private readonly c: BridgeConfig;
  constructor(c: BridgeConfig) {
    this.c = c;
    if (!KEY.test(c.custodyKey)) throw new Error("the custody key is an Ed25519 public key in hex");
    this.custodyKey = c.custodyKey;
    this.cid8 = c.cid.slice(0, 16);
    this.asksName = c.asks ?? "default";
    this.asks = asksNamed(this.asksName);
    this.now = c.now ?? (() => new Date());
  }

  /**
   * The asks setting changes only while no ticket is open and the escrow marks nothing: an open ticket's challenge and a
   * marked item's marker are the old setting's. With a different setting than the state records, this refuses and says
   * what is still open; with nothing open, it records the new setting.
   */
  assertAsks(heldInEscrow: number[]): void {
    const s = this.c.store.load();
    if (s.asks === undefined || s.asks === this.asksName) return;
    const now = this.now().getTime();
    const open = Object.values(s.deposits)
      .filter((d) => d.state === "received" || d.state === "issuing" || ((d.state === "open" || d.state === "proven") && Date.parse(d.expiresAt) > now))
      .map((d) => d.item);
    if (open.length > 0 || heldInEscrow.length > 0) {
      throw new Error(
        `the bridge's state uses the "${s.asks}" asks and the config says "${this.asksName}": they change only while no ticket is open and the escrow marks nothing (open tickets: ${open.join(", ") || "none"}; in escrow: ${heldInEscrow.join(", ") || "none"}). Run with "${s.asks}", or finish those first.`,
      );
    }
    this.change((x) => {
      x.asks = this.asksName;
    });
  }

  private change<T>(f: (s: State) => T): T {
    const s = this.c.store.load();
    const out = f(s);
    this.c.store.save(s);
    return out;
  }
  deposit(item: number): Deposit | null {
    return this.c.store.load().deposits[item] ?? null;
  }
  redemption(item: number): Redemption | null {
    return this.c.store.load().redemptions[item] ?? null;
  }
  private itemOk(item: number): void {
    if (!Number.isSafeInteger(item) || item < 1 || item > this.c.maxItem) throw new Error(`no item #${item}`);
  }
  /** a redemption under way: requested, or its copy returned and the original not yet released */
  private redemptionInFlight(item: number): Redemption | null {
    const r = this.redemption(item);
    return r && (r.state === "requested" || r.state === "returned") ? r : null;
  }
  /** a deposit under way: received or issuing, or opened or proven and not expired */
  private depositInFlight(item: number): Deposit | null {
    const d = this.deposit(item);
    if (!d) return null;
    if (d.state === "received" || d.state === "issuing") return d;
    return (d.state === "open" || d.state === "proven") && Date.parse(d.expiresAt) > this.now().getTime() ? d : null;
  }
  /** One item never has a deposit and a redemption under way at once. */
  private noRedemptionInFlight(item: number): void {
    const r = this.redemptionInFlight(item);
    if (r) throw new Error(`#${item} has a redemption under way (${r.state}): it is released before any deposit of #${item}`);
  }

  /** A deposit ticket: the item, the key that will hold its copy, and how the deposit is bound to the depositor. */
  async openDeposit(item: number, holderKey: string, sender: string | null = null): Promise<Deposit> {
    this.itemOk(item);
    this.noRedemptionInFlight(item);
    if (!KEY.test(holderKey) || holderKey === this.custodyKey) throw new Error("the holder key is an Ed25519 public key in hex, not the custody key");
    if (this.c.binding === "sender" && (sender === null || !ACCOUNT_ID.test(sender))) throw new Error("name the account the item will come from");
    const v = await this.c.venue.item(item);
    if (!v || v.purged) throw new Error(`#${item} does not exist at the marketplace`);
    const t = await this.c.ledger.token(this.cid8, item);
    if (!t || t.holder !== this.custodyKey) throw new Error(`#${item}'s copy is not in custody: it is already out`);
    const recorded = this.c.store.load().asks;
    if (recorded !== undefined && recorded !== this.asksName) throw new Error(`the bridge's state uses the "${recorded}" asks and the config says "${this.asksName}": run with "${recorded}", or change it while nothing is open`);
    const open = this.deposit(item);
    if (open && ["open", "proven", "received", "issuing"].includes(open.state) && Date.parse(open.expiresAt) > this.now().getTime()) throw new Error(`#${item} has an open deposit`);
    const code = String(randomInt(0, 100_000_000)).padStart(8, "0");
    const d: Deposit = {
      item,
      holderKey,
      binding: this.c.binding,
      sender: this.c.binding === "sender" ? sender : null,
      code,
      ask: challengeAsk(code, this.asks),
      openedAt: this.now().toISOString(),
      expiresAt: new Date(this.now().getTime() + DEPOSIT_TTL_MS).toISOString(),
      state: "open",
    };
    this.change((s) => {
      s.asks ??= this.asksName;
      s.deposits[item] = d;
    });
    return d;
  }

  /** The holder's proof, in both bindings: the item is listed at this ticket's challenge ask, after the ticket opened. */
  async proveListing(item: number): Promise<Deposit> {
    const d = this.deposit(item);
    if (!d || d.state !== "open") throw new Error(`#${item} has no deposit waiting for its listing proof`);
    if (Date.parse(d.expiresAt) <= this.now().getTime()) throw new Error("the deposit ticket expired");
    const v = await this.c.venue.item(item);
    if (!v?.listed || !sameAsk(v.ask, d.ask) || !v.listedAt || Date.parse(v.listedAt) < Date.parse(d.openedAt)) throw new Error(`#${item} is not listed at ${d.ask} since the ticket opened`);
    return this.change((s) => {
      const x = s.deposits[item]!;
      x.state = "proven";
      x.provenAt = this.now().toISOString();
      return x;
    });
  }

  /** The escrow holds the item, from the bound depositor. */
  async confirmReceived(item: number): Promise<Deposit> {
    const d = this.deposit(item);
    // every deposit proves its holder by the challenge listing first, sender binding too: an account named by someone
    // else never gets its item issued to their key
    if (!d || d.state !== "proven") throw new Error(`#${item} has no deposit ready to receive (its challenge listing proves the holder first)`);
    this.noRedemptionInFlight(item);
    if (!(await this.c.escrow.holds(item))) throw new Error(`the escrow does not hold #${item}`);
    if (d.binding === "sender" && (await this.c.escrow.sender(item)) !== d.sender) throw new Error(`#${item} did not come from ${d.sender}`);
    return this.change((s) => {
      const x = s.deposits[item]!;
      x.state = "received";
      return x;
    });
  }

  /** The issuance transfer: the custody key moves copy #item to the holder's key. Send it to the inbox. */
  async issue(item: number): Promise<{ deposit: Deposit; payment: Payment }> {
    const d = this.deposit(item);
    if (!d || !(d.state === "received" || d.state === "issuing")) throw new Error(`#${item} has no received deposit`);
    this.noRedemptionInFlight(item);
    if (!(await this.c.escrow.holds(item))) throw new Error(`the escrow no longer holds #${item}`);
    const t = await this.c.ledger.token(this.cid8, item);
    if (!t) throw new Error(`no copy #${item} on the ledger`);
    if (t.holder === d.holderKey) return { deposit: await this.markIssued(item), payment: { address: this.c.inbox, zat: MESSAGE_ZAT, memo: d.memo! } };
    if (t.holder !== this.custodyKey) throw new Error(`copy #${item} is not in custody`);
    const secret = this.c.custodySecret();
    if (publicKey(secret) !== this.custodyKey) throw new Error("the custody secret given is not the custody key's: nothing signed");
    const memo = signTransfer({ pid: this.c.pid, cid: this.c.cid, id: item, sq: t.sq, to: d.holderKey, secret });
    const deposit = this.change((s) => {
      const x = s.deposits[item]!;
      x.state = "issuing";
      x.memo = memo;
      return x;
    });
    return { deposit, payment: { address: this.c.inbox, zat: MESSAGE_ZAT, memo } };
  }

  /** The ledger shows the copy with the holder: the deposit is done. */
  async confirmIssued(item: number): Promise<Deposit> {
    const t = await this.c.ledger.token(this.cid8, item);
    const d = this.deposit(item);
    if (!d || d.state !== "issuing" || t?.holder !== d.holderKey) throw new Error(`copy #${item} has not reached the holder yet`);
    return this.markIssued(item);
  }
  private async markIssued(item: number): Promise<Deposit> {
    return this.change((s) => {
      const x = s.deposits[item]!;
      x.state = "issued";
      return x;
    });
  }

  /** A redemption, signed by the copy's current holder, naming the account the original goes back to. */
  async requestRedemption(item: number, to: string, sig: string): Promise<Redemption> {
    this.itemOk(item);
    if (!ACCOUNT_ID.test(to)) throw new Error("not an account id (ZR-XXXX-XXXX)");
    const open = this.depositInFlight(item);
    if (open) throw new Error(`#${item} has a deposit under way (${open.state}): no redemption of #${item} until it is issued or expired`);
    const t = await this.c.ledger.token(this.cid8, item);
    if (!t || t.holder === this.custodyKey || !KEY.test(t.holder)) throw new Error(`copy #${item} is not out of custody`);
    if (!(await this.c.escrow.holds(item))) throw new Error(`the escrow does not hold #${item}`);
    let ok = false;
    try {
      ok = /^[0-9a-f]{128}$/.test(sig) && ed25519.verify(hexToBytes(sig), redemptionDigest(this.c.pid, item, to), hexToBytes(t.holder), { zip215: false });
    } catch {
      ok = false;
    }
    if (!ok) throw new Error("the redemption is not signed by the copy's holder");
    const prior = this.redemption(item);
    if (prior?.state === "returned") throw new Error(`#${item} is already on its way back to ${prior.to}`);
    const r: Redemption = { item, to, holderKey: t.holder, sq: t.sq, sig, requestedAt: this.now().toISOString(), state: "requested" };
    this.change((s) => (s.redemptions[item] = r));
    return r;
  }

  /**
   * The copy is back in custody, by the holder who signed the redemption as their very next move (sq + 1): a copy sold
   * after its holder signed, then returned by its buyer, is not this redemption's return.
   */
  async confirmReturned(item: number): Promise<Redemption> {
    const r = this.redemption(item);
    const t = await this.c.ledger.token(this.cid8, item);
    if (!r || r.state !== "requested" || t?.holder !== this.custodyKey) throw new Error(`copy #${item} is not back in custody yet`);
    if (t.sq !== r.sq + 1) throw new Error(`copy #${item} moved again after its holder signed the redemption: the holder who returned it signs a new one`);
    return this.change((s) => {
      const x = s.redemptions[item]!;
      x.state = "returned";
      return x;
    });
  }

  /** The original leaves the escrow for the account the redemption named. */
  async release(item: number): Promise<Redemption> {
    const r = this.redemption(item);
    if (!r || r.state !== "returned") throw new Error(`#${item} has no returned redemption`);
    await this.c.escrow.release(item, r.to);
    if (await this.c.escrow.holds(item)) throw new Error(`#${item} is still in the escrow`);
    return this.change((s) => {
      const x = s.redemptions[item]!;
      x.state = "released";
      const d = s.deposits[item];
      if (d) d.state = "expired";
      return x;
    });
  }
}
