"use client";

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import { ring } from "./ring";

/*
 Buttons: pills, the only pill shapes besides avatars (DESIGN.md: pill radius on buttons only). primary is the one main
 action in a view, white on teal ink (charcoal on bright teal in dark). secondary is outlined, danger outlined in red,
 ghost quiet, link printed and underlined. A button is never greyed out to stop a form: it stays pressable and the form
 says what is missing. Busy, it spins and says what it is doing (busyLabel) at the same width, and ignores presses while
 keeping focus. disabled is for an action that truly can't run, with the reason beside it.
*/

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost" | "link";
export type ButtonSize = "sm" | "md";

const VARIANT: Record<Exclude<ButtonVariant, "link">, string> = {
  primary: "border-transparent bg-accent text-on-accent hover:bg-accent-hover",
  secondary: "border-rule-strong text-ink hover:bg-ink/5",
  danger: "border-danger text-danger hover:bg-danger/8",
  ghost: "border-transparent text-ink-2 hover:bg-ink/5 hover:text-ink",
};

// sm 32px, md 40px; both 44px where a finger is the pointer (the design's minimum hit target)
const SIZE: Record<ButtonSize, string> = { sm: "h-8 px-3 gap-1.5", md: "h-10 px-4 gap-2" };

const disabled =
  "disabled:cursor-not-allowed disabled:border-rule disabled:bg-inset disabled:text-ink-3 aria-disabled:cursor-not-allowed aria-disabled:border-rule aria-disabled:bg-inset aria-disabled:text-ink-3";
const press = "motion-safe:enabled:not-aria-disabled:active:translate-y-px";
const spinner = "animate-spin motion-reduce:animate-spin-slow";

/** A button's classes by variant and size. */
function buttonClass(variant: ButtonVariant, size: ButtonSize) {
  if (variant === "link") {
    return `inline-flex items-center gap-1.5 rounded-sm font-sans text-small font-medium text-accent-text underline decoration-accent-text/40 underline-offset-4 transition-[text-decoration-color,color] hover:decoration-accent-text pointer-coarse:-mx-2 pointer-coarse:min-h-11 pointer-coarse:px-2 [&_svg]:size-4 ${ring}`;
  }
  return `inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-full border font-sans text-small font-semibold no-underline transition-[background-color,border-color,color,translate] select-none ${press} ${disabled} pointer-coarse:min-h-11 [&_svg]:size-4 ${SIZE[size]} ${VARIANT[variant]} ${ring}`;
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** a leading Lucide glyph; the spinner takes its place while busy */
  icon?: ReactNode;
  /** pass it from the first render (even false), so the button is as wide as its busy label from the start */
  busy?: boolean;
  /** what it is doing while busy: "Approving", "Sending" */
  busyLabel?: string;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon, busy, busyLabel, type = "button", className = "", onClick, children, ...rest },
  ref,
) {
  const holds = Boolean(busy) || rest["aria-disabled"] === true || rest["aria-disabled"] === "true";
  const idle = (
    <>
      {icon}
      {children}
    </>
  );
  return (
    <button
      ref={ref}
      type={type}
      {...rest}
      aria-busy={busy || undefined}
      onClick={holds ? e => e.preventDefault() : onClick}
      className={`${buttonClass(variant, size)} ${className}`}
    >
      {busy === undefined ? (
        idle
      ) : (
        // both faces share one grid cell, so the button keeps the width of the wider one
        <span className="grid gap-[inherit]">
          <span className={`col-start-1 row-start-1 inline-flex items-center justify-center gap-[inherit] ${busy ? "invisible" : ""}`}>{idle}</span>
          <span className={`col-start-1 row-start-1 inline-flex items-center justify-center gap-[inherit] ${busy ? "" : "invisible"}`}>
            <LoaderCircle className={busy ? spinner : ""} aria-hidden="true" />
            {busyLabel ?? children}
          </span>
        </span>
      )}
    </button>
  );
});

/** An icon-only button: 40px round (44px on touch) with a 20px glyph. `label` names it for screen readers and the tooltip. */
export const IconButton = forwardRef<
  HTMLButtonElement,
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> & { label: string; variant?: "ghost" | "outline" }
>(function IconButton({ label, variant = "ghost", type = "button", title, className = "", children, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={title ?? label}
      {...rest}
      className={`inline-grid size-10 shrink-0 place-items-center rounded-full border transition-[background-color,border-color,color,translate] ${press} ${disabled} pointer-coarse:size-11 [&_svg]:size-5 ${
        variant === "outline" ? "border-rule-strong text-ink hover:bg-ink/5" : "border-transparent text-ink-2 hover:bg-ink/5 hover:text-ink"
      } ${ring} ${className}`}
    >
      {children}
    </button>
  );
});
