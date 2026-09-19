use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{mpsc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

#[cfg(windows)]
use std::ffi::c_void;

const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;

struct AutomationState {
    endpoint: String,
    token: String,
    client: reqwest::Client,
    child: Mutex<Child>,
}

enum AutomationBackend {
    Ready(AutomationState),
    Unavailable(String),
}

#[derive(Deserialize)]
struct ReadyMessage {
    ready: bool,
    port: u16,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PreparedFlowpilotSession {
    cdp_endpoint: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FlowpilotBridgeDescriptor {
    endpoint: String,
    token: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FlowpilotSessionValue {
    cdp_endpoint: String,
}

#[derive(Deserialize)]
struct FlowpilotBridgeResponse {
    ok: bool,
    value: Option<FlowpilotSessionValue>,
    error: Option<String>,
}

fn install_log_directory_for_executable(executable: &std::path::Path) -> Result<PathBuf, String> {
    executable
        .parent()
        .map(|directory| directory.join("logs"))
        .ok_or_else(|| "Application installation directory is unavailable.".to_string())
}

fn install_directory() -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        return std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(std::path::Path::to_path_buf)
            .ok_or_else(|| "Project root is unavailable.".to_string());
    }
    std::env::current_exe()
        .map_err(|error| format!("Unable to locate the application executable: {error}"))?
        .parent()
        .map(std::path::Path::to_path_buf)
        .ok_or_else(|| "Application installation directory is unavailable.".to_string())
}

fn api_vault_settings_path() -> Result<PathBuf, String> {
    Ok(install_directory()?.join("data").join("api-vault").join("settings.json"))
}

#[cfg(windows)]
#[repr(C)]
struct DataBlob {
    cb_data: u32,
    pb_data: *mut u8,
}

#[cfg(windows)]
#[link(name = "Crypt32")]
extern "system" {
    fn CryptProtectData(input: *const DataBlob, description: *const u16, entropy: *const DataBlob, reserved: *mut c_void, prompt: *const c_void, flags: u32, output: *mut DataBlob) -> i32;
    fn CryptUnprotectData(input: *const DataBlob, description: *mut *mut u16, entropy: *const DataBlob, reserved: *mut c_void, prompt: *const c_void, flags: u32, output: *mut DataBlob) -> i32;
}

#[cfg(windows)]
#[link(name = "Kernel32")]
extern "system" {
    fn LocalFree(memory: *mut c_void) -> *mut c_void;
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn hex_decode(value: &str) -> Result<Vec<u8>, String> {
    if value.len() % 2 != 0 { return Err("Encrypted API key is invalid.".to_string()); }
    (0..value.len()).step_by(2).map(|index| u8::from_str_radix(&value[index..index + 2], 16)
        .map_err(|_| "Encrypted API key is invalid.".to_string())).collect()
}

#[cfg(windows)]
fn protect_secret(secret: &str) -> Result<String, String> {
    if secret.is_empty() { return Ok(String::new()); }
    let mut input_bytes = secret.as_bytes().to_vec();
    let input = DataBlob { cb_data: input_bytes.len() as u32, pb_data: input_bytes.as_mut_ptr() };
    let mut output = DataBlob { cb_data: 0, pb_data: std::ptr::null_mut() };
    let result = unsafe { CryptProtectData(&input, std::ptr::null(), std::ptr::null(), std::ptr::null_mut(), std::ptr::null(), 1, &mut output) };
    if result == 0 { return Err(format!("Windows could not protect the API key: {}", std::io::Error::last_os_error())); }
    let protected = unsafe { std::slice::from_raw_parts(output.pb_data, output.cb_data as usize).to_vec() };
    unsafe { LocalFree(output.pb_data.cast()); }
    Ok(hex_encode(&protected))
}

#[cfg(windows)]
fn unprotect_secret(ciphertext: &str) -> Result<String, String> {
    if ciphertext.is_empty() { return Ok(String::new()); }
    let mut encrypted = hex_decode(ciphertext)?;
    let input = DataBlob { cb_data: encrypted.len() as u32, pb_data: encrypted.as_mut_ptr() };
    let mut output = DataBlob { cb_data: 0, pb_data: std::ptr::null_mut() };
    let result = unsafe { CryptUnprotectData(&input, std::ptr::null_mut(), std::ptr::null(), std::ptr::null_mut(), std::ptr::null(), 1, &mut output) };
    if result == 0 { return Err(format!("Windows could not unlock the saved API key: {}", std::io::Error::last_os_error())); }
    let plaintext = unsafe { std::slice::from_raw_parts(output.pb_data, output.cb_data as usize).to_vec() };
    unsafe { LocalFree(output.pb_data.cast()); }
    String::from_utf8(plaintext).map_err(|_| "Saved API key is not valid UTF-8.".to_string())
}

#[cfg(not(windows))]
fn protect_secret(_secret: &str) -> Result<String, String> { Err("Secure API key storage is available on Windows only.".to_string()) }

#[cfg(not(windows))]
fn unprotect_secret(_ciphertext: &str) -> Result<String, String> { Err("Secure API key storage is available on Windows only.".to_string()) }

fn transform_api_keys(settings: &mut Value, protect: bool) -> Result<(), String> {
    let providers = settings.get_mut("providers").and_then(Value::as_object_mut)
        .ok_or_else(|| "API Vault settings are invalid.".to_string())?;
    for provider in providers.values_mut() {
        let values = provider.as_object_mut().ok_or_else(|| "API Vault provider settings are invalid.".to_string())?;
        if protect {
            let api_key = values.remove("apiKey").and_then(|value| value.as_str().map(str::to_string)).unwrap_or_default();
            values.insert("apiKeyProtected".to_string(), Value::String(protect_secret(&api_key)?));
        } else {
            let ciphertext = values.remove("apiKeyProtected").and_then(|value| value.as_str().map(str::to_string)).unwrap_or_default();
            values.insert("apiKey".to_string(), Value::String(unprotect_secret(&ciphertext)?));
        }
    }
    Ok(())
}

fn log_directory() -> Result<PathBuf, String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("Unable to locate the application executable: {error}"))?;
    let directory = install_log_directory_for_executable(&executable)?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory)
}

