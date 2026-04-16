# KeyPick Tutorial

This guide is for beginners who want to go from zero to a solid multi-machine secrets workflow with KeyPick.

It covers:

- installing KeyPick
- setting up your first vault
- joining from another machine
- using secrets in real projects
- managing multiple vaults
- `direnv` integration
- recovery and GitHub Actions
- advanced patterns that push the app further than the basic README flow

---

## 1. What KeyPick Actually Is

KeyPick is a CLI that manages an encrypted `vault.yaml` stored in a private Git repository.

The stack is:

- `age`: encrypts the vault for specific machine public keys
- `sops`: manages encrypted YAML and multi-recipient access
- Git: syncs the encrypted vault repo between machines
- biometrics: Windows Hello, Touch ID, or Linux polkit before interactive decryption

The practical result:

- your secrets live in one encrypted vault repo
- each machine has its own decryption key
- you can sync with `git pull` / `git push`
- you can export only what a project needs when you need it

---

## 2. Recommended Directory Layout

Do not keep real vault repos inside the KeyPick source repository.

Recommended:

```text
~/code/KeyPick/                  # the app source repo
~/.keypick/vaults/work-keys/     # vault repo 1
~/.keypick/vaults/personal-keys/ # vault repo 2
```

On Windows, if your profile blocks writes to hidden home directories, use:

```text
C:\Users\you\OneDrive\Documents\KeyPick\vaults\work-keys
C:\Users\you\OneDrive\Documents\KeyPick\vaults\personal-keys
```

Why this is better:

- vault Git history stays separate from app Git history
- you are much less likely to push encrypted vault data from the wrong repo
- it scales cleanly when you have multiple vaults
- KeyPick can list and select vaults explicitly

KeyPick is now designed around this model.

---

## 3. Install KeyPick

