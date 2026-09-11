use std::{path::PathBuf, process::Command};

use tauri::State;

use crate::{
    domain::{Project, ProjectDraft},
    error::{AppError, AppResult},
    pty::{
        CreateTerminalRequest, EmbeddedTerminalManager, StandaloneTerminalRequest,
        TerminalLaunchSpec, TerminalSession,
    },
    repository::Repository,
};

/// 应用状态只包含项目仓库和应用内终端管理器。
pub struct AppState {
    pub repository: Repository,
    pub terminals: EmbeddedTerminalManager,
}

impl AppState {
    pub fn new(repository: Repository, terminals: EmbeddedTerminalManager) -> Self {
        Self {
            repository,
            terminals,
        }
    }
}

#[tauri::command]
pub fn list_projects(state: State<'_, AppState>) -> AppResult<Vec<Project>> {
    state.repository.list_projects()
}

#[tauri::command]
pub fn list_project_categories(state: State<'_, AppState>) -> AppResult<Vec<String>> {
    state.repository.list_project_categories()
}

#[tauri::command]
pub fn save_project_categories(
    state: State<'_, AppState>,
    categories: Vec<String>,
) -> AppResult<Vec<String>> {
    state.repository.replace_project_categories(&categories)
}

#[tauri::command]
pub fn create_project(state: State<'_, AppState>, draft: ProjectDraft) -> AppResult<Project> {
    state.repository.create_project(&draft)
}

#[tauri::command]
pub fn update_project(
    state: State<'_, AppState>,
    project_id: String,
    draft: ProjectDraft,
) -> AppResult<Project> {
    let project = state.repository.update_project(&project_id, &draft)?;
    // 配置修改后关闭旧 Shell，下一次启动使用新的目录、环境和命令。
    state.terminals.close_project(&project_id);
    Ok(project)
}

#[tauri::command]
pub fn delete_project(state: State<'_, AppState>, project_id: String) -> AppResult<()> {
    state.terminals.close_project(&project_id);
    state.repository.delete_project(&project_id)
}

#[tauri::command]
pub fn reorder_projects(
    state: State<'_, AppState>,
    project_ids: Vec<String>,
) -> AppResult<Vec<Project>> {
    state.repository.reorder_projects(&project_ids)
}

/// 使用系统默认浏览器打开项目访问路径。
#[tauri::command]
pub fn open_url(url: String) -> AppResult<()> {
    let url = url.trim();
    if !is_http_url(url) {
        return Err(AppError::Validation(
            "访问路径必须是有效的 http 或 https 地址".into(),
        ));
    }
    #[cfg(target_os = "windows")]
    let result = Command::new("rundll32.exe")
        .args(["url.dll,FileProtocolHandler", url])
        .spawn();
    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg(url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = Command::new("xdg-open").arg(url).spawn();
    result
        .map(|_| ())
        .map_err(|error| AppError::System(format!("无法打开默认浏览器：{error}")))
}

fn is_http_url(url: &str) -> bool {
    if url.is_empty()
        || url
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
    {
        return false;
    }
    let Some((scheme, rest)) = url.split_once("://") else {
        return false;
    };
    if !matches!(scheme.to_ascii_lowercase().as_str(), "http" | "https") {
        return false;
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    !authority.is_empty()
}

/// 创建项目对应的真实 Shell。创建只打开终端，不会自动执行项目命令。
#[tauri::command]
pub fn create_terminal(
    state: State<'_, AppState>,
    request: CreateTerminalRequest,
) -> AppResult<TerminalSession> {
    let project = state.repository.get_project(&request.project_id)?;
    state.terminals.create(TerminalLaunchSpec {
        project_id: Some(project.id),
        shell: request.shell.unwrap_or(project.environment),
        working_dir: PathBuf::from(project.root_dir),
        env: Default::default(),
        cols: request.cols,
        rows: request.rows,
    })
}

/// 创建使用系统默认工作目录的独立 Shell，不关联任何项目。
#[tauri::command]
pub fn create_standalone_terminal(
    state: State<'_, AppState>,
    request: StandaloneTerminalRequest,
) -> AppResult<TerminalSession> {
    let working_dir = std::env::current_dir()
        .map_err(|error| AppError::System(format!("获取默认终端工作目录失败：{error}")))?;
    state.terminals.create(TerminalLaunchSpec {
        project_id: None,
        shell: request.shell,
        working_dir,
        env: Default::default(),
        cols: request.cols,
        rows: request.rows,
    })
}

/// 将项目配置中的多行命令写入该项目终端并执行。
#[tauri::command]
pub fn start_project(state: State<'_, AppState>, project_id: String) -> AppResult<TerminalSession> {
    let project = state.repository.get_project(&project_id)?;
    let session = match state.terminals.project_session(&project.id) {
        Ok(session) => session,
        Err(AppError::NotFound(_)) => state.terminals.create(TerminalLaunchSpec {
            project_id: Some(project.id.clone()),
            shell: project.environment.clone(),
            working_dir: PathBuf::from(&project.root_dir),
            env: Default::default(),
            cols: None,
            rows: None,
        })?,
        Err(error) => return Err(error),
    };
    state
        .terminals
        .run_command(&session.terminal_id, &project.command)?;
    Ok(session)
}

/// 向项目终端发送 Ctrl+C，停止当前服务但保留 Shell 会话。
#[tauri::command]
pub fn stop_project(state: State<'_, AppState>, project_id: String) -> AppResult<()> {
    match state.terminals.interrupt_project(&project_id) {
        Ok(()) | Err(AppError::NotFound(_)) => Ok(()),
        Err(error) => Err(error),
    }
}

/// 先中断当前项目命令，再在原终端重新执行配置中的命令。
#[tauri::command]
pub fn restart_project(
    state: State<'_, AppState>,
    project_id: String,
) -> AppResult<TerminalSession> {
    match state.terminals.interrupt_project(&project_id) {
        Ok(()) | Err(AppError::NotFound(_)) => {}
        Err(error) => return Err(error),
    }
    start_project(state, project_id)
}

#[tauri::command]
pub fn write_terminal(
    state: State<'_, AppState>,
    terminal_id: String,
    data: String,
) -> AppResult<()> {
    state.terminals.write(&terminal_id, &data)
}

#[tauri::command]
pub fn resize_terminal(
    state: State<'_, AppState>,
    terminal_id: String,
    cols: u16,
    rows: u16,
) -> AppResult<()> {
    state.terminals.resize(&terminal_id, cols, rows)
}

#[tauri::command]
pub fn close_terminal(state: State<'_, AppState>, terminal_id: String) -> AppResult<()> {
    state.terminals.close(&terminal_id)
}

#[cfg(test)]
mod tests {
    use super::is_http_url;

    #[test]
    fn only_accepts_http_urls_with_an_authority() {
        assert!(is_http_url("http://localhost:8887"));
        assert!(is_http_url("HTTPS://example.com/path"));
        assert!(!is_http_url("file:///tmp/app"));
        assert!(!is_http_url("https:///missing-host"));
        assert!(!is_http_url("https://example.com\r\n&whoami"));
    }
}
