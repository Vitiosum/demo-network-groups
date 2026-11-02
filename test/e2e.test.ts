// End to end on one machine: a vault, a stand-in for Clever's block service, and the lobby.
import { afterAll, describe, expect, test } from "bun:test";
import { startLobby } from "../src/lobby";
import { loopbackGuard, startVault } from "../src/vault";

const vault = startVault({ port: 0, guard: loopbackGuard });
const block = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("OK") }); // what CC_REQUEST_FLOW=block answers
const lobby = startLobby({ port: 0, vaultUrl: `http://127.0.0.1:${vault.port}`, vaultPublicUrl: `http://127.0.0.1:${block.port}` });
const base = `http://127.0.0.1:${lobby.port}`;
const post = (path: string, body: unknown = {}) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// A vault whose lock refuses everyone, to prove the lobby notices.
const lockedVault = startVault({ port: 0, guard: async () => ({ allowed: false, reason: "not a peer" }) });
const lockedLobby = startLobby({ port: 0, vaultUrl: `http://127.0.0.1:${lockedVault.port}`, vaultPublicUrl: null });

afterAll(() => {
  for (const server of [vault, block, lobby, lockedVault, lockedLobby]) server.stop(true);
});

describe("the lobby", () => {
  test("/ and /health answer without touching the vault, /health/deep goes through it", async () => {
    expect((await fetch(`${base}/`)).status).toBe(200);
    expect(await (await fetch(`${base}/health`)).text()).toBe("ok");
    const deep = await fetch(`${base}/health/deep`);
    expect(deep.status).toBe(200);
    expect((await deep.json()).sealed).toBe("local-vault/0");
  });

  test("the first screen knows how many drawers the vault holds", async () => {
    const state = await (await fetch(`${base}/api/state`)).json();
    expect(state.vault.manifest).toMatchObject({ reachable: true, drawers: 12 });
    expect(Object.keys(state.platform)).toEqual(["CC_APP_NAME", "APP_ID", "INSTANCE_NUMBER", "INSTANCE_TYPE", "CC_PRETTY_INSTANCE_NAME", "CC_COMMIT_ID", "CC_DEPLOYMENT_ID"]);
  });

  test("the tunnel returns the inventory, sealed by the vault", async () => {
    const data = await (await post("/api/tunnel")).json();
    expect(data.ok).toBe(true);
    expect(data.sealed).toBe("local-vault/0");
    expect(data.body.items).toHaveLength(12);
    expect(data.body.combination).toHaveLength(3);
    expect(data.timings.vault).toBeGreaterThanOrEqual(0);
  });

  test("the break-in gets the block service's answer, never the vault's", async () => {
    const data = await (await post("/api/break-in")).json();
    expect(data.ok).toBe(false);
    expect(data.http).toMatchObject({ status: 200, bytes: 2, preview: "OK", sealed: false });
    expect(data.dns.outcome).toBe("skipped, local mode"); // the local vault has an IP, not a member name
    expect(data.logbook[0].road).toBe("street");
  });

  test("a deposit is written through the tunnel and read back", async () => {
    const data = await (await post("/api/deposit", { kind: "bar" })).json();
    expect(data.ok).toBe(true);
    expect(data.body.item).toMatchObject({ drawer: 13, kind: "bar", deposit: { from: "127.0.0.1" } });
    const again = await (await post("/api/tunnel")).json();
    expect(again.body.items.map((item: { drawer: number }) => item.drawer)).toContain(13);
    expect((await post("/api/deposit", { kind: "<b>gold</b>" })).status).toBe(400);
  });

  test("a vault that refuses the caller is reported as closed", async () => {
    const res = await fetch(`http://127.0.0.1:${lockedLobby.port}/api/tunnel`, { method: "POST" });
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.status).toBe(403);
    expect(data.body.reason).toBe("not a peer");
    expect((await fetch(`http://127.0.0.1:${lockedLobby.port}/health/deep`)).status).toBe(503);
    expect((await fetch(`http://127.0.0.1:${lockedLobby.port}/api/break-in`, { method: "POST" })).status).toBe(503);
  });
});

describe("the vault", () => {
  test("only /health is open without the lock; unknown paths are 404", async () => {
    expect((await fetch(`http://127.0.0.1:${lockedVault.port}/health`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${lockedVault.port}/treasure`)).status).toBe(403);
    expect((await fetch(`http://127.0.0.1:${vault.port}/nope`)).status).toBe(404);
  });
});
