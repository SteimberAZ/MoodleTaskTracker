import type { ReactNode } from 'react';
import { titleCase } from '@/lib/class-schedule';
import type { ScheduleClass } from '@/lib/sga-schedule';

/** One class of the schedule: time range, subject + parallel, teacher, room (type, code, floor) and place. */
export default function ClassItem({ cls, children }: { cls: ScheduleClass; children?: ReactNode }) {
  const room = [titleCase(cls.roomType), cls.roomCode].filter(Boolean).join(' ');
  const roomLine = [room, cls.floor ? `piso ${cls.floor}` : ''].filter(Boolean).join(' · ');
  const place = titleCase(cls.place);
  const teacher = titleCase(cls.teacher);

  return (
    <li className="class-item">
      <p className="class-time">
        <span>{cls.startTime}</span>
        <span className="class-time-end">{cls.endTime}</span>
      </p>
      <div className="class-body">
        <p className="class-subject">
          {titleCase(cls.subject)}
          {cls.parallel && <span className="chip">Paralelo {cls.parallel}</span>}
        </p>
        {teacher && <p className="class-meta">{teacher}</p>}
        {roomLine && <p className="class-meta">{roomLine}</p>}
        {place && <p className="class-meta small">{place}</p>}
        {children}
      </div>
    </li>
  );
}
