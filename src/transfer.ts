/**
 * Transfer messages of the collections ledger the bridge issues on: a token moves when a shielded memo, sent to the
 * protocol inbox, carries `op:xfer` signed by the token's current holder key.
 *
 *   t:sapc
 *   v:1
 *   c:<cid8>        the collection's id, first 8 bytes in hex
 *   op:xfer
 *   id:<token id>
 *   sq:<sequence>   the token's sequence number now; the ledger raises it on every move
 *   to:<key>        the new holder key, hex
 *   sg:<signature>  Ed25519 over BLAKE2b-256("SAPC_sig_v1_____", pid ‖ cid ‖ body), body = every line above but sg
 *
 * The memo goes on an output to the protocol inbox (0.0001 ZEC, zip321.ts MESSAGE_ZAT); the ledger's index applies it in
 * block order.
 */
import { ed25519 } from "@noble/curves/ed25519";
import { blake2b } from "@noble/hashes/blake2b";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";

const SIG_PERSONAL = utf8ToBytes("SAPC_sig_v1_____");
const HEX = (n: number) => new RegExp(`^[0-9a-f]{${n}}$`);
/** the most a memo carries */
export const MAX_MEMO = 512;

export type Transfer = { cid8: string; id: number; sq: number; to: string };

/** The canonical body of a transfer: exactly what the holder key signs. */
export function transferBody(t: Transfer): string {
  if (!HEX(16).test(t.cid8)) throw new Error("cid8 is 16 lower hex");
  for (const [k, v] of [["id", t.id], ["sq", t.sq]] as const) if (!Number.isSafeInteger(v) || v < 0 || v > 0xffffffff) throw new Error(`${k} is a whole number`);
  if (!HEX(64).test(t.to) && !/^0[23][0-9a-f]{64}$/.test(t.to)) throw new Error("to is a holder key in hex");
  return [`t:sapc`, `v:1`, `c:${t.cid8}`, `op:xfer`, `id:${t.id}`, `sq:${t.sq}`, `to:${t.to}`].join("\n");
}

/** BLAKE2b-256 with the signing personalization, over pid ‖ cid ‖ body. */
export function signingDigest(pidHex: string, cidHex: string, body: string): Uint8Array {
  if (!HEX(64).test(pidHex) || !HEX(64).test(cidHex)) throw new Error("pid and cid are 64 lower hex");
  return blake2b.create({ dkLen: 32, personalization: SIG_PERSONAL }).update(hexToBytes(pidHex)).update(hexToBytes(cidHex)).update(utf8ToBytes(body)).digest();
}

/** A signed transfer memo, ready to send to the protocol inbox. */
export function signTransfer(p: { pid: string; cid: string; id: number; sq: number; to: string; secret: Uint8Array }): string {
  const body = transferBody({ cid8: p.cid.slice(0, 16), id: p.id, sq: p.sq, to: p.to });
  const sig = bytesToHex(ed25519.sign(signingDigest(p.pid, p.cid, body), p.secret));
  const memo = `${body}\nsg:${sig}`;
  if (utf8ToBytes(memo).length > MAX_MEMO) throw new Error("the memo is longer than 512 bytes");
  return memo;
}

/** A transfer memo read back, or null when it is not one in canonical form. */
export function parseTransfer(memo: string): (Transfer & { body: string; sig: string }) | null {
  const at = memo.lastIndexOf("\nsg:");
  if (at < 0) return null;
  const body = memo.slice(0, at);
  const sig = memo.slice(at + 4);
  if (!HEX(128).test(sig)) return null;
  const m = /^t:sapc\nv:1\nc:([0-9a-f]{16})\nop:xfer\nid:(0|[1-9][0-9]{0,9})\nsq:(0|[1-9][0-9]{0,9})\nto:([0-9a-f]{64}|0[23][0-9a-f]{64})$/.exec(body);
  if (!m) return null;
  const t = { cid8: m[1]!, id: Number(m[2]), sq: Number(m[3]), to: m[4]! };
  try {
    if (transferBody(t) !== body) return null;
  } catch {
    return null;
  }
  return { ...t, body, sig };
}

/** Whether `memo` is a canonical transfer signed by the Ed25519 key `holderKey` under (pid, cid). */
export function verifyTransfer(memo: string, p: { pid: string; cid: string; holderKey: string }): boolean {
  const t = parseTransfer(memo);
  if (!t || t.cid8 !== p.cid.slice(0, 16) || !HEX(64).test(p.holderKey)) return false;
  try {
    return ed25519.verify(hexToBytes(t.sig), signingDigest(p.pid, p.cid, t.body), hexToBytes(p.holderKey), { zip215: false });
  } catch {
    return false;
  }
}

/** The Ed25519 public key (hex) of a 32-byte secret. */
export const publicKey = (secret: Uint8Array): string => bytesToHex(ed25519.getPublicKey(secret));
