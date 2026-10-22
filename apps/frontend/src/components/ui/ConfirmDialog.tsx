import { useId, useRef, useEffect } from 'react';
import type { ReactNode } from 'react';

interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  /** Confirm action. May be async — the dialog stays open while `busy`. */
  onConfirm: () => void | Promise<void>;
  title: string;
  /** Optional body copy under the title (why the action is destructive etc.). */
  description?: ReactNode;
  confirmLabel?: string;
  busy?: boolean;
}

/**
 * Shared destructive/confirm dialog, built on the AnalysisConfirmDialog
 * pattern: a light-dismissible <dialog> (closedby="any" where supported) with
 * a Safari fallback that closes on backdrop clicks via a hit test on the
 * dialog element itself. Cancel stays reachable via Escape and the Cancel
 * button; focus-visible rings come from the global accent outline.
 */
export default function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = 'Confirm',
  busy = false,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  // title/description ids so the dialog is programmatically named and
  // described (WCAG 1.3.1) without hard-coding ids that could collide.
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) {
      dialog.showModal();
    } else {
      dialog.close();
    }
  }, [open]);

  // Safari fallback for closedby="any" (light-dismiss): clicks landing on the
  // dialog element ITSELF (backdrop/padding — not the inner content box) close
  // the dialog. The rect test excludes real content clicks that still target
  // the element on padded dialogs.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !open) return;

    if (!('closedBy' in HTMLDialogElement.prototype)) {
      const handleClick = (e: MouseEvent) => {
        if (e.target !== dialog || !dialog.open) return;
        const rect = dialog.getBoundingClientRect();
        const isInside =
          rect.top <= e.clientY && e.clientY <= rect.top + rect.height &&
          rect.left <= e.clientX && e.clientX <= rect.left + rect.width;
        if (!isInside && !busy) onClose();
      };
      dialog.addEventListener('click', handleClick);
      return () => dialog.removeEventListener('click', handleClick);
    }
  }, [open, onClose, busy]);

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      className="fixed inset-0 z-50 m-auto w-full max-w-sm rounded-lg border border-border bg-surface-elevated p-6 shadow-lg"
    >
      <h2 id={titleId} className="text-lg font-semibold text-fg">{title}</h2>
      {description && (
        <p id={descriptionId} className="mt-1 text-sm text-fg-secondary">{description}</p>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="min-h-[44px] rounded-lg border border-border bg-surface-card px-4 py-2 text-sm font-medium text-fg-secondary shadow-xs transition hover:bg-surface-elevated hover:text-fg disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void onConfirm()}
          disabled={busy}
          className="min-h-[44px] rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-ink shadow-xs transition hover:bg-accent-hover disabled:opacity-50"
        >
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
