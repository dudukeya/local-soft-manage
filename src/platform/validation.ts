import type { ProjectDraft, ValidationResult } from "./contracts";

export function validateProjectDraft(draft: ProjectDraft): ValidationResult {
  const errors: Record<string, string> = {};
  if (!draft.name.trim()) errors.name = "请输入项目名称";
  if (!draft.rootDir.trim()) errors.rootDir = "请选择项目目录";
  if (!draft.command.trim()) errors.command = "请输入执行命令";
  if (draft.command.length > 32_768) errors.command = "执行命令不能超过 32768 个字符";
  if (draft.accessPath.trim()) {
    if (draft.accessPath.length > 2_048) errors.accessPath = "访问路径不能超过 2048 个字符";
    try {
      const url = new URL(draft.accessPath.trim());
      if (!url.hostname || !["http:", "https:"].includes(url.protocol)) throw new Error("invalid");
    } catch {
      errors.accessPath = "请输入有效的 http 或 https 访问路径";
    }
  }
  if (draft.category.length > 120) errors.category = "项目分类不能超过 120 个字符";
  return { ok: Object.keys(errors).length === 0, errors };
}
