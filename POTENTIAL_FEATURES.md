# KeyPick — Potential Features

A running file of feature ideas that have been seriously considered but not yet
committed to. Each entry should include context, a recommendation, and enough
detail that a future reader (or future maintainer) can pick it up cold.

---

## Team Support (Small-Team Shared Vaults)

> **Status:** Exploratory — not committed. Analysis only.
> **First raised:** 2026-04-22 by an external user.
> **Trust bar agreed:** scoped access (prod vs dev) required; audit logging /
> RBAC explicitly out of scope.

### Context

A user asked whether KeyPick can manage API keys and env files for a small
team instead of just one developer across multiple machines. KeyPick today is
a single-user, multi-machine tool: SOPS-encrypted `vault.yaml` in a private git
repo, age keys per machine, Windows Hello / Touch ID / polkit biometric gate,
multi-vault support, and a Claude Code skill that injects secrets via
`eval $(keypick auto GroupName)`.

The framing we're running with: start with a specific team as a design
partner, and if it works well, consider generalizing. Full audit logging /
RBAC is not required — scoped access (prod vs dev) is.

### The Short Answer

**Yes, KeyPick can serve small teams — and it is closer than it looks.** The
cryptographic primitive already in use (SOPS + multi-recipient age) is *the*
standard team-shared-secrets pattern. A KeyPick "vault with two machine keys"
is cryptographically indistinguishable from "vault with two human keys." The
gap between today's tool and a usable team tool is not crypto — it's
**lifecycle UX** (onboarding, offboarding, scoped access, real revocation) and
**honest positioning** (what KeyPick is and is not for teams).

**Recommendation:** ship a thin layer that makes the existing primitives
pleasant and safe to use for a small team — then stop there until real usage
is observed. Do not pivot to a hosted team product. Do not add RBAC or audit
logging. If a team needs those, they should use Infisical / 1Password /
Doppler.

### What's Already There (and Why This Is Mostly a UX Problem)

| Concern | How KeyPick handles it today |
|---|---|
| Multi-recipient encryption | `.sops.yaml` lists N age public keys; `vault.yaml` is encrypted to all of them |
| Auto re-encryption on recipient change | GitHub Actions (`.github/workflows/vault-sync.yml`) runs `sops updatekeys` on `.sops.yaml` changes |
| Per-identity isolation | Each machine owns its own age private key; no single master |
| Multiple secret scopes | Full multi-vault support via `KEYPICK_VAULT_DIR`, `vault select`, `~/.keypick/vaults/*` |
| Recovery | Passphrase-protected recovery keys already implemented |
| Safe AI/agent access | `keypick auto` + Claude Code skill inject secrets without writing plaintext |

For a team, "machine" just becomes "teammate's machine." That's the whole
conceptual shift on the crypto side.

### The Real Gaps for Team Use

1. **Onboarding ergonomics.** Adding a teammate today means: they run
   `keypick setup`, they commit their `.sops.yaml` update, someone pulls,
   GitHub Actions re-encrypts, they pull again. This works but is fragile —
   forgetting to push, bad public key paste, and the whole team is blocked.
   No KeyPick command today *owns* the flow "add this person to our team
   vault."

2. **Offboarding is silently incorrect by default.** Removing a public key
   from `.sops.yaml` and re-encrypting does **not** retroactively protect old
   ciphertext in git history. The departed member still has the plaintext of
   everything that was ever in the vault while their key was listed — both
   via their cached private key and via `git log` on the encrypted file.
   Real revocation requires:
   - `sops updatekeys -r` (rotate the *data* encryption key, not just the
     recipients)
   - **Rotate the underlying secrets** in the source systems (AWS IAM,
     GitHub tokens, etc.)

   KeyPick currently doesn't prompt for either of these. This is the single
   most important safety gap for team use.

3. **Scoped access is unmodeled.** SOPS supports it; KeyPick does not
   surface it at all. Two mechanisms below.

