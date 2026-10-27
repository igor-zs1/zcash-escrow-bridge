/**
 * The escrow account at the marketplace, worked by the bridge itself through the account's own signed-in session, so
 * a redeemed original goes back without anyone sending it by hand.
 *
 * The marketplace's web app authenticates every account action with its session cookie alone: GET /api/me (the
 * account, its items and its listings), POST /api/market/listings/{id}/cancel (delist) and POST /api/market/transfers
 * ({snarkId, toAccountId}). Signing in is guarded by a human check, so the session comes from the account holder signing
 * in once himself; the bridge reads it only when it acts (from a sealed store, like the custody key) and never logs it.
 *
 * Every action checks first that the session is the escrow account's, that the account may transfer, and that it holds
 * the exact item; a release moves only that item, only to the named account, and checks afterwards that it has left.
 */
import { ACCOUNT_ID, notSent, type Escrow } from "./escrow.ts";

type Me = {
  accountId: string;
  canTransfer: boolean;
  snarks: { id: string; collection: string; tokenNumber: number }[];
  listings: { id: string; snarkId: string }[];
};

/** the venue could not be reached (the route is down): no answer came, so a request may or may not have been acted on */
export class VenueUnreachable extends Error {}
/** the venue answered with a refusal (4xx, its protection's challenge included): the request was not acted on */
export class VenueRefused extends Error {}

export type ZilkRoadEscrowConfig = {
  /** the marketplace, for example https://zilkroad.com */
  base: string;
  /** the escrow account's id: every session is checked against it */
  account: string;
  /** the session's Cookie header, read only when the bridge acts */
  session: () => string;
  fetcher?: typeof fetch;
};

export class ZilkRoadEscrow implements Escrow {
  readonly sendsItself = true;
  private readonly c: ZilkRoadEscrowConfig;
  constructor(c: ZilkRoadEscrowConfig) {
    if (!ACCOUNT_ID.test(c.account)) throw new Error("the escrow account is an account id (ZR-XXXX-XXXX)");
    this.c = c;
  }

  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const fetcher = this.c.fetcher ?? fetch;
    const cookie = this.c.session();
    if (!cookie || /[\r\n]/.test(cookie)) throw new Error("no usable escrow session");
    let r: Response;
    try {
      r = await fetcher(`${this.c.base.replace(/\/+$/, "")}/api${path}`, {
        method,
        headers: { accept: "application/json", cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new VenueUnreachable(`the venue could not be reached for ${method} ${path}`);
    }
    if (r.status === 401) throw new VenueRefused("the escrow session has ended: the account holder signs in again");
    if (r.status >= 400 && r.status < 500) throw new VenueRefused(`the venue refused ${method} ${path} (${r.status})`);
    if (!r.ok) throw new Error(`the venue answered ${r.status} to ${method} ${path}`);
    return r.json();
  }

  /** the signed-in account, refused unless it is the escrow account */
  private async me(): Promise<Me> {
    const m = (await this.call("GET", "/me")) as Partial<Me> | null;
    if (!m || m.accountId !== this.c.account) throw new Error(`the session is not the escrow account's (${this.c.account})`);
    return { accountId: m.accountId, canTransfer: m.canTransfer === true, snarks: Array.isArray(m.snarks) ? m.snarks : [], listings: Array.isArray(m.listings) ? m.listings : [] };
  }

  private static held(m: Me, item: number) {
    return m.snarks.find((s) => s.collection === "main" && s.tokenNumber === item) ?? null;
  }

  async holds(item: number): Promise<boolean> {
    return ZilkRoadEscrow.held(await this.me(), item) !== null;
  }

  /** the account's own view does not say who sent an item */
  async sender(): Promise<string | null> {
    return null;
  }

  /**
   * Delist the exact item if listed, transfer it to the exact account, and check it has left. Every failure before the
   * transfer request, and a transfer the venue refused, is marked notSent; a transfer with no answer (or a server
   * error) is not, since the item may have gone.
   */
  async release(item: number, to: string): Promise<void> {
    let sending = false;
    try {
      if (!Number.isSafeInteger(item) || item < 1) throw new Error(`no item #${item}`);
      if (!ACCOUNT_ID.test(to)) throw new Error("not an account id (ZR-XXXX-XXXX)");
      if (to === this.c.account) throw new Error("a release never goes to the escrow account itself");
      const m = await this.me();
      if (!m.canTransfer) throw new Error("the escrow account cannot transfer right now");
      const s = ZilkRoadEscrow.held(m, item);
      if (!s) throw new Error(`the escrow does not hold #${item}`);
      for (const l of m.listings.filter((l) => l.snarkId === s.id)) await this.call("POST", `/market/listings/${encodeURIComponent(l.id)}/cancel`);
      // checked again right before the transfer: still the escrow's session, still allowed, still the same item
      const n = await this.me();
      if (!n.canTransfer) throw new Error("the escrow account cannot transfer right now");
      if (ZilkRoadEscrow.held(n, item)?.id !== s.id) throw new Error(`#${item} changed in the escrow during the release`);
      sending = true;
      await this.call("POST", "/market/transfers", { snarkId: s.id, toAccountId: to });
    } catch (e) {
      if (!sending || e instanceof VenueRefused) throw notSent(e as Error);
      throw e;
    }
    if (ZilkRoadEscrow.held(await this.me(), item)) throw new Error(`#${item} is still in the escrow after the transfer`);
  }
}
