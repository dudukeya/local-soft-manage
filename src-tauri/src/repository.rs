use std::{collections::HashSet, fs, path::Path, sync::Arc, time::Duration};

use chrono::{SecondsFormat, Utc};
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension, Row};
use uuid::Uuid;

use crate::{
    domain::{Project, ProjectDraft, ShellKind},
    error::{AppError, AppResult},
};

// 新版项目模型使用独立数据库文件，避免读取旧版多动作表结构。
const DATABASE_FILE_NAME: &str = "soft-manage-v2.sqlite3";

const SCHEMA: &str = r#"
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
    id          TEXT PRIMARY KEY NOT NULL,
    name        TEXT NOT NULL COLLATE NOCASE UNIQUE,
    root_dir    TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    environment TEXT NOT NULL CHECK (environment IN ('powershell', 'cmd')),
    command     TEXT NOT NULL,
    access_path TEXT NOT NULL DEFAULT '',
    category    TEXT NOT NULL DEFAULT '',
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_categories (
    name       TEXT PRIMARY KEY NOT NULL COLLATE NOCASE,
    sort_order INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS project_categories_sort_order
    ON project_categories(sort_order, name COLLATE NOCASE);
"#;

/// SQLite 仓库负责项目与分类配置，启动和终端生命周期由 commands/pty 管理。
#[derive(Clone)]
pub struct Repository {
    connection: Arc<Mutex<Connection>>,
}

impl Repository {
    pub fn open(app_data_dir: impl AsRef<Path>) -> AppResult<Self> {
        let app_data_dir = app_data_dir.as_ref();
        fs::create_dir_all(app_data_dir).map_err(storage_error)?;
        let connection =
            Connection::open(app_data_dir.join(DATABASE_FILE_NAME)).map_err(storage_error)?;
        Self::from_connection(connection, true)
    }

    pub fn in_memory() -> AppResult<Self> {
        Self::from_connection(Connection::open_in_memory().map_err(storage_error)?, false)
    }

    fn from_connection(mut connection: Connection, use_wal: bool) -> AppResult<Self> {
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(storage_error)?;
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(storage_error)?;
        if use_wal {
            connection
                .pragma_update(None, "journal_mode", "WAL")
                .map_err(storage_error)?;
            connection
                .pragma_update(None, "synchronous", "NORMAL")
                .map_err(storage_error)?;
        }
        connection.execute_batch(SCHEMA).map_err(storage_error)?;
        ensure_project_schema(&mut connection)?;
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
        })
    }

    pub fn list_projects(&self) -> AppResult<Vec<Project>> {
        let connection = self.connection.lock();
        let mut statement = connection
            .prepare(
                "SELECT id, name, root_dir, description, environment, command, created_at, updated_at,
                        access_path, category, sort_order
                 FROM projects ORDER BY sort_order, name COLLATE NOCASE, id",
            )
            .map_err(storage_error)?;
        let projects = statement
            .query_map([], project_from_row)
            .map_err(storage_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage_error)?;
        Ok(projects)
    }

    pub fn list_project_categories(&self) -> AppResult<Vec<String>> {
        let connection = self.connection.lock();
        let mut statement = connection
            .prepare(
                "SELECT name FROM project_categories
                 ORDER BY sort_order, name COLLATE NOCASE",
            )
            .map_err(storage_error)?;
        let categories = statement
            .query_map([], |row| row.get(0))
            .map_err(storage_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage_error);
        categories
    }

    pub fn replace_project_categories(&self, categories: &[String]) -> AppResult<Vec<String>> {
        let normalized = normalize_project_categories(categories)?;
        let mut connection = self.connection.lock();
        let tx = connection.transaction().map_err(storage_error)?;
        tx.execute("DELETE FROM project_categories", [])
            .map_err(storage_error)?;
        for (sort_order, category) in normalized.iter().enumerate() {
            tx.execute(
                "INSERT INTO project_categories (name, sort_order) VALUES (?1, ?2)",
                params![category, sort_order as i64],
            )
            .map_err(storage_error)?;
        }
        tx.commit().map_err(storage_error)?;
        Ok(normalized)
    }

    pub fn get_project(&self, project_id: &str) -> AppResult<Project> {
        self.connection
            .lock()
            .query_row(
                "SELECT id, name, root_dir, description, environment, command, created_at, updated_at,
                        access_path, category, sort_order
                 FROM projects WHERE id = ?1",
                [project_id],
                project_from_row,
            )
            .optional()
            .map_err(storage_error)?
            .ok_or_else(|| not_found("项目", project_id))
    }

    pub fn create_project(&self, draft: &ProjectDraft) -> AppResult<Project> {
        draft.validate().map_err(AppError::Validation)?;
        let project_id = Uuid::new_v4().to_string();
        let now = now();
        let connection = self.connection.lock();
        let sort_order: i64 = connection
            .query_row(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM projects",
                [],
                |row| row.get(0),
            )
            .map_err(storage_error)?;
        connection
            .execute(
                "INSERT INTO projects
                 (id, name, root_dir, description, environment, command, access_path, category, sort_order, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
                params![
                    project_id,
                    draft.name.trim(),
                    draft.root_dir.trim(),
                    draft.description.trim(),
                    encode_shell(&draft.environment),
                    draft.command,
                    draft.access_path.trim(),
                    draft.category.trim(),
                    sort_order,
                    now,
                ],
            )
            .map_err(|error| {
                if error.sqlite_error_code() == Some(rusqlite::ErrorCode::ConstraintViolation) {
                    AppError::Conflict(format!("项目名称已存在：{}", draft.name.trim()))
                } else {
                    storage_error(error)
                }
            })?;
        load_project(&connection, &project_id)
    }

    pub fn update_project(&self, project_id: &str, draft: &ProjectDraft) -> AppResult<Project> {
        draft.validate().map_err(AppError::Validation)?;
        let connection = self.connection.lock();
        let changed = connection
            .execute(
                "UPDATE projects
                 SET name = ?2, root_dir = ?3, description = ?4, environment = ?5,
                     command = ?6, access_path = ?7, category = ?8, updated_at = ?9
                 WHERE id = ?1",
                params![
                    project_id,
                    draft.name.trim(),
                    draft.root_dir.trim(),
                    draft.description.trim(),
                    encode_shell(&draft.environment),
                    draft.command,
                    draft.access_path.trim(),
                    draft.category.trim(),
                    now(),
                ],
            )
            .map_err(|error| {
                if error.sqlite_error_code() == Some(rusqlite::ErrorCode::ConstraintViolation) {
                    AppError::Conflict(format!("项目名称已存在：{}", draft.name.trim()))
                } else {
                    storage_error(error)
                }
            })?;
        if changed == 0 {
            return Err(not_found("项目", project_id));
        }
        load_project(&connection, project_id)
    }

    pub fn delete_project(&self, project_id: &str) -> AppResult<()> {
        let connection = self.connection.lock();
        let changed = connection
            .execute("DELETE FROM projects WHERE id = ?1", [project_id])
            .map_err(storage_error)?;
        if changed == 0 {
            return Err(not_found("项目", project_id));
        }
        Ok(())
    }

    pub fn reorder_projects(&self, project_ids: &[String]) -> AppResult<Vec<Project>> {
        let mut connection = self.connection.lock();
        let tx = connection.transaction().map_err(storage_error)?;
        let total: i64 = tx
            .query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))
            .map_err(storage_error)?;
        let mut seen = HashSet::with_capacity(project_ids.len());
        for project_id in project_ids {
            if !seen.insert(project_id) {
                return Err(AppError::Validation("项目排序列表包含重复项目".into()));
            }
            let exists: Option<String> = tx
                .query_row(
                    "SELECT id FROM projects WHERE id = ?1",
                    [project_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(storage_error)?;
            if exists.is_none() {
                return Err(not_found("项目", project_id));
            }
        }
        if total != project_ids.len() as i64 {
            return Err(AppError::Validation("项目排序列表必须包含全部项目".into()));
        }
        for (index, project_id) in project_ids.iter().enumerate() {
            tx.execute(
                "UPDATE projects SET sort_order = ?1 WHERE id = ?2",
                params![index as i64, project_id],
            )
            .map_err(storage_error)?;
        }
        tx.commit().map_err(storage_error)?;
        drop(connection);
        self.list_projects()
    }
}

