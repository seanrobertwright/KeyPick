// Shared UI primitives for the KeyPick installer wizards.
// Node-compatible, zero runtime deps, inline ANSI.

import { stdin, stdout } from "node:process";
import readline from "node:readline/promises";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

const FG = {
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  brightCyan: "\x1b[96m",
  brightMagenta: "\x1b[95m",
};

export const color = {
  reset: RESET,
  bold: (s) => BOLD + s + RESET,
  dim: (s) => DIM + s + RESET,
  red: (s) => FG.red + s + RESET,
  green: (s) => FG.green + s + RESET,
  yellow: (s) => FG.yellow + s + RESET,
  blue: (s) => FG.blue + s + RESET,
  magenta: (s) => FG.magenta + s + RESET,
  cyan: (s) => FG.cyan + s + RESET,
  gray: (s) => FG.gray + s + RESET,
  brightCyan: (s) => FG.brightCyan + s + RESET,
  brightMagenta: (s) => FG.brightMagenta + s + RESET,
};

export function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

const BOX_WIDTH = 72;

function padVisual(s, width) {
  const visible = stripAnsi(s).length;
  return s + " ".repeat(Math.max(0, width - visible));
}

// Draws a bordered box with a title tab and content lines.
export function box(title, lines, opts = {}) {
  const colorize = opts.color ?? color.cyan;
  const width = opts.width ?? BOX_WIDTH;
  const titleTab = ` ${title} `;
  const fillDash = "─".repeat(Math.max(0, width - 2 - stripAnsi(titleTab).length));
  const top = colorize("╭─" + titleTab + fillDash + "╮");
  const bottom = colorize("╰" + "─".repeat(width - 2) + "╯");
  const bar = colorize("│");

  stdout.write(top + "\n");
  for (const line of lines) {
    const body = " " + line;
    stdout.write(bar + padVisual(body, width - 2) + bar + "\n");
  }
  stdout.write(bottom + "\n");
}

function wrap(text, width) {
  const words = text.split(/\s+/);
  const lines = [];
  let current = "";
  for (const w of words) {
    if (stripAnsi(current + " " + w).trim().length > width) {
      if (current) lines.push(current);
      current = w;
    } else {
      current = current ? current + " " + w : w;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// Boxed rationale shown before each step.
export function why(text) {
  const lines = wrap(text, BOX_WIDTH - 4);
  box(color.bold("Why"), lines, { color: color.blue });
}

export const log = {
  step: (n, total, title) =>
    stdout.write(
      "\n" + color.brightMagenta(`▸ Step ${n}/${total}`) + "  " + color.bold(title) + "\n",
    ),
  info: (msg) => stdout.write(color.cyan("  ==> ") + msg + "\n"),
  ok: (msg) => stdout.write(color.green("  ✓ ") + msg + "\n"),
  warn: (msg) => stdout.write(color.yellow("  ! ") + msg + "\n"),
  err: (msg) => stdout.write(color.red("  ✗ ") + msg + "\n"),
  skip: (msg) => stdout.write(color.gray("  - ") + msg + "\n"),
  blank: () => stdout.write("\n"),
};

export function banner() {
  const art = [
    "  ██╗  ██╗███████╗██╗   ██╗    ██████╗ ██╗ ██████╗██╗  ██╗",
    "  ██║ ██╔╝██╔════╝╚██╗ ██╔╝    ██╔══██╗██║██╔════╝██║ ██╔╝",
    "  █████╔╝ █████╗   ╚████╔╝     ██████╔╝██║██║     █████╔╝",
    "  ██╔═██╗ ██╔══╝    ╚██╔╝      ██╔═══╝ ██║██║     ██╔═██╗",
    "  ██║  ██╗███████╗   ██║       ██║     ██║╚██████╗██║  ██╗",
    "  ╚═╝  ╚═╝╚══════╝   ╚═╝       ╚═╝     ╚═╝ ╚═════╝╚═╝  ╚═╝",
  ];
  stdout.write("\n");
  for (const line of art) stdout.write(color.brightCyan(line) + "\n");
  stdout.write(
    "\n  " + color.bold(color.brightCyan("KeyPick")) +
      color.dim("  —  Secure Cross-Platform API Key Vault") + "\n\n",
  );
}

async function withReadline(fn) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    return await fn(rl);
  } finally {
    rl.close();
  }
}

export async function ask(question, defaultValue = "") {
  return withReadline(async (rl) => {
    const hint = defaultValue ? color.dim(` [${defaultValue}]`) : "";
    const ans = await rl.question(color.bold("? ") + question + hint + " ");
    return ans.trim() || defaultValue;
  });
}

export async function confirm(question, defaultYes = false) {
  const hint = defaultYes ? "Y/n" : "y/N";
  const ans = await ask(question + " " + color.dim(`(${hint})`), defaultYes ? "y" : "n");
  return /^y/i.test(ans);
}

export async function choose(question, choices) {
  stdout.write(color.bold("? ") + question + "\n");
  for (const c of choices) {
    stdout.write("  " + color.brightCyan(c.key) + ")  " + c.label + "\n");
  }
  const keys = choices.map((c) => c.key).join(", ");
  const ans = await ask(color.dim(`Enter ${keys}:`));
  const matched = choices.find((c) => c.key.toLowerCase() === ans.toLowerCase());
  return matched?.key ?? null;
}

// OSC 52 — writes text to the system clipboard. Modern terminals honor this;
// older ones silently drop the escape.
export function osc52Copy(text) {
  const b64 = Buffer.from(text, "utf8").toString("base64");
  stdout.write(`\x1b]52;c;${b64}\x07`);
}

// Shows a runnable command in a highlighted box and copies it to the clipboard.
export function showCommand(cmd, label = "Copy & run") {
  const line = color.bold(color.green("$ ")) + cmd;
  box(label, [line], { color: color.green });
  osc52Copy(cmd);
  stdout.write(color.gray("  clipboard ← ") + color.dim("copied") + "\n");
}

export function rule() {
  stdout.write(color.gray("─".repeat(BOX_WIDTH)) + "\n");
}

export function done(message) {
  stdout.write("\n" + color.green("━".repeat(BOX_WIDTH)) + "\n");
  stdout.write("  " + color.bold(color.green("✓ " + message)) + "\n");
  stdout.write(color.green("━".repeat(BOX_WIDTH)) + "\n\n");
}

export function cancelled() {
  stdout.write("\n" + color.yellow("Cancelled.") + "\n");
}
