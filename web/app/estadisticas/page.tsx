import type { Metadata } from 'next';
import { withUser } from '@/lib/auth';
import { loadGrades } from '@/lib/grades-store';
import { buildStandings, latestFetch, summarizeStandings } from '@/lib/grades';
import { formatGuayaquil } from '@/lib/time';
import CourseGradeCard from '@/components/CourseGradeCard';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Estadísticas' };

export default async function StatsPage() {
  const [, grades] = await withUser((userId) => loadGrades(userId));

  let body;
  if (grades.state === 'error') {
    body = <p className="alert" role="alert">No se pudieron cargar tus calificaciones.</p>;
  } else if (grades.state === 'missing') {
    body = <p className="notice notice--info">Las estadísticas todavía no están disponibles.</p>;
  } else if (grades.rows.length === 0) {
    body = (
      <p className="card empty">
        Todavía no hay calificaciones. Las traemos de Moodle cada 30 minutos; vuelve a revisar más tarde.
      </p>
    );
  } else {
    const standings = buildStandings(grades.rows);
    const summary = summarizeStandings(standings);
    body = (
      <>
        <section className="grade-summary" aria-label="Resumen">
          <div className="grade-stat">
            <strong className="grade-stat-value">{summary.passed}</strong>
            <span>Aprobadas</span>
          </div>
          <div className="grade-stat">
            <strong className="grade-stat-value">{summary.onTrack}</strong>
            <span>En camino</span>
          </div>
          <div className="grade-stat">
            <strong className="grade-stat-value">{summary.atRisk}</strong>
            <span>En riesgo</span>
          </div>
          <div className="grade-stat">
            <strong className="grade-stat-value">{summary.noData}</strong>
            <span>Sin datos</span>
          </div>
        </section>
        <section className="section">
          <ul className="list grade-list">
            {standings.map((standing) => (
              <CourseGradeCard key={standing.courseId} standing={standing} />
            ))}
          </ul>
        </section>
        <p className="muted small">
          {`Actualizado: ${formatGuayaquil(latestFetch(grades.rows))}. Las notas se traen de Moodle cada 30 minutos.`}
        </p>
      </>
    );
  }

  return (
    <>
      <header className="page-head">
        <h1>Estadísticas</h1>
        <p className="muted">
          Cada materia se califica sobre 100 puntos y se aprueba con 70. Aquí ves cómo vas y cuánto te falta.
        </p>
      </header>
      {body}
      <p className="muted small">Horas en Ecuador (UTC-5).</p>
    </>
  );
}
