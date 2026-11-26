fn main() {
    // Constants and copy are generated from src/shared by `pnpm build`.
    for generated in ["gen/defaults.rs", "gen/identity.rs", "gen/shell_copy.rs"] {
        if !std::path::Path::new(generated).exists() {
            panic!("src/desktop/{generated} is missing; run `pnpm build` first");
        }
        println!("cargo:rerun-if-changed={generated}");
    }

    // App commands must be granted explicitly through capabilities, like plugin commands.
    let manifest = tauri_build::AppManifest::new().commands(&[
        "sidecar_endpoint",
        "shell_diagnostics",
        "pick_local_file",
        "pick_relink_file",
        "save_burn_output",
        "save_cached_media",
        "pick_cache_dir",
        "allow_cache_dir",
        "open_folder",
        "open_bilibili_login",
        "clear_bilibili_player_session",
        "rotate_master_key",
        "pick_backup_destination",
        "inspect_backup",
        "pick_restore_originals_dir",
        "restore_backup",
        "pick_pack_destination",
        "pick_pack_source",
        "pick_pack_originals_dir",
        "begin_update_install",
        "end_update_install",
        "update_download",
        "update_install",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest)).expect("tauri-build failed");
}