KeyPick ships two interchangeable implementations — a Rust native binary and a TypeScript build that runs on [Bun](https://bun.sh). Both produce identical vaults; pick whichever you prefer.

### One-line installer (recommended)

The installer prompts you to choose Rust or TypeScript and installs the chosen variant as `keypick` on your `PATH`.

**macOS / Linux / WSL:**

```bash
curl -fsSL https://raw.githubusercontent.com/seanrobertwright/KeyPick/master/install.sh | sh
keypick --version
```

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/seanrobertwright/KeyPick/master/install.ps1 | iex
keypick --version
```

### Direct install — TypeScript

If you already have Bun:

```bash
bun install -g keypick
keypick --version
```

### Direct install — Rust

Prebuilt binaries for each platform are attached to every [GitHub release](https://github.com/seanrobertwright/KeyPick/releases). Download the archive matching your OS/arch, extract it, and put `keypick` on your `PATH`.

To build from source instead:

```bash
git clone https://github.com/seanrobertwright/KeyPick.git
cd KeyPick/rust
cargo install --path . --force
keypick --version
```

(Install `rustup` first if Rust isn't on the machine.)

KeyPick's setup wizard handles `age` and `sops` for you, so you do not need to preinstall them unless you want manual control.

### WSL note

Inside WSL, run the macOS/Linux installer and pick either implementation. KeyPick detects WSL and routes biometric prompts to Windows Hello on the host via `powershell.exe` (exposed by WSL interop) — so you get the real fingerprint/PIN prompt, not a polkit fallback. Your age keypair lives at `~/.config/sops/age/keys.txt` inside the WSL distro and is treated as a separate "machine" from native Windows.

### Windows note: `KEYPICK_HOME`

If your machine prevents KeyPick from writing to `C:\Users\you\.keypick`, set a writable KeyPick home first:

```powershell
setx KEYPICK_HOME "$env:USERPROFILE\OneDrive\Documents\KeyPick"
```

Then open a new shell and continue with setup.

---

## 4. First Run: Create Your First Vault

Run:

```bash
keypick setup
```

Choose:

- `New vault (first machine)` if this is your first KeyPick machine

What the wizard does:

1. checks or installs `age` and `sops`
2. creates or reuses this machine's `age` keypair
3. creates a private vault repo
4. stores or clones it under `~/.keypick/vaults/<vault-name>` by default
5. writes `.sops.yaml`
6. creates and encrypts `vault.yaml`
7. optionally sets up GitHub Actions and a recovery key

If `KEYPICK_HOME` is set, KeyPick uses `<KEYPICK_HOME>\vaults\<vault-name>` instead.

Good first vault names:

- `work-keys`
- `personal-keys`
- `freelance-keys`

Avoid generic names like `vault` once you have more than one.

---

## 5. Add Your First Secrets

Once setup finishes:

```bash
keypick add
```

You will:

1. pass biometric auth
2. choose an existing group or create a new one
3. add one or more key/value pairs
4. save the vault

Good group naming examples:

- `Supabase_Prod`
- `OpenAI_Personal`
- `Stripe_Test`
- `AWS_Prod`

Keep group names stable. Projects and scripts will depend on them.

---

## 6. Commit and Sync the Vault

After updating secrets, go to the vault repo and commit:

```bash
cd ~/.keypick/vaults/work-keys
git add vault.yaml
git commit -m "Update OpenAI_Personal keys"
git push
```

On another machine:

```bash
cd ~/.keypick/vaults/work-keys
git pull
```

The vault file is encrypted, so committing it is expected. The private `age` key is not.

Never commit:

- `keys.txt`
- plaintext `.env` files
- plaintext recovery material

---

## 7. Join the Vault From Another Machine

On the second machine:

```bash
keypick setup
```

Choose:

- `Join existing vault`

The wizard will:

1. clone your vault repo
2. check `.sops.yaml`
3. add this machine's public key if needed
4. run `sops updatekeys -y vault.yaml`
5. commit and push the updated recipient list

That machine can now decrypt the vault too.

This is one of KeyPick's biggest advantages over copy-pasted `.env` files: machine access is explicit and revocable.

---

## 8. Use Secrets in Projects

### Export to `.env`

Inside any project directory:

```bash
keypick extract
```

Pick the groups you want. KeyPick writes a `.env` file for that project.

Use this when:

- the project expects a local `.env`
- you want a simple explicit export step
- you do not mind rotating the file manually when secrets change

### Copy a single secret

```bash
keypick copy
```

Use this when:

- a website asks for one API key
- you need to paste a token into a dashboard
- you do not want a whole `.env`

### List secret structure without showing values

```bash
keypick list
```

Use this when:

- you forgot a group name
- you want to see what is stored without exposing values

---

## 9. Use `direnv` for Automatic Project Loading

This is where KeyPick starts feeling powerful.

Instead of generating `.env` files manually every time, use:

```bash
keypick auto Supabase_Prod OpenAI_Personal
```

That prints shell exports. Pair it with `direnv`.

Example `.envrc`:

```bash
eval "$(keypick auto Supabase_Prod OpenAI_Personal)"
```

Then:

```bash
direnv allow
```

Now when you enter the project directory, the environment variables load automatically.

This is one of the best workflows for:

- local development
- switching between projects
- keeping project secrets out of committed files

Important:

- `keypick auto` is non-interactive
- you should use it only in a workflow you control
- it is best when the vault repo and machine are already trusted

---

## 10. Manage Multiple Vaults Explicitly

KeyPick now has explicit vault commands:

```bash
keypick vault list
keypick vault current
keypick vault select
```

### `keypick vault list`

Shows known vault repos.

Use this when:

- you have multiple vaults
- you forgot what vaults exist on disk
- you want to check whether KeyPick sees a newly cloned vault

### `keypick vault current`

Shows the active vault repo.

Use this before:

- `keypick add`
- `keypick extract`
- `keypick copy`

especially when you maintain both personal and work vaults.

### `keypick vault select`

Lets you choose the active vault explicitly.

This should be part of your normal routine if you switch contexts often.

Example:

```bash
keypick vault select
keypick add
```

If `keypick vault select` fails with a message about not being able to create `~/.keypick`, set `KEYPICK_HOME` to a writable location and try again.

### Override per command

If you want one command to use a different vault without changing the active one:

```bash
KEYPICK_VAULT_DIR=/path/to/other-vault keypick list
```

On PowerShell:

```powershell
$env:KEYPICK_VAULT_DIR='C:\Users\you\.keypick\vaults\personal-keys'
keypick list
```

To change KeyPick's default home for remembered state and default vault storage:

```powershell
setx KEYPICK_HOME "$env:USERPROFILE\OneDrive\Documents\KeyPick"
```

---

## 11. A Practical Multi-Project Workflow

Here is a strong real-world setup:

Vaults:

- `~/.keypick/vaults/work-keys`
- `~/.keypick/vaults/personal-keys`

Groups in `work-keys`:

- `OpenAI_Work`
- `Supabase_Prod`
- `Stripe_Test`
- `AWS_Prod`

Groups in `personal-keys`:

- `OpenAI_Personal`
- `Anthropic_Personal`
- `Vercel_Personal`

Project flow:

1. `keypick vault select`
2. choose `work-keys`
3. `cd ~/code/client-app`
4. `keypick extract`
5. select `OpenAI_Work` and `Supabase_Prod`

Better flow with `direnv`:

1. `keypick vault select`
2. choose `work-keys`
3. add this to `.envrc`:

```bash
eval "$(keypick auto OpenAI_Work Supabase_Prod)"
```

This keeps the vault concerns separate from the project concerns.

---

## 12. GitHub Actions Auto Re-Encryption

This is one of the most useful advanced features.

Problem:

- you add a new machine key to `.sops.yaml`
- but `vault.yaml` is still encrypted for the old recipient set

Solution:

- configure `keypick setup actions`

That creates:

- a dedicated Actions `age` key
- a GitHub secret `SOPS_AGE_KEY`
- the workflow file that runs `sops updatekeys`

Why this matters:

- it makes multi-machine recipient updates much smoother
- it reduces the chance you forget to re-encrypt after changing recipients
- it keeps the vault usable as your machine inventory evolves

If you plan to use KeyPick seriously across multiple machines, this is worth doing.

---

## 13. Recovery Key Strategy

Run:

```bash
keypick setup recovery
```

This gives you a recovery key that is separate from your machine keys.

Best practice:

- keep `recovery_key.age` in cloud storage or an offline USB
- keep the passphrase on paper in a physically separate location

Do not store both together.

This is how you avoid "lost laptop + dead desktop = permanent lockout".

If you care about your secrets long-term, this is not optional. It is part of a serious setup.

---

## 14. How to Push KeyPick to Its Limits

### Pattern 1: One vault per trust boundary

Use separate vaults for:

- work
- personal
- consulting / clients
- experimental side projects

This keeps blast radius small and access clean.

### Pattern 2: Stable group naming

Do not invent random names every time.

Good:

- `OpenAI_Work`
- `OpenAI_Personal`
- `Supabase_Prod`
- `Supabase_Staging`

Bad:

- `keys`
- `api stuff`
- `openai new one`

Stable names make `direnv`, automation, and team habits much easier.

### Pattern 3: Treat `.env` as disposable output

The vault is the source of truth.

Your project `.env` should be considered a generated artifact, not the master copy.

### Pattern 4: Use Git history intentionally

Because the vault is a Git repo:

- you get change history
- you can see when secret structure changed
- you can revert mistakes carefully

Do not abuse this, but do use meaningful commit messages.

### Pattern 5: Keep machine keys per machine

Never copy `keys.txt` between machines just to "make it work".

That defeats the whole access model.

Add machines properly through the recipient flow.

---

## 15. Beginner Mistakes to Avoid

- keeping the vault repo inside the KeyPick app repo
- committing plaintext `.env` files
- reusing one `age` private key across multiple machines
- storing both recovery file and recovery passphrase in one place
- forgetting to commit and push after updating `vault.yaml`
- not checking `keypick vault current` before editing secrets

---

## 16. Good Daily Commands

Pick a vault:

```bash
keypick vault select
```

See what is in it:

```bash
keypick list
```

Add or update:

```bash
keypick add
```

Export for a project:

```bash
cd ~/projects/my-app
keypick extract
```

Use with `direnv`:

```bash
keypick auto OpenAI_Work Supabase_Prod
```

Commit changes:

```bash
cd ~/.keypick/vaults/work-keys
git add vault.yaml
git commit -m "Rotate Supabase credentials"
git push
```

---

## 17. Final Recommendation

If you want the cleanest setup:

1. keep KeyPick source code in its own repo
2. keep vault repos under `~/.keypick/vaults/`
3. use `keypick vault select` when switching contexts
4. use `direnv` for projects you touch often
5. configure GitHub Actions and a recovery key once you trust the workflow

That gets you a setup that is simple enough to use daily and disciplined enough to scale across machines.