fn load_project(connection: &Connection, project_id: &str) -> AppResult<Project> {
    connection
        .query_row(
            "SELECT id, name, root_dir, description, environment, command, created_at, updated_at,
                    access_path, category, sort_order
             FROM projects WHERE id = ?1",
            [project_id],
            project_from_row,
        )
        .optional()
        .map_err(storage_error)?
        .ok_or_else(|| not_found("项目", project_id))
}

fn project_from_row(row: &Row<'_>) -> rusqlite::Result<Project> {
    let environment: String = row.get(4)?;
    Ok(Project {
        id: row.get(0)?,
        name: row.get(1)?,
        root_dir: row.get(2)?,
        description: row.get(3)?,
        environment: decode_shell(&environment).map_err(value_from_sql_error)?,
        command: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
        access_path: row.get(8)?,
        category: row.get(9)?,
        sort_order: row.get(10)?,
    })
}

fn ensure_project_schema(connection: &mut Connection) -> AppResult<()> {
    let tx = connection.transaction().map_err(storage_error)?;
    let mut columns = HashSet::new();
    {
        let mut statement = tx
            .prepare("PRAGMA table_info(projects)")
            .map_err(storage_error)?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(storage_error)?;
        for column in rows {
            columns.insert(column.map_err(storage_error)?);
        }
    }
    let mut added_sort_order = false;
    if !columns.contains("access_path") {
        tx.execute(
            "ALTER TABLE projects ADD COLUMN access_path TEXT NOT NULL DEFAULT ''",
            [],
        )
        .map_err(storage_error)?;
    }
    if !columns.contains("category") {
        tx.execute(
            "ALTER TABLE projects ADD COLUMN category TEXT NOT NULL DEFAULT ''",
            [],
        )
        .map_err(storage_error)?;
    }
    if !columns.contains("sort_order") {
        tx.execute(
            "ALTER TABLE projects ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0",
            [],
        )
        .map_err(storage_error)?;
        added_sort_order = true;
    }
    if added_sort_order {
        let ids: Vec<String> = {
            let mut statement = tx
                .prepare("SELECT id FROM projects ORDER BY name COLLATE NOCASE, id")
                .map_err(storage_error)?;
            let rows = statement
                .query_map([], |row| row.get(0))
                .map_err(storage_error)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(storage_error)?
        };
        for (index, project_id) in ids.iter().enumerate() {
            tx.execute(
                "UPDATE projects SET sort_order = ?1 WHERE id = ?2",
                params![index as i64, project_id],
            )
            .map_err(storage_error)?;
        }
    }
    tx.execute_batch(
        "CREATE INDEX IF NOT EXISTS projects_name ON projects(name COLLATE NOCASE, id);
         CREATE INDEX IF NOT EXISTS projects_sort_order ON projects(sort_order, name COLLATE NOCASE, id);",
    )
    .map_err(storage_error)?;
    tx.commit().map_err(storage_error)
}

