import { useRef, useEffect } from 'react';

interface Props {
    open: boolean;
    onClose: () => void;
    onConfirm: () => void;
    busy: boolean;
}

export default function AnalysisConfirmDialog({ open, onClose, onConfirm, busy }: Props) {
    const dialogRef = useRef<HTMLDialogElement>(null);

    useEffect(() => {
        const dialog = dialogRef.current;
        if (!dialog) return;
        if (open) {
            dialog.showModal();
        } else {
            dialog.close();
        }
    }, [open]);

    // Safari fallback for closedby="any" (light-dismiss)
    useEffect(() => {
        const dialog = dialogRef.current;
        if (!dialog || !open) return;

        if (!('closedBy' in HTMLDialogElement.prototype)) {
            const handleClick = (e: MouseEvent) => {
                if (e.target === dialog) {
                    const rect = dialog.getBoundingClientRect();
                    const isInside =
                        rect.top <= e.clientY && e.clientY <= rect.top + rect.height &&
                        rect.left <= e.clientX && e.clientX <= rect.left + rect.width;
                    if (!isInside) onClose();
                }
            };
            dialog.addEventListener('click', handleClick);
            return () => dialog.removeEventListener('click', handleClick);
        }
    }, [open, onClose]);

    return (
        <dialog
            ref={dialogRef}
            onClose={onClose}
            className="fixed inset-0 z-50 m-auto w-full max-w-sm rounded-lg border bg-white p-6 shadow-xl dark:border-[var(--border-strong)] dark:bg-[var(--bg-card)]"
        >
            <div className="space-y-4">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Run AI Analysis?</h2>
                <p className="text-sm text-gray-600 dark:text-[var(--text-secondary)]">
                    This will send session telemetry data to your configured LLM provider
                    and may incur API costs (~$0.01–0.05 per analysis depending on provider
                    and session size).
                </p>
                <div className="flex justify-end gap-2">
                    <button
                        type="button"
                        onClick={onClose}
                        disabled={busy}
                        className="rounded border bg-white px-4 py-2 text-sm font-medium hover:bg-gray-50 dark:border-[var(--border-default)] dark:bg-[var(--bg-card)] dark:text-[var(--text-primary)] dark:hover:bg-[var(--bg-surface)]"
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={onConfirm}
                        disabled={busy}
                        className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 dark:bg-indigo-500 dark:hover:bg-indigo-600"
                    >
                        {busy ? 'Analyzing...' : 'Analyze'}
                    </button>
                </div>
            </div>
        </dialog>
    );
}