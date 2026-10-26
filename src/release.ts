/**
 * Automatic release: every redemption that is due goes back to its account, without anyone sending it by hand.
 *
 * One run, one redemption at a time, in item order:
 *   requested  if the copy came back to custody as its holder's very next move (Bridge.confirmReturned), it is
 *              returned; if it has not come back yet, it waits; if it moved otherwise, the run stops
 *   returned   the escrow sends the exact original to the exact account the holder signed for (Bridge.release, one
 *              release per redemption), and the release is recorded
 *
 * The venue unreachable (its route down): nothing happens, the redemption holds and the next run tries again. The
 * escrow session ended: it holds and says so, for the account holder to sign in again. Anything else that does not
 * match: the run stops at once and says why, and nothing further is released until someone looks.
 */
import type { Bridge } from "./bridge.ts";
import { VenueUnreachable } from "./zilkroad.ts";

export type ReleaseOutcome = "released" | "waiting" | "held" | "stopped";
export type ReleaseEvent = { item: number; to: string; outcome: ReleaseOutcome; why: string; at: string; alert: boolean };

export async function releaseDue(bridge: Bridge, opts: { recordReleased?: (item: number, to: string) => void; now?: () => Date } = {}): Promise<ReleaseEvent[]> {
  const now = () => (opts.now ?? (() => new Date()))().toISOString();
  const events: ReleaseEvent[] = [];
  const say = (item: number, to: string, outcome: ReleaseOutcome, why: string, alert: boolean) => {
    const e = { item, to, outcome, why, at: now(), alert };
    events.push(e);
    return e;
  };
  for (const r of bridge.openRedemptions()) {
    if (r.state === "requested") {
      try {
        await bridge.confirmReturned(r.item);
      } catch (e) {
        const why = (e as Error).message;
        if (/not back in custody yet/.test(why)) {
          say(r.item, r.to, "waiting", "the copy has not come back to custody yet", false);
          continue;
        }
        say(r.item, r.to, "stopped", why, true);
        return events;
      }
    }
    try {
      await bridge.release(r.item);
      opts.recordReleased?.(r.item, r.to);
      say(r.item, r.to, "released", `#${r.item} sent back to ${r.to}`, true);
    } catch (e) {
      const why = (e as Error).message;
      if (e instanceof VenueUnreachable) {
        say(r.item, r.to, "held", `${why}; the next run tries again`, false);
        return events;
      }
      if (/session has ended/.test(why)) {
        say(r.item, r.to, "held", why, true);
        return events;
      }
      say(r.item, r.to, "stopped", why, true);
      return events;
    }
  }
  return events;
}
