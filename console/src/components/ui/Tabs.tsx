"use client";

import { useId, useRef, type HTMLAttributes, type KeyboardEvent, type ReactNode } from "react";
import { ring } from "./ring";

/*
 Tabs switch an employee's desk views: a real tablist with one tab stop (arrow keys, Home and End move and select), each
 tab tied to its panel. A count follows the label as a small pill in the accent; its meaning is said in words for screen
 readers (note). Segmented picks a setting (the theme) with native radios, so arrow keys and announcements come free.
*/

const PILL = "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-full border font-sans text-small font-medium transition-[background-color,border-color,color]";
const CHOSEN = "border-rule-strong bg-card text-ink forced-colors:border-[Highlight] forced-colors:bg-[Highlight] forced-colors:text-[HighlightText] forced-colors:forced-color-adjust-none";
const OTHER = "border-transparent text-ink-2 hover:bg-ink/5 hover:text-ink";
const COUNT = "inline-grid h-5 min-w-5 place-items-center rounded-full bg-accent px-1 text-label font-semibold text-on-accent tabular-nums forced-colors:border";

export type TabItem<T extends string> = { value: T; label: string; count?: number; note?: string };

const tabId = (id: string, value: string) => `${id}-tab-${value}`;
const panelId = (id: string, value: string) => `${id}-panel-${value}`;

export function Tabs<T extends string>({
  id,
  label,
  value,
  onChange,
  items,
  className = "",
}: {
  id: string;
  label: string;
  value: T;
  onChange: (value: T) => void;
  items: TabItem<T>[];
  className?: string;
}) {
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  function onKeyDown(e: KeyboardEvent) {
    const at = items.findIndex(t => t.value === value);
    const last = items.length - 1;
    const next = e.key === "ArrowRight" ? (at === last ? 0 : at + 1) : e.key === "ArrowLeft" ? (at === 0 ? last : at - 1) : e.key === "Home" ? 0 : e.key === "End" ? last : -1;
    if (next < 0) return;
    e.preventDefault();
    onChange(items[next].value);
    tabs.current[next]?.focus();
  }
  return (
    <div role="tablist" aria-label={label} onKeyDown={onKeyDown} className={`flex flex-wrap gap-1 max-sm:grid max-sm:grid-cols-2 ${className}`}>
      {items.map((t, i) => {
        const chosen = t.value === value;
        return (
          <button
            key={t.value}
            ref={el => {
              tabs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={tabId(id, t.value)}
            aria-selected={chosen}
            aria-controls={panelId(id, t.value)}
            tabIndex={chosen ? 0 : -1}
            aria-label={t.note ? `${t.label}, ${t.note}` : undefined}
            onClick={() => onChange(t.value)}
            className={`h-9 px-4 pointer-coarse:h-11 ${PILL} ${chosen ? CHOSEN : OTHER} ${ring}`}
          >
            {t.label}
            {Boolean(t.count) && (
              <span aria-hidden="true" className={COUNT}>
                {t.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** A tab's panel. Keep panels mounted and pass `hidden`, so half-typed work survives a switch. */
export function TabPanel({ tabs, value, className = "", children, ...rest }: HTMLAttributes<HTMLDivElement> & { tabs: string; value: string; children: ReactNode }) {
  return (
    <div {...rest} role="tabpanel" id={panelId(tabs, value)} aria-labelledby={tabId(tabs, value)} tabIndex={0} className={`rounded-lg ${ring} ${className}`}>
      {children}
    </div>
  );
}

export type SegmentedOption<T extends string> = { value: T; label: ReactNode; icon?: ReactNode };

export function Segmented<T extends string>({ legend, value, onChange, options, className = "" }: { legend: string; value: T; onChange: (value: T) => void; options: SegmentedOption<T>[]; className?: string }) {
  const name = useId();
  return (
    <fieldset className={`m-0 min-w-0 border-0 p-0 ${className}`}>
      <legend className="sr-only">{legend}</legend>
      <div className="flex w-full gap-0.5 rounded-full border border-rule bg-inset p-0.5">
        {options.map(o => (
          <label key={o.value} className="relative flex flex-auto cursor-pointer">
            <input type="radio" name={name} value={o.value} checked={o.value === value} onChange={() => onChange(o.value)} className="peer sr-only" />
            <span
              className={`h-8 w-full px-3 pointer-coarse:h-11 [&_svg]:size-4 ${PILL} border-transparent text-ink-2 hover:text-ink peer-checked:border-rule-strong peer-checked:bg-card peer-checked:text-ink forced-colors:peer-checked:border-[Highlight] forced-colors:peer-checked:bg-[Highlight] forced-colors:peer-checked:text-[HighlightText] forced-colors:peer-checked:forced-color-adjust-none peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus`}
            >
              {o.icon}
              {o.label}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
