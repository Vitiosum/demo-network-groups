// THE LOBBY: the public app. It serves the page and reaches the vault two ways:
//   - through the Network Group, at VAULT_URL (the vault's private member domain): it works;
//   - through the vault's public address, VAULT_PUBLIC_URL: Clever's block service answers instead.
import { lookup } from "node:dns/promises";
import type { Server } from "bun";
import { findInterface, memberDomain, parseMemberDomain } from "./lib/ng";
import { publicDns, publicHttp, rawTcp, throughTunnel } from "./lib/probe";
import { isDepositKind } from "./lib/treasure";

const PUBLIC = `${import.meta.dir}/../public`;

// Only these platform variables are ever shown in the page.
const PLATFORM_VARS = ["CC_APP_NAME", "APP_ID", "INSTANCE_NUMBER", "INSTANCE_TYPE", "CC_PRETTY_INSTANCE_NAME", "CC_COMMIT_ID", "CC_DEPLOYMENT_ID"];
const platform = Object.fromEntries(
  PLATFORM_VARS.map((name) => [name, (name === "CC_COMMIT_ID" ? process.env[name]?.slice(0, 7) : process.env[name]) || null]),
);

const HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; " +
    "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { ...HEADERS, "Cache-Control": "no-store" } });

// A demo on the open internet: a few dozen actions per minute and per visitor is plenty.
const hits = new Map<string, number[]>();
setInterval(() => hits.clear(), 10 * 60_000).unref();
function tooMany(ip: string, perMinute = 40) {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > perMinute;
}

export type LobbyConfig = { port: number; vaultUrl: string; vaultPublicUrl: string | null };

