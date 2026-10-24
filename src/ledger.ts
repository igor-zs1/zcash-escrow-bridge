/**
 * The collections ledger as its index serves it: who holds a token now, and its sequence number. Every answer the
 * bridge acts on is a token's state; the index replays the chain with the ledger's public viewing keys, so anyone can
 * run their own and check it.
 */
import { parseTransfer, verifyTransfer } from "./transfer.ts";

export type TokenState = { cid8: string; id: number; holder: string; sq: number };
export type LedgerStatus = { network: string; pid: string; tip: number; synced: boolean };

export interface Ledger {
  status(): Promise<LedgerStatus>;
  token(cid8: string, id: number): Promise<TokenState | null>;
  /** every token of a collection */
  tokens(cid8: string): Promise<TokenState[]>;
}

/** A token as the index serves it: its field for the key that holds the token is named by the index's own API. */
type IndexToken = { cid8: string; id: number; owner: string; sq: number };
const fromIndex = (t: IndexToken): TokenState => ({ cid8: t.cid8, id: t.id, holder: t.owner, sq: t.sq });

/** A ledger index over HTTP: GET {base}/v1/zcash/status and /v1/zcash/tokens/{cid8}/{id}. */
export class HttpLedger implements Ledger {
  private readonly base: string;
  private readonly fetcher: typeof fetch;
  constructor(base: string, fetcher: typeof fetch = fetch) {
    this.base = base;
    this.fetcher = fetcher;
  }
  private async get<T>(path: string): Promise<T | null> {
    const r = await this.fetcher(`${this.base.replace(/\/+$/, "")}/v1/zcash${path}`, { headers: { accept: "application/json" } });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`the ledger index answered ${r.status}`);
    return (await r.json()) as T;
  }
  async status(): Promise<LedgerStatus> {
    const s = await this.get<LedgerStatus>("/status");
    if (!s) throw new Error("the ledger index has no status");
    return { network: s.network, pid: s.pid, tip: s.tip, synced: s.synced };
  }
  async token(cid8: string, id: number): Promise<TokenState | null> {
    if (!/^[0-9a-f]{16}$/.test(cid8) || !Number.isSafeInteger(id) || id < 0) return null;
    const t = await this.get<IndexToken>(`/tokens/${cid8}/${id}`);
    return t ? fromIndex(t) : null;
  }
  async tokens(cid8: string): Promise<TokenState[]> {
    if (!/^[0-9a-f]{16}$/.test(cid8)) return [];
    const r = await this.get<{ data: IndexToken[] }>(`/collections/${cid8}/tokens`);
    return (r?.data ?? []).map(fromIndex);
  }
}

/** A ledger kept in memory, for tests and the stand-in demo: transfers apply as the index would apply them. */
export class MemoryLedger implements Ledger {
  readonly byId = new Map<number, TokenState>();
  readonly cid8: string;
  readonly pid: string;
  readonly cidHex: string;
  readonly network: string;
  constructor(pid: string, cidHex: string, network = "testnet") {
    this.pid = pid;
    this.cidHex = cidHex;
    this.network = network;
    this.cid8 = cidHex.slice(0, 16);
  }
  async status(): Promise<LedgerStatus> {
    return { network: this.network, pid: this.pid, tip: 0, synced: true };
  }
  async token(cid8: string, id: number): Promise<TokenState | null> {
    return cid8 === this.cid8 ? (this.byId.get(id) ?? null) : null;
  }
  async tokens(cid8: string): Promise<TokenState[]> {
    return cid8 === this.cid8 ? [...this.byId.values()] : [];
  }
  /** the collection's start: tokens 0 … count-1 held by the reserve key */
  reserve(count: number, holder: string): void {
    for (let id = 0; id < count; id++) this.byId.set(id, { cid8: this.cid8, id, holder, sq: 0 });
  }
  /** a transfer memo, applied as the index applies it: canonical, the token's current sq, signed by its holder */
  apply(memo: string): string | null {
    const t = parseTransfer(memo);
    if (!t || t.cid8 !== this.cid8) return "not a transfer for this collection";
    const cur = this.byId.get(t.id);
    if (!cur) return "no such token";
    if (cur.sq !== t.sq) return "a stale sequence number";
    if (!verifyTransfer(memo, { pid: this.pid, cid: this.cidHex, holderKey: cur.holder })) return "not signed by the holder";
    this.byId.set(t.id, { ...cur, holder: t.to, sq: cur.sq + 1 });
    return null;
  }
}
