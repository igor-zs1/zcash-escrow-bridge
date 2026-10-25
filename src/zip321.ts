/**
 * ZIP 321 payment requests: what a wallet opens to send the bridge's transfer memos (one output each, of MESSAGE_ZAT, to
 * the protocol inbox). Memos are base64url of their UTF-8 bytes, without padding.
 */
export type Payment = { address: string; zat: bigint; memo?: string };

/**
 * What a ledger message's payment carries: 0.0001 ZEC, not zero, because some wallets refuse a zero amount. It lands in
 * the ledger's own protocol inbox with the message.
 */
export const MESSAGE_ZAT = 10_000n;

const zec = (zat: bigint): string => {
  if (zat < 0n) throw new Error("a negative amount");
  const whole = zat / 100_000_000n;
  const frac = (zat % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
};
const b64url = (s: string): string => Buffer.from(s, "utf8").toString("base64url");

/**
 * One payment as `zcash:<address>?amount=…&memo=…` (the form wallets read most widely, as librustzcash writes it);
 * several as `zcash:?address=…&amount=…&memo=…`, the second and later outputs suffixed .1, .2, …
 */
export function paymentUri(payments: Payment[]): string {
  if (payments.length === 0) throw new Error("no payment");
  const params = payments.flatMap((p, i) => {
    const sfx = i === 0 ? "" : `.${i}`;
    if (!/^[a-z0-9]+$/i.test(p.address)) throw new Error("not an address");
    if (p.memo !== undefined && Buffer.byteLength(p.memo, "utf8") > 512) throw new Error("a memo is at most 512 bytes");
    return [`address${sfx}=${p.address}`, `amount${sfx}=${zec(p.zat)}`, ...(p.memo === undefined ? [] : [`memo${sfx}=${b64url(p.memo)}`])];
  });
  if (payments.length === 1) return `zcash:${payments[0]!.address}?${params.slice(1).join("&")}`;
  return `zcash:?${params.join("&")}`;
}
