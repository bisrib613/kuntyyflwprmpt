use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader},
    process::{Child, Command, Stdio},
    sync::{mpsc, Mutex},
    time::Duration,
};
use tauri::Manager;

struct AutomationState {
    endpoint: String,
    token: String,
    client: reqwest::Client,
    child: Mutex<Child>,
}

#[derive(Deserialize)]
struct ReadyMessage {
    ready: bool,
    port: u16,
}

fn sidecar_paths(app: &tauri::AppHandle) -> Result<(String, String), String> {
    if cfg!(debug_assertions) {
        let project = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .ok_or_else(|| "Project root is unavailable.".to_string())?
            .to_path_buf();
        return Ok(("node".to_string(), project.join("dist-sidecar/sidecar/server.js").to_string_lossy().into_owned()));
    }

    let resources = app.path().resource_dir().map_err(|error| error.to_string())?;
    Ok((
        resources.join("resources/node.exe").to_string_lossy().into_owned(),
        resources.join("resources/automation/sidecar/server.js").to_string_lossy().into_owned(),
    ))
}

fn start_sidecar(app: &tauri::AppHandle) -> Result<AutomationState, String> {
    let (node, script) = sidecar_paths(app)?;
    let token = uuid::Uuid::new_v4().simple().to_string() + &uuid::Uuid::new_v4().simple().to_string();
    let mut command = Command::new(&node);
    command.args([&script, "--token", &token]).stdin(Stdio::null()).stdout(Stdio::piped());
    if cfg!(debug_assertions) { command.stderr(Stdio::inherit()); } else { command.stderr(Stdio::null()); }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }

    let mut child = command.spawn().map_err(|error| format!("Unable to start automation runtime at {node}: {error}"))?;
    let stdout = child.stdout.take().ok_or_else(|| "Automation runtime stdout is unavailable.".to_string())?;
    let (sender, receiver) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        let result = reader
            .read_line(&mut line)
            .map_err(|error| format!("Unable to read automation startup status: {error}"))
            .and_then(|_| serde_json::from_str::<ReadyMessage>(line.trim()).map_err(|error| format!("Invalid automation startup status: {error}")));
        let _ = sender.send(result);
    });
    let ready = match receiver.recv_timeout(Duration::from_secs(15)) {
        Ok(Ok(ready)) => ready,
        Ok(Err(error)) => {
            let _ = child.kill();
            return Err(error);
        }
        Err(_) => {
            let _ = child.kill();
            return Err("Automation runtime did not start within 15 seconds.".to_string());
        }
    };
    if !ready.ready || ready.port == 0 {
        let _ = child.kill();
        return Err("Automation runtime did not become ready.".to_string());
    }

    Ok(AutomationState {
        endpoint: format!("http://127.0.0.1:{}/request", ready.port),
        token,
        client: reqwest::Client::builder()
            .timeout(Duration::from_secs(90))
            .build()
            .map_err(|error| format!("Unable to initialize the automation bridge: {error}"))?,
        child: Mutex::new(child),
    })
}

#[tauri::command]
async fn sidecar_request(state: tauri::State<'_, AutomationState>, method: String, params: Value) -> Result<Value, String> {
    state.client
        .post(&state.endpoint)
        .bearer_auth(&state.token)
        .json(&json!({ "method": method, "params": params }))
        .send().await.map_err(|error| format!("Automation runtime is unavailable: {error}"))?
        .error_for_status().map_err(|error| error.to_string())?
        .json::<Value>().await.map_err(|error| format!("Invalid automation response: {error}"))
}

#[tauri::command]
fn read_prompt_file(path: String) -> Result<String, String> {
    let file = std::path::Path::new(&path);
    if file.extension().and_then(|value| value.to_str()).map(|value| value.eq_ignore_ascii_case("txt")) != Some(true) {
        return Err("Only .txt prompt files are supported.".to_string());
    }
    let metadata = std::fs::metadata(file).map_err(|error| error.to_string())?;
    if metadata.len() > 5 * 1024 * 1024 { return Err("Prompt file exceeds 5 MiB.".to_string()); }
    std::fs::read_to_string(file).map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let state = start_sidecar(&app.handle()).map_err(std::io::Error::other)?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![sidecar_request, read_prompt_file])
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if let Some(state) = window.try_state::<AutomationState>() {
                    if let Ok(mut child) = state.child.lock() { let _ = child.kill(); }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Kuntyy AutoPrompt");
}
