import { useNavigate } from 'react-router-dom';
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

interface Props {
  sessions: Session[];
}

export default function SessionTable({ sessions }: Props) {
  const navigate = useNavigate();

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
            return (
              <TableRow
                key={s.id}
                onClick={() => navigate(`/session/${s.id}`)}
                className="cursor-pointer hover:bg-gray-50"
              >
                <TableCell>{s.name || 'Unnamed session'}</TableCell>
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
