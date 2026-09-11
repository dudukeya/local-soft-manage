import { useEffect, useState, type FormEvent } from "react";
import { FolderOpen, Save } from "lucide-react";
import type { Project, ProjectDraft, ShellKind } from "../../platform/contracts";
import { desktopApi, type DesktopApi } from "../../platform/desktopApi";
import { validateProjectDraft } from "../../platform/validation";
import { DEFAULT_PROJECT_CATEGORIES } from "../settings/SettingsDialog";
import "../../styles/project-form.css";

export interface ProjectFormProps {
  project?: Project;
  api?: DesktopApi;
  onSaved?: (project: Project) => void;
  onCancel?: () => void;
  categories?: string[];
}

const EMPTY_DRAFT: ProjectDraft = {
  name: "",
  rootDir: "",
  description: "",
  environment: "powershell",
  accessPath: "",
  category: "",
  command: "",
};

export function ProjectForm({ project, api = desktopApi, onSaved, onCancel, categories = DEFAULT_PROJECT_CATEGORIES }: ProjectFormProps) {
  const [draft, setDraft] = useState<ProjectDraft>(() => toDraft(project, categories));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const categoryOptions = categories;

  useEffect(() => {
    setDraft(toDraft(project, categories));
    setErrors({});
    setMessage(null);
  }, [categories, project]);

  const update = <K extends keyof ProjectDraft>(field: K, value: ProjectDraft[K]) => {
    setDraft((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: "" }));
    setMessage(null);
  };

  const chooseDirectory = async () => {
    try {
      const selected = await api.selectDirectory();
      if (selected) update("rootDir", selected);
    } catch (reason) {
      setMessage(errorMessage(reason));
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const normalized: ProjectDraft = {
      ...draft,
      name: draft.name.trim(),
      rootDir: draft.rootDir.trim(),
      description: draft.description.trim(),
      accessPath: draft.accessPath.trim(),
      category: draft.category.trim(),
      command: draft.command.replace(/\r\n?/g, "\n").trim(),
    };
    const validation = validateProjectDraft(normalized);
    if (!validation.ok) {
      setErrors(validation.errors);
      setMessage("请先修正标红字段");
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const saved = project
        ? await api.updateProject(project.id, normalized)
        : await api.createProject(normalized);
      onSaved?.(saved);
    } catch (reason) {
      setMessage(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="project-form" onSubmit={submit}>
      <div className="project-form__grid">
        <label className="project-field">
          <span>项目名称 <b>*</b></span>
          <input value={draft.name} onChange={(event) => update("name", event.target.value)} placeholder="例如：web2api" aria-label="项目名称" aria-invalid={Boolean(errors.name)} />
          {errors.name && <small className="field-error">{errors.name}</small>}
        </label>
        <label className="project-field">
          <span>项目分类</span>
          <select value={draft.category} onChange={(event) => update("category", event.target.value)} aria-label="项目分类">
            <option value="">未分类</option>
            {categoryOptions.map((category) => <option value={category} key={category}>{category}</option>)}
          </select>
          {errors.category && <small className="field-error">{errors.category}</small>}
        </label>
        <label className="project-field">
          <span>运行环境 <b>*</b></span>
          <select value={draft.environment} onChange={(event) => update("environment", event.target.value as ShellKind)} aria-label="运行环境">
            <option value="powershell">PowerShell</option>
            <option value="cmd">CMD</option>
          </select>
        </label>
        <label className="project-field">
          <span>访问路径</span>
          <input value={draft.accessPath} onChange={(event) => update("accessPath", event.target.value)} placeholder="例如：http://localhost:8887" aria-label="访问路径" aria-invalid={Boolean(errors.accessPath)} />
          {errors.accessPath && <small className="field-error">{errors.accessPath}</small>}
        </label>
        <label className="project-field project-field--wide">
          <span>项目目录 <b>*</b></span>
          <div className="project-field__with-button">
            <input value={draft.rootDir} onChange={(event) => update("rootDir", event.target.value)} placeholder="D:\\projects\\my-service" aria-label="项目目录" aria-invalid={Boolean(errors.rootDir)} />
            <button type="button" className="secondary-button" onClick={() => void chooseDirectory()}><FolderOpen size={15} />浏览</button>
          </div>
          {errors.rootDir && <small className="field-error">{errors.rootDir}</small>}
        </label>
        <label className="project-field project-field--wide">
          <span>项目说明</span>
          <input value={draft.description} onChange={(event) => update("description", event.target.value)} placeholder="可选：记录服务用途或启动注意事项" aria-label="项目说明" />
        </label>
      </div>

      <label className="project-field project-command-field">
        <span>执行命令 <b>*</b></span>
        <textarea
          value={draft.command}
          onChange={(event) => update("command", event.target.value)}
          placeholder={'例如：\npython server.py --port 8887\n\n也可以直接填写：\nWeb2api.bat'}
          rows={10}
          spellCheck={false}
          aria-label="执行命令"
          aria-invalid={Boolean(errors.command)}
        />
        <small className="project-command-field__hint">支持单行或多行命令，也支持直接运行 .bat、.ps1、.exe。多行内容会按原顺序写入终端。</small>
        {errors.command && <small className="field-error">{errors.command}</small>}
      </label>

      {message && <div className="project-form__message" role="alert">{message}</div>}
      <footer className="project-form__footer">
        {onCancel && <button type="button" className="secondary-button" onClick={onCancel} disabled={saving}>取消</button>}
        <button type="submit" className="primary-button" disabled={saving}><Save size={15} />{saving ? "保存中…" : "保存项目"}</button>
      </footer>
    </form>
  );
}

function toDraft(project: Project | undefined, categories: string[]): ProjectDraft {
  if (!project) return { ...EMPTY_DRAFT };
  const category = project.category?.trim() ?? "";
  return {
    name: project.name,
    rootDir: project.rootDir,
    description: project.description,
    environment: project.environment,
    accessPath: project.accessPath ?? "",
    category: category && categories.includes(category) ? category : "",
    command: project.command,
  };
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason || "保存项目失败");
}
