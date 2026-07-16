import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  Table,
  TableHead,
  TableHeaderCell,
  TableBody,
  TableRow,
  TableCell,
  Text,
} from '@tremor/react';
import type { Session } from '@/lib/types';
import { renameSession } from '@/lib/api';

interface Props {
  sessions: Session[];
}

export default function SessionTable({ sessions }: Props) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Focus input when entering edit mode
  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId]);

  const startEditing = (session: Session, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(session.id);
    setEditValue(session.name || '');
  };

  const cancelEditing = () => {
    setEditingId(null);
    setEditValue('');
  };

  const saveEditing = async (sessionId: string) => {
    const trimmed = editValue.trim();
    // If unchanged or empty, just cancel
    if (!trimmed || trimmed === (sessions.find((s) => s.id === sessionId)?.name || '')) {
      cancelEditing();
      return;
    }
    try {
      await renameSession(sessionId, trimmed);
      await queryClient.invalidateQueries({ queryKey: ['sessions'] });
    } catch {
      // Silently ignore — the name just won't update
    }
    cancelEditing();
  };

  const handleKeyDown = (
    sessionId: string,
    e: React.KeyboardEvent<HTMLInputElement>,
  ) => {
    if (e.key === 'Enter') {
      saveEditing(sessionId);
    } else if (e.key === 'Escape') {
      cancelEditing();
    }
  };

  return (
    <Table>
      <TableHead>
        <TableRow>
          <TableHeaderCell>Vehicle / Name</TableHeaderCell>
          <TableHeaderCell>Start</TableHeaderCell>
          <TableHeaderCell>Duration</TableHeaderCell>
          <TableHeaderCell>Max Speed</TableHeaderCell>
          <TableHeaderCell>Max RPM</TableHeaderCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {sessions.length === 0 ? (
          <TableRow>
            <TableCell colSpan={5}>
              <Text>No sessions yet.</Text>
            </TableCell>
          </TableRow>
        ) : (
          sessions.map((s) => {
            const maxSpeed = s.maxSpeed ?? null;
            const maxRpm = s.maxRpm ?? null;
            const isEditing = editingId === s.id;
            return (
              <TableRow
                key={s.id}
                tabIndex={isEditing ? -1 : 0}
                role="button"
                aria-label={`Session: ${s.name || 'Unnamed session'}`}
                onClick={() => !isEditing && navigate(`/session/${s.id}`)}
                onKeyDown={(e) => {
                  if (!isEditing && (e.key === 'Enter' || e.key === ' ')) {
                    e.preventDefault();
                    navigate(`/session/${s.id}`);
                  }
                }}
                className="card-hover cursor-pointer hover:bg-gray-50 dark:hover:bg-[var(--bg-surface)]"
              >
                <TableCell>
                  {isEditing ? (
                    <input
                      ref={inputRef}
                      type="text"
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onKeyDown={(e) => handleKeyDown(s.id, e)}
                      onBlur={() => saveEditing(s.id)}
                      onClick={(e) => e.stopPropagation()}
                      className="w-full border border-teal-400 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-teal-300"
                    />
                  ) : (
                    <span className="group inline-flex items-center gap-1">
                      {s.name || 'Unnamed session'}
                      <button
                        onClick={(e) => startEditing(s, e)}
                        className="opacity-0 group-hover:opacity-100 transition-opacity text-gray-400 hover:text-gray-600 dark:text-[var(--text-muted)] dark:hover:text-[var(--text-secondary)] ml-1"
                        title="Rename session"
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          viewBox="0 0 20 20"
                          fill="currentColor"
                          className="w-3.5 h-3.5"
                        >
                          <path d="M2.695 14.763l-1.262 3.154a.5.5 0 00.65.65l3.155-1.262a4 4 0 001.343-.885L17.5 5.5a2.121 2.121 0 00-3-3L3.58 13.42a4 4 0 00-.885 1.343z" />
                        </svg>
                      </button>
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  {s.startDate
                    ? new Date(s.startDate).toLocaleString()
                    : '—'}
                </TableCell>
                <TableCell>{s.duration || '—'}</TableCell>
                <TableCell>
                  {maxSpeed != null ? `${Math.round(maxSpeed)} km/h` : '—'}
                </TableCell>
                <TableCell>{maxRpm != null ? Math.round(maxRpm) : '—'}</TableCell>
              </TableRow>
            );
          })
        )}
      </TableBody>
    </Table>
  );
}
