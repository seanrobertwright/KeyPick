# Approval gating in secret CLIs

Research for issue #10, a child of the wayfinder map (#9). It feeds the decision ticket #17, "How does approval work: what is unlocked, for how long, and where is it held?". Researched 2026-10-10.

## Question

How do established secret tools gate non-interactive access to secret values and cache a human approval? Can another process running as the same OS user reuse or forge that cached approval?

For each tool, this note answers four questions. What does one approval cover: one call, a process tree, a terminal session, or a time window? Where does the approval live? How long does it last? What can a same-user process do with it?

## Summary

- **Approvals bind to one of three things.** The first is a *context label*, such as a terminal, a parent PID, or a login session (sudo, 1Password CLI, polkit). The second is a *capability*, such as access to a socket, a token in a keystore or environment variable, or an unlocked keyring (gpg-agent, ssh-agent, Doppler, Infisical, aws-vault, Credential Manager, Secret Service). The third is a *per-use cryptographic operation* that hardware or the OS gates (Secure Enclave access control, Windows Hello keys, YubiKey touch). Only the third holds up against a same-user process. With the other two, any same-user process that can enter the context or reach the capability can reuse the approval.
- **Context labels are not secrets.** sudo's default ticket is keyed to the terminal and lasts 5 minutes. 1Password CLI's biometric session is keyed to the tty plus its start time on macOS and Linux, and lasts 10 minutes idle and 12 hours at most. Any process that shares the terminal inherits the approval. That includes an AI agent started from that terminal, and every command the agent spawns. For sudo this is confirmed in the source, because it reads the *controlling* tty. For 1Password it is inferred. Neither approval can be *forged* from elsewhere. sudo keeps its records in a root-owned directory, and 1Password's docs imply its desktop app holds the state, since locking the app revokes every authorization.
- **Agent caches are per user, not per caller.** gpg-agent caches an unlocked key for every client of its socket for 10 minutes idle (2 hours at most). ssh-agent keeps keys forever by default and serves any peer with the same uid. `ssh-add -c` is the only surveyed mechanism that confirms *every* use and caches nothing.
- **Token-based CLIs have no per-access gate.** Doppler, Infisical, and aws-vault trade one login for a long-lived token or master key in the OS keystore. Any same-user process can run the CLI, or print the token outright with `doppler configure get token --plain`. Apart from MFA, the only prompt aws-vault adds is unlocking its macOS keychain after the keychain locks for inactivity. It limits damage by issuing short-lived STS credentials (1 hour by default), not by gating access.
- **OS keystores split three ways.** Windows Credential Manager lets any process of the user read generic credentials without a prompt. gnome-keyring calls app-to-app separation inside a session "security theater". The macOS file-based keychain prompts each new app (Allow, Always Allow, or Deny). Only the macOS data protection keychain can demand biometry on *each* read, and the Secure Enclave enforces it. That keychain needs code-signing entitlements and a provisioning profile, which a plain CLI does not have.
- **A UI-only biometric check gates nothing.** `UserConsentVerifier`, a bare `LAContext.evaluatePolicy`, and `pkexec /bin/true` each return pass or fail to the caller. KeyPick's `verify()` in `ts/src/lib/auth.ts` is this kind of check on every platform. The age identity sits in a plaintext `keys.txt`, so a same-user process can skip KeyPick and run `sops -d` itself.
- **Short reuse windows exist mostly in hardware and the OS.** A YubiKey with the "cached" touch policy stays usable for 15 seconds after a touch. Touch ID can reuse a recent *device unlock* for up to 5 minutes. polkit's `auth_*_keep` lasts 300 seconds for the subject process. These are the clearest precedents for a short, scoped unlock window.
- **For KeyPick, only per-call decryption bound to hardware or the OS stops a same-terminal agent.** A cached approval of any kind, whether a ticket, a broker, or a token, shortens how long an agent can reuse it but does not shut the agent out. And no approval design matters while the age identity stays readable in plaintext.

## Same-user baseline

What another process running as the same user can generally do, which every row below depends on:

- **Run the same binary.** If the gate is "this CLI is trusted", the attacker runs that CLI. Keychain ACLs, the 1Password socket's GID check, and aws-vault's keychain trust all reduce to this.
- **Read environment variables of other processes**, on some platforms. 1Password's own docs say: "You should assume that processes on your computer can access the environment of other processes run by the same user." ([1Password: secrets as environment variables](https://www.1password.dev/cli/secrets-environment-variables/))
- **Debug other processes and read their memory.** The Linux Yama docs state that "a single user is able to examine the memory and running state of any of their processes". They note that "some applications use `prctl(PR_SET_DUMPABLE, ...)` to specifically disallow such ptrace attachment (e.g. ssh-agent), but many do not". With `ptrace_scope=1`, attaching is limited to descendants. ([Linux Yama](https://www.kernel.org/doc/html/latest/admin-guide/LSM/Yama.html)) ssh-agent turns off tracing, and gpg-agent turns off core dumps (see their sections).
- **Connect to user-owned sockets and pipes.** The OpenSSH man page says the agent socket "is accessible only to the current user, but is easily abused by root or another instance of the same user." ([ssh-agent(1)](https://man.openbsd.org/ssh-agent.1))

"Reuse" below means using an approval that already exists. "Forge" means creating one without the human.

## Comparison

| Tool | What one approval covers | Where it lives | How long | What a same-user process can do |
| --- | --- | --- | --- | --- |
| 1Password CLI, biometric | One account in one terminal session. macOS and Linux: tty plus start time, sub-shells included. Windows: the invoking PID plus start time, so sub-shells need their own approval | The 1Password desktop app (implied; the docs don't say outright) | 10 min, renewed on each use; 12 h hard limit; revoked when the app locks | Anything on the same tty runs `op` without a prompt. The docs describe no way to reuse it from another tty. The vendor says root and macOS apps with accessibility permission may get around it |
| 1Password CLI, manual sign-in | The shell holding the session token | Encrypted key on disk plus a wrapper key in the shell's environment | 30 min idle | Vendor: "any process running under the current user can, on some platforms, potentially access your 1Password account" |
| `op run` / `op inject` | One run, under whichever approval is active | Values sit in the child's environment (`run`) or a plaintext file (`inject -o`) | The child's life, or until the file is deleted | The child sees plaintext. Masking covers only stdout and stderr |
| aws-vault | No per-access approval: unlocking the keystore, plus MFA if configured | Master credentials in the OS keystore (by default on macOS, a dedicated `aws-vault` keychain). The STS session is cached there too | Keychain locks after a user-set idle time. STS session tokens last 1 h by default | Runs `aws-vault exec`/`export` while the keychain is unlocked. `--ec2-server` serves credentials to any local app |
| sudo | Commands from the same terminal (`tty`, the default), the same parent (`ppid`), or every session (`global`) | Root-owned files under `/var/run/sudo/ts` | 5 min by default | Any process whose *controlling* terminal is that tty runs `sudo -n` without a password. Can't write the record |
| ssh-agent, `ssh-add -c` | One signature | No cache. The agent holds the keys and asks through `ssh-askpass` each time | Keys stay forever unless `-t` is set. Confirmation is per use | Can connect and ask for signatures. With `-c`, the user sees a prompt every time; without it, use is silent |
| gpg-agent | One key, for every client of that agent | The agent's memory, one agent per user and home directory | 600 s, renewed on use; 7200 s at most (SSH keys: 1800 s and 7200 s) | Decrypts or signs without a prompt during the window |
| Doppler `run` | No per-access approval; one browser login | CLI token in the OS keychain (macOS, Windows); scope in `.doppler.yaml`; encrypted fallback snapshot | Token expiry not documented (unverified) | Runs `doppler run -- env`, or prints the token, which has all of the user's permissions |
| Infisical `run` | No per-access approval; one login | System keyring, or a `file` vault whose random passphrase sits in the CLI's config file | Session expiry not documented (unverified) | Runs `infisical run`/`export`; with the `file` vault, reads both files and decrypts |
| macOS file-based keychain | Per item and per app. "Always Allow" adds the app permanently | The item's ACL inside the keychain file | Unlocked until the keychain locks; ACL entries last forever | Runs an app that is already trusted (for example `security`, when it is on the ACL). An untrusted caller gets a prompt |
| macOS data protection keychain with `SecAccessControl` | Each read of the item | The Secure Enclave evaluates the policy and gates the item | Per read. The reuse setting covers only a recent *device unlock*, up to 5 min | Can't read without the user's biometry or passcode |
| Windows Credential Manager (generic credentials) | Nothing is asked | Per-user store tied to the logon session | Persistent | Reads any generic credential with `CredRead` |
| Windows Hello `UserConsentVerifier` | Nothing; it returns a result value | The caller's memory | Instant | Doesn't need to call it at all |
| Windows Hello key (`KeyCredential`) | One operation with a key that Hello protects | Windows Hello (Passport key storage provider) | Per operation. Caching of the gesture is under-documented (unverified) | Can't use the key without the gesture |
| Secret Service (gnome-keyring, libsecret) | One collection unlock, usually the login keyring at login | The keyring daemon | Until locked | Reads every unlocked item. The spec requires no access control |
| polkit (`pkexec`) | One action for one subject process | polkitd's memory | `auth_*_keep`: 300 s for that process. `pkexec` defaults to `auth_admin`, which keeps nothing | Gets only the pass/fail exit code |
| YubiKey PIV (age-plugin-yubikey) | One private-key operation | YubiKey firmware | Touch policy "cached" is 15 s; PIN policy "once" lasts the PIV session | Any process that can reach the token may use it within those 15 s; after that, it needs a physical touch |
| age-plugin-se | One decryption | Secure Enclave access control | Per use | Can't decrypt without biometry or passcode |

## Per-tool notes

### 1Password CLI (`op`, `op run`, `op inject`)

- **Scope:** "Authorization in 1Password CLI occurs on a per-account basis." On macOS and Linux, "authorization is confined to a terminal session but extends to sub-shell processes in that window." On Windows, "commands executed in a sub-shell require separate authorization." ([app integration security](https://www.1password.dev/cli/app-integration-security/))
- **Session identity:**
  - macOS and Linux: "an ID that's based on the current `tty`, plus the start time".
  - Windows: "an ID that's based on the PID of the process that invokes 1Password CLI, plus the start time".
  - "These credentials don't consist of any sensitive or secret information." ([same page](https://www.1password.dev/cli/app-integration-security/))
- **Lifetime:** "a 10-minute session that automatically refreshes on each use". "There's a hard limit of 12 hours". "When the 1Password app is locked, all prior authorization is revoked." A process already running when authorization ends "will be able to finish its task and exit." ([same page](https://www.1password.dev/cli/app-integration-security/))
- **Where it lives and how the CLI is authenticated:** The docs never say outright where the authorization state is kept. They imply the desktop app holds it, since locking the app revokes all authorization and the CLI reaches the app over IPC.
  - macOS: XPC, with "Authenticity of both is confirmed by verifying the code signature".
  - Linux: a Unix socket "owned by the current user/group, allowing any process started by this user to connect to it". The app then checks that the caller's GID is the `onepassword-cli` group.
  - Windows: a named pipe, with the caller's Authenticode signature verified.
  - The vendor also states: "Applications that are granted accessibility permissions on macOS may be able to circumvent the authorization prompt". ([same page](https://www.1password.dev/cli/app-integration-security/))
- **Manual sign-in:** "1Password CLI stores your session key encrypted on disk and the random wrapper key used in the environment of the current shell". "Sessions expire after 30 minutes of inactivity". "any process running under the current user can, on some platforms, potentially access your 1Password account." ([sign in manually](https://www.1password.dev/cli/sign-in-manually/))
- **`op run`:** It runs the command "in a subprocess with the secrets made available as environment variables". "Secrets printed to stdout or stderr are concealed by default". `--no-masking` turns this off. ([op run guide](https://www.1password.dev/cli/secrets-environment-variables/), [op run reference](https://www.1password.dev/cli/reference/commands/run/))
- **`op inject`:** It writes the resolved plaintext into the output file, and the docs warn: "Make sure to delete the resolved config file when you no longer need it." ([load secrets into config files](https://www.1password.dev/cli/secrets-config-files/))
- **Same-user reading:** Another process can't create a session; it has to *be* in the authorized tty. On Linux, sudo finds the tty from the *controlling terminal* (`tty_nr` in `/proc/self/stat`), not from stdin ([sudo `ttyname.c`](https://github.com/sudo-project/sudo/blob/main/src/ttyname.c)). If 1Password identifies "the current tty" the same way, an agent started in an authorized terminal, and every command it runs, is inside the session. That last step is an inference; 1Password's docs don't say how they derive the tty.

### aws-vault

- **Maintenance:** The original project's README now says: "This project has been abandoned and it's not receiving any more updates", and points to the [ByteNess fork](https://github.com/ByteNess/aws-vault). ([99designs/aws-vault](https://github.com/99designs/aws-vault))
- **How it gates:** aws-vault "stores IAM credentials in your operating system's secure keystore". It then uses STS (`GetSessionToken` or `AssumeRole`) to mint temporary credentials and passes them to the subprocess as environment variables, or through a local metadata server with `--server`. ([README](https://github.com/99designs/aws-vault))
- **Approval and caching:**
  - On macOS the keystore is a dedicated `aws-vault` keychain, and users set the prompt interval with Keychain Access's "Lock after X minutes of inactivity".
  - The `GetSessionToken` result "is cached in the backend vault and can be used to assume roles from different profiles without further MFA prompts".
  - Defaults: `AWS_SESSION_TOKEN_TTL` 1h and `AWS_ASSUME_ROLE_TTL` 1h. ([USAGE](https://github.com/99designs/aws-vault/blob/master/USAGE.md))
  - The keyring configuration sets `KeychainTrustApplication: true`, so the aws-vault binary is on the item ACL. ([cli/global.go](https://github.com/99designs/aws-vault/blob/master/cli/global.go))
- **Same-user reading:** While the keychain is unlocked, any same-user process can run `aws-vault exec <profile> -- env`. No prompt appears, because aws-vault itself is the trusted app. The docs say this about `--ec2-server` directly: "while this `aws-vault` server runs, any application wanting to connect to AWS will be able to do so". `--ecs-server` adds an authorization token that "is only exposed to the subprocess via environment variables". ([USAGE](https://github.com/99designs/aws-vault/blob/master/USAGE.md))
- **Biometrics in the fork:** The fork adds a `--biometrics` flag ([ByteNess cli/global.go](https://github.com/ByteNess/aws-vault/blob/main/cli/global.go)). On macOS its keyring library calls Touch ID (`touchid.Authenticate`), then reads the aws-vault keychain password from a login-keychain item and unlocks the keychain. That is a UI gate in front of a stored password ([byteness/keyring `keychain_macos.go`](https://github.com/byteness/keyring/blob/main/keychain_macos.go)). The Windows backend is different. It stores items in Windows Credential Manager, encrypted with a key held by the Windows Hello Passport key storage provider, created with decrypt-only usage and an NGC "cache type: auth mandatory" property, so the gesture gates each decryption ([byteness/keyring `winhello/passport.go`](https://github.com/byteness/keyring/blob/main/winhello/passport.go)). That property doesn't appear in Microsoft's public property list ([key storage property identifiers](https://learn.microsoft.com/en-us/windows/win32/seccng/key-storage-property-identifiers)). What it does is unverified.

### sudo timestamps and tty tickets

- **Lifetime:** `timestamp_timeout`: "The default is 5." ([sudoers(5)](https://www.sudo.ws/docs/man/sudoers.man/))
- **Scope (`timestamp_type`, default `tty`):**
  - `tty`: "One time stamp record is used for each terminal". "If no terminal is present, the behavior is the same as ppid."
  - `ppid`: "all processes with the same parent process ID (usually the shell)".
  - `global`: covers all of a user's login sessions.
  - `kernel`: stores the timestamp "in the kernel as an attribute of the terminal device", on OpenBSD only. `tty_tickets` has been superseded. ([sudoers(5)](https://www.sudo.ws/docs/man/sudoers.man/))
- **Record contents:** auth uid, terminal session ID, "the start time of the session leader", the tty device number, and a monotonic time stamp. ([sudoers_timestamp(5)](https://www.sudo.ws/docs/man/sudoers_timestamp.man/))
- **Where it lives:** `timestampdir` defaults to `/var/run/sudo/ts`, owned by root. sudoers ignores the directory "if it is not owned by root or if it is writable by a user other than root". The man page warns that with older `/tmp` storage "it may be possible for a user to create the time stamp themselves". ([sudoers(5)](https://www.sudo.ws/docs/man/sudoers.man/))
- **Same-user reading:** No user process can forge a record. Reuse is exactly "Commands run from the same terminal will not require a password for timestamp_timeout minutes". On Linux, the terminal is the controlling tty from `/proc/self/stat` ([`ttyname.c`](https://github.com/sudo-project/sudo/blob/main/src/ttyname.c)). So an agent's subprocess with redirected stdin and stdout still matches, unless it calls `setsid` or is started from another terminal.

### ssh-agent and `ssh-add -c`

- **`-c`:** "Indicates that added identities should be subject to confirmation before being used for authentication." Confirmation runs through `ssh-askpass`. ([ssh-add(1)](https://man.openbsd.org/ssh-add.1)) In the source, every signing request on a confirm-flagged key calls `confirm_key` → `ask_permission` ("Allow use of key %s?"). Nothing is cached. ([`ssh-agent.c`](https://github.com/openssh/openssh-portable/blob/master/ssh-agent.c), [`readpass.c`](https://github.com/openssh/openssh-portable/blob/master/readpass.c))
- **Lifetime:** "Without this option the default maximum lifetime is forever"; `ssh-add -t` sets a lifetime per key. ([ssh-agent(1)](https://man.openbsd.org/ssh-agent.1), [ssh-add(1)](https://man.openbsd.org/ssh-add.1))
- **Who can connect:** The agent accepts a peer only if `euid == 0` or it matches the agent's uid (`getpeereid` check in `ssh-agent.c`). It calls `platform_disable_tracing`, which uses `PR_SET_DUMPABLE` or `PT_DENY_ATTACH`, so same-user debuggers can't read its memory. ([`ssh-agent.c`](https://github.com/openssh/openssh-portable/blob/master/ssh-agent.c), [`platform-tracing.c`](https://github.com/openssh/openssh-portable/blob/master/platform-tracing.c)) The agent returns signatures, not keys: "Authentication passphrases and private keys never go over the network." ([ssh-agent(1)](https://man.openbsd.org/ssh-agent.1))
- **Same-user reading:** Any same-user process can request a signature. Without `-c` the request succeeds silently. With `-c`, the human sees a prompt for each request. The remaining risk is that a well-timed request gets approved by mistake, or that something injects input into the prompt.

### gpg-agent

- **Lifetime:** `--default-cache-ttl` is 600 seconds; "Each time a cache entry is accessed, the entry's timer is reset." `--max-cache-ttl` is 7200 seconds. The SSH equivalents are 1800 and 7200 seconds. ([Agent Options](https://www.gnupg.org/documentation/manuals/gnupg/Agent-Options.html), constants `DEFAULT_CACHE_TTL` and `MAX_CACHE_TTL` in [`gpg-agent.c`](https://github.com/gpg/gnupg/blob/master/agent/gpg-agent.c))
- **Scope:** The cache belongs to the agent process, not to a terminal or caller. Unlocked keys are cached by keygrip (`CACHE_MODE_NORMAL`). Any client on the standard socket can then decrypt or sign without a prompt until the TTL runs out. `GET_PASSPHRASE` with a cache ID "returns a cached passphrase". When that command arrives on a restricted socket, such as the extra socket, the source says "we don't consider the cache". ([GET_PASSPHRASE](https://www.gnupg.org/documentation/manuals/gnupg/Agent-GET_005fPASSPHRASE.html), [`agent/command.c`](https://github.com/gpg/gnupg/blob/master/agent/command.c))
- **Hardening knobs:**
  - `--ignore-cache-for-signing`.
  - `--allow-preset-passphrase`: with it, `gpg-preset-passphrase` can seed the cache without a prompt.
  - Loopback pinentry, on by default: lets clients supply the passphrase themselves.
  - `--grab`, which "should be used on X-Servers to avoid X-sniffing attacks". ([Agent Options](https://www.gnupg.org/documentation/manuals/gnupg/Agent-Options.html))
  - The agent calls `disable_core_dumps()` at startup ([`gpg-agent.c`](https://github.com/gpg/gnupg/blob/master/agent/gpg-agent.c)).

### Doppler `run`

- **Approval:** There is no per-access approval. "The Doppler CLI requires an API key for authentication", which you get through `doppler login` or a service token. `doppler run` puts secrets into the child's environment. ([CLI guide](https://docs.doppler.com/docs/cli))
- **Where the token lives:** "By default, when you use `doppler login` on MacOS or Windows, the CLI token that's received is stored in the OS keychain". "A CLI token is highly privileged (it has all permissions your Doppler user has)". ([multiple workplaces](https://docs.doppler.com/docs/multiple-workplaces)) Login can be scoped to a directory tree, so that applications in that tree "automatically use the correct API key". The docs present this as a convenience for working with several workplaces, not as a security boundary. ([CLI guide](https://docs.doppler.com/docs/cli))
- **Same-user reading:**
  - `doppler configure get token --plain` prints the token "being used in your local shell". ([CLI guide](https://docs.doppler.com/docs/cli))
  - `doppler run` also writes an encrypted fallback snapshot of the secrets, which by default "can only be decrypted when using the same Doppler token". ([fallback files](https://docs.doppler.com/docs/automatic-fallbacks))
  - So any same-user process that can run the CLI has the user's full Doppler access.
- **Narrower delivery:** `--mount` exposes secrets as a named pipe that "is automatically cleaned up when the Doppler process exits". `--mount-max-reads` caps how many times it can be read. ([accessing secrets](https://docs.doppler.com/docs/accessing-secrets))
- **Token expiry:** Unverified. A Doppler community answer says CLI login tokens don't expire; I found no primary doc.

### Infisical `run`

- **`run`:** It "fetches the secrets for the project linked in `.infisical.json`" and injects them into the child's environment. Authentication is the user's login by default, or `--token` / `INFISICAL_TOKEN` for a machine identity. ([CLI reference: run](https://infisical.com/docs/cli/reference#run))
- **Storage:** `auto` (the default) "uses your system keyring: the macOS Keychain, Windows Credential Manager, or the Secret Service on Linux". The CLI falls back to `file` on its own if the keyring is unusable. `file` stores credentials encrypted in `~/infisical-keyring`, and the random passphrase sits in `~/.infisical/infisical-config.json`. ([CLI reference: vault](https://infisical.com/docs/cli/reference#vault))
- **Same-user reading:** There is no per-access approval. Any same-user process can run `infisical run` or `infisical export`. With the `file` vault, it can read both files and decrypt the credentials. Session lifetime isn't documented in the pages I read (unverified).

### macOS Keychain

- **File-based keychain ACLs:**
  - "If there is an entry that lists the operation, the system checks whether the calling app is among the entry's trusted apps. If so, the system grants access. Otherwise, the system prompts the user". "Always Allow" adds the app to the trusted list "enabling the app to gain access in the future without prompting the user again." ([Access Control Lists](https://developer.apple.com/documentation/security/access-control-lists))
  - The `security` tool can create items with `-T appPath` (trust an app) or `-A` ("Allow any application to access this item without warning (insecure, not recommended!)"). ([security(1) source](https://github.com/apple-oss-distributions/Security/blob/main/SecurityTool/macOS/security.1))
  - So a CLI that stores secrets through `security` and trusts `/usr/bin/security` lets every same-user process read them through `security`.
- **Data protection keychain:**
  - Its access control is "keychain access groups, supplemented by an optional access control object (SecAccessControl)". The access groups come from code-signing entitlements, which "must be authorized by a provisioning profile". "Your program needs an app-like bundle structure in which to embed that profile. This is standard for app and app extensions but not for command-line tools."
  - "Protecting an item with biometrics (Touch ID and Face ID)" needs the data protection keychain. The file-based keychain "is on the road to deprecation". ([TN3137](https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains))
- **Biometric access control:**
  - With `userPresence`, keychain services ask for biometry or passcode "whenever the item is later read". "The Secure Enclave passes back a pass/fail result that gates keychain item access."
  - `touchIDAuthenticationAllowableReuseDuration` lets a read be "satisfied by the most recent device unlock event, if it happened within the given number of seconds (up to five minutes)". It "applies specifically to device unlock with Touch ID, not keychain retrieval authentications." ([Accessing keychain items with Face ID or Touch ID](https://developer.apple.com/documentation/localauthentication/accessing-keychain-items-with-face-id-or-touch-id), [reuse duration](https://developer.apple.com/documentation/localauthentication/lacontext/touchidauthenticationallowablereuseduration))
  - `biometryCurrentSet` invalidates the item when fingers are added or removed. ([biometryCurrentSet](https://developer.apple.com/documentation/security/secaccesscontrolcreateflags/biometrycurrentset), [userPresence](https://developer.apple.com/documentation/security/secaccesscontrolcreateflags/userpresence))
- **Precedent:** KeePassXC's Touch ID quick unlock stores its key under a `SecAccessControl` built from `kSecAccessControlBiometryCurrentSet` (with Apple Watch or device passcode as optional alternatives) and `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` ([KeePassXC `TouchID.mm`](https://github.com/keepassxreboot/keepassxc/blob/develop/src/quickunlock/TouchID.mm)).

### Windows Credential Manager and Windows Hello

- **Credential Manager:** "Generic credentials can be read and written by user processes." Only LSA can read domain credentials. ([Kinds of credentials](https://learn.microsoft.com/en-us/windows/win32/secauthn/kinds-of-credentials)) `CredRead` reads "the one associated with the logon session of the current token" and has no prompt. ([CredReadW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credreadw)) Any same-user process can read anything Doppler, Infisical, aws-vault (`wincred`), or KeyPick would store there.
- **`UserConsentVerifier`:** It "performs a verification" and returns a `UserConsentVerificationResult`. Microsoft frames it as a consent check before an action ("before authorizing an in-app purchase or access to restricted resources"). It isn't tied to any key or stored secret. ([UserConsentVerifier](https://learn.microsoft.com/en-us/uwp/api/windows.security.credentials.ui.userconsentverifier))
- **Hello-protected keys:** Microsoft says `KeyCredential.RequestSignAsync` prompts the user to sign data with their key credential. ([RequestSignAsync](https://learn.microsoft.com/en-us/uwp/api/windows.security.credentials.keycredential.requestsignasync)) KeePassXC turns this into an encryption key in three steps ([KeePassXC `WindowsHello.cpp`](https://github.com/keepassxreboot/keepassxc/blob/develop/src/quickunlock/WindowsHello.cpp)):
  1. Have Hello sign a random challenge.
  2. Use the SHA-256 of the signature as an AES-256-GCM key.
  3. Store the challenge, which doubles as the IV, next to the ciphertext.

  The ByteNess keyring fork instead uses a decrypt-only key from the Passport key storage provider (above).

  Microsoft's docs don't say whether, or how long, Windows caches a Hello gesture for later key operations (unverified).

### libsecret and the Secret Service API

- **Spec:** "A service may choose to unlock items or collections just for a single client application. Alternatively the service may choose to allow any client application to access items or collections unlocked by another client application." ([Locking and Unlocking](https://specifications.freedesktop.org/secret-service/latest/unlocking.html)) "This specification does not mandate any form of access control." ([What's not included](https://specifications.freedesktop.org/secret-service/latest/ch10.html))
- **gnome-keyring:** "An example of security theater is giving the illusion that somehow one application running in a security context (such as your user session) can keep information from another application running in the same security context." The project protects against passive attacks only. ([gnome-keyring Security Philosophy](https://wiki.gnome.org/Projects/GnomeKeyring/SecurityPhilosophy))
- **Same-user reading:** Once the login keyring is unlocked, which normally happens at login, any process on the session bus can read every item.

### polkit (what KeyPick's Linux gate uses)

- **Caching:** `auth_admin_keep` and `auth_self_keep` keep "the authorization ... for a brief period (e.g. five minutes)". ([polkit(8) source](https://github.com/polkit-org/polkit/blob/main/docs/man/polkit.xml)) `ExpirationSeconds` defaults to 300. ([polkitd.conf(5) source](https://github.com/polkit-org/polkit/blob/main/docs/man/polkitd.conf.xml)) Temporary authorizations are stored against the subject *process*; the source comment reads "for now, prefer to store the process". ([`polkitbackendinteractiveauthority.c`](https://github.com/polkit-org/polkit/blob/main/src/polkitbackend/polkitbackendinteractiveauthority.c))
- **pkexec:** pkexec's subject is its parent process (`getppid()`). ([`pkexec.c`](https://github.com/polkit-org/polkit/blob/main/src/programs/pkexec.c)) The `org.freedesktop.policykit.exec` action defaults to `auth_admin`, with no keep, in every state. ([policy file](https://github.com/polkit-org/polkit/blob/main/actions/org.freedesktop.policykit.policy.in))
- **For KeyPick:** `pkexec /bin/true` prompts on every call and asks for an *administrator's* credentials. What it hands back to KeyPick is an exit code.

### Hardware-backed age identities (precedent for short windows)

- **YubiKey (age-plugin-yubikey):** Identities are generated with `--pin-policy` and `--touch-policy`. The plugin "does not provide or interact with an agent", but it keeps the PIN cache for the `once` policy. ([age-plugin-yubikey](https://github.com/str4d/age-plugin-yubikey)) Yubico's touch policy "Cached" means that "if more than 15 seconds have elapsed since the last time the YubiKey was touched, a touch is needed". ([Yubico PIN and touch policies](https://docs.yubico.com/yesdk/users-manual/application-piv/pin-touch-policies.html)) The device holds the cache, so any process that can reach the token in those 15 seconds can use it.
- **Secure Enclave (age-plugin-se):** It keeps the age key in the Secure Enclave. `--access-control` takes `none`, `passcode`, `any-biometry`, `any-biometry-and-passcode`, `any-biometry-or-passcode` (the default), `current-biometry`, and `current-biometry-and-passcode`. It needs macOS 14 to decrypt. ([age-plugin-se](https://github.com/remko/age-plugin-se))
- **SOPS support:** SOPS 3.10.0 added "Age plugin support" and a `SOPS_AGE_KEY_CMD` hook (an executable that supplies the key). Both are ways to stop keeping a plaintext `keys.txt`. ([SOPS changelog](https://github.com/getsops/sops/blob/main/CHANGELOG.md))

## Implications for KeyPick

### Where KeyPick stands

- **Gating today:** `requireBio` in `main.ts` calls `auth.verify()` before `add`, `extract`, `list`, `copy`, `env push`, `env pull`, and the no-argument interactive menu. `keypick auto` (`commands/auto_export.ts`) has no gate and prints `export KEY='VALUE'` lines.
- **What `verify()` is:** On every platform, `verify()` in `ts/src/lib/auth.ts` is a UI-only check: Windows Hello `UserConsentVerifier`, `LAContext.evaluatePolicy` through a `swift` script, `pkexec /bin/true`, or Hello reached from WSL. The result is an exit code. Nothing is decrypted under it.
- **Where the key lives:** The age identity is a plaintext `keys.txt` at the SOPS default location (`%AppData%\sops\age\keys.txt` or `~/.config/sops/age/keys.txt`, per `ts/src/lib/vault.ts`). A same-user process, including a prompt-injected agent, can skip KeyPick, read the file, or run `sops -d`.
- **Consequence:** Any approval-caching design is advisory until something that needs the human protects the identity itself, or until something else holds the identity. Decision #17 therefore has two parts: what binds the approval (options A and B below), and what scope and lifetime it gets once granted (options C to F).

### Options and their same-user properties

These are options, not a recommendation.

**A. Per-call decryption bound to hardware or the OS, with no cache.**

- **Mechanism:**
  - Wrap or replace the age identity so that every decryption needs a gesture.
  - macOS: age-plugin-se with biometric access control.
  - Any OS: age-plugin-yubikey with touch policy `always`.
  - Windows: a key protected by Hello (KeePassXC's sign-a-challenge pattern, or a Passport decrypt key).
  - Wiring: SOPS age plugins or `SOPS_AGE_KEY_CMD`.
- **Reuse by a same-user process:** None; each use needs the human.
- **Forgery:** Not possible without the human. What remains: an agent can *trigger* a prompt and hope the user approves out of habit, and UI injection may reach the prompt (macOS accessibility, X11 synthetic input).
- **Cost:**
  - Every `keypick` call prompts, which hurts agent workflows that run many commands.
  - Linux has no keystore-backed biometric equivalent: polkit only answers pass or fail, and Secret Service has no per-app access control. Linux would need a hardware token such as a YubiKey, or a TPM, or a passphrase. FIDO2 and TPM age plugins exist but weren't reviewed here.

**B. A short window enforced by hardware or the OS.**

- **Mechanism:** Like A, but with a cached policy: YubiKey cached touch (15 s), or Touch ID reuse of a device unlock (up to 5 min, device unlock only). Windows Hello's caching is unverified.
- **Reuse:** Any same-user process can use the cached state inside the window, because the device or OS holds it, not a per-caller record.
- **Forgery:** Not possible outside the window.
- **Cost:** The vendor fixes the window length; KeyPick can't scope it to one group or one command.

**C. A KeyPick broker that holds unlocked material with a TTL and a scope.** This follows the gpg-agent, ssh-agent, and 1Password app model.

- **Mechanism:**
  - `keypick unlock <group> --for 5m` asks for approval, ideally through A.
  - A broker process holds the decrypted values or identity in memory and serves clients over a socket or named pipe that only the user can open, checking the peer's uid.
  - Scope can be per group, per number of uses, and per TTL.
  - The broker can require a fresh confirmation for each "reveal" while letting "inject into a child process" through silently, in the style of `ssh-add -c`.
  - It turns off ptrace, as ssh-agent does, and core dumps, as gpg-agent does.
- **Reuse:** Yes, inside the window, by any same-user process that can open the socket. gpg-agent and the 1Password Linux socket document exactly this. Checking the caller's binary signature (as 1Password does) doesn't help when the attacker runs the real `keypick` binary.
- **Forgery:** Not possible outside the window, *if* the identity at rest is protected (A). Otherwise the broker adds nothing, because `keys.txt` is still readable.
- **Cost:** A long-running process on three OSes. On Windows, I found no documented equivalent of Yama or `PR_SET_DUMPABLE` that keeps a same-user process at the same integrity level out of the broker's memory (unverified).

**D. A ticket bound to context (sudo and 1Password style).**

- **Mechanism:** The approval is keyed to (controlling tty, session ID, session-leader start time) on Unix, or (invoking PID, start time) on Windows, and held in broker memory. KeyPick has no root-owned directory, so a ticket *file* the user can write would be forgeable. sudoers warns about the same thing for timestamps in `/tmp`.
- **Reuse:** Any process in the same terminal session can reuse it, including an agent started in that terminal and its children, because they inherit the controlling tty. This helps only when the agent runs in a different terminal or session from the one where the human approved. Windows scoping by PID is narrower: each new sub-shell asks again.
- **Forgery:** Copying the label isn't enough; the process has to be inside the session. But context labels contain no secret, so nothing stops a process that *is* inside.

**E. A capability token handed to the child process.** This follows `OP_SESSION`, aws-vault `--ecs-server`, and Doppler's token.

- **Mechanism:** The approval mints a random token, passed only in the environment of `keypick run -- <cmd>`. Children present it to the broker.
- **Reuse:** Yes, by anything that can read the token. That includes the child itself (which is the agent's command) and, on some platforms, other same-user processes that can read process environments, as 1Password's docs warn.
- **Forgery:** Not possible without the token.
- **Cost:** It mostly scopes access to a process tree by convention.

**F. Inject without revealing.** This works alongside any of A to E.

- **Mechanism:** `keypick run -- <cmd>` sends values only into the child's environment, or through a named pipe that can be read a limited number of times (Doppler `--mount-max-reads`), and masks stdout and stderr (`op run`).
- **What it achieves:** It keeps values out of agent transcripts and logs by accident. It doesn't stop a determined child, which matches the map's threat model: once a secret reaches a child process, KeyPick can't stop exfiltration.

### Summary of options

| Option | Unlock scope | Same-user reuse inside the window | Same-user forgery without the human | Needs identity protection at rest |
| --- | --- | --- | --- | --- |
| A. Per call, hardware or OS | One decryption | No | No (prompt-spoofing risk only) | It *is* the protection |
| B. Hardware or OS cache | Device-wide, fixed window | Yes | No | It *is* the protection |
| C. Broker with TTL | Per group, TTL, use count | Yes, through the socket | Only if the identity is plaintext at rest | Yes |
| D. Context ticket | Terminal, session, or PID | Yes, for processes in that context | Only if the identity is plaintext at rest | Yes |
| E. Capability token | Process tree, by convention | Yes, for anything that reads the token | Only if the identity is plaintext at rest | Yes |
| F. Inject without revealing | n/a | n/a | n/a | No, but it doesn't gate anything |

## Unverified or open

- Doppler CLI token expiry (only a community answer says these tokens don't expire), and the lifetime of an Infisical user session.
- Whether 1Password's "current `tty`" means the controlling terminal, as it does for sudo, so that agent subprocesses with redirected stdio inherit the session. This is inferred, not documented.
- What the Windows Hello NGC cache-type property does (undocumented). Also whether Windows reuses a recent Hello gesture for later `KeyCredential` operations, and for how long.
- Whether a same-user process can answer the Windows Hello or `ssh-askpass` prompt with synthetic input on each platform.
- The default lock interval of the `aws-vault` keychain that aws-vault creates.
- The exact value of `LATouchIDAuthenticationMaximumAllowableReuseDuration`. Apple's article says "up to five minutes".
- How macOS file-based keychain ACLs identify a trusted app (code signature versus path) for an unsigned binary such as a Bun-compiled CLI.
- Whether Windows offers any documented way to keep a same-user process at the same integrity level from reading a broker's memory.
- Whether FIDO2 or TPM age plugins would give Linux a per-use gate; they weren't reviewed.

## Sources

- 1Password: [app integration security](https://www.1password.dev/cli/app-integration-security/), [app integration](https://www.1password.dev/cli/app-integration/), [secrets as environment variables](https://www.1password.dev/cli/secrets-environment-variables/), [`op run` reference](https://www.1password.dev/cli/reference/commands/run/), [secrets in config files](https://www.1password.dev/cli/secrets-config-files/), [sign in manually](https://www.1password.dev/cli/sign-in-manually/)
- aws-vault: [99designs README](https://github.com/99designs/aws-vault), [USAGE.md](https://github.com/99designs/aws-vault/blob/master/USAGE.md), [cli/global.go](https://github.com/99designs/aws-vault/blob/master/cli/global.go), [ByteNess cli/global.go](https://github.com/ByteNess/aws-vault/blob/main/cli/global.go), [byteness/keyring keychain_macos.go](https://github.com/byteness/keyring/blob/main/keychain_macos.go), [byteness/keyring winhello/passport.go](https://github.com/byteness/keyring/blob/main/winhello/passport.go)
- sudo: [sudoers(5)](https://www.sudo.ws/docs/man/sudoers.man/), [sudoers_timestamp(5)](https://www.sudo.ws/docs/man/sudoers_timestamp.man/), [ttyname.c](https://github.com/sudo-project/sudo/blob/main/src/ttyname.c)
- OpenSSH: [ssh-add(1)](https://man.openbsd.org/ssh-add.1), [ssh-agent(1)](https://man.openbsd.org/ssh-agent.1), [ssh-agent.c](https://github.com/openssh/openssh-portable/blob/master/ssh-agent.c), [readpass.c](https://github.com/openssh/openssh-portable/blob/master/readpass.c), [platform-tracing.c](https://github.com/openssh/openssh-portable/blob/master/platform-tracing.c)
- GnuPG: [Agent Options](https://www.gnupg.org/documentation/manuals/gnupg/Agent-Options.html), [GET_PASSPHRASE](https://www.gnupg.org/documentation/manuals/gnupg/Agent-GET_005fPASSPHRASE.html), [agent/command.c](https://github.com/gpg/gnupg/blob/master/agent/command.c), [agent/gpg-agent.c](https://github.com/gpg/gnupg/blob/master/agent/gpg-agent.c)
- Doppler: [CLI guide](https://docs.doppler.com/docs/cli), [accessing secrets](https://docs.doppler.com/docs/accessing-secrets), [fallback files](https://docs.doppler.com/docs/automatic-fallbacks), [multiple workplaces](https://docs.doppler.com/docs/multiple-workplaces)
- Infisical: [CLI reference](https://infisical.com/docs/cli/reference)
- Apple: [Access Control Lists](https://developer.apple.com/documentation/security/access-control-lists), [TN3137: On Mac keychain APIs and implementations](https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains), [Accessing keychain items with Face ID or Touch ID](https://developer.apple.com/documentation/localauthentication/accessing-keychain-items-with-face-id-or-touch-id), [touchIDAuthenticationAllowableReuseDuration](https://developer.apple.com/documentation/localauthentication/lacontext/touchidauthenticationallowablereuseduration), [userPresence](https://developer.apple.com/documentation/security/secaccesscontrolcreateflags/userpresence), [biometryCurrentSet](https://developer.apple.com/documentation/security/secaccesscontrolcreateflags/biometrycurrentset), [security(1) source](https://github.com/apple-oss-distributions/Security/blob/main/SecurityTool/macOS/security.1)
- Microsoft: [Kinds of credentials](https://learn.microsoft.com/en-us/windows/win32/secauthn/kinds-of-credentials), [CredReadW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credreadw), [UserConsentVerifier](https://learn.microsoft.com/en-us/uwp/api/windows.security.credentials.ui.userconsentverifier), [KeyCredential.RequestSignAsync](https://learn.microsoft.com/en-us/uwp/api/windows.security.credentials.keycredential.requestsignasync), [Key storage property identifiers](https://learn.microsoft.com/en-us/windows/win32/seccng/key-storage-property-identifiers)
- freedesktop and GNOME: [Secret Service: Locking and Unlocking](https://specifications.freedesktop.org/secret-service/latest/unlocking.html), [Secret Service: What's not included](https://specifications.freedesktop.org/secret-service/latest/ch10.html), [gnome-keyring Security Philosophy](https://wiki.gnome.org/Projects/GnomeKeyring/SecurityPhilosophy)
- polkit: [polkit(8) source](https://github.com/polkit-org/polkit/blob/main/docs/man/polkit.xml), [polkitd.conf(5) source](https://github.com/polkit-org/polkit/blob/main/docs/man/polkitd.conf.xml), [polkitbackendinteractiveauthority.c](https://github.com/polkit-org/polkit/blob/main/src/polkitbackend/polkitbackendinteractiveauthority.c), [pkexec.c](https://github.com/polkit-org/polkit/blob/main/src/programs/pkexec.c), [org.freedesktop.policykit.policy.in](https://github.com/polkit-org/polkit/blob/main/actions/org.freedesktop.policykit.policy.in)
- Linux: [Yama LSM](https://www.kernel.org/doc/html/latest/admin-guide/LSM/Yama.html)
- KeePassXC: [WindowsHello.cpp](https://github.com/keepassxreboot/keepassxc/blob/develop/src/quickunlock/WindowsHello.cpp), [TouchID.mm](https://github.com/keepassxreboot/keepassxc/blob/develop/src/quickunlock/TouchID.mm)
- age and SOPS: [age-plugin-yubikey](https://github.com/str4d/age-plugin-yubikey), [Yubico PIN and touch policies](https://docs.yubico.com/yesdk/users-manual/application-piv/pin-touch-policies.html), [age-plugin-se](https://github.com/remko/age-plugin-se), [SOPS changelog](https://github.com/getsops/sops/blob/main/CHANGELOG.md)