4. **Identity ↔ key mapping is lossy.** `.sops.yaml` today has public keys
   and maybe comments. There's no structured "this key belongs to
   alice@acme, joined 2026-03-14, role: dev" metadata. Fine for two
   machines. Painful at eight people.

### Scoped Access: Two Mechanisms

#### Mechanism A — Separate Vaults per Scope *(recommended)*

One git repo with one `vault.yaml` per trust scope:

```
acme-secrets/
├── vault-prod.yaml       # encrypted to: alice, bob, CI, recovery
├── vault-dev.yaml        # encrypted to: alice, bob, carol, dan, CI, recovery
└── .sops.yaml            # creation_rules map each file to its recipient set
```

Users already switch vaults via `keypick vault select` or `KEYPICK_VAULT_DIR`.
Extending to "vault-prod" and "vault-dev" within a repo is essentially free
conceptually — KeyPick's multi-vault plumbing already handles it.

- **Pros:** uses machinery that already exists; no new mental model; the
  cryptographic boundary between scopes is a full, separate DEK — not just
  a path filter.
- **Cons:** slightly more git repo / path ceremony for the team admin.
  Users in both scopes need both vaults selected/activated for the right
  command.

#### Mechanism B — Per-Path Recipients in One Vault

SOPS `.sops.yaml` supports `creation_rules` with `path_regex` — different
YAML files or key paths can be encrypted to different recipient sets.

- **Pros:** single vault, single `keypick auto` call surface.
- **Cons:** significantly more cognitive overhead; "which keys can I
  actually see" becomes non-obvious; partial-field encryption with
  divergent recipient sets within a single file is the least-well-trodden
  SOPS path and needs careful edge-case testing.

**Verdict:** Mechanism A is more boring, and boring is correct here.

### Proposed Tiered Approach

Ship tier 1, evaluate with the design-partner team, then decide on tier 2.
Do not commit to tier 3 up front.

#### Tier 1 — Make the existing primitives pleasant and safe

- **`keypick team add <public-key> [--label alice@acme]`**
  Appends to `.sops.yaml`, triggers `sops updatekeys`, commits with a
  standard message, pushes. Prints re-encryption summary.
- **`keypick team remove <label-or-key> [--rotate]`**
  Removes from `.sops.yaml`. With `--rotate`, runs `sops updatekeys -r` to
  rotate the DEK. **Without `--rotate`, prints a loud warning** explaining
  that the removed member can still decrypt historical git versions until
  secrets are rotated in source systems. This warning is the
  highest-leverage thing in the whole proposal.
- **`keypick team list`** — shows recipients with labels, last-seen commit,
  whether each has a recovery key registered.
- **Recipient metadata** — sidecar YAML (e.g. `.keypick/team.yaml`)
  mapping age public keys → `{label, added_at, role: human|ci|recovery}`.
  Plaintext (public keys are already public); belongs in git.
- **Docs section: "Small team use."** Explicit discussion of the
  offboarding caveat, recommendation to use separate vaults per scope,
  limits of biometric gates for team trust. Plain-spoken.

#### Tier 2 — Scoped vaults as a first-class concept

- Document and lightly automate the "prod vault + dev vault in one repo"
  pattern (Mechanism A). Possibly a `keypick vault init --scope prod` that
  generates a `vault-prod.yaml` and matching `.sops.yaml` creation rule.
- Team convention: `keypick auto Group` resolves across currently-active
  scopes. (Requires collision handling for duplicate group names across
  vaults.)

#### Tier 3 — *Defer.* Explicitly out of scope

- **Hosted sync / web UI.** Pivots the product; competes with
  Doppler/Infisical; changes trust model. Don't.
- **Built-in audit logging.** Local-only opt-in log file is defensible;
  "real" audit requires a server. If a team needs it, different tool.
