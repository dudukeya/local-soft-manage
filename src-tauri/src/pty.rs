//! 应用内交互终端。
//!
//! 每个项目拥有一个由 portable-pty 创建的独立 ConPTY/native PTY。前端只负责
//! xterm 渲染和输入转发，项目命令由后端写入对应 Shell，因此多行命令和脚本
//! 可以在同一个真实终端中按原顺序执行。

use std::{
    collections::HashMap,
    io::{Read, Write},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
};

use parking_lot::Mutex;
use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    domain::ShellKind,
    error::{AppError, AppResult},
};

const DEFAULT_COLS: u16 = 120;
const DEFAULT_ROWS: u16 = 32;
const MAX_COLS: u16 = 5_000;
const MAX_ROWS: u16 = 5_000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTerminalRequest {
    pub project_id: String,
    /// 手动打开终端时可覆盖项目默认环境（例如左栏的“启动 CMD”按钮）。
    #[serde(default)]
    pub shell: Option<ShellKind>,
    #[serde(default)]
    pub cols: Option<u16>,
    #[serde(default)]
    pub rows: Option<u16>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StandaloneTerminalRequest {
    pub shell: ShellKind,
    #[serde(default)]
    pub cols: Option<u16>,
    #[serde(default)]
    pub rows: Option<u16>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSession {
    pub terminal_id: String,
    pub project_id: Option<String>,
    pub shell: ShellKind,
    pub working_dir: String,
    pub cols: u16,
    pub rows: u16,
    pub pid: Option<u32>,
}

#[derive(Debug, Clone)]
pub enum TerminalEvent {
    Output {
        terminal_id: String,
        data: String,
    },
    Exit {
        terminal_id: String,
        exit_code: Option<i32>,
        signal: Option<String>,
    },
}

type EventSink = Arc<dyn Fn(TerminalEvent) + Send + Sync + 'static>;

#[derive(Clone)]
pub struct EmbeddedTerminalManager {
    inner: Arc<ManagerInner>,
}

struct ManagerInner {
    sessions: Mutex<HashMap<String, Arc<TerminalEntry>>>,
    create_lock: Mutex<()>,
    sink: EventSink,
}

impl Drop for ManagerInner {
    fn drop(&mut self) {
        for entry in self.sessions.get_mut().values() {
            entry.closed.store(true, Ordering::Release);
            let _ = entry.killer.lock().kill();
        }
        self.sessions.get_mut().clear();
    }
}

struct TerminalEntry {
    session: TerminalSession,
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send>>,
    closed: AtomicBool,
}

impl EmbeddedTerminalManager {
    pub fn new<S>(sink: S) -> Self
    where
        S: Fn(TerminalEvent) + Send + Sync + 'static,
    {
        Self {
            inner: Arc::new(ManagerInner {
                sessions: Mutex::new(HashMap::new()),
                create_lock: Mutex::new(()),
                sink: Arc::new(sink),
            }),
        }
    }

    /// 创建或复用同一项目的终端，确保一个项目始终只有一个独立 Shell。
    pub fn create(&self, spec: TerminalLaunchSpec) -> AppResult<TerminalSession> {
        validate_spec(&spec)?;
        let cols = spec.cols.unwrap_or(DEFAULT_COLS);
        let rows = spec.rows.unwrap_or(DEFAULT_ROWS);
        validate_size(cols, rows)?;

        let _create_guard = self.inner.create_lock.lock();

        if let Some(project_id) = spec.project_id.as_deref() {
            if let Some(existing) = self.inner.sessions.lock().values().find(|entry| {
                entry.session.project_id.as_deref() == Some(project_id)
                    && !entry.closed.load(Ordering::Acquire)
            }) {
                if existing.session.shell == spec.shell {
                    return Ok(existing.session.clone());
                }
                self.close_entry(existing);
            }
        }

        let pair = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| AppError::System(format!("创建 PTY 失败：{error}")))?;
        let child = pair
            .slave
            .spawn_command(build_command(&spec)?)
            .map_err(|error| AppError::System(format!("启动终端进程失败：{error}")))?;
        let pid = child.process_id();
        let killer = child.clone_killer();
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| AppError::System(format!("打开终端输出失败：{error}")))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| AppError::System(format!("打开终端输入失败：{error}")))?;

        let terminal_id = Uuid::new_v4().to_string();
        let session = TerminalSession {
            terminal_id: terminal_id.clone(),
            project_id: spec.project_id,
            shell: spec.shell,
            working_dir: spec.working_dir.to_string_lossy().into_owned(),
            cols,
            rows,
            pid,
        };
        let entry = Arc::new(TerminalEntry {
            session: session.clone(),
            writer: Mutex::new(writer),
            master: Mutex::new(pair.master),
            killer: Mutex::new(killer),
            closed: AtomicBool::new(false),
        });
        self.inner
            .sessions
            .lock()
            .insert(terminal_id.clone(), Arc::clone(&entry));
        self.spawn_reader(terminal_id, reader);
        self.spawn_waiter(entry, child);
        Ok(session)
    }

    pub fn write(&self, terminal_id: &str, data: &str) -> AppResult<()> {
        if data.is_empty() {
            return Ok(());
        }
        let entry = self.entry(terminal_id)?;
        if entry.closed.load(Ordering::Acquire) {
            return Err(AppError::Conflict("终端会话已经结束".into()));
        }
        let mut writer = entry.writer.lock();
        writer
            .write_all(data.as_bytes())
            .and_then(|_| writer.flush())
            .map_err(|error| AppError::System(format!("写入终端失败：{error}")))
    }

    /// 将配置中的多行命令原样写入 Shell，并补一个执行换行。
    pub fn run_command(&self, terminal_id: &str, command: &str) -> AppResult<()> {
        let normalized = command.replace("\r\n", "\n").replace('\r', "\n");
        let mut input = normalized.replace('\n', "\r\n");
        if !input.ends_with("\r\n") {
            input.push_str("\r\n");
        }
        self.write(terminal_id, &input)
    }

    /// 向正在运行的命令发送 Ctrl+C，保持 Shell 会话可继续输入。
    pub fn interrupt(&self, terminal_id: &str) -> AppResult<()> {
        self.write(terminal_id, "\u{3}")
    }

    pub fn project_session(&self, project_id: &str) -> AppResult<TerminalSession> {
        self.inner
            .sessions
            .lock()
            .values()
            .find(|entry| {
                entry.session.project_id.as_deref() == Some(project_id)
                    && !entry.closed.load(Ordering::Acquire)
            })
            .map(|entry| entry.session.clone())
            .ok_or_else(|| AppError::NotFound(format!("项目终端 {project_id}")))
    }

    pub fn interrupt_project(&self, project_id: &str) -> AppResult<()> {
        let session = self.project_session(project_id)?;
        self.interrupt(&session.terminal_id)
    }

    pub fn resize(&self, terminal_id: &str, cols: u16, rows: u16) -> AppResult<()> {
        validate_size(cols, rows)?;
        let entry = self.entry(terminal_id)?;
        if entry.closed.load(Ordering::Acquire) {
            return Err(AppError::Conflict("终端会话已经结束".into()));
        }
        let result = entry
            .master
            .lock()
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| AppError::System(format!("调整终端尺寸失败：{error}")))?;
        Ok(result)
    }

    pub fn close(&self, terminal_id: &str) -> AppResult<()> {
        let entry = self.entry(terminal_id)?;
        self.close_entry(&entry);
        Ok(())
    }

    pub fn close_all(&self) {
        let entries: Vec<_> = self.inner.sessions.lock().values().cloned().collect();
        for entry in entries {
            self.close_entry(&entry);
        }
    }

    pub fn close_project(&self, project_id: &str) {
        let entries: Vec<_> = self
            .inner
            .sessions
            .lock()
            .values()
            .filter(|entry| entry.session.project_id.as_deref() == Some(project_id))
            .cloned()
            .collect();
        for entry in entries {
            self.close_entry(&entry);
        }
    }

    pub fn get(&self, terminal_id: &str) -> AppResult<TerminalSession> {
        Ok(self.entry(terminal_id)?.session.clone())
    }

    fn entry(&self, terminal_id: &str) -> AppResult<Arc<TerminalEntry>> {
        self.inner
            .sessions
            .lock()
            .get(terminal_id)
            .cloned()
            .ok_or_else(|| AppError::NotFound(format!("终端会话 {terminal_id}")))
    }

    fn close_entry(&self, entry: &Arc<TerminalEntry>) {
        if entry.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        let _ = entry.killer.lock().kill();
        self.inner
            .sessions
            .lock()
            .remove(&entry.session.terminal_id);
    }

    fn spawn_reader(&self, terminal_id: String, mut reader: Box<dyn Read + Send>) {
        let sink = Arc::clone(&self.inner.sink);
        thread::spawn(move || {
            let mut buffer = [0u8; 16 * 1024];
            let mut pending = Vec::new();
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(size) => {
                        pending.extend_from_slice(&buffer[..size]);
                        emit_utf8_chunks(&sink, &terminal_id, &mut pending);
                    }
                    Err(_) => break,
                }
            }
            if !pending.is_empty() {
                sink(TerminalEvent::Output {
                    terminal_id,
                    data: String::from_utf8_lossy(&pending).into_owned(),
                });
            }
        });
    }

    fn spawn_waiter(&self, entry: Arc<TerminalEntry>, mut child: Box<dyn Child + Send>) {
        let inner = Arc::downgrade(&self.inner);
        thread::spawn(move || {
            let exit_code = child.wait().ok().map(|status| status.exit_code() as i32);
            if let Some(inner) = inner.upgrade() {
                if !entry.closed.swap(true, Ordering::AcqRel) {
                    inner.sessions.lock().remove(&entry.session.terminal_id);
                    (inner.sink)(TerminalEvent::Exit {
                        terminal_id: entry.session.terminal_id.clone(),
                        exit_code,
                        signal: None,
                    });
                }
            }
        });
    }
}

