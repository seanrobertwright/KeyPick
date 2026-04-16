# KeyPick — Next Steps

> Follow these steps **in order** to get KeyPick running across your machines.

> [!TIP]
> If this machine blocks writes to `C:\Users\you\.keypick`, set a writable KeyPick home first:
>
> ```powershell
> setx KEYPICK_HOME "$env:USERPROFILE\OneDrive\Documents\KeyPick"
> ```
>
> Then open a new shell before continuing.

---

## Phase 1: Install Prerequisites (All 3 Machines)

### 1. Install `age` (encryption engine)

Download the latest release from [github.com/FiloSottile/age/releases](https://github.com/FiloSottile/age/releases).

- Grab the `age-v*-windows-amd64.zip`
- Extract `age.exe` and `age-keygen.exe`
- Move both to `C:\Windows\System32\` (or any folder on your `PATH`)

Verify:
```powershell
age --version
```

### 2. Install `sops` (encrypted file manager)

Download from [github.com/getsops/sops/releases](https://github.com/getsops/sops/releases).

- Grab `sops-v*-windows.amd64.exe`
- Rename it to `sops.exe`
- Move to `C:\Windows\System32\` (or any folder on your `PATH`)

Verify:
```powershell
sops --version
```

### 3. Generate your machine's age key

Run this on **each** of your 3 machines:

```powershell
# Create the directory if it doesn't exist
New-Item -ItemType Directory -Path "$env:APPDATA\sops\age" -Force

# Generate the key
age-keygen -o "$env:APPDATA\sops\age\keys.txt"
```

You'll see output like:
```
Public key: age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p
```

> [!IMPORTANT]
> **Write down or copy each machine's public key.** You need all 3 public keys for the next phase.

---

## Phase 2: Create Your Secrets Repository

### 4. Create a private GitHub repo

1. Go to [github.com/new](https://github.com/new)
2. Name it something like `my-keys` or `vault`
3. Set it to **Private**
4. Do **not** initialize with a README (you'll push from local)

### 5. Clone it into KeyPick's vault home and set up the SOPS config

```powershell
New-Item -ItemType Directory -Path "$HOME\.keypick\vaults" -Force
Set-Location "$HOME\.keypick\vaults"
git clone git@github.com:YOUR_USERNAME/my-keys.git
cd my-keys
```

Create a `.sops.yaml` file with your 3 machine public keys:

```yaml
# .sops.yaml
creation_rules:
  - path_regex: vault\.yaml$
    age: >-
      age1DESKTOP1_PUBLIC_KEY,
      age1DESKTOP2_PUBLIC_KEY,
      age1LAPTOP_PUBLIC_KEY
```

> [!TIP]
> Replace each placeholder with the actual public key from that machine (Step 3).

### 6. Create and encrypt the initial vault

```powershell
# Create an empty vault
echo "services: {}" > vault.yaml

# Encrypt it in-place using your .sops.yaml config
sops -e -i vault.yaml

# Verify it's encrypted (should be gibberish)
cat vault.yaml
```

### 7. Push it

```powershell
git add .sops.yaml vault.yaml
git commit -m "feat: initialize encrypted vault"
git push -u origin main
```

---

## Phase 3: Deploy keypick

### 8. Install keypick

```powershell
bun install -g keypick
```

Verify:
```powershell
keypick --version
```

### 10. Clone the secrets repo on your other machines

On Desktop 2 and your Laptop:
```powershell
Set-Location "$HOME\.keypick\vaults"
git clone git@github.com:YOUR_USERNAME/my-keys.git
```

Then copy `keypick.exe` to each machine (via Google Drive, USB, or build from source on each).

---

## Phase 4: Add Your First Keys

### 11. Select your vault and run keypick

```powershell
keypick vault select
keypick add
```

Follow the wizard:
1. **Windows Hello prompt** → verify fingerprint/face
2. **Select group** → `[ + New Group ]`
3. **Name** → e.g. `Supabase_Prod`
4. **Key Name** → `DB_HOST`
5. **Value** → paste the value
6. **Add another?** → repeat for `DB_PASSWORD`, `SUPABASE_SECRET`, etc.

### 12. Commit and push the updated vault

```powershell
git add vault.yaml
git commit -m "Add Supabase_Prod keys"
git push
```

### 13. Pull on your other machines

```powershell
cd "$HOME\.keypick\vaults\my-keys"
git pull
keypick list   # Verify the keys are there
```

---

## Phase 5: Set Up GitHub Actions Auto Re-Encryption

### 14. Generate a GitHub Actions age key

```powershell
age-keygen -o github_key.txt
```

Copy the **public key** (starts with `age1...`).

### 15. Add the public key to `.sops.yaml`

Add it as a 4th recipient:
```yaml
creation_rules:
  - path_regex: vault\.yaml$
    age: >-
      age1DESKTOP1_PUBLIC_KEY,
      age1DESKTOP2_PUBLIC_KEY,
      age1LAPTOP_PUBLIC_KEY,
      age1GITHUB_ACTIONS_PUBLIC_KEY
```

### 16. Add the private key to GitHub Secrets

1. Go to your `my-keys` repo on GitHub
2. **Settings → Secrets and variables → Actions**
3. Create a new secret named `SOPS_AGE_KEY`
4. Paste the **entire contents** of `github_key.txt` (both the comment line and the `AGE-SECRET-KEY-...` line)

### 17. Copy the workflow file

Copy `.github/workflows/vault-sync.yml` from `E:\Projects\KeyPick` into your `my-keys` repo.

```powershell
# From inside $HOME\.keypick\vaults\my-keys
mkdir -p .github/workflows
copy E:\Projects\KeyPick\.github\workflows\vault-sync.yml .github\workflows\
git add .github .sops.yaml
git commit -m "Add auto re-encryption workflow"
git push
```

### 18. Delete the local GitHub key file

```powershell
Remove-Item github_key.txt
```

> [!CAUTION]
> Do not keep `github_key.txt` on your machine. The private key now lives only in GitHub Secrets.

---

## Phase 6: Set Up Recovery Key (Emergency Backup)

### 19. Generate a passphrase-protected recovery key

```powershell
age-keygen | age -p > recovery_key.age
```

Enter a strong, memorable passphrase when prompted.

### 20. Extract the recovery public key

```powershell
age --decrypt recovery_key.age | age-keygen -y
```

Add this public key to `.sops.yaml` as another recipient, then push.

### 21. Store the recovery key safely

| What | Where |
|------|-------|
| `recovery_key.age` (encrypted file) | Upload to Google Drive |
| Passphrase | Write on paper, store in a safe/lockbox |

> [!WARNING]
> Store the file and the passphrase in **separate physical locations**. Both are needed to recover.

---

## Phase 7: Optional — direnv Auto-Injection

### 22. Install direnv

```powershell
winget install direnv.direnv
```

### 23. Hook it into PowerShell

Add this line to your `$PROFILE`:
```powershell
Invoke-Expression "$(direnv hook pwsh)"
```

### 24. Create a `.envrc` in any project

```bash
# my-project/.envrc
eval $(keypick auto Supabase_Prod Google_AI)
```

Then authorize it once:
```powershell
direnv allow
```

Now every `cd` into that project auto-injects the keys. Every `cd` out removes them.

---

## Quick Reference Card

| Task | Command |
|------|---------|
| Interactive menu | `keypick` |
| Show known vaults | `keypick vault list` |
| Show current vault | `keypick vault current` |
| Select current vault | `keypick vault select` |
| Add keys to a group | `keypick add` |
| Extract groups to .env | `keypick extract` |
| List groups (values hidden) | `keypick list` |
| Copy one key to clipboard | `keypick copy` |
| direnv auto-export | `keypick auto Group1 Group2` |
| Sync to other machines | `git pull` / `git push` |
