use crossterm::terminal;

/// Restore the terminal to a sane state and exit.
pub fn cleanup_and_exit(code: i32) -> ! {
    let _ = terminal::disable_raw_mode();
    std::process::exit(code)
}

/// Install a panic hook that restores the terminal before printing the
/// panic message.  Without this, a panic inside an `inquire` prompt
/// leaves the terminal in raw mode.
pub fn install_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = terminal::disable_raw_mode();
        default_hook(info);
    }));
}

/// Restore keyboard input to the terminal after an external dialog
/// (like Windows Hello) that disconnects ConPTY's focus tracking.
///
/// The Windows Hello dialog is owned by the desktop window, so when it
/// closes, focus returns to the desktop — not the terminal. In Windows
/// Terminal (ConPTY), simply calling SetForegroundWindow isn't enough
/// because ConPTY's internal focus pipe is disconnected. Forcing a
/// minimize/restore cycle triggers ConPTY to re-establish focus, the
/// same way lock/unlock does.
#[cfg(windows)]
pub fn restore_console_focus() {
    use winapi::um::wincon::GetConsoleWindow;
    use winapi::um::winuser::{
        GetAncestor, ShowWindow, SetForegroundWindow,
        GA_ROOTOWNER, SW_MINIMIZE, SW_RESTORE,
    };

    unsafe {
        let console_hwnd = GetConsoleWindow();
        if console_hwnd.is_null() {
            return;
        }

        // In Windows Terminal, GetConsoleWindow() returns a hidden ConPTY
        // pseudo-window. GetAncestor with GA_ROOTOWNER gets the real
        // Windows Terminal HWND.
        let terminal_hwnd = GetAncestor(console_hwnd, GA_ROOTOWNER);
        let target = if terminal_hwnd.is_null() { console_hwnd } else { terminal_hwnd };

        // Force a minimize/restore cycle to re-establish ConPTY's focus
        // tracking. This is the programmatic equivalent of the user's
        // lock/unlock workaround.
        ShowWindow(target, SW_MINIMIZE);
        std::thread::sleep(std::time::Duration::from_millis(200));
        ShowWindow(target, SW_RESTORE);
        SetForegroundWindow(target);
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

#[cfg(all(target_os = "linux", not(windows)))]
pub fn restore_console_focus() {
    // Under WSL, the terminal host is Windows Terminal / conhost. After
    // Windows Hello closes, the same ConPTY focus quirk applies, so run
    // the minimize/restore cycle via powershell.exe (exposed via WSL interop).
    if !is_wsl() {
        return;
    }

    let script = r#"
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -Namespace KP -Name Win -MemberDefinition @"
  [System.Runtime.InteropServices.DllImport("kernel32.dll")]
  public static extern System.IntPtr GetConsoleWindow();
  [System.Runtime.InteropServices.DllImport("user32.dll")]
  public static extern System.IntPtr GetAncestor(System.IntPtr hwnd, uint gaFlags);
  [System.Runtime.InteropServices.DllImport("user32.dll")]
  public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);
  [System.Runtime.InteropServices.DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(System.IntPtr hWnd);
"@
$console = [KP.Win]::GetConsoleWindow()
if ($console -eq [System.IntPtr]::Zero) { exit 0 }
$root = [KP.Win]::GetAncestor($console, 3) # GA_ROOTOWNER
$target = if ($root -eq [System.IntPtr]::Zero) { $console } else { $root }
[KP.Win]::ShowWindow($target, 6) | Out-Null  # SW_MINIMIZE
Start-Sleep -Milliseconds 200
[KP.Win]::ShowWindow($target, 9) | Out-Null  # SW_RESTORE
[KP.Win]::SetForegroundWindow($target) | Out-Null
Start-Sleep -Milliseconds 100
"#;

    let _ = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

#[cfg(all(target_os = "linux", not(windows)))]
fn is_wsl() -> bool {
    if std::env::var("WSL_DISTRO_NAME").is_ok() || std::env::var("WSL_INTEROP").is_ok() {
        return true;
    }
    if let Ok(v) = std::fs::read_to_string("/proc/version") {
        let lower = v.to_lowercase();
        return lower.contains("microsoft") || lower.contains("wsl");
    }
    false
}

#[cfg(all(not(windows), not(target_os = "linux")))]
pub fn restore_console_focus() {}
