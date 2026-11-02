// Network Group helpers: member domain names and a little IPv4 math.
//
// Clever Cloud doc: a member is reachable at <memberID>.m.<ngID>.cc-ng.cloud,
// on any port, and each instance (peer) gets an IP from the group's CIDR.
import { networkInterfaces } from "node:os";

const MEMBER_DOMAIN = /^([a-z]+_[0-9a-f-]+)\.m\.(ng_[0-9a-f-]+)\.cc-ng\.cloud$/i;

export type Member = { memberId: string; ngId: string };

/** "app_x.m.ng_y.cc-ng.cloud" → { memberId: "app_x", ngId: "ng_y" }, or null. */
export function parseMemberDomain(hostname: string): Member | null {
  const match = MEMBER_DOMAIN.exec(hostname.replace(/:\d+$/, ""));
  return match ? { memberId: match[1]!, ngId: match[2]! } : null;
}

export function memberDomain(memberId: string, ngId: string): string {
  return `${memberId}.m.${ngId}.cc-ng.cloud`;
}

/** "::ffff:10.0.0.2" → "10.0.0.2" (Bun reports IPv4 callers in IPv6 form on dual-stack sockets). */
export function plainIPv4(address: string): string {
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

function toInt(ip: string): number | null {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function fromInt(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

/** Address and netmask of an interface → its network in CIDR form: "10.101.0.3" + "255.255.0.0" → "10.101.0.0/16". */
export function toCidr(address: string, netmask: string): string | null {
  const ip = toInt(address);
  const mask = toInt(netmask);
  if (ip === null || mask === null) return null;
  const bits = mask.toString(2).replace(/0+$/, "").length;
  return `${fromInt((ip & mask) >>> 0)}/${bits}`;
}

export function cidrContains(cidr: string, address: string): boolean {
  const [base, bitsText] = cidr.split("/");
  const net = toInt(base ?? "");
  const ip = toInt(plainIPv4(address));
  const bits = Number(bitsText);
  if (net === null || ip === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return ((ip & mask) >>> 0) === ((net & mask) >>> 0);
}

export type NgInterface = { name: string; address: string; cidr: string };

/**
 * The local interface that carries the Network Group.
 * We know it by its address: it is one of the IPs our own member domain resolves to.
 */
export function findInterface(peerIps: string[], interfaces = networkInterfaces()): NgInterface | null {
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal || !peerIps.includes(entry.address)) continue;
      const cidr = toCidr(entry.address, entry.netmask);
      if (cidr) return { name, address: entry.address, cidr };
    }
  }
  return null;
}

/** One line per IPv4 interface, for the startup log (private addresses only, nothing secret). */
export function describeInterfaces(interfaces = networkInterfaces()): string {
  return Object.entries(interfaces)
    .flatMap(([name, entries]) =>
      (entries ?? []).filter((e) => e.family === "IPv4").map((e) => `${name} ${e.address}/${toCidr(e.address, e.netmask)?.split("/")[1]}`),
    )
    .join(", ");
}
