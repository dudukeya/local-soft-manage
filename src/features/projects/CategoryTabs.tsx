import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

export interface CategoryTabItem { id: string; label: string; count: number; }
export interface CategoryTabsProps { items: CategoryTabItem[]; activeId: string; onSelect: (id: string) => void; }

export function CategoryTabs({ items, activeId, onSelect }: CategoryTabsProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scrollState, setScrollState] = useState({ hasOverflow: false, canScrollLeft: false, canScrollRight: false });
  const syncScrollState = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const maxScroll = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
    setScrollState({ hasOverflow: maxScroll > 1, canScrollLeft: viewport.scrollLeft > 1, canScrollRight: maxScroll - viewport.scrollLeft > 1 });
  }, []);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    syncScrollState();
    viewport.addEventListener("scroll", syncScrollState, { passive: true });
    window.addEventListener("resize", syncScrollState);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(syncScrollState);
    observer?.observe(viewport);
    return () => { viewport.removeEventListener("scroll", syncScrollState); window.removeEventListener("resize", syncScrollState); observer?.disconnect(); };
  }, [items.length, syncScrollState]);
  const scroll = (direction: -1 | 1) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const amount = Math.max(120, Math.floor(viewport.clientWidth * 0.72));
    if (typeof viewport.scrollBy === "function") viewport.scrollBy({ left: direction * amount, behavior: "smooth" });
    else viewport.scrollLeft += direction * amount;
  };
  return <div className="category-tabs-shell">
    {scrollState.hasOverflow && <button type="button" className="category-tabs-arrow" onClick={() => scroll(-1)} disabled={!scrollState.canScrollLeft} aria-label="向左滚动项目分类"><ChevronLeft size={14} /></button>}
    <div className="category-tabs-viewport" ref={viewportRef} role="tablist" aria-label="项目分类">
      {items.map((item) => <button type="button" role="tab" aria-selected={item.id === activeId} className={item.id === activeId ? "is-active" : ""} key={item.id} onClick={() => onSelect(item.id)}>{item.label} <small>{item.count}</small></button>)}
    </div>
    {scrollState.hasOverflow && <button type="button" className="category-tabs-arrow" onClick={() => scroll(1)} disabled={!scrollState.canScrollRight} aria-label="向右滚动项目分类"><ChevronRight size={14} /></button>}
  </div>;
}
