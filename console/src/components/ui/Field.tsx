"use client";

import { forwardRef, useId, type AriaAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { CircleAlert } from "lucide-react";

/*
 Fields: a visible label above, the text at 16px so a phone never zooms in, a hint under it, and an error tied to it
 (aria-invalid, aria-describedby) with an alert glyph. The box is 40px (44px on touch), 4px corners (the design's inputs),
 an inset well with a rule-strong edge (at least 3:1), and on focus its edge and a real outline take the focus colour.
*/

export type FieldProps = { label: string; hint?: ReactNode; error?: string; labelHidden?: boolean };
type Control = { id: string; "aria-invalid"?: AriaAttributes["aria-invalid"]; "aria-describedby"?: string };

const control =
  "block w-full rounded-sm border border-rule-strong bg-inset px-3 font-sans text-body text-ink transition-[border-color] placeholder:text-ink-3 focus-visible:border-focus focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-focus forced-colors:focus-visible:outline-[Highlight] aria-invalid:border-danger aria-invalid:focus-visible:outline-danger disabled:cursor-not-allowed disabled:border-rule disabled:text-ink-3";

function Field({ label, hint, error, labelHidden, id: given, className = "", children }: FieldProps & { id?: string; className?: string; children: (control: Control) => ReactNode }) {
  const auto = useId();
  const id = given ?? auto;
  const describedBy = [hint ? `${id}-hint` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ") || undefined;
  return (
    <div className={className}>
      <label htmlFor={id} className={labelHidden ? "sr-only" : "mb-1.5 block text-label text-ink-2"}>
        {label}
      </label>
      {children({ id, "aria-invalid": error ? true : undefined, "aria-describedby": describedBy })}
      {hint && (
        <p id={`${id}-hint`} className="mt-1.5 text-small text-ink-2">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="mt-1.5 flex items-start gap-1.5 text-small font-medium text-danger">
          <span className="inline-flex h-lh shrink-0 items-center">
            <CircleAlert className="size-4" aria-hidden="true" />
          </span>
          {error}
        </p>
      )}
    </div>
  );
}

type Own<T> = Omit<T, "id"> & FieldProps & { id?: string };

export const Input = forwardRef<HTMLInputElement, Own<InputHTMLAttributes<HTMLInputElement>>>(function Input({ label, hint, error, labelHidden, id, className, ...input }, ref) {
  return (
    <Field label={label} hint={hint} error={error} labelHidden={labelHidden} id={id} className={className}>
      {a => <input ref={ref} {...input} {...a} className={`${control} h-10 pointer-coarse:h-11`} />}
    </Field>
  );
});

/** Grows with what is typed (field-sizing), from `rows` lines up to 15rem, then scrolls. */
export const Textarea = forwardRef<HTMLTextAreaElement, Own<TextareaHTMLAttributes<HTMLTextAreaElement>>>(function Textarea(
  { label, hint, error, labelHidden, id, className, rows = 3, ...input },
  ref,
) {
  return (
    <Field label={label} hint={hint} error={error} labelHidden={labelHidden} id={id} className={className}>
      {a => (
        <textarea
          ref={ref}
          rows={rows}
          style={{ minHeight: `calc(${rows}lh + 1rem)` }}
          {...input}
          {...a}
          className={`${control} field-sizing-content max-h-60 resize-none py-2`}
        />
      )}
    </Field>
  );
});