fn emit_utf8_chunks(sink: &EventSink, terminal_id: &str, pending: &mut Vec<u8>) {
    loop {
        match std::str::from_utf8(pending) {
            Ok(text) => {
                if !text.is_empty() {
                    sink(TerminalEvent::Output {
                        terminal_id: terminal_id.to_owned(),
                        data: text.to_owned(),
                    });
                }
                pending.clear();
                return;
            }
            Err(error) => {
                let valid = error.valid_up_to();
                if valid > 0 {
                    sink(TerminalEvent::Output {
                        terminal_id: terminal_id.to_owned(),
                        data: String::from_utf8_lossy(&pending[..valid]).into_owned(),
                    });
                    pending.drain(..valid);
                    continue;
                }
                let Some(error_len) = error.error_len() else {
                    return;
                };
                let invalid_end = error_len.min(pending.len());
                sink(TerminalEvent::Output {
                    terminal_id: terminal_id.to_owned(),
                    data: String::from_utf8_lossy(&pending[..invalid_end]).into_owned(),
                });
                pending.drain(..invalid_end);
            }
        }
    }
}

#[derive(Debug, Clone)]
pub struct TerminalLaunchSpec {
    pub project_id: Option<String>,
    pub shell: ShellKind,
    pub working_dir: PathBuf,
    pub env: std::collections::BTreeMap<String, String>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}