fn rotate_log(path: &std::path::Path) {
    let Ok(metadata) = fs::metadata(path) else {
        return;
    };
    if metadata.len() < MAX_LOG_BYTES {
        return;
    }
    let previous = path.with_extension("log.previous");
    let _ = fs::remove_file(&previous);
    let _ = fs::rename(path, previous);
}

fn append_log(file_name: &str, line: &str) -> Result<(), String> {
    let path = log_directory()?.join(file_name);
    rotate_log(&path);
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| format!("Unable to write {}: {error}", path.display()))?;
    writeln!(file, "{line}")
        .map_err(|error| format!("Unable to write {}: {error}", path.display()))
}

fn log_timestamp() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis()
}

fn safe_log_value(value: &str) -> String {
    value.replace(['\r', '\n'], " ").chars().take(1_000).collect()
}

fn append_automation_log(_app: &tauri::AppHandle, event: &str, details: &str) {
    let suffix = if details.is_empty() { String::new() } else { format!(" {details}") };
    let _ = append_log("automation.log", &format!("[{}] {event}{suffix}", log_timestamp()));
}

fn install_panic_log() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = append_log("crash.log", &format!("[{}] rust.panic {info}", log_timestamp()));
        previous(info);
    }));
}

fn append_startup_log(_app: &tauri::AppHandle, message: &str) {
    let _ = append_log("startup.log", message);
}

fn command_path(path: PathBuf) -> String {
    let value = path.to_string_lossy().into_owned();
    if let Some(path) = value.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{path}");
    }
    value.strip_prefix(r"\\?\").unwrap_or(&value).to_string()
}

fn verify_node_runtime(node: &str) -> Result<(), String> {
    let output = Command::new(node)
        .arg("--version")
        .output()
        .map_err(|error| format!("Node.js was not found in PATH: {error}"))?;
    if !output.status.success() {
        return Err("Node.js in PATH could not be started.".to_string());
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let major = version
        .trim_start_matches('v')
        .split('.')
        .next()
        .and_then(|value| value.parse::<u32>().ok())
        .ok_or_else(|| format!("Unable to read the installed Node.js version: {version}"))?;
    if major < 20 {
        return Err(format!("Node.js 20 or newer is required; PATH currently resolves to {version}."));
    }
    Ok(())
}

fn valid_account_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-' || character == '_')
}

