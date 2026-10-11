# What coding agents can enforce to keep secrets out of their context

Research for issue #11, a child of the v0.3 wayfinder map (issue #9). It feeds the decision in
issue #20, "Should KeyPick ship agent-side enforcement, and for which agents?".

Researched 2026-10-10. Agent features move fast, so each section names the version or date of the
sources it read. Claims that could not be confirmed against a primary source are marked
**unverified**.

## Question

What can coding agents enforce, beyond instructions to the model, to keep secret values out of
their context? Should KeyPick integrate through a skill, through hooks and permission rules,
through an MCP server, or through a combination?

For each agent the research asks four things:

1. Can a tool call be **blocked** before it runs?
2. Can a tool call be **rewritten** before it runs?
3. Can tool output be **redacted** before the model sees it?
4. Can a tool run a command with **injected environment variables** while returning only the exit
   code and scrubbed output?

It also asks whether each agent's shell inherits environment that direnv or the user's profile
loaded, and what an MCP server adds over a CLI plus a skill.

Threat model, settled on the map: assume the agent may be prompt-injected, and it must not get
secret values without the user's biometric approval.

## Summary

- **Every agent studied can block a tool call before it runs**, through hooks, permission rules, or
  both. Rules that match shell command text are bypassable, and the Claude Code, Codex, Cursor, and
  VS Code docs each say their rules or hooks are not a security boundary. Only an OS sandbox
  enforces file access independently of the command text.
- **Output redaction is uneven.** Claude Code (`updatedToolOutput`) and the Copilot CLI
  (`modifiedResult`) can replace a tool's output, shell included, before the model sees it. Codex
  can only block a result and substitute the hook's feedback text. Cursor can replace MCP output
  only. Copilot in VS Code cannot: a blocking `PostToolUse` appends a note, and the original output
  still reaches the model.
- **No agent has a built-in "run with secrets, return only exit code and scrubbed output" tool.**
  The only portable way to get that is a KeyPick-owned wrapper (a CLI subcommand or an MCP server)
  that holds the values, runs the child, and scrubs its own output.
- **Claude Code's and the Copilot CLI's sandboxes can mask credentials**: sandboxed commands see a
  placeholder, and a local proxy substitutes the real value on outbound requests to allowed hosts.
  This is the closest any agent comes to "use a secret without seeing it", but it works only for
  credentials sent over HTTPS, needs the sandbox on, and Claude Code's sandbox does not run on
  native Windows. Codex's source has a similar credential broker that is not yet documented.
- **Hooks mostly fail open.** In Claude Code, Codex, Cursor, and Copilot in VS Code a hook that
  crashes or exits with an unexpected code lets the call through. Claude Code
  (`onFailure: "block"`) and Cursor (`failClosed: true`) let a hook opt into failing closed. The
  Copilot CLI's `preToolUse` command hooks fail closed on errors but open on timeouts.
- **Agent shells inherit secrets that are already in the environment.** Claude Code and Codex pass
  their environment to every command (Codex keeps `KEY`, `SECRET`, and `TOKEN` variables by
  default); the Cursor CLI loads `.envrc` itself. KeyPick's documented direnv pattern
  (`eval $(keypick auto …)` in `.envrc`) therefore hands every secret in those groups to any agent
  started in that project, with no biometric prompt.
- **The biggest hole is on KeyPick's side, not the agent's.** `keypick auto` has no biometric gate,
  and the age private key sits in a file any process running as the user can read. A
  prompt-injected agent can decrypt the whole vault without touching any rule an agent enforces.
  Agent-side enforcement can narrow that path; only KeyPick can close it.

## Capability matrix

"Yes" means a documented mechanism exists; it does not mean the mechanism is a security boundary.
The per-agent notes give the caveats.

| Agent | Block before run | Rewrite before run | Redact output before the model | Run with injected env, return exit code and scrubbed output | MCP |
| :- | :- | :- | :- | :- | :- |
| Claude Code | Yes: `PreToolUse` hooks, deny rules; OS sandbox with per-path read deny (not native Windows) | Yes: `updatedInput` | Yes, every tool: `updatedToolOutput` | No built-in. Closest: sandbox credential `mask` (HTTP only) | Yes. `requiresUserInteraction` forces a prompt per call; servers run outside the sandbox |
| Codex CLI | Yes: `PreToolUse` hooks, `forbidden` rules (experimental), permission profiles with per-path read deny (beta, includes native Windows) | Yes: `updatedInput` | Partly: a blocking `PostToolUse` replaces the result with the hook's feedback text | No built-in. A proxy credential broker exists in source but is undocumented | Yes, per-tool `approval_mode` |
| Cursor (IDE and CLI) | Yes: `beforeShellExecution`, `beforeReadFile`, `preToolUse` hooks; CLI deny rules; sandbox without per-file read deny | Partly: `updated_input`, documented in one line | MCP only: `updated_mcp_tool_output`; shell output is observe-only | No built-in locally. Cloud "Runtime Secrets" are redacted | Yes, approval by default |
| Copilot in VS Code | Yes: `PreToolUse` hooks (Preview). Sandbox `deniedPaths` only in the Agent Host harness, off by default. Auto-approve rules only prompt | Yes: `updatedInput` | No: a blocking `PostToolUse` appends a note; the original output is still sent | No built-in | Yes; optional per-server sandbox with `denyRead` (macOS and Linux) |
| Copilot CLI | Yes: `preToolUse` hooks (fail closed on errors), `--deny-tool`, local sandbox with deny rules | Yes: `modifiedArgs` | Yes: `modifiedResult` | No built-in. Closest: sandbox masked env vars (HTTPS headers only) | Yes; local servers run inside the sandbox by default |

