/**
 * What the marketplace that holds the originals shows publicly, read without an account: each item's listing (whether
 * it is listed, at what ask, since when) and whether it was burned. Holdings, accounts and transfers are not public, so
 * the bridge proves what it needs with listings:
 *
 *   a deposit's binding  the holder lists the item at a one-time challenge ask, which only the item's holder can do;
 *   the escrow's backing the escrow account keeps every item it holds listed at one marker ask nobody would pay.
 *
 * Both asks are far above any real price (the venue accepts asks to 8 decimals and in the millions of ZEC).
 */
export type VenueItem = { id: number; listed: boolean; ask: string | null; listedAt: string | null; purged: boolean };

export interface Venue {
  item(id: number): Promise<VenueItem | null>;
  items(): Promise<VenueItem[]>;
}

/** The marker ask the escrow lists every held item at (the decimals are the bridge's tag). */
export const MARKER_ASK = "9999999.31415926";

/** A deposit ticket's challenge ask: 8,888,888 ZEC and the ticket's 8 digit code as the decimals. */
export const challengeAsk = (code: string): string => {
  if (!/^[0-9]{8}$/.test(code)) throw new Error("a code is 8 digits");
  return `8888888.${code}`;
};

/** Two asks the same number (the venue may print 8888888.01234500 as 8888888.012345). */
export const sameAsk = (a: string | null, b: string): boolean => a !== null && Number(a).toFixed(8) === Number(b).toFixed(8);

type ApiToken = { id: number; listed: boolean; ask: string | null; listedAt: string | null; purged: boolean };

/** The marketplace's public market API: GET {base}/api/market/tokens/{id} and /api/market/tokens. */
export class HttpVenue implements Venue {
  private readonly base: string;
  private readonly fetcher: typeof fetch;
  constructor(base: string, fetcher: typeof fetch = fetch) {
    this.base = base;
    this.fetcher = fetcher;
  }
  private async get<T>(path: string): Promise<T | null> {
    const r = await this.fetcher(`${this.base.replace(/\/+$/, "")}${path}`, { headers: { accept: "application/json" } });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`the venue answered ${r.status}`);
    return (await r.json()) as T;
  }
  private static item(t: ApiToken): VenueItem {
    return { id: t.id, listed: !!t.listed, ask: t.ask ?? null, listedAt: t.listedAt ?? null, purged: !!t.purged };
  }
  async item(id: number): Promise<VenueItem | null> {
    const r = await this.get<{ token?: ApiToken }>(`/api/market/tokens/${id}`);
    return r?.token ? HttpVenue.item(r.token) : null;
  }
  async items(): Promise<VenueItem[]> {
    const r = await this.get<{ tokens?: ApiToken[] }>("/api/market/tokens");
    return (r?.tokens ?? []).map(HttpVenue.item);
  }
}

/** A venue kept in memory, for tests and the stand-in demo. */
export class MemoryVenue implements Venue {
  readonly byId = new Map<number, VenueItem>();
  async item(id: number): Promise<VenueItem | null> {
    return this.byId.get(id) ?? null;
  }
  async items(): Promise<VenueItem[]> {
    return [...this.byId.values()];
  }
  list(id: number, ask: string, at = new Date().toISOString()): void {
    this.byId.set(id, { id, listed: true, ask, listedAt: at, purged: false });
  }
  delist(id: number): void {
    const v = this.byId.get(id);
    if (v) this.byId.set(id, { ...v, listed: false, ask: null, listedAt: null });
  }
}
