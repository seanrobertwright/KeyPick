// Unit tests for the emitters that turn vault groups into shell or .env text.
// `keypick extract` is interactive, so its .env output is tested here.

import { describe, expect, test } from "bun:test";
import { UnsafeVaultContentError, groupsToEnv, groupsToExports, keysToEnv } from "../src/lib/vault.ts";

const SECRET = "s3cret-value";

/** Run `emit`, expecting a refusal, and return the error it threw. */
function refusal(emit: () => string): UnsafeVaultContentError {
  try {
    emit();
  } catch (e) {
    if (e instanceof UnsafeVaultContentError) return e;
    throw e;
  }
  throw new Error("expected the emitter to refuse");
}

describe("keysToEnv", () => {
  test("refuses a key name that isn't a variable name, naming it without its value", () => {
    const error = refusal(() => keysToEnv({ GOOD: "fine", "BAD=1\nINJECTED": SECRET }));

    expect(error.problems).toHaveLength(1);
    expect(error.message).toContain('"BAD=1\\nINJECTED"');
    expect(error.message).not.toContain(SECRET);
  });

  test.each([
    ["a newline", `${SECRET}\nINJECTED=1`],
    ["a carriage return", `${SECRET}\rINJECTED=1`],
  ])("refuses a value containing %s, naming the key without its value", (_label, value) => {
    const error = refusal(() => keysToEnv({ GOOD: "fine", MULTILINE: value }));

    expect(error.problems).toHaveLength(1);
    expect(error.message).toContain('"MULTILINE"');
    expect(error.message).not.toContain(SECRET);
    expect(error.message).not.toContain("INJECTED");
  });
});

describe("groupsToEnv", () => {
  test("writes each group's header and sorted keys, unchanged for a valid vault", () => {
    const services = {
      Beta: { Z_KEY: "z", A_KEY: "a b" },
      Alpha: { ONE: "1" },
    };

    expect(groupsToEnv(services, ["Beta", "Alpha"])).toBe(
      "# --- Beta ---\nA_KEY=a b\nZ_KEY=z\n\n# --- Alpha ---\nONE=1\n\n",
    );
  });

  test.each([
    ["Evil\nINJECTED=1", '"Evil\\nINJECTED=1"'],
    ["Evil\u001b[2J", '"Evil\\u001b[2J"'],
    ["Evil\u009b", '"Evil\\u009b"'],
  ])("refuses the group name %j, which contains a control character", (group, quoted) => {
    const error = refusal(() => groupsToEnv({ Fine: { OK: "ok" }, [group]: { KEY: SECRET } }, ["Fine", group]));

    expect(error.problems).toHaveLength(1);
    expect(error.message).toContain(quoted);
    expect(error.message).not.toContain(SECRET);
  });

  test("names every problem in every requested group", () => {
    const services = {
      "Bad\tGroup": { "BAD-KEY": SECRET },
      Other: { OK: "ok", MULTI: `${SECRET}\n` },
    };

    const error = refusal(() => groupsToEnv(services, ["Bad\tGroup", "Other"]));

    expect(error.problems).toEqual([
      'group "Bad\\tGroup" has a control character in its name',
      'group "Bad\\tGroup": key "BAD-KEY" is not a valid variable name (^[A-Za-z_][A-Za-z0-9_]*$)',
      'group "Other": key "MULTI" has a line break in its value',
    ]);
    expect(error.message).not.toContain(SECRET);
  });
});

describe("groupsToExports", () => {
  test("writes sorted export lines, unchanged for a valid vault", () => {
    const services = { Beta: { Z_KEY: "z", A_KEY: "it's" }, Alpha: { ONE: "1" } };

    expect(groupsToExports(services, ["Beta", "Alpha"])).toBe(
      "export A_KEY='it'\\''s'\nexport Z_KEY='z'\nexport ONE='1'\n",
    );
  });

  test("names every bad key in every requested group and returns nothing", () => {
    const services = {
      First: { GOOD: "fine", "1ST": SECRET },
      Second: { "X=1;id;Y": SECRET },
    };

    const error = refusal(() => groupsToExports(services, ["First", "Second"]));

    expect(error.problems).toEqual([
      'group "First": key "1ST" is not a valid variable name (^[A-Za-z_][A-Za-z0-9_]*$)',
      'group "Second": key "X=1;id;Y" is not a valid variable name (^[A-Za-z_][A-Za-z0-9_]*$)',
    ]);
    expect(error.message).not.toContain(SECRET);
  });
});
