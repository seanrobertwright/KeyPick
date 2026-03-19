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

#[cfg(not(windows))]
pub fn restore_console_focus() {}
