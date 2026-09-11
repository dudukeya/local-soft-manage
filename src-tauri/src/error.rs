use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Validation(String),
    #[error("未找到：{0}")]
    NotFound(String),
    #[error("当前状态不允许此操作：{0}")]
    Conflict(String),
    #[error("系统操作失败：{0}")]
    System(String),
    #[error("数据存储失败：{0}")]
    Storage(String),
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
