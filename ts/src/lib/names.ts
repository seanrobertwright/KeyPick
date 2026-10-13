// Rules for vault names that reach a shell or a .env file, and the escaping
// used to name them in messages.

/** A portable shell variable name. `auto` and `extract` emit only key names that match. */
export const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isVariableName(name: string): boolean {
  return VARIABLE_NAME.test(name);
}

/** Names that resolve to built-ins on a plain object instead of to vault data. */
const RESERVED_NAMES = new Set(["__proto__", "constructor", "prototype"]);

function reservedProblem(name: string): string | null {
  return RESERVED_NAMES.has(name) ? `${quoteName(name)} is reserved. Choose another name.` : null;
}

/** Why `keypick add` can't store `name` as a key name, or null if it can. */
export function keyNameProblem(name: string): string | null {
  if (!isVariableName(name)) {
    return `Use letters, digits, and _, not starting with a digit (${VARIABLE_NAME.source}).`;
  }
  return reservedProblem(name);
}

/** The rule for a group name `keypick add` creates. Existing groups keep their names. */
const GROUP_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** Why `keypick add` can't create a group called `name`, or null if it can. */
export function groupNameProblem(name: string): string | null {
  if (!GROUP_NAME.test(name)) {
    return `Use letters, digits, _, ., and -, starting with a letter or digit (${GROUP_NAME.source}).`;
  }
  return reservedProblem(name);
}

/** True if `name` contains a C0 or C1 control character or DEL, such as a newline or ESC. */
export function hasControlCharacter(name: string): boolean {
  return /\p{Cc}/u.test(name);
}

/**
 * Quote a name for a message: JSON string escaping, plus `\u` escapes for DEL
 * and the C1 controls, which JSON leaves raw, so a name can't break a line or
 * start a terminal escape sequence.
 */
export function quoteName(name: string): string {
  return JSON.stringify(name).replace(
    /[\u007f-\u009f]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
