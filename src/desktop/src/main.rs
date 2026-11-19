// Release builds run without a console window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Amber desktop shell: window, sidecar lifecycle, updater and the few capabilities only a
//! native shell has (file dialogs with signed grants, the isolated login window, the master
//! key in the Credential Manager). Business logic lives in the sidecar behind `/api`.

mod backup;
mod bilibili_login;
mod data_dir;
mod encoding;
mod file_grant;
mod files;
mod marker;
mod master_key;
mod pack;
mod sidecar;

/// Named default constants, generated from src/shared/defaults.ts by `pnpm build`.
mod defaults {
    include!("../gen/defaults.rs");
}

/// Directory, marker and credential names, generated from src/shared/app-identity.ts. Not
/// every generated name has a use in the shell; the set mirrors the shared module.
#[allow(dead_code)]
mod identity {
    include!("../gen/identity.rs");
}

/// The shell's native message copy, generated from src/shared/i18n/installer.ts.
mod shell_copy {
    include!("../gen/shell_copy.rs");
}

use std::collections::BTreeMap;

use tauri::Manager;

use crate::sidecar::Supervisor;

#[tauri::command]
fn sidecar_endpoint(supervisor: tauri::State<'_, Supervisor>) -> Option<BTreeMap<&'static str, String>> {
    supervisor.endpoint()
}

#[tauri::command]
fn shell_diagnostics(supervisor: tauri::State<'_, Supervisor>) -> BTreeMap<&'static str, String> {
    supervisor.diagnostics()
}

/// After a successful credential reset: a new master key in the Credential Manager and a
/// sidecar restart with it. Async so the keyring call stays off the main thread.
#[tauri::command]
async fn rotate_master_key(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<Supervisor>().rotate_master_key())
        .await
        .map_err(|error| format!("rotation task failed: {error}"))?
}

fn main() {
    tauri::Builder::default()
        // Registered first so a second launch only focuses the running instance.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_fs::init())
        // After fs: it restores and persists the fs scope only when fs is already registered,
        // and the asset protocol scope that keeps picked media playable across restarts.
        .plugin(tauri_plugin_persisted_scope::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let supervisor = Supervisor::start(app.handle())?;
            app.resources_table().add(supervisor.shutdown_guard());
            app.manage(supervisor);
            app.manage(backup::NativeOps::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            sidecar_endpoint,
            shell_diagnostics,
            files::pick_local_file,
            files::pick_relink_file,
            files::save_burn_output,
            files::save_cached_media,
            files::pick_cache_dir,
            files::allow_cache_dir,
            files::open_folder,
            backup::pick_backup_destination,
            backup::inspect_backup,
            backup::pick_restore_originals_dir,
            backup::restore_backup,
            backup::begin_update_install,
            backup::end_update_install,
            pack::pick_pack_destination,
            pack::pick_pack_source,
            pack::pick_pack_originals_dir,
            bilibili_login::open_bilibili_login,
            bilibili_login::clear_bilibili_player_session,
            rotate_master_key
        ])
        .run(tauri::generate_context!())
        .expect("error while running Amber");
}