fn should_stop_sidecar(window_label: &str, destroyed: bool) -> bool {
    destroyed && window_label == "main"
}

fn sidecar_request_timeout(method: &str) -> Duration {
    match method {
        // One Agent run can include several provider and filesystem-tool rounds.
        // The sidecar owns the tighter per-round limits; the bridge must not abort
        // a healthy run while it is still producing a response.
        "api-vault:run" => Duration::from_secs(30 * 60),
        "api-vault:models" => Duration::from_secs(60),
        "events:poll" => Duration::from_secs(15),
        _ => Duration::from_secs(60),
    }
}

fn valid_flowpilot_endpoint(value: &str) -> bool {
    reqwest::Url::parse(value).is_ok_and(|url| {
        url.scheme() == "http"
            && url.host_str() == Some("127.0.0.1")
            && url.port().is_some()
            && (url.path().is_empty() || url.path() == "/")
            && url.query().is_none()
            && url.fragment().is_none()
    })
}

#[tauri::command]
async fn prepare_flowpilot_session(
    app: tauri::AppHandle,
    account_id: String,
) -> Result<PreparedFlowpilotSession, String> {
    append_automation_log(&app, "session.prepare.start", "");
    let result = async {
        if !valid_account_id(&account_id) {
            return Err("Invalid FlowPilot account id.".to_string());
        }
        let local_app_data = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .ok_or_else(|| "LOCALAPPDATA is unavailable; FlowPilot cannot be located.".to_string())?;
        let descriptor_path = local_app_data
            .join("com.flowpilot.desktop")
            .join("automation-bridge.json");
        let descriptor: FlowpilotBridgeDescriptor = serde_json::from_slice(
            &fs::read(descriptor_path)
                .map_err(|_| "FlowPilot session host is unavailable. Install FlowPilot 1.5.4 or newer, open it, then start the queue again.".to_string())?,
        )
        .map_err(|_| "FlowPilot's automation bridge descriptor is invalid. Restart FlowPilot.".to_string())?;
        if !valid_flowpilot_endpoint(&descriptor.endpoint) || descriptor.token.len() < 32 {
            return Err("FlowPilot's automation bridge descriptor is invalid. Restart FlowPilot.".to_string());
        }
        let payload: FlowpilotBridgeResponse = reqwest::Client::builder()
            .timeout(Duration::from_secs(40))
            .build()
            .map_err(|error| error.to_string())?
            .post(format!("{}/v1/session/open", descriptor.endpoint.trim_end_matches('/')))
            .bearer_auth(descriptor.token)
            .json(&json!({ "accountId": account_id }))
            .send()
            .await
            .map_err(|_| "FlowPilot session host is not running. Open or restart FlowPilot, then start the queue again.".to_string())?
            .json()
            .await
            .map_err(|_| "FlowPilot returned an invalid automation response.".to_string())?;
        if !payload.ok {
            return Err(payload.error.unwrap_or_else(|| "FlowPilot could not open the selected session.".to_string()));
        }
        let value = payload.value
            .ok_or_else(|| "FlowPilot did not return an automation endpoint.".to_string())?;
        if !valid_flowpilot_endpoint(&value.cdp_endpoint) {
            return Err("FlowPilot returned an unsafe automation endpoint.".to_string());
        }
        Ok(PreparedFlowpilotSession { cdp_endpoint: value.cdp_endpoint })
    }
    .await;
    match &result {
        Ok(_) => append_automation_log(&app, "session.prepare.complete", "source=flowpilot-webview2"),
        Err(error) => append_automation_log(
            &app,
            "session.prepare.failed",
            &format!("error={}", safe_log_value(error)),
        ),
    }
    result
}

fn sidecar_paths(app: &tauri::AppHandle) -> Result<(String, String), String> {
    if cfg!(debug_assertions) {
        let project = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .ok_or_else(|| "Project root is unavailable.".to_string())?
            .to_path_buf();
        return Ok(("node".to_string(), command_path(project.join("dist-sidecar/sidecar/server.js"))));
    }

    let resources = app.path().resource_dir().map_err(|error| error.to_string())?;
    Ok((
        "node.exe".to_string(),
        command_path(resources.join("resources/automation/sidecar/server.js")),
    ))
}

