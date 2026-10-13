// generateAgeIdentity: the in-memory age key generator that `setup actions`
// and `setup recovery` use, so no private key is written to disk.
//
// Requires `age-keygen` on PATH.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { generateAgeIdentity } from "../src/commands/setup/utils.ts";

describe("generateAgeIdentity", () => {
  test("returns an identity and the public key age-keygen derives from it", () => {
    const { identity, publicKey } = generateAgeIdentity();

    expect(identity).toContain("AGE-SECRET-KEY-1");
    expect(publicKey).toMatch(/^age1[0-9a-z]+$/);
    const derived = spawnSync("age-keygen", ["-y"], { input: identity, encoding: "utf8" });
    expect(derived.status).toBe(0);
    expect(derived.stdout.trim()).toBe(publicKey);
  });

  test("returns a different identity each call", () => {
    expect(generateAgeIdentity().publicKey).not.toBe(generateAgeIdentity().publicKey);
  });
});