export function startLobby({ port, vaultUrl, vaultPublicUrl }: LobbyConfig): Server<undefined> {
  const vaultHost = new URL(vaultUrl).hostname;
  const vaultPort = Number(new URL(vaultUrl).port || 80);

  // The guard's logbook: the last requests the lobby sent, by either road.
  type Entry = { at: string; road: "tunnel" | "street"; line: string; ok: boolean };
  const logbook: Entry[] = [];
  const log = (road: Entry["road"], line: string, ok: boolean) => {
    logbook.unshift({ at: new Date().toISOString(), road, line, ok });
    logbook.length = Math.min(logbook.length, 14);
  };

  // What the Network Group looks like from here: its id, its members, their peer IPs.
  let cached: { at: number; value: unknown } | null = null;
  async function network() {
    if (cached && Date.now() - cached.at < 30_000) return cached.value;
    const vault = parseMemberDomain(vaultHost);
    const appId = process.env.APP_ID ?? null;
    const resolve = (host: string | null) =>
      host ? lookup(host, { all: true, family: 4 }).then((list) => list.map((a) => a.address)).catch(() => []) : Promise.resolve([]);

    let value;
    if (!vault) {
      value = { mode: "local", ngId: null, cidr: null, members: [{ role: "vault", id: null, domain: vaultHost, peers: await resolve(vaultHost) }] };
    } else {
      const lobbyDomain = appId ? memberDomain(appId, vault.ngId) : null;
      const [lobbyPeers, vaultPeers] = await Promise.all([resolve(lobbyDomain), resolve(vaultHost)]);
      const own = findInterface(lobbyPeers);
      value = {
        mode: "network-group",
        ngId: vault.ngId,
        cidr: own?.cidr ?? null,
        members: [
          { role: "lobby", id: appId, domain: lobbyDomain, peers: lobbyPeers, interface: own?.name ?? null },
          { role: "vault", id: vault.memberId, domain: vaultHost, peers: vaultPeers },
        ],
      };
    }
    cached = { at: Date.now(), value };
    return value;
  }

  const tunnelError = (err: unknown) => {
    const name = (err as Error).name === "TimeoutError" ? "no answer within 4 s" : (err as Error).message;
    log("tunnel", `GET ${vaultUrl}: ${name}`, false);
    return json({ ok: false, error: `The tunnel did not answer: ${name}.`, logbook }, 502);
  };

  let breakInsInFlight = 0;

  const server = Bun.serve({
    port,
    hostname: "0.0.0.0",
    maxRequestBodySize: 1024,

    routes: {
      "/": () => new Response(Bun.file(`${PUBLIC}/index.html`), { headers: HEADERS }),

      "/health": () => new Response("ok"),
      "/health/deep": async () => {
        try {
          const r = await throughTunnel(`${vaultUrl}/health/deep`);
          const ok = r.status === 200 && Boolean(r.sealed);
          return json({ status: ok ? "ok" : "fail", vault: r.status, sealed: r.sealed, via: vaultHost, ms: r.timings.total }, ok ? 200 : 503);
        } catch (err) {
          return json({ status: "fail", via: vaultHost, error: (err as Error).message }, 503);
        }
      },

      "/api/state": async () => {
        const manifest = await throughTunnel(`${vaultUrl}/manifest`)
          .then((r) => ({ reachable: r.status === 200, status: r.status, ...r.body, ms: r.timings.total }))
          .catch((err) => ({ reachable: false, error: (err as Error).message }));
        return json({
          platform,
          network: await network(),
          vault: { url: vaultUrl, publicUrl: vaultPublicUrl, privatePort: vaultPort, manifest },
          logbook,
        });
      },

      // The right way in: through the Network Group.
      "/api/tunnel": {
        POST: async (req, srv) => {
          if (tooMany(clientIp(req, srv))) return json({ error: "Too many attempts. Wait a minute." }, 429);
          try {
            const r = await throughTunnel(`${vaultUrl}/treasure`);
            const ok = r.status === 200 && Boolean(r.sealed);
            log("tunnel", `GET ${r.url} → ${r.status}${r.sealed ? ", sealed by the vault" : ""}, ${r.timings.total} ms`, ok);
            return json({ ok, ...r, network: await network(), logbook });
          } catch (err) {
            return tunnelError(err);
          }
        },
      },

      // The wrong way in: the vault's public address, from the street.
      "/api/break-in": {
        POST: async (req, srv) => {
          if (tooMany(clientIp(req, srv))) return json({ error: "Too many attempts. Wait a minute." }, 429);
          if (!vaultPublicUrl) return json({ error: "VAULT_PUBLIC_URL is not set: there is no public address to try." }, 503);
          if (breakInsInFlight >= 6) return json({ error: "Several break-ins are already under way. Try again in a few seconds." }, 429);
          breakInsInFlight++;
          try {
            const [http, tcp, dns] = await Promise.all([
              publicHttp(`${vaultPublicUrl}/treasure`), // 1. the public address
              rawTcp(new URL(vaultPublicUrl).hostname, vaultPort), // 2. the private port, on the public host
              publicDns(vaultHost), // 3. the private name, on a public resolver
            ]);
            // Newest first in the logbook: log in reverse so the three lines read in order.
            log("street", `DNS ${dns.host} @${dns.resolver} → ${dns.outcome}${dns.addresses.length ? ` ${dns.addresses.join(", ")}` : ""}, ${dns.ms} ms`, dns.outcome === "resolved");
            log("street", `TCP ${tcp.host}:${tcp.port} → ${tcp.outcome}, ${tcp.ms} ms`, tcp.outcome === "open");
            log("street", `GET ${http.url} → ${http.status ?? http.error}, ${http.bytes} bytes, ${http.sealed ? "SEALED" : "no vault seal"}, ${http.ms} ms`, http.sealed);
            return json({ ok: http.sealed, http, tcp, dns, logbook });
          } finally {
            breakInsInFlight--;
          }
        },
      },

      // A write through the tunnel, read back from the vault's answer.
      "/api/deposit": {
        POST: async (req, srv) => {
          if (tooMany(clientIp(req, srv), 12)) return json({ error: "The vault takes a dozen deposits a minute per visitor. Wait a minute." }, 429);
          const body = (await req.json().catch(() => null)) as { kind?: unknown } | null;
          if (!isDepositKind(body?.kind)) return json({ error: "Choose one of: bar, gem, coin, pearls." }, 400);
          try {
            const r = await throughTunnel(`${vaultUrl}/deposits`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ kind: body.kind }),
            });
            const ok = r.status === 201 && Boolean(r.sealed);
            log("tunnel", `POST ${r.url} {"kind":"${body.kind}"} → ${r.status}, drawer ${r.body?.item?.drawer ?? "?"}, ${r.timings.total} ms`, ok);
            return json({ ok, ...r, logbook }, ok ? 200 : 502);
          } catch (err) {
            return tunnelError(err);
          }
        },
      },
    },

    // Static files: /css, /js and /img only.
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (/^\/(css|js|img)\/[\w.-]+\.(css|js|svg|png)$/.test(pathname)) {
        const file = Bun.file(`${PUBLIC}${pathname}`);
        if (await file.exists()) return new Response(file, { headers: HEADERS });
      }
      return new Response("Not found", { status: 404, headers: HEADERS });
    },
  });

  return server;
}

// Behind Clever's reverse proxy, the visitor's address is the first X-Forwarded-For entry.
function clientIp(req: Request, srv: Server<undefined>) {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || srv.requestIP(req)?.address || "unknown";
}

if (import.meta.main) {
  const server = startLobby({
    port: Number(process.env.PORT ?? 8080),
    vaultUrl: process.env.VAULT_URL ?? "http://127.0.0.1:9000",
    vaultPublicUrl: process.env.VAULT_PUBLIC_URL ?? null,
  });
  console.log(`Lobby: listening on 0.0.0.0:${server.port}, vault at ${process.env.VAULT_URL ?? "http://127.0.0.1:9000"}`);
}
