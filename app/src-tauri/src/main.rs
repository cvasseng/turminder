// Prevents a console window on Windows in release; harmless everywhere else.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    turminder_app::run()
}
