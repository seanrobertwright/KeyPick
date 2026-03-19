# KeyPick 🔑

> A cross-platform, biometric-secured CLI for managing reusable API keys across multiple machines.
> Built on **SOPS + age encryption** with a **private Git repo** as the sync backbone.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Private Git Repository                     │
│                                                              │
│   vault.yaml  (SOPS-encrypted, safe to commit)              │
│   .sops.yaml  (recipient list — public keys only)           │
│   .github/workflows/vault-sync.yml  (auto re-encrypt CI)   │
└──────────────────────────┬───────────────────────────────────┘
                           │  git pull / push
          ┌────────────────┼────────────────┐
          │                │                │
    Desktop 1        Desktop 2          Laptop
    age key #1       age key #2        age key #3
          │                │                │
          └────────────────┼────────────────┘
                           │
                    key-pick binary
                    (biometric gate → sops decrypt → interactive menu)
```

**Security layers:**
1. **GitHub auth** — who can `git pull` the encrypted file
2. **age encryption** — who can decrypt the file (each machine has its own private key)
3. **Biometric gate** — Windows Hello / Touch ID before any decryption happens

---

## Prerequisites

Install the following tools on **every machine**:

| Tool | Windows | macOS | Linux |
|------|---------|-------|-------|
| **age** | [Download .zip](https://github.com/FiloSottile/age/releases) | `brew install age` | `apt install age` |
| **sops** | [Download .exe](https://github.com/getsops/sops/releases) | `brew install sops` | `apt install sops` |
| **Rust** | [rustup.rs](https://rustup.rs) | `brew install rust` | `curl https://sh.rustup.rs | sh` |
| **Git** | [git-scm.com](https://git-scm.com) | built-in | `apt install git` |
| **direnv** *(optional)* | `winget install direnv` | `brew install direnv` | `apt install direnv` |

> **Windows PATH tip:** After downloading `age.exe` and `sops.exe`, move them to `C:\Windows\System32\`
> or add their folder to your `PATH` in System Environment Variables.

---

## One-Time Setup (Do This Once Per Machine)

### Step 1 — Generate your machine's age key

```powershell
# Windows
age-keygen -o "$env:APPDATA\sops\age\keys.txt"

# macOS / Linux
age-keygen -o ~/.config/sops/age/keys.txt
```

**The output will look like:**
```
Public key: age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p
```

📋 **Copy and save that public key line** — you'll need it in Step 3.

---

### Step 2 — Create your private secrets repository

1. Go to GitHub and create a **private** repository named `my-keys` (or any name you like).
2. Clone it locally:

```powershell
git clone git@github.com:YOUR_USERNAME/my-keys.git
cd my-keys
```

---

### Step 3 — Configure SOPS with your machine keys

Copy `.sops.yaml` from this repo into your `my-keys` folder, then edit it:

```yaml
# my-keys/.sops.yaml
creation_rules:
  - path_regex: vault\.yaml$
    age: >-
      age1DESKTOP1_PUBLIC_KEY,
      age1DESKTOP2_PUBLIC_KEY,
      age1LAPTOP_PUBLIC_KEY,
      age1GITHUB_ACTIONS_PUBLIC_KEY
```

Replace the placeholders with the public keys from each machine (Step 1).

---

### Step 4 — Create and encrypt the initial vault

```powershell
cd my-keys

# Create an empty vault
echo "services: {}" > vault.yaml

# Encrypt it in-place
sops -e -i vault.yaml

# Commit and push
git add vault.yaml .sops.yaml
git commit -m "feat: initialize encrypted vault"
git push
```

If you `cat vault.yaml` now, it should look like gibberish — that's correct.

---

### Step 5 — Generate a GitHub Actions age key (for auto re-encrypt CI)

```powershell
age-keygen -o github_key.txt
```

1. Add the **public key** from `github_key.txt` to `.sops.yaml` (Step 3).
2. Go to your GitHub repo → **Settings → Secrets and variables → Actions**.
3. Create a secret named `SOPS_AGE_KEY` and paste the **entire contents** of `github_key.txt`.
4. Delete `github_key.txt` from your local machine after adding the secret.

Copy the `.github/workflows/vault-sync.yml` file from this repo into your `my-keys` repo.

---

### Step 6 — Build key-pick

```powershell
cd E:\Projects\KeyPick
cargo build --release
```

The binary will be at `target\release\key-pick.exe`.

**Add it to your PATH** (run once, then restart your shell):
```powershell
Copy-Item .\target\release\key-pick.exe C:\Windows\System32\
```

---

## Daily Usage

### Run interactively (no arguments)

```powershell
key-pick
```

You'll see a Windows Hello / fingerprint prompt, then a menu:
```
? What would you like to do?
> Extract keys to .env
  Add / Update a key group
  List vault contents
  Copy a key to clipboard
  Exit
```

---

### Add a new service group

```powershell
key-pick add
```

**Example session:**
```
Select a group: [ + New Group ]
Service/Group name: Supabase_Prod

Adding keys to group: Supabase_Prod

Key Name  : DB_HOST
Value for DB_HOST: db.xxxxx.supabase.co
✓ Added: DB_HOST

Add another? Y

Key Name  : DB_PASSWORD
Value for DB_PASSWORD: ••••••••••••
✓ Added: DB_PASSWORD

Add another? N

✓ Vault updated successfully.
Remember to sync: git add vault.yaml && git commit -m "Update Supabase_Prod" && git push
```

---

### Extract keys to a project's .env file

```powershell
cd my-project
key-pick extract
```

**Example session:**
```
Select the groups to extract (Space to toggle, Enter to confirm):
> [x] Supabase_Prod
  [ ] Google_AI
  [ ] Anthropic

✓ 3 keys from 1 group(s) written to .env
⚠ Add .env to your .gitignore so secrets are never committed.
```

The generated `.env`:
```env
# --- Supabase_Prod ---
DB_HOST=db.xxxxx.supabase.co
DB_PASSWORD=secret
SUPABASE_SECRET=service_role_key_abc
```

---

### List vault contents (values hidden)

```powershell
key-pick list
```

```
Vault Contents (values hidden):

◆ Google_AI
    · API_KEY
    · PROJECT_ID

◆ Supabase_Prod
    · DB_HOST
    · DB_PASSWORD
    · SUPABASE_SECRET

→ 2 group(s), 5 key(s) total.
```

---

### Copy a single key to clipboard (never touches disk)

```powershell
key-pick copy
```

Great for pasting into a browser or another tool without creating a `.env` file.

---

## Automatic Shell Injection with direnv

`direnv` automatically loads and unloads environment variables when you enter/leave a project folder.

### Setup (one-time)

**Windows PowerShell** — add to your `$PROFILE`:
```powershell
Invoke-Expression "$(direnv hook pwsh)"
```

**macOS / Linux** — add to your `~/.zshrc` or `~/.bashrc`:
```bash
eval "$(direnv hook bash)"   # or zsh
```

### Per-project configuration

Create a `.envrc` file in your project root:
```bash
# .envrc
# This tells direnv to call key-pick and inject the listed groups
eval $(key-pick auto Supabase_Prod Google_AI)
```

Then allow it once:
```powershell
direnv allow
```

**Now:** When you `cd` into this project, the keys appear as environment variables automatically.
When you `cd` out, they vanish from your shell session.

> ⚠ **Note:** `key-pick auto` skips the biometric gate for non-interactive shell use.
> Your git repo and age key encryption still protect the data at rest.

---

## Syncing Between Machines

```powershell
# Pull latest keys from any machine
cd my-keys
git pull

# After adding/updating keys, push them
git commit -am "Update Google_AI keys"
git push
```

The GitHub Action (`vault-sync.yml`) automatically re-encrypts `vault.yaml` whenever `.sops.yaml` changes.
This means adding a new machine is as easy as:
1. Generate the machine's age key (Step 1)
2. Add its public key to `.sops.yaml`
3. `git push` → GitHub does the rest

---

## Recovery Key (Emergency Access)

If you lose all three machines, use this procedure to regain access.

### Create a recovery key (do this once)

```powershell
# Generate a key and immediately encrypt it with a passphrase
age-keygen | age -p > recovery_key.age
```

It will prompt for a passphrase. **Make it strong and memorable.**

### Add recovery key to vault

```powershell
# View the public key inside your encrypted recovery file
age --decrypt recovery_key.age | grep "public key"
```

Add that public key to `.sops.yaml` and push. The GitHub Action will authorize it.

### Store the recovery key

| Copy | Location |
|------|----------|
| `recovery_key.age` (encrypted) | Google Drive |
| Passphrase | Written on paper in a safe location |

> 💡 **The encrypted file is useless without the passphrase.** Storing them separately means both have to be compromised simultaneously.

### Using the recovery key

```powershell
# On a fresh machine with age + sops installed:
age -d recovery_key.age > temp_key.txt
SOPS_AGE_KEY_FILE=temp_key.txt key-pick list

# Delete the temp key when done
Remove-Item temp_key.txt
```

---

## File Reference

```
key-pick/                       ← This Rust project
├── Cargo.toml                  ← Dependencies
├── .sops.yaml                  ← Copy to your secrets repo
├── .gitignore
├── .github/
│   └── workflows/
│       └── vault-sync.yml     ← Copy to your secrets repo
└── src/
    ├── main.rs                 ← Entry point + CLI parsing
    ├── auth.rs                 ← Cross-platform biometric module
    ├── vault.rs                ← SOPS encrypt/decrypt + data types
    └── commands/
        ├── mod.rs
        ├── add.rs              ← `key-pick add`
        ├── extract.rs          ← `key-pick extract`
        ├── list.rs             ← `key-pick list`
        ├── copy.rs             ← `key-pick copy`
        ├── auto_export.rs      ← `key-pick auto` (for direnv)
        └── interactive.rs      ← No-argument menu mode

my-keys/                        ← Your private Git repo (separate)
├── .sops.yaml                  ← SOPS recipient list
├── vault.yaml                  ← Encrypted secrets (safe to commit)
└── .github/
    └── workflows/
        └── vault-sync.yml      ← Auto re-encryption CI
```

---

## Security Notes

- `vault.yaml` is safe to store in a private Git repo. Without an authorized `age` private key, it is unreadable.
- `.env` files generated by `key-pick extract` **must never be committed** — they are excluded by `.gitignore`.
- The biometric check (`Windows Hello / Touch ID`) protects the decryption step locally.
- The `key-pick auto` mode (for direnv) skips biometrics — only use this on trusted, full-disk-encrypted machines.
