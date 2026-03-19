use crossterm::terminal;

/// Restore the terminal to a sane state and exit.
///
/// `std::process::exit()` skips destructors, so crossterm's raw-mode guard
/// never fires.  Call this instead to guarantee the terminal is usable
/// after the process ends.
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
