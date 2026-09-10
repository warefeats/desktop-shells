// The Tauri host: the command surface and nothing else. Every command is the
// shell's documented idiom; the raw path uses tauri::ipc::Request/Response and
// Channel, which is what Tauri's docs recommend for large payloads.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody, Request, Response};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Serialize, Deserialize)]
struct Nested {
    a: u64,
    b: bool,
    c: String,
}

#[derive(Serialize, Deserialize)]
struct Row {
    id: u64,
    x: f64,
    y: f64,
    z: f64,
    s: String,
    nested: Nested,
}

#[derive(Serialize)]
struct Info {
    shell: &'static str,
    #[serde(rename = "shellVersion")]
    shell_version: String,
    webview: String,
    mode: String,
    params: serde_json::Value,
}

#[derive(Serialize, Clone)]
struct PushEvent {
    seq: u32,
    t: f64,
    s: String,
}

struct Bench {
    mode: String,
    params: serde_json::Value,
    out: Option<String>,
    started: Instant,
}

fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs_f64() * 1000.0
}

#[tauri::command]
fn info(state: State<'_, Mutex<Bench>>) -> Info {
    let b = state.lock().unwrap();
    Info {
        shell: "tauri",
        shell_version: tauri::VERSION.to_string(),
        webview: tauri::webview_version().unwrap_or_else(|_| "unknown".into()),
        mode: b.mode.clone(),
        params: b.params.clone(),
    }
}

#[tauri::command]
fn first_frame(state: State<'_, Mutex<Bench>>) {
    let b = state.lock().unwrap();
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "FIRST_FRAME {} {}", now_ms(), b.started.elapsed().as_secs_f64() * 1000.0);
    let _ = out.flush();
}

#[tauri::command]
fn report(json: String, state: State<'_, Mutex<Bench>>) -> Result<(), String> {
    let b = state.lock().unwrap();
    match &b.out {
        Some(path) => std::fs::write(path, json).map_err(|e| e.to_string()),
        None => {
            println!("REPORT {json}");
            Ok(())
        }
    }
}

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn log(msg: String) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "LOG {msg}");
    let _ = out.flush();
}

#[tauri::command]
fn rows(rows: Vec<Row>) -> Vec<Row> {
    rows
}

#[tauri::command]
fn bytes(request: Request<'_>) -> Result<Response, String> {
    match request.body() {
        InvokeBody::Raw(b) => Ok(Response::new(b.clone())),
        InvokeBody::Json(_) => Err("expected raw body".into()),
    }
}

fn pace<F: FnMut(u32)>(rate: u32, count: u32, mut f: F) {
    let interval = Duration::from_secs_f64(1.0 / rate as f64);
    let start = Instant::now();
    for seq in 0..count {
        let deadline = start + interval * seq;
        let now = Instant::now();
        if deadline > now {
            std::thread::sleep(deadline - now);
        }
        f(seq);
    }
}

#[tauri::command]
fn push_start(app: AppHandle, rate: u32, size: usize, count: u32) {
    std::thread::spawn(move || {
        let s: String = std::iter::repeat('x').take(size).collect();
        pace(rate, count, |seq| {
            let _ = app.emit("push", PushEvent { seq, t: now_ms(), s: s.clone() });
        });
    });
}

#[tauri::command]
fn push_raw_start(channel: Channel<InvokeResponseBody>, rate: u32, size: usize, count: u32) {
    std::thread::spawn(move || {
        let mut buf = vec![0u8; size.max(4)];
        pace(rate, count, |seq| {
            buf[..4].copy_from_slice(&seq.to_le_bytes());
            let _ = channel.send(InvokeResponseBody::Raw(buf.clone()));
        });
    });
}

fn main() {
    let started = Instant::now();
    let mode = std::env::var("BENCH_MODE").unwrap_or_else(|_| "start".into());
    let params = std::env::var("BENCH_PARAMS")
        .ok()
        .and_then(|p| serde_json::from_str(&p).ok())
        .unwrap_or(serde_json::json!({}));
    let out = std::env::var("BENCH_OUT").ok();
    tauri::Builder::default()
        .manage(Mutex::new(Bench { mode, params, out, started }))
        .invoke_handler(tauri::generate_handler![
            info, first_frame, report, quit, log, rows, bytes, push_start, push_raw_start
        ])
        .setup(|app| {
            let _ = app.get_webview_window("main");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
