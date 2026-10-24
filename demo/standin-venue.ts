/**
 * A stand-in for the marketplace's public API, for a testnet run (the marketplace itself has no testnet): it serves
 * GET /api/market/tokens and /api/market/tokens/{id} as the real one does, from a JSON file, and takes the listings a
 * holder and the escrow would make there:
 *
 *   POST /standin/list?id=42&ask=8888888.01234567    list item 42 at an ask (now)
 *   POST /standin/delist?id=42                        delist it
 *
 *   node demo/standin-venue.ts <state.json> [port, default 18490] [items, default 10000]
 */
import { createServer } from "node:http";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

const [file = "standin-venue.json", portArg = "18490", itemsArg = "10000"] = process.argv.slice(2);
type Item = { id: number; listed: boolean; ask: string | null; listedAt: string | null; purged: boolean };
const load = (): Record<string, Item> => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, Item>) : {});
const save = (s: Record<string, Item>) => {
  writeFileSync(`${file}.tmp`, JSON.stringify(s, null, 2));
  renameSync(`${file}.tmp`, file);
};
const item = (s: Record<string, Item>, id: number): Item => s[id] ?? { id, listed: false, ask: null, listedAt: null, purged: false };
const max = Number(itemsArg);

createServer((req, res) => {
  const u = new URL(req.url ?? "/", "http://localhost");
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const id = Number(u.searchParams.get("id") ?? u.pathname.split("/").pop());
  if (req.method === "GET" && u.pathname === "/api/market/tokens") {
    const s = load();
    return send(200, { tokens: Array.from({ length: max }, (_, i) => item(s, i + 1)) });
  }
  if (req.method === "GET" && /^\/api\/market\/tokens\/[0-9]+$/.test(u.pathname)) return id >= 1 && id <= max ? send(200, { token: item(load(), id) }) : send(404, {});
  if (req.method === "POST" && u.pathname === "/standin/list") {
    const ask = u.searchParams.get("ask");
    if (!(id >= 1 && id <= max) || !ask || !/^[0-9]+(\.[0-9]{1,8})?$/.test(ask)) return send(400, { error: "id and ask" });
    const s = load();
    s[id] = { ...item(s, id), listed: true, ask, listedAt: new Date().toISOString() };
    save(s);
    return send(200, s[id]);
  }
  if (req.method === "POST" && u.pathname === "/standin/delist") {
    const s = load();
    s[id] = { ...item(s, id), listed: false, ask: null, listedAt: null };
    save(s);
    return send(200, s[id]);
  }
  send(404, {});
}).listen(Number(portArg), "127.0.0.1", () => console.log(`stand-in venue on http://127.0.0.1:${portArg} (${file})`));
