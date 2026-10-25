/**
 * The escrow account at the marketplace that holds the originals. Its holdings are visible only to the account itself,
 * so the bridge asks an Escrow: by hand (the operator, signed in, confirms what arrived and what was sent back), or a
 * stand-in for tests and the demo. A server that watches the signed-in account can implement the same interface.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";

export const ACCOUNT_ID = /^ZR-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

export interface Escrow {
  /** whether the escrow account holds the item now */
  holds(item: number): Promise<boolean>;
  /** the account the item came from, when the escrow's view shows it; null when it does not */
  sender(item: number): Promise<string | null>;
  /** send the item back to an account; resolves once it has left the escrow */
  release(item: number, to: string): Promise<void>;
}

type Book = { received: Record<string, { from: string | null; at: string }>; released: Record<string, { to: string; at: string }> };

/** The operator's confirmations, kept in a JSON file the CLI writes (`bridge escrow received` / `released`). */
export class ManualEscrow implements Escrow {
  private readonly path: string;
  constructor(path: string) {
    this.path = path;
  }
  private read(): Book {
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as Book;
    } catch {
      return { received: {}, released: {} };
    }
  }
  private write(b: Book): void {
    writeFileSync(`${this.path}.tmp`, JSON.stringify(b, null, 2));
    renameSync(`${this.path}.tmp`, this.path);
  }
  async holds(item: number): Promise<boolean> {
    const b = this.read();
    const r = b.received[item];
    const s = b.released[item];
    return !!r && (!s || s.at < r.at);
  }
  async sender(item: number): Promise<string | null> {
    return this.read().received[item]?.from ?? null;
  }
  /** every item the book shows in the escrow now (received and not released since) */
  held(): number[] {
    const b = this.read();
    return Object.entries(b.received)
      .filter(([item, r]) => {
        const s = b.released[item];
        return !s || s.at < r.at;
      })
      .map(([item]) => Number(item))
      .sort((x, y) => x - y);
  }
  async release(item: number): Promise<void> {
    if (await this.holds(item)) throw new Error(`send #${item} back by hand at the marketplace, then run: bridge escrow released ${item}`);
  }
  /** the operator saw the item arrive in the escrow account */
  confirmReceived(item: number, from: string | null): void {
    if (from !== null && !ACCOUNT_ID.test(from)) throw new Error("not an account id");
    const b = this.read();
    b.received[item] = { from, at: new Date().toISOString() };
    this.write(b);
  }
  /** the operator sent the item back */
  confirmReleased(item: number, to: string): void {
    if (!ACCOUNT_ID.test(to)) throw new Error("not an account id");
    const b = this.read();
    b.released[item] = { to, at: new Date().toISOString() };
    this.write(b);
  }
}

/** An escrow in memory: what the demo and the tests use in place of the marketplace. */
export class StandInEscrow implements Escrow {
  readonly held = new Map<number, string | null>();
  readonly sentBack = new Map<number, string>();
  private readonly showsSender: boolean;
  constructor(showsSender = true) {
    this.showsSender = showsSender;
  }
  receive(item: number, from: string): void {
    this.held.set(item, from);
  }
  async holds(item: number): Promise<boolean> {
    return this.held.has(item);
  }
  async sender(item: number): Promise<string | null> {
    return this.showsSender ? (this.held.get(item) ?? null) : null;
  }
  async release(item: number, to: string): Promise<void> {
    if (!this.held.has(item)) throw new Error(`the escrow does not hold #${item}`);
    this.held.delete(item);
    this.sentBack.set(item, to);
  }
}
