// The two ways to the vault, measured.
import { lookup, Resolver } from "node:dns/promises";
import { connect, isIP } from "node:net";

const ms = (from: number) => Math.round((performance.now() - from) * 10) / 10;

export type TunnelResult = {
  url: string;
  status: number;
  sealed: string | null; // X-Vault-Seal: present only on answers written by the vault app itself
  resolved: string[]; // what the member domain resolved to (Network Group peer IPs)
  timings: { dns: number; roundTrip: number; vault: number | null; total: number };
  body: any;
};

/** A request to the vault through the Network Group, with a DNS / round trip / vault-time breakdown. */
export async function throughTunnel(url: string, init: RequestInit = {}): Promise<TunnelResult> {
  const started = performance.now();
  const { hostname } = new URL(url);
  const answers = await lookup(hostname, { all: true, family: 4 }).catch(() => []);
  const dns = ms(started);

  const sent = performance.now();
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(4000) });
  const body = await res.json().catch(() => null);
  const roundTrip = ms(sent);

  const vaultTime = /vault;dur=([\d.]+)/.exec(res.headers.get("server-timing") ?? "")?.[1];
  return {
    url,
    status: res.status,
    sealed: res.headers.get("x-vault-seal"),
    resolved: answers.map((a) => a.address),
    timings: { dns, roundTrip, vault: vaultTime ? Number(vaultTime) : null, total: ms(started) },
    body,
  };
}

export type HttpAttempt = { url: string; status: number | null; bytes: number; preview: string; sealed: boolean; ms: number; error?: string };

/** Break-in, part one: ask the vault's public address for the treasure. */
export async function publicHttp(url: string): Promise<HttpAttempt> {
  const started = performance.now();
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5000), headers: { accept: "application/json" } });
    const text = await res.text();
    return {
      url,
      status: res.status,
      bytes: new TextEncoder().encode(text).length,
      preview: text.replace(/[^\x20-\x7e]+/g, " ").trim().slice(0, 80),
      sealed: res.headers.has("x-vault-seal"),
      ms: ms(started),
    };
  } catch (err) {
    return { url, status: null, bytes: 0, preview: "", sealed: false, ms: ms(started), error: (err as Error).name };
  }
}

export type TcpAttempt = { host: string; port: number; outcome: "open" | "refused" | "timeout" | "unreachable"; ms: number };

/** Break-in, part two: knock on the vault's private port from the internet. */
export function rawTcp(host: string, port: number, timeoutMs = 2500): Promise<TcpAttempt> {
  const started = performance.now();
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (outcome: TcpAttempt["outcome"]) => {
      socket.destroy();
      resolve({ host, port, outcome, ms: ms(started) });
    };
    socket.setTimeout(timeoutMs, () => done("timeout"));
    socket.once("connect", () => done("open"));
    socket.once("error", (err: NodeJS.ErrnoException) => done(err.code === "ECONNREFUSED" ? "refused" : "unreachable"));
  });
}

export type DnsAttempt = { host: string; resolver: string; outcome: string; addresses: string[]; ms: number };

/** Break-in, part three: look the vault's private member name up on a public resolver. */
export async function publicDns(host: string, resolver = "1.1.1.1"): Promise<DnsAttempt> {
  const started = performance.now();
  if (isIP(host)) return { host, resolver, outcome: "skipped, local mode", addresses: [], ms: 0 };
  const dns = new Resolver({ timeout: 2000, tries: 1 });
  dns.setServers([resolver]);
  try {
    return { host, resolver, outcome: "resolved", addresses: await dns.resolve4(host), ms: ms(started) };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { host, resolver, outcome: code === "ENOTFOUND" ? "no such domain" : `failed (${code})`, addresses: [], ms: ms(started) };
  }
}
