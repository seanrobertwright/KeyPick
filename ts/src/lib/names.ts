// Rules for vault names that reach a shell or a .env file, and the escaping
// used to name them in messages.

/** A portable shell variable name. `auto` and `extract` emit only key names that match. */
export const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isVariableName(name: string): boolean {
  return VARIABLE_NAME.test(name);
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
