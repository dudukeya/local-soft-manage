use serde::{Deserialize, Serialize};

/// 项目启动时使用的命令行环境。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ShellKind {
    Powershell,
    Cmd,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDraft {
    pub name: String,
    pub root_dir: String,
    pub description: String,
    pub environment: ShellKind,
    pub access_path: String,
    pub category: String,
    pub command: String,
}

impl ProjectDraft {
    pub fn validate(&self) -> Result<(), String> {
        validate_non_empty_bounded(&self.name, "项目名称", 120)?;
        validate_non_empty_bounded(&self.root_dir, "项目目录", 2_048)?;
        validate_bounded(&self.description, "项目说明", 4_096)?;
        validate_bounded(&self.access_path, "访问路径", 2_048)?;
        if !self.access_path.trim().is_empty() && !is_http_url(&self.access_path) {
            return Err("访问路径必须是有效的 http 或 https 地址".into());
        }
        validate_bounded(&self.category, "项目分类", 120)?;
        validate_non_empty_bounded(&self.command, "执行命令", 32_768)?;
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub root_dir: String,
    pub description: String,
    pub environment: ShellKind,
    pub access_path: String,
    pub category: String,
    pub command: String,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

fn validate_non_empty_bounded(value: &str, field: &str, max_chars: usize) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("请输入{field}"));
    }
    validate_bounded(value, field, max_chars)
}

fn validate_bounded(value: &str, field: &str, max_chars: usize) -> Result<(), String> {
    if value.chars().count() > max_chars {
        return Err(format!("{field}长度不能超过 {max_chars} 个字符"));
    }
    Ok(())
}

fn is_http_url(value: &str) -> bool {
    let value = value.trim();
    if value.is_empty()
        || value
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
    {
        return false;
    }
    let Some((scheme, rest)) = value.split_once("://") else {
        return false;
    };
    if !matches!(scheme.to_ascii_lowercase().as_str(), "http" | "https") {
        return false;
    }
    !rest
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default()
        .is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn draft(command: &str) -> ProjectDraft {
        ProjectDraft {
            name: "开发服务".into(),
            root_dir: r"F:\开发项目\演示".into(),
            description: "本地服务".into(),
            environment: ShellKind::Powershell,
            access_path: "http://localhost:8887".into(),
            category: "开发".into(),
            command: command.into(),
        }
    }

    #[test]
    fn validates_multiline_command_and_unicode_path() {
        let value = draft("$env:PORT=8887\npython server.py");
        assert!(value.validate().is_ok());
    }

    #[test]
    fn rejects_empty_command() {
        let value = draft("\n  ");
        assert_eq!(value.validate(), Err("请输入执行命令".into()));
    }

    #[test]
    fn rejects_oversized_command() {
        let value = draft(&"x".repeat(32_769));
        assert!(value.validate().is_err());
    }

    #[test]
    fn rejects_invalid_access_path() {
        let mut value = draft("echo ok");
        value.access_path = "file:///tmp/demo".into();
        assert_eq!(
            value.validate(),
            Err("访问路径必须是有效的 http 或 https 地址".into())
        );
    }
}
