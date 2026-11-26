"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { IconButton } from "./Button";

/*
 A dialog, for a task that needs its own focus (adding a person); anything smaller happens in place. Native <dialog>:
 showModal keeps focus inside and Escape closes it. It hangs from the top on desktop and is a bottom sheet on phones. It
 rises in over 200ms and drops in 150ms (a fade alone under reduced motion). No shadow (DESIGN.md): the scrim and the
 raised surface separate it. Focus returns to whatever opened it. While work can't be abandoned, dismissible={false}.
*/
export function Dialog({
  open,
  onClose,
  dismissible = true,
  title,
  description,
  actions,
  className = "",
  children,
}: {
  open: boolean;
  onClose: () => void;
  dismissible?: boolean;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const back = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const [shown, setShown] = useState(open);
  if (open && !shown) setShown(true);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      back.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      d.showModal();
    } else if (!open && d.open) d.close();
  }, [open, shown]);

  function closed() {
    onClose();
    if (back.current?.isConnected) back.current.focus();
    const d = ref.current;
    if (d) void Promise.allSettled(d.getAnimations().map(a => a.finished)).then(() => d.open || setShown(false));
  }

  if (!shown) return null;
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onClose={closed}
      onCancel={e => dismissible || e.preventDefault()}
      className={`m-auto mt-[clamp(1rem,10vh,6rem)] max-h-[calc(100dvh_-_clamp(1rem,10vh,6rem)_-_1rem)] w-[min(34rem,calc(100%-2rem))] max-w-none overflow-y-auto overscroll-contain rounded-xl border border-rule bg-raised p-0 text-ink opacity-0 transition-[opacity,translate,overlay,display] transition-discrete duration-200 ease-out open:opacity-100 starting:open:opacity-0 not-open:duration-150 not-open:ease-in motion-safe:translate-y-2 motion-safe:open:translate-y-0 motion-safe:starting:open:translate-y-2 backdrop:bg-scrim backdrop:opacity-0 backdrop:transition-[opacity,overlay,display] backdrop:transition-discrete backdrop:duration-200 open:backdrop:opacity-100 starting:open:backdrop:opacity-0 max-sm:mb-0 max-sm:w-full max-sm:rounded-b-none ${className}`}
    >
      <div className="px-5 pr-16 pt-5 sm:px-6 sm:pr-16">
        <h2 id={titleId} className="text-heading text-balance text-ink">
          {title}
        </h2>
        {description && (
          <p id={descriptionId} className="mt-1 text-small text-pretty text-ink-2">
            {description}
          </p>
        )}
      </div>
      <div className="px-5 py-4 text-body sm:px-6">{children}</div>
      {actions && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-rule px-5 py-4 sm:px-6">{actions}</div>}
      <IconButton label="Close" className="absolute right-3 top-3" hidden={!dismissible} onClick={() => ref.current?.close()}>
        <X />
      </IconButton>
    </dialog>
  );
}
