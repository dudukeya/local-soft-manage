import { useEffect, useState, type FormEvent } from "react";
import { ArrowDown, ArrowUp, Plus, Save, Trash2, X } from "lucide-react";

// 新项目不预置分类，分类由设置中的数据字典维护。
export const DEFAULT_PROJECT_CATEGORIES: string[] = [];
export interface SettingsDialogProps {
  open: boolean;
  categories: string[];
  onSave: (categories: string[]) => void | Promise<void>;
  onClose: () => void;
}

export function SettingsDialog({ open, categories, onSave, onClose }: SettingsDialogProps) {
  const [draft, setDraft] = useState<string[]>(categories);
  const [newCategory, setNewCategory] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) { setDraft(categories); setNewCategory(""); setMessage(null); }
  }, [categories, open]);

  if (!open) return null;

  const addCategory = (event: FormEvent) => {
    event.preventDefault();
    const value = newCategory.trim();
    if (!value) { setMessage("请输入分类名称"); return; }
    if (value.length > 60) { setMessage("分类名称不能超过 60 个字符"); return; }
    if (draft.some((item) => item.toLocaleLowerCase() === value.toLocaleLowerCase())) { setMessage("分类名称已存在"); return; }
    setDraft((current) => [...current, value]);
    setNewCategory("");
    setMessage(null);
  };

  const moveCategory = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= draft.length) return;
    setDraft((current) => {
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const save = async () => {
    const next = normalizeCategories(draft);
    setSaving(true);
    setMessage(null);
    try {
      await onSave(next);
      onClose();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason || "保存分类失败"));
    } finally {
      setSaving(false);
    }
  };

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="settings-surface" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <header className="editor-header"><div><p className="section-kicker">APPLICATION SETTINGS</p><h2 id="settings-title">设置</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="关闭设置"><X size={16} /></button></header>
      <div className="settings-body">
        <div className="settings-section-heading"><div><strong>项目分类字典</strong><small>维护项目表单中的统一下拉选项</small></div><span>{draft.length} 项</span></div>
        <form className="settings-add-row" onSubmit={addCategory}><input value={newCategory} onChange={(event) => { setNewCategory(event.target.value); setMessage(null); }} placeholder="输入新分类名称" aria-label="新分类名称" /><button type="submit" className="secondary-button"><Plus size={14} />添加</button></form>
        <div className="settings-category-list" role="list" aria-label="项目分类列表">
          {draft.length ? draft.map((category, index) => <div className="settings-category-item" role="listitem" key={`${category}-${index}`}><span>{category}</span><div className="settings-category-actions"><button type="button" className="icon-button" onClick={() => moveCategory(index, -1)} disabled={index === 0} aria-label={`上移分类 ${category}`} title="上移"><ArrowUp size={18} /></button><button type="button" className="icon-button" onClick={() => moveCategory(index, 1)} disabled={index === draft.length - 1} aria-label={`下移分类 ${category}`} title="下移"><ArrowDown size={18} /></button><button type="button" className="icon-button settings-delete-button" onClick={() => setDraft((current) => current.filter((_, itemIndex) => itemIndex !== index))} aria-label={`删除分类 ${category}`} title="删除"><Trash2 size={18} /></button></div></div>) : <p className="settings-empty">暂无分类，项目将归入“未分类”。</p>}
        </div>
        {message && <p className="settings-message" role="alert">{message}</p>}
      </div>
      <footer className="project-form__footer settings-footer"><button type="button" className="secondary-button" onClick={onClose} disabled={saving}>取消</button><button type="button" className="primary-button" onClick={() => void save()} disabled={saving}><Save size={15} />{saving ? "保存中…" : "保存设置"}</button></footer>
    </section>
  </div>;
}

function normalizeCategories(values: unknown[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const normalized = value.trim();
    if (!normalized || result.some((item) => item.toLocaleLowerCase() === normalized.toLocaleLowerCase())) continue;
    result.push(normalized);
  }
  return result;
}