fn normalize_project_categories(categories: &[String]) -> AppResult<Vec<String>> {
    let mut normalized = Vec::with_capacity(categories.len());
    let mut seen = HashSet::with_capacity(categories.len());
    for category in categories {
        let value = category.trim();
        if value.is_empty() {
            return Err(AppError::Validation("项目分类不能为空".into()));
        }
        if value.chars().count() > 60 {
            return Err(AppError::Validation(
                "项目分类名称不能超过 60 个字符".into(),
            ));
        }
        let key = value.to_lowercase();
        if !seen.insert(key) {
            return Err(AppError::Validation("项目分类名称不能重复".into()));
        }
        normalized.push(value.to_owned());
    }
    Ok(normalized)
}

fn encode_shell(value: &ShellKind) -> &'static str {
    match value {
        ShellKind::Powershell => "powershell",
        ShellKind::Cmd => "cmd",
    }
}

fn decode_shell(value: &str) -> Result<ShellKind, String> {
    match value {
        "powershell" => Ok(ShellKind::Powershell),
        "cmd" => Ok(ShellKind::Cmd),
        _ => Err(format!("未知运行环境：{value}")),
    }
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn not_found(kind: &str, id: &str) -> AppError {
    AppError::NotFound(format!("{kind} {id}"))
}

fn value_from_sql_error(message: String) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        4,
        rusqlite::types::Type::Text,
        Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            message,
        )),
    )
}

