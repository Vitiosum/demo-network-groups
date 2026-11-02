import { describe, expect, test } from "bun:test";
import { cidrContains, findInterface, memberDomain, parseMemberDomain, plainIPv4, toCidr } from "../src/lib/ng";

describe("Network Group helpers", () => {
  const host = "app_abc123.m.ng_def456.cc-ng.cloud";

  test("member domains follow <memberID>.m.<ngID>.cc-ng.cloud", () => {
    const member = parseMemberDomain(`${host}:9000`);
    expect(member).toEqual({ memberId: "app_abc123", ngId: "ng_def456" });
    expect(memberDomain(member!.memberId, member!.ngId)).toBe(host);
    expect(parseMemberDomain("app-0f1e2d3c.cleverapps.io")).toBeNull();
    expect(parseMemberDomain("127.0.0.1")).toBeNull();
  });

  test("CIDR math", () => {
    expect(toCidr("10.101.0.3", "255.255.0.0")).toBe("10.101.0.0/16");
    expect(toCidr("192.168.1.7", "255.255.255.0")).toBe("192.168.1.0/24");
    expect(cidrContains("10.101.0.0/16", "10.101.42.7")).toBe(true);
    expect(cidrContains("10.101.0.0/16", "::ffff:10.101.0.2")).toBe(true);
    expect(cidrContains("10.101.0.0/16", "10.102.0.2")).toBe(false);
    expect(cidrContains("10.101.0.0/16", "203.0.113.9")).toBe(false);
    expect(cidrContains("10.101.0.0/16", "not-an-ip")).toBe(false);
    expect(plainIPv4("::ffff:10.0.0.1")).toBe("10.0.0.1");
  });

  test("the Network Group interface is the one holding our member IP", () => {
    const fake = {
      lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", internal: true }],
      eth0: [{ address: "172.16.4.20", netmask: "255.255.255.0", family: "IPv4", internal: false }],
      wg0: [{ address: "10.101.0.3", netmask: "255.255.0.0", family: "IPv4", internal: false }],
    } as unknown as ReturnType<typeof import("node:os").networkInterfaces>;
    expect(findInterface(["10.101.0.3"], fake)).toEqual({ name: "wg0", address: "10.101.0.3", cidr: "10.101.0.0/16" });
    expect(findInterface(["10.9.9.9"], fake)).toBeNull();
  });
});