fn build_command(spec: &TerminalLaunchSpec) -> AppResult<CommandBuilder> {
    let mut command = match spec.shell {
        ShellKind::Powershell => {
            let mut command = CommandBuilder::new(locate_powershell()?);
            command.args(["-NoLogo", "-NoProfile", "-NoExit"]);
            command
        }
        ShellKind::Cmd => {
            let mut command = CommandBuilder::new("cmd.exe");
            // /k 保持 Shell 常驻，用户切换项目选项卡时会话和历史仍然存在。
            command.args(["/d", "/k"]);
            command
        }
    };
    command.cwd(&spec.working_dir);
    for (key, value) in &spec.env {
        command.env(key, value);
    }
    Ok(command)
}

fn locate_powershell() -> AppResult<PathBuf> {
    which::which("pwsh.exe")
        .or_else(|_| which::which("powershell.exe"))
        .map_err(|_| AppError::NotFound("未找到 pwsh.exe 或 powershell.exe".into()))
}

fn validate_spec(spec: &TerminalLaunchSpec) -> AppResult<()> {
    if spec.working_dir.as_os_str().is_empty() {
        return Err(AppError::Validation("终端工作目录不能为空".into()));
    }
    Ok(())
}

fn validate_size(cols: u16, rows: u16) -> AppResult<()> {
    if cols == 0 || rows == 0 || cols > MAX_COLS || rows > MAX_ROWS {
        return Err(AppError::Validation(format!(
            "终端尺寸无效：列数需为 1-{MAX_COLS}，行数需为 1-{MAX_ROWS}"
        )));
    }
    Ok(())
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::{
        sync::mpsc::channel,
        time::{Duration, Instant},
    };

    #[test]
    fn cmd_pty_emits_output_and_exit() {
        let (events_tx, events_rx) = channel();
        let manager = EmbeddedTerminalManager::new(move |event| {
            let _ = events_tx.send(event);
        });
        let session = manager
            .create(TerminalLaunchSpec {
                project_id: Some("project-1".into()),
                shell: ShellKind::Cmd,
                working_dir: std::env::current_dir().unwrap(),
                env: Default::default(),
                cols: Some(80),
                rows: Some(24),
            })
            .unwrap();
        manager.resize(&session.terminal_id, 100, 30).unwrap();
        manager
            .run_command(&session.terminal_id, "echo SOFT_MANAGE_PTY_OK")
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut output = String::new();
        while Instant::now() < deadline {
            match events_rx.recv_timeout(Duration::from_millis(100)) {
                Ok(TerminalEvent::Output { data, .. }) => {
                    if data.contains("\x1b[6n") {
                        manager.write(&session.terminal_id, "\x1b[1;1R").unwrap();
                    }
                    output.push_str(&data);
                }
                Ok(TerminalEvent::Exit { .. }) => break,
                Err(_) => {}
            }
            if output.contains("SOFT_MANAGE_PTY_OK") {
                break;
            }
        }
        assert!(output.contains("SOFT_MANAGE_PTY_OK"), "终端输出：{output}");
        manager.close(&session.terminal_id).unwrap();
    }
}