Environment the agent's shell starts with:

| Agent | Inherits the launching environment (including direnv exports) | Loads profile or `.envrc` itself | Built-in env scrubbing |
| :- | :- | :- | :- |
| Claude Code | Yes | Sources the rc file once for aliases and functions; no direnv | Opt-in `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`; sandbox `credentials.envVars` |
| Codex CLI | Yes, `inherit: All` by default, secret-named variables kept | Login shell by default; no direnv | Opt-in through `shell_environment_policy` |
| Cursor CLI | Yes (forum evidence before 2026-06) | Loads `.envrc` automatically since v2026.06.09 | None documented |
| Copilot in VS Code | Yes, unless `terminal.integrated.inheritEnv` is `false` | Uses the user's terminal profile | None documented |
| Copilot CLI | Yes (inferred: `--secret-env-vars` exists to remove inherited variables) | **Unverified** | Opt-in `--secret-env-vars`; sandbox masking |

## Per-agent notes

### Claude Code

Sources: the Claude Code docs at `code.claude.com/docs` and the
[changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md), whose newest entry
on 2026-10-10 was v2.1.296.

**Block before run.** `PreToolUse` hooks run before every tool call and return
`permissionDecision` of `allow`, `deny`, `ask`, or `defer`; exit code 2 also blocks
([hooks](https://code.claude.com/docs/en/hooks)). Hook decisions never override deny and ask
rules: "Claude Code evaluates deny and ask rules regardless of what a PreToolUse hook returns"
([permissions](https://code.claude.com/docs/en/permissions)). Permission rules such as
`Read(./.env)` block the file tools and also "file commands Claude Code recognizes in Bash, such as
`cat`, `head`, `tail`, `sed`, and `tee`", but "don't apply to … arbitrary subprocesses that read or
write files indirectly, like a Python or Node script" (same page). Bash rules match command text,
and the docs say a deny rule "covers the invocation Claude usually produces and isn't a security
boundary around the program": `Bash(curl *)` does not stop `/usr/bin/curl` or `sh -c 'curl …'`.

**Rewrite before run.** `updatedInput` in `PreToolUse` "replaces a tool's arguments before it
runs", and permission rules are re-evaluated "against the input your hook returns, not the input
Claude sent" ([hooks](https://code.claude.com/docs/en/hooks)). `PermissionRequest` hooks can do the
same on the calls that would otherwise prompt.

**Redact output.** `PostToolUse` can return `updatedToolOutput`, which "replaces the tool's output
with the provided value before it is sent to Claude"; the older `updatedMCPToolOutput` is MCP-only,
and the docs say to "prefer `updatedToolOutput`, which works for all tools". The docs' example
replaces a Bash result's `stdout` with `[redacted]`. Caveats from the same page:

- The tool has already run. "Telemetry such as OpenTelemetry tool spans and analytics events also
  captures the original output before the hook runs."
- For built-in tools, "a value that doesn't match the tool's output schema is ignored and the
  original output is used", so a buggy redactor leaks.
- `decision: "block"` on `PostToolUse` does not hide anything: "Claude still sees the original
  output".
- A hook that exits with a code other than 2, prints invalid JSON, or times out is a "non-blocking
  error" and "the action goes ahead"; `onFailure: "block"` (v2.1.295 or later) makes a hook fail
  closed. Whether `onFailure` also withholds a `PostToolUse` result when the redactor itself fails
  is **unverified**.
- Large Bash output is written to a file in the session directory and Claude is given the path
  ([tools reference](https://code.claude.com/docs/en/tools-reference)); background commands and the
  Monitor tool also deliver output outside the Bash result. A redactor has to cover every tool that
  can surface those bytes (Read, Grep, Monitor, MCP), not only Bash. Whether the transcript file
  keeps the original or the replaced output is **unverified**.

**How the Bash tool captures output.** Each command "runs in a separate process"; environment
variables "don't persist" between commands. Output streams to a working file; up to roughly 30,000
characters come back inline, and beyond that Claude gets a file path plus a 2,000-character preview
([tools reference](https://code.claude.com/docs/en/tools-reference)). `CLAUDE_CODE_SHELL_PREFIX`
wraps every Bash tool call (and hooks and stdio MCP server start-up) in a command of the user's
choice ([env vars](https://code.claude.com/docs/en/env-vars)); in principle that wrapper could
filter output, but the docs present it for "logging or auditing" and its use as a redactor is
**unverified**.

**Sandbox.** The sandbox is OS-enforced around Bash, PowerShell, and Monitor commands and their
children, on macOS, Linux, and WSL2; "On native Windows, Claude Code runs commands unsandboxed"
([sandboxing](https://code.claude.com/docs/en/sandboxing)). By default sandboxed commands can read
"most of the machine, including credential files", and environment variables are "inherited from
Claude Code, including any secrets in its environment". The controls that matter here:

- `sandbox.filesystem.denyRead` and `sandbox.credentials.files` with `"mode": "deny"` block reads
  of a path for every sandboxed process, which a command-text rule cannot.
- `sandbox.credentials.envVars` with `"mode": "deny"` unsets named variables before each sandboxed
  command. With `"mode": "mask"`, "the command and anything it logs never hold the real credential,
  but its requests still authenticate": the proxy swaps a per-session placeholder for the real
  value on requests to allowed hosts. Masking requires `network.tlsTerminate` and is honoured only
  from user, managed, or `--settings` scope, never from a repository's settings.
- "There is no built-in credential deny list, so only the files and variables you list are
  restricted."
- The sandbox does not cover the Read tool, hooks, or MCP servers ("run with your full access"),
  and Claude may retry a failed command with `dangerouslyDisableSandbox` unless
  `allowUnsandboxedCommands` is `false`.
- `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` strips credentials from the environment of every subprocess
  (Bash, hooks, stdio MCP servers). It is a heuristic: it recognises a credential "by its variable
  name or by the shape of its value", leaves `GITHUB_TOKEN`-style variables and proxy settings in
  place, and leaves "a secret whose variable name and value don't look like a credential". On
  Linux it also isolates Bash subprocesses in a PID namespace "so they can't read host process
  environments through `/proc`" ([env vars](https://code.claude.com/docs/en/env-vars)).

**Env inheritance.** Bash commands inherit Claude Code's own environment ("Inherited from Claude
Code, including any secrets in its environment", [sandboxing](https://code.claude.com/docs/en/sandboxing)),
so anything direnv loaded into the terminal that launched `claude` is visible to every command.
At session start Claude Code
sources `~/.zshrc`, `~/.bashrc`, or `~/.profile` and captures "aliases, functions, and shell
options" ([tools reference](https://code.claude.com/docs/en/tools-reference)). Claude Code does not
run direnv by itself; the hooks docs suggest `CwdChanged` and `FileChanged` hooks writing to
`CLAUDE_ENV_FILE` "for tools like direnv" ([hooks](https://code.claude.com/docs/en/hooks)).

**MCP.** MCP tool results go to Claude inline, or as a saved file Claude reads when they exceed the
token limit ([MCP](https://code.claude.com/docs/en/mcp)). Two MCP features matter for KeyPick:

- A server can set `_meta["anthropic/requiresUserInteraction"]: true` on a tool. Claude Code then
  "shows that tool's permission prompt on every call, even in `acceptEdits`, `auto`, and
  `bypassPermissions`", allow rules don't skip it, and a `--permission-prompt-tool` cannot approve
  it (v2.1.214 or later).
- Elicitation: a server can ask the user for input mid-call, and Claude Code "passes your response
  back to the server".

**Skills and plugins.** A skill's `allowed-tools` only pre-approves tools; "It does not restrict
which tools are available" ([skills](https://code.claude.com/docs/en/skills)). Hooks in skill
frontmatter are registered only once the skill is invoked, so a prompt-injected agent that never
invokes the KeyPick skill never triggers them ([hooks](https://code.claude.com/docs/en/hooks)). A
plugin can bundle skills, `hooks/hooks.json`, and MCP servers that load whenever the plugin is
enabled ([plugin reference](https://code.claude.com/docs/en/plugins-reference)).

### OpenAI Codex CLI

Sources: the Codex docs (the `developers.openai.com/codex` pages now redirect to
`learn.chatgpt.com/docs`; undated), and the `openai/codex` source at the latest release on
2026-10-10, `rust-v0.162.1` (published 2026-10-09).

**Block before run.** Three mechanisms:

- `PreToolUse` hooks can deny a call with `permissionDecision: "deny"` (or exit code 2). They
  cover shell commands (matched as `Bash`), `apply_patch`, MCP tools, and other local function
  tools, but not hosted tools such as web search. The docs say: "Treat tool hooks as a useful
  guardrail, not a complete enforcement boundary"; hook errors, missing servers, and timeouts let
  the call continue ([hooks](https://learn.chatgpt.com/docs/hooks)). Project hooks load only for a
  trusted project, and non-managed hooks must be reviewed with `/hooks` before they run.
- Rules files (`~/.codex/rules/*.rules`) with `prefix_rule` decisions `allow`, `prompt`, or
  `forbidden` ("Block the request without prompting"). `bash -lc` scripts are split into
  subcommands only when they are a plain chain; anything with substitution, variables, or
  redirection is matched as a whole. "Rules are experimental and may change"
  ([rules](https://learn.chatgpt.com/docs/agent-configuration/rules)).
- Permission profiles (beta): filesystem rules of `read`, `write`, or `deny` per path, for example
  `"**/*.env" = "deny"`, enforced by Seatbelt on macOS, bubblewrap and seccomp on Linux and WSL,
  and "MXC process isolation" on native Windows. "If enforcement fails, Codex refuses to run the
  command instead of silently running it unsandboxed." Profiles replace the older `sandbox_mode`
  settings rather than composing with them, and they do not govern MCP servers
  ([permission profiles](https://learn.chatgpt.com/docs/permissions)). Codex and the Copilot CLI
  document per-path read denial on native Windows; Claude Code's sandbox does not run there, and
  VS Code's is Experimental on Windows.

**Rewrite before run.** `PreToolUse` can return `permissionDecision: "allow"` with
`updatedInput`; for Bash and `apply_patch` it must include a string `command`
([hooks](https://learn.chatgpt.com/docs/hooks)).

**Redact output.** Partly. `PostToolUse` receives the tool output (`tool_response`). Returning
`decision: "block"` "doesn't undo the completed Bash command", but Codex "replaces the tool result
with that feedback", so a hook can hand the model a scrubbed copy as its feedback text.
`updatedMCPToolOutput` is "parsed but not supported yet" ([hooks](https://learn.chatgpt.com/docs/hooks)).
Whether the original output is kept anywhere the model can later reach is **unverified**.

**Env injection.** No built-in "run with secrets" tool. `shell_environment_policy.set` injects
fixed values into every command, which puts them in plain config and in every command's
environment ([config reference](https://learn.chatgpt.com/docs/config-file/config-reference)). The
source also has a network-proxy credential broker, added as
`features.network_proxy.credential_broker` in
[PR #40466](https://github.com/openai/codex/pull/40466) (merged 2026-08-24), with per-provider
`credentials` and a `credential_masking` flag in `codex-rs/core/config.schema.json`. It resembles
Claude Code's masking, but the same PR says it will "restore real credentials for unsandboxed
escalated commands", so one approved escalation hands the real values over. No user-facing doc
for it was found; treat it as experimental and its behaviour as **unverified**.

**Env inheritance.** By default Codex passes its whole environment to commands, including
variables whose names contain `KEY`, `SECRET`, or `TOKEN`: the `ShellEnvironmentPolicy` default in
`codex-rs/protocol/src/config_types.rs` is `inherit: All` with `ignore_default_excludes: true`, and
the config reference describes that flag as "Keep variables containing KEY, SECRET, or TOKEN …
(default: true)". Setting it to `false`, or using `inherit = "core"` or `"none"` with filters,
strips them. The shell tool uses a login shell unless configured otherwise ("omitting `login`
defaults to using a login shell", `allow_login_shell` in the schema), so login profile files run,
and the `shell_snapshot` feature is stable and on by default (`codex-rs/features/src/lib.rs`).
Codex does not run direnv; variables direnv loaded into the launching terminal are inherited (an
inference from `inherit: All`). The filters are not watertight: open issue
[#48096](https://github.com/openai/codex/issues/48096) (2026-09-25) reports app-server
environment reaching `exec_command` "despite `include_only`".

**MCP.** Servers are configured under `mcp_servers` with `env` ("forwarded to the MCP stdio
server") and `env_vars` (variables to whitelist) ([config reference](https://learn.chatgpt.com/docs/config-file/config-reference)).
Unlike shell commands, a stdio server does not inherit Codex's environment: `create_env_for_mcp_server`
in `codex-rs/rmcp-client/src/utils.rs` starts from a short `DEFAULT_ENV_VARS` list (`HOME`,
`PATH`, `SHELL`, `USER`, locale and terminal variables) and adds only `env_vars` and `env`. The
schema exposes a per-tool `approval_mode` (`auto`, `prompt`, `writes`, `approve`); the exact
semantics of each value are **unverified**.

### Cursor

Sources: `cursor.com/docs` pages (undated), the [1.7 changelog](https://cursor.com/changelog/1-7)
(2025-09-29), and the [CLI changelog](https://cursor.com/docs/cli/changelog). Forum evidence is
labelled as such.

**Block before run.** Hooks are configured in `.cursor/hooks.json`, `~/.cursor/hooks.json`, a team
dashboard, or an enterprise path ([hooks](https://cursor.com/docs/agent/hooks)).
`beforeShellExecution` and `beforeMCPExecution` return `allow`, `deny`, or `ask`; `beforeReadFile`
returns `allow` or `deny` and is documented "for access control to block sensitive files from being
sent to the model"; `preToolUse` returns `allow` or `deny` ("ask" is "accepted by the schema but
not enforced"). Crashes, timeouts, and exit codes other than 2 "fail open by default"; `failClosed:
true` on a hook blocks on those failures. `.cursorignore` blocks Agent, Tab, Inline Edit and
@-mentions, but "The terminal and MCP server tools used by Agent cannot block access to code
governed by `.cursorignore`"; Cursor ignores `.gitignore` entries and a default list that includes
`.env*` ([ignore files](https://cursor.com/docs/context/ignore-files)). Run modes are "best-effort
guardrails rather than a hard security boundary" ([agent security](https://cursor.com/docs/agent/security)).

**Rewrite before run.** `preToolUse` accepts `updated_input`, documented only as "Modified tool
input to use instead" ([hooks](https://cursor.com/docs/agent/hooks)). A Cursor staff reply on the
forum says it accepts `command`, `cwd`, and `timeout` for the shell tool
([forum, 2026-08-13](https://forum.cursor.com/t/hooks-that-rewrite-bash-pretool-ask-every-time-and-allowing-it-auto-allows-everything/168218));
per-tool behaviour beyond that is **unverified**.

**Redact output.** Only for MCP: `postToolUse` can return `updated_mcp_tool_output`, "For MCP tools
only: replaces the tool output seen by the model". `afterShellExecution` is observe-only, and
`beforeReadFile` can deny but not redact ([hooks](https://cursor.com/docs/agent/hooks)). The 1.7
changelog says hooks can "redact secrets from context", which the documented schema supports only
for MCP output. Cloud agents are different: "Runtime Secrets" are "redacted from the agent's tool
call results, chat transcript, commits, and commit messages"
([cloud agent network and secrets](https://cursor.com/docs/cloud-agent/security-network)); how
that matching works is **unverified**.

**Sandbox.** "Network traffic is denied by default. Only the listed domains are reachable"
([sandbox](https://cursor.com/docs/reference/sandbox)). Writes default to the workspace. Reads
default to `readBoundary: "system"`; `"workspace"` (Cursor 3.23 or later) makes the agent ask
before reading outside the workspace. The reference page documents read allow-lists but no
per-file read deny, so a sandboxed `cat .env` inside the workspace appears to be allowed (an
inference). Platform support is not listed on that page and is **unverified**. CLI permission rules
(`Shell(…)`, `Read(…)`, `Write(…)`, `Mcp(…)`) live in `~/.cursor/cli-config.json` and
`.cursor/cli.json`, and deny beats allow ([CLI permissions](https://cursor.com/docs/cli/reference/permissions)).

**Env inheritance.** The CLI changelog for v2026.06.09 says "The agent's shell loads `.envrc`
automatically, in interactive and agent-dispatched shells" ([CLI changelog](https://cursor.com/docs/cli/changelog)).
For the IDE, the terminal docs tell users to check `CURSOR_AGENT` in `.zshrc` and `.bashrc`, which
implies agent shells source the profile ([terminal](https://cursor.com/docs/agent/tools/terminal));
that is an inference.

**MCP.** Servers are configured in `.cursor/mcp.json` or `~/.cursor/mcp.json` with `env` and
`envFile`; "Cursor asks for approval before using MCP tools by default", subject to the run mode
([MCP](https://cursor.com/docs/context/mcp)).

### GitHub Copilot agent mode

Copilot's agent runs in several harnesses with different controls. This covers agent mode in VS
Code (the "Local harness"; the VS Code pages read show a date of 2026-10-07) and the Copilot CLI
(GitHub docs, undated). The cloud agent is noted briefly; it runs on GitHub's machines, not the
user's.

**VS Code, block before run.** Agent hooks are in Preview, need `chat.useHooks` and a trusted
workspace, and live in `.github/hooks/*.json`, `~/.copilot/hooks/*.json`, agent frontmatter, or a
plugin; with `chat.useClaudeHooks` VS Code also reads Claude Code's `settings.json` hooks
([hooks](https://code.visualstudio.com/docs/copilot/customization/hooks)). `PreToolUse` returns
`allow`, `deny`, or `ask`, and the most restrictive decision wins. Exit code 2 blocks; any other
non-zero code shows "a non-blocking warning to the user and continue[s] processing"; the default
timeout is 30 seconds ([hooks reference](https://code.visualstudio.com/docs/agents/reference/hooks-reference)).
Terminal auto-approve rules do not block: "A false rule requires approval. It does not block the
command", and "Terminal auto-approval is a best-effort convenience, not a security boundary"
([approvals](https://code.visualstudio.com/docs/agents/run/approvals)). The terminal sandbox
applies to "the Agent Host's default Copilot SDK tool implementation", "not the Local chat
harness", and `chat.agent.sandbox.enabled` "defaults to `off`". Where it applies (Preview on
macOS, Linux, and WSL2; Experimental on Windows) it supports `deniedPaths` ("No access") in
`chat.agent.sandbox.fileSystem.userConfiguredPaths`; outbound network is not blocked by default,
and `chat.agent.sandbox.allowUnsandboxedCommands` defaults to `true`, letting the agent ask to run
a command unsandboxed ([sandboxing](https://code.visualstudio.com/docs/agents/run/agent-sandboxing)).
Repository content exclusion is marked not supported in VS Code agent mode
([content exclusion](https://docs.github.com/en/copilot/concepts/context/content-exclusion)).

**VS Code, rewrite.** `updatedInput` is an "Optional replacement tool input" that must match the
tool schema or is ignored ([hooks reference](https://code.visualstudio.com/docs/agents/reference/hooks-reference)).

**VS Code, redact output.** No. `PostToolUse` can set `decision: "block"`, described as "blocks
further processing", and add `additionalContext`; no field replaces the tool response
([hooks reference](https://code.visualstudio.com/docs/agents/reference/hooks-reference)). In the
source (`extensions/copilot/src/extension/prompts/node/panel/toolCalling.tsx` in
`microsoft/vscode`), a block pushes "The PostToolUse hook blocked this tool result" onto the
existing `toolResult.content`, so the original output still reaches the model.

**Copilot CLI, block and rewrite.** `preToolUse` hooks return `permissionDecision` (`allow`,
`deny`, `ask`) and can substitute arguments with `modifiedArgs`. Unlike the other agents,
`preToolUse` command hooks fail closed: "a crash or non-zero exit (including exit `2`) denies the
tool call", though "timeouts are always fail-open, even for `preToolUse`"
([hooks reference](https://docs.github.com/en/copilot/reference/hooks-configuration)).
"Deny rules always take precedence over allow rules", "even when `--allow-all` is set", but
`--deny-tool='shell(git push)'` and similar flags "apply only to the current session"; the page
does not define how `shell(…)` patterns match
([allowing tools](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/allowing-tools)).
Local sandboxing (`/sandbox enable`) is "deny-by-default" for paths and supports deny rules for
files such as `.env`, with platform notes for macOS, Linux, and Windows; built-in file tools
"check the policy in software", and local MCP servers run inside the sandbox by default
([local sandboxing](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/understanding-local-sandboxing)).

**Copilot CLI, redact output.** Yes. "The `postToolUse` hook can modify the tool result" by
returning `modifiedResult`, a "Replacement tool result"; omitting `matcher` receives "results from
all tools", and the docs' matcher example targets `bash`
([hooks reference](https://docs.github.com/en/copilot/reference/hooks-configuration)). Whether the
original is kept in session logs is **unverified**.

**Copilot CLI, env injection.** With local sandboxing on, `sandbox.credentials.envVars` entries
are masked: "Sandboxed processes receive placeholder values. A local proxy supplies the real
credentials only in HTTPS request headers sent to approved destinations", and "Masking is active
only while local sandboxing is enabled". Separately, `--secret-env-vars` "removes named variables
from command and MCP server environments"
([local sandbox settings](https://docs.github.com/en/copilot/how-tos/cloud-and-local-sandboxes/configuring-local-sandbox-settings)).

**Env inheritance.** "The agent uses the shell you have configured as the default for the
terminal", except `cmd` and `sh` ([tools](https://code.visualstudio.com/docs/agents/run/tools)). On
macOS VS Code starts that shell as a login shell, and setting `terminal.integrated.inheritEnv` to
`false` "will strip most environment variables from the terminal's environment"
([terminal profiles](https://code.visualstudio.com/docs/terminal/profiles)). Since 1.121
(2026-05-20) "VS Code now sets a `VSCODE_AGENT` environment variable for agent-initiated terminal
commands" ([release notes 1.121](https://code.visualstudio.com/updates/v1_121)). Whether a direnv shell hook
fires in agent terminals, and whether the Copilot CLI shell loads profile files, are
**unverified**. That the Copilot CLI passes its launch environment to commands is inferred from
`--secret-env-vars`, which exists to remove inherited variables.

**MCP.** VS Code reads `mcp.json` with `env`, `envFile`, and `${input:…}` variables whose values
are "securely stored for subsequent use". Per-server sandboxing is opt-in with `sandboxEnabled`
(macOS and Linux only) and accepts `filesystem.denyRead`; "When sandboxing is enabled, tool
confirmations are auto-approved" ([MCP configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration)).
The sandboxing page says servers launched by the newer Agent Host are sandboxed by default
([sandboxing](https://code.visualstudio.com/docs/agents/run/agent-sandboxing)).

**Cloud agent.** "Agents" secrets are exposed as environment variables in the agent's environment,
except names prefixed `COPILOT_MCP_`, which reach only MCP servers; secret values are masked in
session logs ([secrets and variables](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/configure-secrets-and-variables)).

## What an MCP server adds over a CLI plus a skill

An MCP server is a process the agent starts and talks to through declared tools. Compared with a
`keypick` CLI that the agent drives through its shell, guided by a skill:

What it adds:

- **A narrow surface.** The model can only call the tools the server declares, such as
  `list_groups` or `run_with_secrets(group, command)`. There is no `keypick auto` that prints
  `export` lines, unless the server chooses to offer one.
- **Secrets stay in a process the agent's shell does not share.** The server's environment is not
  the shell's environment. In Claude Code the sandbox does not wrap MCP servers, so a sandbox
  policy can deny the agent's shell access to the age key file while the KeyPick server still
  reads it ([sandboxing](https://code.claude.com/docs/en/sandboxing)).
- **One place to scrub, in every agent.** The server can run the child process, scrub known
  secret values from its output, and return the exit code and scrubbed text. That works in any MCP
  client, including agents whose hooks cannot redact shell output.
- **Agent-side approval hooks keyed to a stable tool name.** Claude Code's
  `anthropic/requiresUserInteraction` forces a human prompt on every call to a flagged tool, even
  in `bypassPermissions` mode ([MCP](https://code.claude.com/docs/en/mcp)). Cursor gates MCP calls
  with `beforeMCPExecution` and can rewrite MCP results with `updated_mcp_tool_output`
  ([hooks](https://cursor.com/docs/agent/hooks)). Codex has a per-tool `approval_mode`, and its
  docs list MCP tools among those its `PreToolUse` hooks cover.
- **A path to ask the user directly.** MCP elicitation lets the server ask the user mid-call and
  receive the answer itself ([spec 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation)).
  The spec forbids form-mode elicitation for "passwords, API keys, access tokens", so it suits an
  approve-or-deny question, not secret entry. The OS biometric prompt KeyPick already uses works
  the same way from a server and needs no agent support at all.

What it does not add:

- **It does not take the shell away.** The agent keeps its own shell tool. If the CLI, the age key,
  or an `.envrc` that exports secrets is reachable, a prompt-injected agent can go around the
  server. The server is only as strong as the shell-side rules and sandbox that close those paths.
- **It does not stop a child process from leaking.** Once a secret is in the child's environment,
  the child can write it to a file, encode it, or send it over the network. Scrubbing output
  catches the plain value and whatever encodings the scrubber knows; it is not a boundary. The map
  already accepts this limit.
- **Its results reach the model unfiltered by default.** Every agent studied passes MCP output
  straight to the model, so the scrubbing has to happen inside the server.
- **Tool descriptions are instructions, not enforcement.** Text that tells the model how to use a
  tool has the same status as the skill.
- **Cost.** A server is a long-running process per agent session, with per-agent configuration and
  its own upgrade path. A `keypick run` CLI subcommand with the same scrubbing and approval gives
  most of the same guarantees to any agent with a shell, without MCP.

## Implications for KeyPick

These are options for issue #20, not a decision. "Enforces" means it holds against a
prompt-injected agent; "discourages" means it holds only if the model cooperates or nobody tries a
variant.

### Start from KeyPick's own gaps

Agent-side controls sit on top of two facts in the current code:

- `keypick auto` has no biometric gate. The header of `ts/src/commands/auto_export.ts` says
  "No biometric gate — authentication is handled by the calling shell context", and the README's
  direnv section says the same.
- The age private key lives in the SOPS `keys.txt` file (see `localAgePublicKey` in
  `ts/src/lib/vault.ts`), readable by any process running as the user. With it, `sops -d` decrypts
  the whole vault without KeyPick.

So today an injected agent with a shell needs no agent feature to fail: it runs `keypick auto
<Group>` and prints the result, or decrypts the vault directly. Agent-side rules can narrow these
paths. Only KeyPick can close them, for example by putting decryption behind the same approval as
`list` and `copy` and moving the key out of a plain file. That choice belongs to the
approval-window and key-storage tickets on the map, but every option below assumes it; without it
each one is a speed bump.

The README's direnv pattern (`eval $(keypick auto …)` in `.envrc`) is the other cross-cutting
problem. Claude Code and Codex inherit the launching terminal's environment and the Cursor CLI
loads `.envrc` itself, so any agent started in such a project holds every secret in those groups in
its shell environment, where `printenv` or a crash dump puts them in context.

### Options

**1. Skill only (today).** Text in `skills/keypick/SKILL.md`, and the equivalent instruction files
for other agents. Discourages only. Portable and cheap. A prompt-injected agent ignores it.

**2. A KeyPick-owned runner: `keypick run <group> -- <command>`.** KeyPick asks for approval,
injects the group into the child's environment, captures stdout and stderr, replaces every known
secret value (and its common encodings) with a marker, and returns the child's exit code. Works in
every agent that has a shell. Enforces that KeyPick's own output never contains a value and that
values need approval. Does not stop the child from leaking, and does not stop the agent from
choosing another path, so it depends on closing `keypick auto` and the key file as above.

**3. Option 2 plus agent-native guard rails, installed per agent** (for example a
`keypick agent install <agent>` command). Per agent:

- **Claude Code**, as a plugin bundling the skill, hooks, and optionally the MCP server:
  - Enforces, with the sandbox on (macOS, Linux, WSL2; not native Windows): `sandbox.credentials.files`
    deny on the age key file and `.env` files, `allowUnsandboxedCommands: false`, and
    `credentials.envVars` deny for variables that should never reach a command.
  - Enforces, on any platform: `Read` deny rules for the key file and `.env` files against the file
    tools; `PostToolUse` `updatedToolOutput` redaction of known values from Bash, Read, Grep, and
    MCP results, with `onFailure: "block"` (whether that withholds a result when the redactor
    fails is unverified). Redaction needs the hook to know the values, so it would ask a KeyPick
    process holding the approved values in memory.
  - Discourages: `PreToolUse` denials or rewrites keyed on command text (such as turning
    `eval $(keypick auto X) && cmd` into `keypick run X -- cmd`), because the docs say command-text
    rules are not "a security boundary around the program".
  - Worth a closer look: sandbox credential masking for HTTP API keys, where the agent's commands
    never hold the real value. It needs TLS termination and user-scope settings.
- **Cursor**, as `hooks.json` plus CLI permissions:
  - Enforces, best-effort: `beforeReadFile` denial of the key file and `.env` files for the file
    tools, with `failClosed: true`; `beforeShellExecution` denial of `keypick auto`, `sops -d`,
    and environment dumps.
  - Cannot do: redact shell output. Only MCP output can be rewritten, so the scrubbing must live in
    `keypick run` or an MCP server.
  - Does not stop: the CLI loading an `.envrc` that exports secrets.
- **Codex CLI**, as `hooks.json`, a rules file, and a permission profile:
  - Enforces, OS-level on macOS, Linux, WSL, and native Windows: a permission profile that denies
    reads of the age key file and `.env` files. The profile is beta and replaces `sandbox_mode`.
  - Enforces by configuration: `shell_environment_policy` with `ignore_default_excludes = false`
    or an `include_only` filter, so secret-named variables never reach commands.
  - Partly: a `PostToolUse` hook that blocks any result containing a known value and returns a
    scrubbed copy as feedback.
  - Discourages: `forbidden` rules and `PreToolUse` denials keyed on command text.
- **Copilot CLI**, as `.github/hooks/*.json` plus sandbox rules:
  - Enforces: local-sandbox deny rules for the key file and `.env` files; `postToolUse`
    `modifiedResult` redaction; `preToolUse` hooks that fail closed on errors; `--secret-env-vars`
    for variables that should never reach a command.
  - Worth a closer look: sandbox masked env vars for HTTPS API keys, as with Claude Code.
  - Gap: local MCP servers run inside the sandbox by default, so a KeyPick MCP server would need
    an explicit grant for the key file, which the agent's own commands would then share unless
    the grant can be scoped to the server (**unverified**).
- **Copilot in VS Code**, as `.github/hooks/*.json` plus sandbox settings:
  - Enforces, best-effort: `PreToolUse` denials (Preview). Sandbox `deniedPaths` for the key file
    and `.env` files, with `allowUnsandboxedCommands` set to `false`, only in the Agent Host
    harness and only once the user turns the sandbox on; the Local harness gets no sandbox.
  - Cannot do: redact output. The scrubbing has to live in `keypick run` or an MCP server.
- **Shared hook script.** Codex and VS Code use Claude Code's `hookSpecificOutput` /
  `permissionDecision` shape. VS Code (with `chat.useClaudeHooks`) and the Cursor CLI read Claude
  Code's `settings.json` hooks, and the Cursor CLI accepts "Claude Code-format hook responses"
  ([CLI changelog](https://cursor.com/docs/cli/changelog), April 2026). The Cursor IDE and the
  Copilot CLI use their own field names. One KeyPick hook binary with a small adapter per agent
  looks feasible.
- **Agent detection.** `VSCODE_AGENT` (VS Code), `CURSOR_AGENT` (Cursor), and `CODEX_THREAD_ID`
  (Codex source) let `keypick` notice it is running under an agent and refuse plaintext output.
  An injected agent can unset them, so this discourages; it does not enforce.

**4. An MCP server (`keypick mcp`).** Tools such as `list_groups` and `run_with_secrets` with
approval and scrubbing inside the server, as described in the MCP section above. Adds a stable
tool to gate (Claude Code's `requiresUserInteraction`, Cursor's `beforeMCPExecution`) and a second
redaction pass where the agent supports it. Its guarantees match option 2; it adds per-agent
configuration and a long-running process, and still depends on closing the shell paths.

**5. Combination.** Option 2 as the portable core, option 3 for the agents whose hooks and sandbox
add real enforcement, and option 1 kept as guidance. Option 4 becomes worth its cost if an agent
without a shell, or one whose shell can be locked down hard, becomes a target.

Whichever option is chosen, the order of strength is the same in every agent studied: OS-level
controls (KeyPick's own biometric prompt, an OS sandbox) enforce; agent hooks and permission rules
on file tools enforce within their scope but fail open unless configured otherwise; rules on
command text and written instructions discourage.

## Sources

All fetched 2026-10-10 unless a date is given.

Claude Code (changelog head v2.1.296):

- [Hooks reference](https://code.claude.com/docs/en/hooks)
- [Configure permissions](https://code.claude.com/docs/en/permissions)
- [Sandboxing](https://code.claude.com/docs/en/sandboxing)
- [Tools reference](https://code.claude.com/docs/en/tools-reference)
- [Environment variables](https://code.claude.com/docs/en/env-vars)
- [MCP](https://code.claude.com/docs/en/mcp)
- [Skills](https://code.claude.com/docs/en/skills)
- [Plugin manifest reference](https://code.claude.com/docs/en/plugins-reference)
- [Changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)

OpenAI Codex CLI (latest release `rust-v0.162.1`, 2026-10-09):

- [Hooks](https://learn.chatgpt.com/docs/hooks)
- [Rules](https://learn.chatgpt.com/docs/agent-configuration/rules)
- [Permission profiles](https://learn.chatgpt.com/docs/permissions)
- [Configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- Source: [`codex-rs/protocol/src/config_types.rs`](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/config_types.rs)
  (`ShellEnvironmentPolicy`),
  [`codex-rs/protocol/src/shell_environment.rs`](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/shell_environment.rs),
  [`codex-rs/core/config.schema.json`](https://github.com/openai/codex/blob/main/codex-rs/core/config.schema.json)
  (`allow_login_shell`, `credential_broker`, `credential_masking`, `approval_mode`),
  [`codex-rs/rmcp-client/src/utils.rs`](https://github.com/openai/codex/blob/main/codex-rs/rmcp-client/src/utils.rs)
  (`create_env_for_mcp_server`),
  [`codex-rs/features/src/lib.rs`](https://github.com/openai/codex/blob/main/codex-rs/features/src/lib.rs)
  (`shell_snapshot`)
- [PR #40466](https://github.com/openai/codex/pull/40466), credential brokering (merged 2026-08-24);
  [issue #48096](https://github.com/openai/codex/issues/48096), environment filter leak (open)

Cursor:

- [Hooks](https://cursor.com/docs/agent/hooks)
- [Ignore files](https://cursor.com/docs/context/ignore-files)
- [Sandbox reference](https://cursor.com/docs/reference/sandbox)
- [Agent security](https://cursor.com/docs/agent/security)
- [Run modes](https://cursor.com/docs/agent/security/run-modes)
- [CLI permissions](https://cursor.com/docs/cli/reference/permissions)
- [CLI changelog](https://cursor.com/docs/cli/changelog)
- [Terminal](https://cursor.com/docs/agent/tools/terminal)
- [MCP](https://cursor.com/docs/context/mcp)
- [Cloud agent network and secrets](https://cursor.com/docs/cloud-agent/security-network)
- [Changelog 1.7](https://cursor.com/changelog/1-7) (2025-09-29)
- Forum: [hooks that rewrite shell input](https://forum.cursor.com/t/hooks-that-rewrite-bash-pretool-ask-every-time-and-allowing-it-auto-allows-everything/168218) (2026-08-13)

GitHub Copilot (VS Code pages dated 2026-10-07; GitHub docs undated):

- VS Code: [Hooks](https://code.visualstudio.com/docs/copilot/customization/hooks),
  [Local hooks reference](https://code.visualstudio.com/docs/agents/reference/hooks-reference),
  [Approvals](https://code.visualstudio.com/docs/agents/run/approvals),
  [Agent sandboxing](https://code.visualstudio.com/docs/agents/run/agent-sandboxing),
  [Tools](https://code.visualstudio.com/docs/agents/run/tools),
  [MCP configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration),
  [Terminal profiles](https://code.visualstudio.com/docs/terminal/profiles),
  [Release notes 1.121](https://code.visualstudio.com/updates/v1_121) (2026-05-20); source
  [`toolCalling.tsx`](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/extension/prompts/node/panel/toolCalling.tsx)
  (`PostToolUse` handling)
- GitHub: [Hooks reference](https://docs.github.com/en/copilot/reference/hooks-configuration),
  [Allowing and denying tool use](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/allowing-tools),
  [Local sandboxing](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/understanding-local-sandboxing),
  [Local sandbox settings](https://docs.github.com/en/copilot/how-tos/cloud-and-local-sandboxes/configuring-local-sandbox-settings),
  [Using Copilot CLI](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-copilot-cli),
  [Content exclusion](https://docs.github.com/en/copilot/concepts/context/content-exclusion),
  [Cloud agent secrets and variables](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/configure-secrets-and-variables)

Model Context Protocol:

- [Elicitation, specification revision 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation)

KeyPick (this repository): `skills/keypick/SKILL.md`, `ts/src/commands/auto_export.ts`,
`ts/src/lib/vault.ts` (`localAgePublicKey`), and the README section "Automatic Shell Injection
(direnv)".