- **RBAC beyond scope-level groups.** At that point: 1Password / Infisical.
- **Automatic underlying-secret rotation** (rotating the AWS keys etc.).
  Far outside KeyPick's scope.

### Honest Counter-Arguments

Reasons *not* to do this, worth sitting with:

- **The current strength is the single-user biometric story.** "My keys,
  on my machines, unlocked by my fingerprint." That's clear and sells
  itself. Team features dilute that — biometric on a teammate's machine
  means nothing to *you*.
- **Team mode increases the blast radius of bugs.** Today a KeyPick bug
  affects one user. In a team vault, a bug in `updatekeys -r` logic could
  quietly lock a whole team out or, worse, leave a departed member with
  access.
- **The competitive space is crowded.** 1Password, Doppler, Infisical,
  Bitwarden Secrets Manager all exist. KeyPick's differentiator for teams
  would need to be "self-hosted, git-backed, biometric-gated,
  AI-assistant-aware" — a real niche but not a mass market.
- **The design-partner team might not generalize.** What works for three
  devs at one startup may break at five at another. Don't overfit.

Case *for* doing it anyway: the code delta is small, the primitives exist,
the offboarding warning alone is genuinely useful even for single-user
multi-machine cases, and the Claude Code skill angle is a real
differentiator that none of the commercial tools currently emphasize.

### Critical Files (when/if this becomes an implementation plan)

- `ts/src/lib/vault.ts` — vault load/resolve/discovery (lines 82–108
  crypto, 251–306 multi-vault resolution).
- `ts/src/lib/auth.ts` — biometric gate; informs which team commands
  should require bio.
- `ts/src/main.ts` — command registration, `requireBio()` wrapper.
- `ts/src/commands/vaults.ts` — existing multi-vault commands; `team`
  commands would sit alongside these as peers.
- `.github/workflows/vault-sync.yml` — existing auto-re-encrypt workflow;
  `team add/remove` must cooperate with it.
- `skills/keypick/SKILL.md` — any change to `keypick auto` resolution
  semantics (e.g. cross-vault group lookup in tier 2) must be reflected
  here.

### Verification Plan (before shipping)

If tier 1 is built, the honest test is end-to-end with two real humans on
two real machines:

1. User A creates a vault, adds a secret group "Staging".
2. User A runs `keypick team add <B-public-key> --label user-b`. Confirm
   git history shows one commit, `.sops.yaml` has B's key, `vault.yaml`
   re-encrypted.
3. User B runs `keypick setup`, points at the vault, runs
   `keypick auto Staging` — should succeed without A's involvement
   beyond the initial add.
4. User A runs `keypick team remove user-b` (no `--rotate`) — verify the
   loud warning text actually explains the git-history caveat.
5. User A runs `keypick team remove user-b --rotate` — verify
   `sops updatekeys -r` fires, `git log -p vault.yaml` shows the new DEK,
   old ciphertext is unreadable by B's key.
6. Repeat with scoped vaults (tier 2) — B gets added to dev only, confirm
   B cannot decrypt `vault-prod.yaml`.
7. Claude Code skill: from within User B's machine, verify
   `eval $(keypick auto Staging) && echo "KEY=${SOME_KEY:+set}"` works
   and does not leak to conversation context.

Anything short of this two-human test is self-deception.

### Open Questions

1. **Who is the design-partner team, and how many people?** Three devs is
   a different design than eight.
2. **Is this team already using SOPS/age, or would KeyPick be their
   first encounter with it?** Affects how much of the primitive needs to
   be hidden vs documented.
3. **Would the team tolerate separate vaults per scope (Mechanism A), or
   do they want single-vault partial encryption (Mechanism B)?**
   Recommendation is A; strong preference for B changes tier 2.
4. **Should `--rotate` be the *default* for `team remove`, requiring an
   explicit `--no-rotate` to skip?** Likely yes — the silent-unsafe
   default is how people get burned.
