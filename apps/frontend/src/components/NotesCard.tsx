import { useState, useEffect, useCallback } from 'react';
import { updateSessionNotes } from '@/lib/api';

interface Props {
    sessionId: string;
    initialNotes: string;
}

export default function NotesCard({ sessionId, initialNotes }: Props) {
    const [notes, setNotes] = useState(initialNotes);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => { setNotes(initialNotes); }, [initialNotes]);

    const handleBlur = useCallback(async () => {
        setSaving(true);
        setError(null);
        try {
            await updateSessionNotes(sessionId, notes.trim() || null);
        } catch {
            setError('Failed to save notes');
        } finally {
            setSaving(false);
        }
    }, [sessionId, notes]);

    return (
        <div className="animate-slide-up rounded-lg bg-white px-4 py-3 shadow-xs dark:bg-[var(--bg-card)]">
            <label htmlFor="session-notes" className="mb-1 block text-sm font-medium text-gray-700 dark:text-[var(--text-secondary)]">
                Notes
            </label>
            <textarea
                id="session-notes"
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                onBlur={handleBlur}
                placeholder="Add notes about this session..."
                className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm shadow-xs focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500 dark:border-[var(--border-default)] dark:bg-[var(--bg-surface)] dark:text-[var(--text-primary)] dark:focus:border-teal-400"
            />
            {saving && (
                <span className="text-xs text-gray-400 dark:text-[var(--text-muted)]">Saving...</span>
            )}
            {error && <span className="text-xs text-red-600">{error}</span>}
        </div>
    );
}