// Unit tests for the name checks `keypick add` uses to re-prompt. `add` is
// interactive, so the checks are tested directly.

import { describe, expect, test } from "bun:test";
import { groupNameProblem, keyNameProblem } from "../src/lib/names.ts";

describe("keyNameProblem", () => {
  test.each(["API_KEY", "_private", "a1", "DB_HOST"])("accepts %j", (name) => {
    expect(keyNameProblem(name)).toBeNull();
  });

  test.each(["", "1ABC", "MY-KEY", "X=1;touch /tmp/marker;Y", " KEY", "KEY\n", "KÉY"])(
    "rejects %j, which isn't a shell variable name",
    (name) => {
      expect(keyNameProblem(name)).toContain("^[A-Za-z_][A-Za-z0-9_]*$");
    },
  );

  test.each(["__proto__", "constructor", "prototype"])("rejects the reserved name %j", (name) => {
    expect(keyNameProblem(name)).toContain(`"${name}" is reserved`);
  });
});

describe("groupNameProblem", () => {
  test.each(["Supabase_Prod", "Google_AI", "my-app.v2", "1Password"])("accepts %j", (name) => {
    expect(groupNameProblem(name)).toBeNull();
  });

  test.each(["", "_private", "-flag", ".hidden", "..", "a b", "a/b", "a\\b", "Evil\nINJECTED=1"])(
    "rejects %j",
    (name) => {
      expect(groupNameProblem(name)).toContain("^[A-Za-z0-9][A-Za-z0-9_.-]*$");
    },
  );

  test.each(["constructor", "prototype"])("rejects the reserved name %j", (name) => {
    expect(groupNameProblem(name)).toContain(`"${name}" is reserved`);
  });
});
