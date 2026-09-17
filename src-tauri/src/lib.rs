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
use tauri::WebviewUrl;

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

#[derive(Deserialize)]
struct StoredFlowpilotAccount {
    id: String,
    #[serde(default)]
    service: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserCookie {
    name: String,
    value: String,
    domain: String,
    path: String,
    secure: bool,
    http_only: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    same_site: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PreparedFlowpilotSession {
    profile_path: String,
    cookies: Vec<BrowserCookie>,
}

fn startup_log_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app.path().app_log_dir().map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join("startup.log"))
}

fn automation_log_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app.path().app_log_dir().map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join("automation.log"))
}

fn log_timestamp() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis()
}

fn safe_log_value(value: &str) -> String {
    value.replace(['\r', '\n'], " ").chars().take(1_000).collect()
}

fn append_automation_log(app: &tauri::AppHandle, event: &str, details: &str) {
    let Ok(path) = automation_log_path(app) else { return };
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) else { return };
    let suffix = if details.is_empty() { String::new() } else { format!(" {details}") };
    let _ = writeln!(file, "[{}] {event}{suffix}", log_timestamp());
}

fn install_panic_log() {
    let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") else { return };
    let directory = PathBuf::from(local_app_data).join("com.kuntyy.autoprompt").join("logs");
    let _ = fs::create_dir_all(&directory);
    let crash_log = directory.join("crash.log");
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&crash_log) {
            let _ = writeln!(file, "[{}] rust.panic {info}", log_timestamp());
        }
        previous(info);
    }));
}

fn append_startup_log(app: &tauri::AppHandle, message: &str) {
    let Ok(path) = startup_log_path(app) else { return };
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) else { return };
    let _ = writeln!(file, "{message}");
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

const SESSION_PROFILE_FILES: &[&[&str]] = &[
    &["Local State"],
    &["First Run"],
    &["Default", "Preferences"],
    &["Default", "Secure Preferences"],
    &["Default", "Network", "Network Persistent State"],
    &["Default", "Network", "Cookies"],
    &["Default", "Network", "Cookies-journal"],
    &["Default", "Network", "Cookies-wal"],
    &["Default", "Network", "Cookies-shm"],
    &["Default", "Cookies"],
    &["Default", "Cookies-journal"],
    &["Default", "Cookies-wal"],
    &["Default", "Cookies-shm"],
    &["EBWebView", "Local State"],
    &["EBWebView", "First Run"],
    &["EBWebView", "Default", "Preferences"],
    &["EBWebView", "Default", "Secure Preferences"],
    &["EBWebView", "Default", "Network", "Network Persistent State"],
    &["EBWebView", "Default", "Network", "Cookies"],
    &["EBWebView", "Default", "Network", "Cookies-journal"],
    &["EBWebView", "Default", "Network", "Cookies-wal"],
    &["EBWebView", "Default", "Network", "Cookies-shm"],
    &["EBWebView", "Default", "Cookies"],
    &["EBWebView", "Default", "Cookies-journal"],
    &["EBWebView", "Default", "Cookies-wal"],
    &["EBWebView", "Default", "Cookies-shm"],
];

fn session_relative_path(parts: &[&str]) -> PathBuf {
    let mut path = PathBuf::new();
    for part in parts {
        path.push(part);
    }
    path
}

fn copy_session_profile(source: &std::path::Path, destination: &std::path::Path) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(|error| error.to_string())?;
    let mut copied_cookie_store = false;
    for parts in SESSION_PROFILE_FILES {
        let relative = session_relative_path(parts);
        let source_path = source.join(&relative);
        if !source_path.is_file() {
            continue;
        }
        let destination_path = destination.join(&relative);
        if let Some(parent) = destination_path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::copy(&source_path, &destination_path).map_err(|error| {
            format!("Unable to copy {}: {error}", source_path.display())
        })?;
        if parts.last() == Some(&"Cookies") {
            copied_cookie_store = true;
        }
    }
    if !copied_cookie_store {
        let _ = fs::remove_dir_all(destination);
        return Err("FlowPilot's WebView2 cookie store was not found.".to_string());
    }
    Ok(())
}

fn google_cookie_domain(domain: &str) -> bool {
    let domain = domain.trim_start_matches('.').to_ascii_lowercase();
    domain == "google.com"
        || domain.ends_with(".google.com")
        || domain == "labs.google"
        || domain.ends_with(".labs.google")
        || domain == "googleusercontent.com"
        || domain.ends_with(".googleusercontent.com")
}

