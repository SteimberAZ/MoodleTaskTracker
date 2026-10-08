import { formatPoints, type CourseStanding, type StandingStatus } from '@/lib/grades';
import { formatGuayaquilShort } from '@/lib/time';
import ExamEntry from './ExamEntry';

/** Badge text and tone per standing status; the tone is a globals.css modifier, empty means neutral. */
const BADGE: Record<StandingStatus, { label: string; tone: string }> = {
  passed: { label: 'Aprobada', tone: 'is-ok' },
  on_track: { label: 'En camino', tone: '' },
  at_risk: { label: 'En riesgo', tone: 'is-danger' },
  lost: { label: 'No alcanza', tone: 'is-danger' },
  unknown: { label: 'Estimado', tone: 'is-warn' },
  no_grades: { label: 'Sin notas', tone: '' },
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/**
 * One course on /estadisticas: the score out of 100, a progress bar with the 70-point mark, what is still needed
 * and the graded activities. Text that mixes values and words is built as one string so it renders as one text node.
 */
export default function CourseGradeCard({ standing, examsEnabled = false }: { standing: CourseStanding; examsEnabled?: boolean }) {
  const { courseId, exams, linkable, courseName, status, passed, estimate, earned, available, needed, maxReachable, neededShare, graded, pendingItems } =
    standing;
  const badge = BADGE[status];
  const points = formatPoints(earned);
  const fill = clamp(earned, 0, 100);
  const pending = available === null ? 0 : clamp(available, 0, 100 - fill);

  return (
    <li className="card grade-card">
      <div className="grade-top">
        <h2 className="grade-course">{courseName}</h2>
        <span className={`badge ${badge.tone}`.trimEnd()}>{badge.label}</span>
      </div>
      <p className="grade-score">
        <strong>{points}</strong> <span className="muted">/ 100 pts</span>
      </p>
      <div className="grade-bar" role="img" aria-label={`${points} de 100 puntos; se aprueba con 70`}>
        <span className={`grade-bar-fill${passed ? ' is-passed' : ''}`} style={{ width: `${fill}%` }} />
        {available !== null && <span className="grade-bar-pending" style={{ left: `${fill}%`, width: `${pending}%` }} />}
        <span className="grade-bar-mark" style={{ left: '70%' }} />
      </div>
      <p className="grade-bar-legend small muted">
        <span>0</span>
        <span>70 para aprobar</span>
        <span>100</span>
      </p>
      <div className="grade-lines">
        {passed ? (
          <p className="status-ok">¡Aprobado!</p>
        ) : status === 'no_grades' ? (
          <p>Aún no tienes notas en esta materia.</p>
        ) : needed === 0 ? (
          <p>Aún hay actividades sin calificar: todavía no se puede confirmar si apruebas.</p>
        ) : (
          <p>
            {`Te faltan `}
            <strong>{`${formatPoints(needed)} puntos`}</strong>
            {` para llegar a 70.`}
          </p>
        )}
        {available !== null && status !== 'no_grades' && (
          <p className="muted">{`Puntos aún por calificar: ${formatPoints(available)}`}</p>
        )}
      </div>
      {status === 'lost' && (
        <p className="notice notice--danger">
          {`Con lo que queda por calificar ya no llegas a 70: como máximo sumarías ${formatPoints(maxReachable ?? 0)} puntos.`}
        </p>
      )}
      {status === 'at_risk' && neededShare !== null && (
        <p className="notice notice--warn">
          {`Necesitas al menos el ${Math.ceil(neededShare * 100)} % de los puntos que faltan.`}
        </p>
      )}
      {estimate && (
        <p className="notice notice--info">
          Estimado con el total del curso en Moodle: no se pudo calcular cuánto aporta cada actividad.
        </p>
      )}
      {graded.length > 0 && (
        <>
          <h3 className="grade-items-title">Notas calificadas</h3>
          <ul className="grade-items plain-list">
            {graded.map((item) => (
              <li key={item.itemId} className="grade-item">
                <span className="grade-item-name">
                  {item.name}
                  {item.manual && <span className="grade-item-tag muted small">(nota tuya)</span>}
                </span>
                <span className="grade-item-score">
                  {`${formatPoints(item.grade)}${item.max !== null ? `/${formatPoints(item.max)}` : ''}`}
                </span>
                {item.contribution !== null && (
                  <span className="grade-item-points muted small">{`+${formatPoints(item.contribution)} pts`}</span>
                )}
                {item.gradedAt !== null && (
                  <span className="grade-item-date muted small">{formatGuayaquilShort(item.gradedAt)}</span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {examsEnabled && (
        <div className="grade-exams">
          {exams.map((exam) => (
            <ExamEntry key={exam.kind} courseId={courseId} exam={exam} linkable={linkable} />
          ))}
        </div>
      )}
      {pendingItems > 0 && (
        <p className="muted small">
          {pendingItems === 1 ? '1 actividad sin calificar' : `${pendingItems} actividades sin calificar`}
        </p>
      )}
    </li>
  );
}