fn storage_error(error: impl std::fmt::Display) -> AppError {
    AppError::Storage(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(name: &str, shell: ShellKind, command: &str) -> ProjectDraft {
        ProjectDraft {
            name: name.into(),
            root_dir: r"F:\开发项目\演示".into(),
            description: "本地服务".into(),
            environment: shell,
            access_path: "http://localhost:8887".into(),
            category: "开发".into(),
            command: command.into(),
        }
    }

    #[test]
    fn round_trips_unicode_and_multiline_command() {
        let repository = Repository::in_memory().unwrap();
        let created = repository
            .create_project(&project(
                "小说 API",
                ShellKind::Powershell,
                "$env:PORT=8887\npython server.py",
            ))
            .unwrap();
        let loaded = repository.get_project(&created.id).unwrap();
        assert_eq!(loaded.environment, ShellKind::Powershell);
        assert_eq!(loaded.access_path, "http://localhost:8887");
        assert_eq!(loaded.category, "开发");
        assert_eq!(loaded.command, "$env:PORT=8887\npython server.py");
        assert_eq!(repository.list_projects().unwrap().len(), 1);
    }

    #[test]
    fn updates_project_without_action_records() {
        let repository = Repository::in_memory().unwrap();
        let created = repository
            .create_project(&project("旧名称", ShellKind::Cmd, "echo old"))
            .unwrap();
        let updated = repository
            .update_project(
                &created.id,
                &project("新名称", ShellKind::Powershell, "Write-Output new"),
            )
            .unwrap();
        assert_eq!(updated.name, "新名称");
        assert_eq!(updated.environment, ShellKind::Powershell);
        assert_eq!(updated.command, "Write-Output new");
    }

    #[test]
    fn rejects_duplicate_project_name() {
        let repository = Repository::in_memory().unwrap();
        repository
            .create_project(&project("重复", ShellKind::Cmd, "echo 1"))
            .unwrap();
        let result = repository.create_project(&project("重复", ShellKind::Cmd, "echo 2"));
        assert!(matches!(result, Err(AppError::Conflict(_))));
    }

    #[test]
    fn persists_explicit_project_order() {
        let repository = Repository::in_memory().unwrap();
        let first = repository
            .create_project(&project("一", ShellKind::Cmd, "echo 1"))
            .unwrap();
        let second = repository
            .create_project(&project("二", ShellKind::Cmd, "echo 2"))
            .unwrap();
        let third = repository
            .create_project(&project("三", ShellKind::Cmd, "echo 3"))
            .unwrap();
        repository
            .reorder_projects(&[third.id.clone(), first.id.clone(), second.id.clone()])
            .unwrap();
        let names = repository
            .list_projects()
            .unwrap()
            .into_iter()
            .map(|item| item.name)
            .collect::<Vec<_>>();
        assert_eq!(names, ["三", "一", "二"]);
    }

    #[test]
    fn persists_project_categories_in_configured_order() {
        let repository = Repository::in_memory().unwrap();
        let categories = vec!["服务".to_owned(), "工具".to_owned(), "AI".to_owned()];

        assert_eq!(
            repository.replace_project_categories(&categories).unwrap(),
            categories
        );
        assert_eq!(repository.list_project_categories().unwrap(), categories);

        let replacement = vec!["开发".to_owned()];
        repository.replace_project_categories(&replacement).unwrap();
        assert_eq!(repository.list_project_categories().unwrap(), replacement);
    }

    #[test]
    fn rejects_invalid_project_categories() {
        let repository = Repository::in_memory().unwrap();
        assert!(matches!(
            repository.replace_project_categories(&[" ".to_owned()]),
            Err(AppError::Validation(_))
        ));
        assert!(matches!(
            repository.replace_project_categories(&["开发".to_owned(), "开发".to_owned()]),
            Err(AppError::Validation(_))
        ));
        assert!(matches!(
            repository.replace_project_categories(&["x".repeat(61)]),
            Err(AppError::Validation(_))
        ));
    }

    #[test]
    fn migrates_existing_database_with_old_project_columns() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE projects (
                    id TEXT PRIMARY KEY NOT NULL,
                    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
                    root_dir TEXT NOT NULL,
                    description TEXT NOT NULL DEFAULT '',
                    environment TEXT NOT NULL,
                    command TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO projects (id, name, root_dir, environment, command, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                params!["old-1", "B项目", r"F:\\b", "cmd", "echo b", "2026-01-01T00:00:00Z"],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO projects (id, name, root_dir, environment, command, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                params!["old-2", "A项目", r"F:\\a", "cmd", "echo a", "2026-01-01T00:00:00Z"],
            )
            .unwrap();
        let repository = Repository::from_connection(connection, false).unwrap();
        let projects = repository.list_projects().unwrap();
        assert_eq!(
            projects
                .iter()
                .map(|item| item.name.as_str())
                .collect::<Vec<_>>(),
            ["A项目", "B项目"]
        );
        assert!(projects
            .iter()
            .all(|item| item.access_path.is_empty() && item.category.is_empty()));
        assert_eq!(
            projects
                .iter()
                .map(|item| item.sort_order)
                .collect::<Vec<_>>(),
            [0, 1]
        );
    }
}