fn start_sidecar(app: &tauri::AppHandle) -> Result<AutomationState, String> {
    let (node, script) = sidecar_paths(app)?;
    append_startup_log(app, &format!("Starting automation runtime. node={node}; script={script}"));
    verify_node_runtime(&node)?;
    if !std::path::Path::new(&script).is_file() {
        return Err(format!("Bundled automation script is missing: {script}"));
    }
    let token = uuid::Uuid::new_v4().simple().to_string() + &uuid::Uuid::new_v4().simple().to_string();
    let log_directory_arg = command_path(log_directory()?);
    let install_directory_arg = command_path(install_directory()?);
    let mut command = Command::new(&node);
    command
        .args([&script, "--token", &token, "--log-dir", &log_directory_arg, "--install-dir", &install_directory_arg])
        .stdin(Stdio::null())
        .stdout(Stdio::piped());
    if cfg!(debug_assertions) {
        command.stderr(Stdio::inherit());
    } else {
        let log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_directory()?.join("startup.log"))
            .map_err(|error| format!("Unable to open the startup log: {error}"))?;
        command.stderr(Stdio::from(log));
    }

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
            .connect_timeout(Duration::from_secs(5))
            .build()
            .map_err(|error| format!("Unable to initialize the automation bridge: {error}"))?,
        child: Mutex::new(child),
    })
}

#[cfg(test)]
mod path_tests {
    use super::{
        command_path, valid_flowpilot_endpoint,
        install_log_directory_for_executable, safe_log_value, should_stop_sidecar,
        sidecar_request_timeout, valid_account_id,
    };

    #[test]
    fn strips_windows_verbatim_prefix_from_local_paths() {
        assert_eq!(
            command_path(std::path::PathBuf::from(r"\\?\D:\Data\Kuntyy AutoPrompt\server.js")),
            r"D:\Data\Kuntyy AutoPrompt\server.js"
        );
    }

    #[test]
    fn converts_windows_verbatim_unc_paths() {
        assert_eq!(
            command_path(std::path::PathBuf::from(r"\\?\UNC\server\share\server.js")),
            r"\\server\share\server.js"
        );
    }

    #[test]
    fn accepts_only_safe_flowpilot_account_ids() {
        assert!(valid_account_id("flow-account_123"));
        assert!(!valid_account_id("../accounts"));
        assert!(!valid_account_id(""));
    }

    #[test]
    fn keeps_runtime_log_entries_on_one_bounded_line() {
        assert_eq!(safe_log_value("first\r\nsecond"), "first  second");
        assert_eq!(safe_log_value(&"x".repeat(1_001)).len(), 1_000);
    }

    #[test]
    fn places_logs_next_to_the_installed_executable() {
        let executable = std::path::Path::new("install-root")
            .join("Kuntyy AutoPrompt")
            .join("kuntyy-autoprompt.exe");
        assert_eq!(
            install_log_directory_for_executable(&executable).unwrap(),
            std::path::Path::new("install-root")
                .join("Kuntyy AutoPrompt")
                .join("logs")
        );
    }

    #[test]
    fn only_main_window_destruction_stops_the_sidecar() {
        assert!(should_stop_sidecar("main", true));
        assert!(!should_stop_sidecar("flowpilot-session-export-test", true));
        assert!(!should_stop_sidecar("main", false));
    }

    #[test]
    fn accepts_only_loopback_flowpilot_endpoints() {
        assert!(valid_flowpilot_endpoint("http://127.0.0.1:42100"));
        assert!(!valid_flowpilot_endpoint("http://localhost:42100"));
        assert!(!valid_flowpilot_endpoint("https://127.0.0.1:42100"));
        assert!(!valid_flowpilot_endpoint("http://127.0.0.1:42100/path"));
        assert!(!valid_flowpilot_endpoint("http://example.com:42100"));
    }