fn prepare_flowpilot_session_inner(
    app: tauri::AppHandle,
    account_id: String,
) -> Result<PreparedFlowpilotSession, String> {
    if !valid_account_id(&account_id) {
        return Err("Invalid FlowPilot account id.".to_string());
    }
    let account_log = safe_log_value(&account_id);
    append_automation_log(&app, "session.prepare.validate", &format!("accountId={account_log}"));
    let local_app_data = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .ok_or_else(|| "LOCALAPPDATA is unavailable; FlowPilot profiles cannot be located.".to_string())?;
    let flowpilot_root = local_app_data.join("com.flowpilot.desktop");
    let accounts_path = flowpilot_root.join("accounts.json");
    let accounts: Vec<StoredFlowpilotAccount> = serde_json::from_slice(
        &fs::read(&accounts_path).map_err(|error| format!("Unable to read {}: {error}", accounts_path.display()))?,
    )
    .map_err(|error| format!("Invalid FlowPilot accounts.json: {error}"))?;
    if !accounts.iter().any(|account| {
        account.id == account_id && account.service.as_deref().unwrap_or("flow") == "flow"
    }) {
        return Err("The selected FlowPilot account no longer exists.".to_string());
    }

    let source = flowpilot_root
        .join("webview-profiles")
        .join(format!("flow-{account_id}"));
    if !source.is_dir() {
        return Err("The selected FlowPilot session profile does not exist.".to_string());
    }
    append_automation_log(&app, "session.snapshot.copy.start", &format!("accountId={account_log}"));
    let session_root = std::env::temp_dir().join("kuntyy-autoprompt-sessions");
    let snapshot = session_root
        .join(format!("flow-{account_id}-{}", uuid::Uuid::new_v4().simple()));
    copy_session_profile(&source, &snapshot).map_err(|error| {
        format!("FlowPilot session snapshot failed. Close the active Flow profile and retry. {error}")
    })?;
    append_automation_log(&app, "session.snapshot.copy.complete", &format!("accountId={account_log}"));

    let label = format!("flowpilot-session-export-{}", uuid::Uuid::new_v4().simple());
    let app_for_webview = app.clone();
    let snapshot_for_webview = snapshot.clone();
    let label_for_webview = label.clone();
    let (sender, receiver) = mpsc::sync_channel(1);
    append_automation_log(&app, "session.webview.create.start", &format!("accountId={account_log}"));
    let open_result = app.run_on_main_thread(move || {
        let result = tauri::WebviewWindowBuilder::new(
            &app_for_webview,
            label_for_webview,
            WebviewUrl::External("about:blank".parse().expect("about:blank is a valid URL")),
        )
        .data_directory(snapshot_for_webview)
        .visible(false)
        .focused(false)
        .inner_size(1.0, 1.0)
        .position(-10_000.0, -10_000.0)
        .build()
        .map_err(|error| error.to_string());
        let _ = sender.send(result);
    });
    if let Err(error) = open_result {
        let _ = fs::remove_dir_all(&snapshot);
        return Err(error.to_string());
    }
    let webview = match receiver
        .recv_timeout(Duration::from_secs(15))
        .map_err(|_| "Timed out while opening the FlowPilot session snapshot.".to_string())
        .and_then(|result| result)
    {
        Ok(webview) => webview,
        Err(error) => {
            let _ = fs::remove_dir_all(&snapshot);
            return Err(error);
        }
    };
    append_automation_log(&app, "session.webview.create.complete", &format!("accountId={account_log}"));
    append_automation_log(&app, "session.cookies.read.start", &format!("accountId={account_log}"));
    let result = webview.cookies().map_err(|error| error.to_string()).map(|cookies| {
        cookies
            .into_iter()
            .filter_map(|cookie| {
                let domain = cookie.domain()?.to_string();
                if !google_cookie_domain(&domain) {
                    return None;
                }
                let same_site = cookie.same_site().map(|value| match value {
                    tauri::webview::cookie::SameSite::Strict => "Strict",
                    tauri::webview::cookie::SameSite::Lax => "Lax",
                    tauri::webview::cookie::SameSite::None => "None",
                });
                Some(BrowserCookie {
                    name: cookie.name().to_string(),
                    value: cookie.value().to_string(),
                    domain,
                    path: cookie.path().unwrap_or("/").to_string(),
                    secure: cookie.secure().unwrap_or(false),
                    http_only: cookie.http_only().unwrap_or(false),
                    same_site: same_site.map(str::to_string),
                })
            })
            .collect::<Vec<_>>()
    });
    let _ = webview.close();
    let _ = fs::remove_dir_all(&snapshot);
    let cookies = result?;
    append_automation_log(&app, "session.cookies.read.complete", &format!("accountId={account_log} count={}", cookies.len()));
    if cookies.is_empty() {
        return Err("No signed-in Google cookies were found in the selected FlowPilot session.".to_string());
    }
    let profile = session_root.join(format!(
        "chrome-{account_id}-{}",
        uuid::Uuid::new_v4().simple()
    ));
    fs::create_dir_all(&profile)
        .map_err(|error| format!("Unable to create the temporary automation profile: {error}"))?;
    append_automation_log(&app, "session.chrome_profile.ready", &format!("accountId={account_log} profile={}", profile.file_name().and_then(|value| value.to_str()).unwrap_or("unknown")));
    Ok(PreparedFlowpilotSession {
        profile_path: command_path(profile),
        cookies,
    })
}

