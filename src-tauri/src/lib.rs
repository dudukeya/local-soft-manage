pub mod commands;
pub mod domain;
pub mod error;
pub mod pty;
pub mod repository;

use commands::AppState;
use pty::{EmbeddedTerminalManager, TerminalEvent};
use repository::Repository;
use tauri::{Emitter, Manager, RunEvent};

/// Tauri 应用入口：初始化项目仓库和应用内 PTY 终端。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let application = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let repository = Repository::open(app.path().app_data_dir()?)?;
            let terminal_handle = app.handle().clone();
            let terminals = EmbeddedTerminalManager::new(move |event| match event {
                TerminalEvent::Output { terminal_id, data } => {
                    let _ = terminal_handle.emit(
                        "terminal://output",
                        serde_json::json!({ "terminalId": terminal_id, "data": data }),
                    );
                }
                TerminalEvent::Exit {
                    terminal_id,
                    exit_code,
                    signal,
                } => {
                    let _ = terminal_handle.emit(
                        "terminal://exit",
                        serde_json::json!({
                            "terminalId": terminal_id,
                            "exitCode": exit_code,
                            "signal": signal,
                        }),
                    );
                }
            });
            app.manage(AppState::new(repository, terminals));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_projects,
            commands::list_project_categories,
            commands::save_project_categories,
            commands::create_project,
            commands::update_project,
            commands::delete_project,
            commands::reorder_projects,
            commands::open_url,
            commands::create_terminal,
            commands::create_standalone_terminal,
            commands::start_project,
            commands::stop_project,
            commands::restart_project,
            commands::write_terminal,
            commands::resize_terminal,
            commands::close_terminal,
        ])
        .build(tauri::generate_context!())
        .expect("初始化 Local Soft Manage 失败");

    application.run(|app, event| {
        if matches!(event, RunEvent::ExitRequested { .. }) {
            if let Some(state) = app.try_state::<AppState>() {
                state.terminals.close_all();
            }
        }
    });
}