    #[test]
    fn allows_agent_runs_to_outlive_provider_round_timeouts() {
        assert_eq!(sidecar_request_timeout("api-vault:run"), std::time::Duration::from_secs(30 * 60));
        assert_eq!(sidecar_request_timeout("api-vault:models"), std::time::Duration::from_secs(60));
        assert_eq!(sidecar_request_timeout("events:poll"), std::time::Duration::from_secs(15));
    }
}

#[tauri::command]
async fn sidecar_request(app: tauri::AppHandle, state: tauri::State<'_, AutomationBackend>, method: String, params: Value) -> Result<Value, String> {
    let traced = method != "events:poll";
    let method_log = safe_log_value(&method);
    if traced {
        append_automation_log(&app, "bridge.request.start", &format!("method={method_log}"));
    }
    let state = match &*state {
        AutomationBackend::Ready(state) => state,
        AutomationBackend::Unavailable(error) => {
            if traced {
                append_automation_log(&app, "bridge.request.unavailable", &format!("method={method_log}"));
            }
            return Ok(json!({ "ok": false, "error": error }));
        }
    };
    let result = async {
        let timeout = sidecar_request_timeout(&method);
        state.client
            .post(&state.endpoint)
            .timeout(timeout)
            .bearer_auth(&state.token)
            .json(&json!({ "method": method, "params": params }))
            .send().await.map_err(|error| {
                if error.is_timeout() {
                    format!("Automation request exceeded {} seconds.", timeout.as_secs())
                } else {
                    format!("Automation runtime is unavailable: {error}")
                }
            })?
            .error_for_status().map_err(|error| error.to_string())?
            .json::<Value>().await.map_err(|error| format!("Invalid automation response: {error}"))
    }.await;
    if traced {
        match &result {
            Ok(_) => append_automation_log(&app, "bridge.request.complete", &format!("method={method_log}")),
            Err(error) => append_automation_log(&app, "bridge.request.failed", &format!("method={method_log} error={}", safe_log_value(error))),
        }
    }
    result
}

#[tauri::command]
fn read_prompt_file(path: String) -> Result<String, String> {
    let file = std::path::Path::new(&path);
    let extension = file.extension().and_then(|value| value.to_str()).unwrap_or_default();
    if !["txt", "md", "markdown"].iter().any(|value| extension.eq_ignore_ascii_case(value)) {
        return Err("Only TXT and Markdown prompt files are supported.".to_string());
    }
    let metadata = std::fs::metadata(file).map_err(|error| error.to_string())?;
    if metadata.len() > 5 * 1024 * 1024 { return Err("Prompt file exceeds 5 MiB.".to_string()); }
    std::fs::read_to_string(file).map_err(|error| error.to_string())
}