#[tauri::command]
fn prepare_flowpilot_session(
    app: tauri::AppHandle,
    account_id: String,
) -> Result<PreparedFlowpilotSession, String> {
    append_automation_log(&app, "session.prepare.start", "");
    let result = prepare_flowpilot_session_inner(app.clone(), account_id);
    match &result {
        Ok(session) => append_automation_log(&app, "session.prepare.complete", &format!("cookieCount={}", session.cookies.len())),
        Err(error) => append_automation_log(&app, "session.prepare.failed", &format!("error={}", safe_log_value(error))),
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
    let log_directory = app.path().app_log_dir().map_err(|error| error.to_string())?;
    fs::create_dir_all(&log_directory).map_err(|error| error.to_string())?;
    let log_directory = command_path(log_directory);
    let mut command = Command::new(&node);
    command.args([&script, "--token", &token, "--log-dir", &log_directory]).stdin(Stdio::null()).stdout(Stdio::piped());
    if cfg!(debug_assertions) {
        command.stderr(Stdio::inherit());
    } else {
        let log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(startup_log_path(app)?)
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
            .timeout(Duration::from_secs(90))
            .build()
            .map_err(|error| format!("Unable to initialize the automation bridge: {error}"))?,
        child: Mutex::new(child),
    })
}

#[cfg(test)]
mod path_tests {
    use super::{command_path, copy_session_profile, google_cookie_domain, safe_log_value, valid_account_id};
    use std::fs;

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
    fn limits_exported_cookies_to_google_domains() {
        assert!(google_cookie_domain(".google.com"));
        assert!(google_cookie_domain("accounts.google.com"));
        assert!(google_cookie_domain("labs.google"));
        assert!(!google_cookie_domain("google.com.example.org"));
        assert!(!google_cookie_domain("example.org"));
    }

    #[test]
    fn session_snapshot_copies_cookie_files_without_cache_data() {
        let root = std::env::temp_dir().join(format!("kuntyy-session-copy-test-{}", uuid::Uuid::new_v4()));
        let source = root.join("source");
        let destination = root.join("destination");
        fs::create_dir_all(source.join("EBWebView/Default/Network")).unwrap();
        fs::create_dir_all(source.join("EBWebView/Default/Cache")).unwrap();
        fs::write(source.join("EBWebView/Local State"), "key").unwrap();
        fs::write(source.join("EBWebView/Default/Network/Cookies"), "cookies").unwrap();
        fs::write(source.join("EBWebView/Default/Cache/large.bin"), "cache").unwrap();

        copy_session_profile(&source, &destination).unwrap();

        assert!(destination.join("EBWebView/Local State").is_file());
        assert!(destination.join("EBWebView/Default/Network/Cookies").is_file());
        assert!(!destination.join("EBWebView/Default/Cache/large.bin").exists());
        fs::remove_dir_all(root).unwrap();
    }
}

#[tauri::command]
async fn sidecar_request(state: tauri::State<'_, AutomationBackend>, method: String, params: Value) -> Result<Value, String> {
    let state = match &*state {
        AutomationBackend::Ready(state) => state,
        AutomationBackend::Unavailable(error) => return Ok(json!({ "ok": false, "error": error })),
    };
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
    install_panic_log();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
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
            prepare_flowpilot_session
        ])
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
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
