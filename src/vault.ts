// THE VAULT: the private app.
//
// On Clever Cloud, CC_REQUEST_FLOW=block bricks up its public port (8080): Clever's block
// service answers there and no request reaches this code. The vault listens on PORT=9000,
// a port that only peers of its Network Group can reach, at <app id>.m.<ng id>.cc-ng.cloud:9000.
// As a second lock, it refuses any caller whose address is outside the Network Group's subnet.
import { lookup } from "node:dns/promises";
import type { Server } from "bun";
import { cidrContains, describeInterfaces, findInterface, memberDomain, parseMemberDomain, plainIPv4, type NgInterface } from "./lib/ng";
import { isDepositKind, mintDeposit, seedInventory, type Item } from "./lib/treasure";

export type Verdict = { allowed: boolean; reason: string };
export type Guard = (ip: string, host: string) => Promise<Verdict>;

const MAX_DEPOSITS = 48;

// --- The second lock -------------------------------------------------------------------------

// The vault learns its own Network Group address the first time it is called by its member name:
// it resolves that name, finds the local interface holding that IP, and keeps its subnet.
let network: NgInterface | null = null;

async function learnNetwork(host: string): Promise<NgInterface | null> {
  if (network) return network;
  const member = parseMemberDomain(host);
  if (!member || member.memberId !== process.env.APP_ID) return null;
  const answers = await lookup(memberDomain(member.memberId, member.ngId), { all: true, family: 4 }).catch(() => []);
  network = findInterface(answers.map((a) => a.address));
  if (network) console.log(`Vault: Network Group interface ${network.name} ${network.address}, subnet ${network.cidr}`);
  return network;
}

/** On Clever Cloud: only peers of the Network Group get in. */
export const networkGroupGuard: Guard = async (ip, host) => {
  const net = await learnNetwork(host);
  if (!net) return { allowed: false, reason: "not called through the Network Group" };
  return cidrContains(net.cidr, ip)
    ? { allowed: true, reason: `${ip} is a peer of ${net.cidr}` }
    : { allowed: false, reason: `${ip} is outside ${net.cidr}` };
};

/** On a laptop: only this machine gets in. */
export const loopbackGuard: Guard = async (ip) =>
  ip === "127.0.0.1" || ip === "::1"
    ? { allowed: true, reason: `${ip} is this machine (local mode)` }
    : { allowed: false, reason: `${ip} is not this machine` };

// --- The vault -------------------------------------------------------------------------------

export function startVault({ port, guard }: { port: number; guard: Guard }): Server<undefined> {
  const jewels: Item[] = seedInventory();
  const deposits: Item[] = [];
  let nextDrawer = jewels.length + 1;
  const ledger = { received: 0, allowed: 0, refused: 0, sources: {} as Record<string, number>, lastRefusal: null as null | { at: string; ip: string; reason: string } };

  const seal = `${process.env.APP_ID ?? "local-vault"}/${process.env.INSTANCE_NUMBER ?? "0"}`;
  const identity = () => ({
    appId: process.env.APP_ID ?? null,
    instance: process.env.CC_PRETTY_INSTANCE_NAME ?? null,
    instanceNumber: process.env.INSTANCE_NUMBER ?? null,
    peer: network?.address ?? null,
    interface: network?.name ?? null,
    cidr: network?.cidr ?? null,
    port,
  });

  // Every vault answer carries a seal and its own processing time: the lobby uses both.
  const reply = (data: unknown, status: number, started: number) =>
    Response.json(data, {
      status,
      headers: {
        "X-Vault-Seal": seal,
        "Server-Timing": `vault;dur=${(performance.now() - started).toFixed(2)}`,
        "Cache-Control": "no-store",
      },
    });

  const inventory = () => {
    const items = [...jewels, ...deposits];
    return { items, total: items.reduce((sum, item) => sum + item.appraisal, 0) };
  };

  const server = Bun.serve({
    port,
    hostname: "0.0.0.0",
    maxRequestBodySize: 1024,

    async fetch(req, srv) {
      const started = performance.now();
      const url = new URL(req.url);
      if (url.pathname === "/health") return new Response("ok"); // liveness only, no lock involved

      // Who is knocking? The caller's address and the name it used to reach us.
      const ip = plainIPv4(srv.requestIP(req)?.address ?? "");
      const host = req.headers.get("host") ?? "";
      const verdict = await guard(ip, host);
      ledger.received++;
      if (!verdict.allowed) {
        ledger.refused++;
        ledger.lastRefusal = { at: new Date().toISOString(), ip, reason: verdict.reason };
        console.log(`Vault: refused ${ip} (${verdict.reason})`);
        return reply({ refused: true, reason: verdict.reason }, 403, started);
      }
      ledger.allowed++;
      if (Object.keys(ledger.sources).length < 32 || ip in ledger.sources) ledger.sources[ip] = (ledger.sources[ip] ?? 0) + 1;
      const caller = { ip, host, verdict: verdict.reason };

      if (req.method === "GET" && url.pathname === "/health/deep") {
        return reply({ status: "ok", vault: identity(), drawers: jewels.length + deposits.length }, 200, started);
      }

      if (req.method === "GET" && url.pathname === "/manifest") {
        return reply({ drawers: jewels.length + deposits.length, deposits: deposits.length }, 200, started);
      }

      if (req.method === "GET" && url.pathname === "/treasure") {
        const combination = Array.from({ length: 3 }, () => Math.floor(Math.random() * 100));
        return reply({ vault: identity(), caller, ledger, combination, ...inventory() }, 200, started);
      }

      if (req.method === "POST" && url.pathname === "/deposits") {
        const body = (await req.json().catch(() => null)) as { kind?: unknown } | null;
        if (!isDepositKind(body?.kind)) return reply({ error: "Choose one of: bar, gem, coin, pearls." }, 400, started);
        const item = mintDeposit(body.kind, nextDrawer++, ip);
        deposits.push(item);
        if (deposits.length > MAX_DEPOSITS) deposits.shift(); // the oldest visitor deposits make room
        return reply({ item, vault: identity(), caller, ledger, ...inventory() }, 201, started);
      }

      return reply({ error: "No such drawer." }, 404, started);
    },
  });

  return server;
}

if (import.meta.main) {
  const onClever = Boolean(process.env.APP_ID);
  const server = startVault({
    port: Number(process.env.PORT ?? 9000),
    guard: onClever ? networkGroupGuard : loopbackGuard,
  });
  console.log(`Vault: listening on 0.0.0.0:${server.port} (${onClever ? "Network Group peers only" : "local mode, loopback only"})`);
  console.log(`Vault: interfaces ${describeInterfaces()}`);
  const ngVars = Object.keys(process.env).filter((name) => /(^|_)(NG|WG|WIREGUARD|NETWORK_GROUP)(_|$)/i.test(name));
  console.log(`Vault: Network Group variable names in the environment: ${ngVars.join(", ") || "none"}`);
}
