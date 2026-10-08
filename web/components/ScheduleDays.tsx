import type { ReactNode } from 'react';
import { WEEKDAY_NAMES, groupByWeekday } from '@/lib/class-schedule';
import type { ScheduleClass } from '@/lib/sga-schedule';
import ClassItem from './ClassItem';

export interface IndexedClass {
  /** Position in the original list (the preview uses it to say which entries to keep). */
  index: number;
  cls: ScheduleClass;
}

/**
 * Classes grouped by day (Lunes to Domingo), sorted by start time. `today` (ISO weekday) highlights that day
 * and shows it even when empty; `extra` renders something inside each class (the preview's checkbox).
 */
export default function ScheduleDays({
  items,
  today,
  extra,
}: {
  items: IndexedClass[];
  today?: number;
  extra?: (item: IndexedClass) => ReactNode;
}) {
  const groups = groupByWeekday(items.map((item) => ({ ...item, weekday: item.cls.weekday, startTime: item.cls.startTime })));
  const shown =
    today && !groups.some((g) => g.weekday === today)
      ? [...groups, { weekday: today, name: WEEKDAY_NAMES[today], items: [] }].sort(
          (a, b) => a.weekday - b.weekday,
        )
      : groups;

  return (
    <div className="schedule-days">
      {shown.map((group) => {
        const isToday = group.weekday === today;
        return (
          <section key={group.weekday} className={`schedule-day${isToday ? ' is-today' : ''}`} aria-labelledby={`day-${group.weekday}`}>
            <h3 id={`day-${group.weekday}`} className="schedule-day-title">
              {group.name}
              {isToday && <span className="badge activo">Hoy</span>}
            </h3>
            {group.items.length === 0 ? (
              <p className="card muted empty">Sin clases hoy.</p>
            ) : (
              <ul className="class-list">
                {group.items.map((item) => (
                  <ClassItem key={item.index} cls={item.cls}>
                    {extra?.(item)}
                  </ClassItem>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
