import { expect, test } from "bun:test";
import { isDepositKind, mintDeposit, seedInventory } from "../src/lib/treasure";

test("the seed is idempotent: same jewels after every restart", () => {
  const first = seedInventory();
  expect(first).toHaveLength(12);
  expect(seedInventory()).toEqual(first);
  expect(new Set(first.map((item) => item.drawer)).size).toBe(12);
  expect(first.every((item) => item.appraisal > 0 && /^[A-Z]{2}-[0-9A-F]{4}-\d{2}$/.test(item.serial))).toBe(true);
});

test("deposits come from a fixed menu", () => {
  expect(isDepositKind("bar")).toBe(true);
  expect(isDepositKind("<script>")).toBe(false);
  expect(isDepositKind(undefined)).toBe(false);
  const item = mintDeposit("gem", 13, "10.101.0.2");
  expect(item).toMatchObject({ drawer: 13, kind: "gem", name: "Ruby", deposit: { from: "10.101.0.2" } });
});
