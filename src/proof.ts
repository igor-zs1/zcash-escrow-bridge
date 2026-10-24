/**
 * The public proof that every copy is backed: anyone can run it with no account.
 *
 *   issued   the copies outside custody, read from the ledger index (public, replayable with its viewing keys)
 *   marked   the items the marketplace shows listed at the escrow's marker ask (its public API)
 *   unbacked issued but not marked: a copy whose original the public data does not place in escrow
 *   pending  marked but not issued: an original in escrow whose copy is still in custody (a deposit in flight, or a
 *            redemption whose original has not left yet)
 *
 * The custody key also signs a daily attestation of the same numbers, so its own word is on the record beside them.
 */
import { ed25519 } from "@noble/curves/ed25519";
import { blake2b } from "@noble/hashes/blake2b";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import type { Ledger } from "./ledger.ts";
import { MARKER_ASK, sameAsk, type Venue } from "./venue.ts";

export type Backing = { at: string; pid: string; cid8: string; custodyKey: string; issued: number[]; marked: number[]; unbacked: number[]; pending: number[]; backed: boolean };

export async function backing(p: { ledger: Ledger; venue: Venue; pid: string; cid8: string; custodyKey: string; now?: Date }): Promise<Backing> {
  const tokens = await p.ledger.tokens(p.cid8);
  const issued = tokens.filter((t) => t.id > 0 && t.holder !== p.custodyKey).map((t) => t.id).sort((a, b) => a - b);
  const marked = (await p.venue.items()).filter((v) => v.listed && sameAsk(v.ask, MARKER_ASK)).map((v) => v.id).sort((a, b) => a - b);
  const m = new Set(marked);
  const i = new Set(issued);
  const unbacked = issued.filter((x) => !m.has(x));
  const pending = marked.filter((x) => !i.has(x));
  return { at: (p.now ?? new Date()).toISOString(), pid: p.pid, cid8: p.cid8, custodyKey: p.custodyKey, issued, marked, unbacked, pending, backed: unbacked.length === 0 };
}

/** The attestation's bytes: the backing as canonical JSON (keys sorted, no spaces). */
export const attestationText = (b: Backing): string =>
  JSON.stringify(Object.fromEntries(Object.entries(b).sort(([x], [y]) => (x < y ? -1 : 1))));
const digest = (text: string) => blake2b.create({ dkLen: 32, personalization: utf8ToBytes("ESCROWattest_v1_") }).update(utf8ToBytes(text)).digest();

/** The custody key's signature over the backing. */
export function attest(b: Backing, custodySecret: Uint8Array): { text: string; sig: string } {
  const text = attestationText(b);
  return { text, sig: bytesToHex(ed25519.sign(digest(text), custodySecret)) };
}

/** Whether an attestation is the custody key's, over exactly this text. */
export function verifyAttestation(text: string, sig: string, custodyKey: string): boolean {
  try {
    return ed25519.verify(hexToBytes(sig), digest(text), hexToBytes(custodyKey), { zip215: false });
  } catch {
    return false;
  }
}
