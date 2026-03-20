# KeyPick Bug Research: Terminal Input Corruption After Windows Hello

## The Problem
The user reports that after successfully authenticating via Windows Hello, the terminal keyboard input behaves erratically (nothing is displayed, or wrong characters output). This occurs just before the `inquire` crate prompts the user.

## Key Files and Roles
- **`src/main.rs`**: The main entry point. It calls `auth::verify()` to block access until biometrics pass. If successful, it proceeds to command execution (like `commands::interactive::run()`).
- **`src/auth.rs`**: Wraps the `robius-authentication` crate to trigger OS-level biometric prompts (Windows Hello, Touch ID, Polkit).
- **`src/terminal.rs`**: Contains terminal state management utilities, specifically `cleanup_and_exit()` which utilizes `crossterm::terminal::disable_raw_mode()` to recover the terminal.

## Architecture & Existing Patterns
- The app relies on `crossterm` (via `inquire`) for all interactive CLI elements.
- The biometric authentication is done sequentially on the main thread prior to rendering the next prompts.
- A panic hook exists in `src/terminal.rs` to ensure raw mode is disabled if the application crashes.

## Hypothesis & Gotchas
When `robius-authentication` opens the native Windows Hello consent UI, the Windows OS likely tampers with the underlying Console Input Modes (such as unsetting `ENABLE_VIRTUAL_TERMINAL_INPUT`, `ENABLE_PROCESSED_INPUT`, or `ENABLE_ECHO_INPUT`). 

When the GUI closes and control returns to the CLI, these console modes are not restored. Consequently, `crossterm` and `inquire` are forced to read raw ANSI escape sequences or fail to capture keystrokes properly, resulting in "messed up" keyboard input.

## Proposed Solution
We need to explicitly restore the terminal to a sane state immediately after `auth::verify()` completes. 
This can likely be achieved by either:
1. Forcing `crossterm` to reset the terminal state (e.g., quickly toggling `enable_raw_mode()` and `disable_raw_mode()`).
2. Alternatively, ensuring that standard console modes are re-applied if we detect Windows. 

The fix should be applied in `src/main.rs` directly after `auth::verify()` returns `Ok(())` or inside a wrapper function in `src/terminal.rs`.