#[tauri::command]
fn save_api_vault_result(directory: String, filename: String, content: String, format: String) -> Result<String, String> {
    let folder = std::path::PathBuf::from(directory);
    if !folder.is_absolute() || !folder.is_dir() {
        return Err("Select an existing result folder first.".to_string());
    }
    if format != "txt" && format != "json" {
        return Err("Result format must be TXT or JSON.".to_string());
    }
    if format == "json" {
        serde_json::from_str::<serde_json::Value>(&content)
            .map_err(|error| format!("The provider result is not valid JSON: {error}"))?;
    }
    let mut name = filename.trim().to_string();
    if name.is_empty() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_secs();
        name = format!("result-{stamp}");
    }
    if name.contains('/') || name.contains('\\') || name == "." || name == ".." {
        return Err("Filename cannot contain a folder path.".to_string());
    }
    let extension = format.as_str();
    if !name.to_ascii_lowercase().ends_with(&format!(".{extension}")) {
        name.push('.');
        name.push_str(extension);
    }
    let base = std::path::Path::new(&name)
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Filename is invalid.".to_string())?;
    for index in 1..10_000 {
        let candidate_name = if index == 1 { name.clone() } else { format!("{base}-{index}.{extension}") };
        let candidate = folder.join(candidate_name);
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&candidate) {
            Ok(mut file) => {
                use std::io::Write;
                file.write_all(content.as_bytes()).map_err(|error| error.to_string())?;
                return Ok(candidate.to_string_lossy().to_string());
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    Err("Unable to choose an available result filename.".to_string())
}

#[tauri::command]
fn load_api_vault_settings() -> Result<Option<Value>, String> {
    let path = api_vault_settings_path()?;
    let backup = path.with_extension("json.backup");
    let source = if path.is_file() { &path } else if backup.is_file() { &backup } else { return Ok(None); };
    let bytes = fs::read(source).map_err(|error| format!("Unable to read {}: {error}", source.display()))?;
    if bytes.len() > 256 * 1024 { return Err("API Vault settings exceed 256 KiB.".to_string()); }
    let mut settings: Value = serde_json::from_slice(&bytes).map_err(|error| format!("API Vault settings are invalid: {error}"))?;
    transform_api_keys(&mut settings, false)?;
    Ok(Some(settings))
}

#[tauri::command]
fn save_api_vault_settings(mut settings: Value) -> Result<(), String> {
    transform_api_keys(&mut settings, true)?;
    let content = serde_json::to_vec_pretty(&settings).map_err(|error| error.to_string())?;
    if content.len() > 256 * 1024 { return Err("API Vault settings exceed 256 KiB.".to_string()); }
    let path = api_vault_settings_path()?;
    let directory = path.parent().ok_or_else(|| "API Vault data directory is unavailable.".to_string())?;
    fs::create_dir_all(directory).map_err(|error| format!("Unable to create {}: {error}", directory.display()))?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, content).map_err(|error| format!("Unable to write {}: {error}", temporary.display()))?;
    let backup = path.with_extension("json.backup");
    if path.exists() {
        let _ = fs::remove_file(&backup);
        fs::rename(&path, &backup).map_err(|error| format!("Unable to prepare {} for replacement: {error}", path.display()))?;
    }
    if let Err(error) = fs::rename(&temporary, &path) {
        if backup.exists() { let _ = fs::rename(&backup, &path); }
        return Err(format!("Unable to replace {}: {error}", path.display()));
    }
    let _ = fs::remove_file(backup);
    Ok(())
}

#[tauri::command]
fn get_log_directory() -> Result<String, String> {
    Ok(command_path(log_directory()?))
}

#[tauri::command]
fn open_log_directory() -> Result<(), String> {
    let directory = log_directory()?;
    #[cfg(windows)]
    Command::new("explorer.exe")
        .arg(&directory)
        .spawn()
        .map_err(|error| format!("Unable to open the logs folder: {error}"))?;
    #[cfg(target_os = "macos")]
    Command::new("open")
        .arg(&directory)
        .spawn()
        .map_err(|error| format!("Unable to open the logs folder: {error}"))?;
    #[cfg(all(unix, not(target_os = "macos")))]
    Command::new("xdg-open")
        .arg(&directory)
        .spawn()
        .map_err(|error| format!("Unable to open the logs folder: {error}"))?;
    Ok(())
}

#[tauri::command]
fn record_updater_event(event: String, message: String) -> Result<(), String> {
    append_log(
        "updater.log",
        &format!(
            "[{}] {} {}",
            log_timestamp(),
            safe_log_value(&event),
            safe_log_value(&message)
        ),
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            install_panic_log();
            let backend = match start_sidecar(&app.handle()) {
                Ok(state) => {
                    append_startup_log(&app.handle(), "Automation runtime is ready.");
                    AutomationBackend::Ready(state)
                }
                Err(error) => {
                    let message = format!("Automation runtime is unavailable: {error}");
                    append_startup_log(&app.handle(), &message);
                    AutomationBackend::Unavailable(message)
                }
            };
            app.manage(backend);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            sidecar_request,
            read_prompt_file,
            save_api_vault_result,
            load_api_vault_settings,
            save_api_vault_settings,
            prepare_flowpilot_session,
            get_log_directory,
            open_log_directory,
            record_updater_event
        ])
        .on_window_event(|window, event| {
            if should_stop_sidecar(window.label(), matches!(event, tauri::WindowEvent::Destroyed)) {
                if let Some(backend) = window.try_state::<AutomationBackend>() {
                    if let AutomationBackend::Ready(state) = &*backend {
                        if let Ok(mut child) = state.child.lock() { let _ = child.kill(); }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Kuntyy AutoPrompt");
}
