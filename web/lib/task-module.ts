/** Moodle activity type (`modname`) to the Spanish label shown in the module chip. */
const LABELS: Record<string, string> = {
  assign: 'Tarea',
  quiz: 'Cuestionario',
  forum: 'Foro',
  workshop: 'Taller',
  lesson: 'Lección',
  choice: 'Consulta',
  feedback: 'Encuesta',
  survey: 'Encuesta',
  data: 'Base de datos',
  glossary: 'Glosario',
  wiki: 'Wiki',
  scorm: 'SCORM',
  h5pactivity: 'H5P',
  bigbluebuttonbn: 'Clase virtual',
  lti: 'Herramienta externa',
  chat: 'Chat',
  page: 'Página',
  book: 'Libro',
  url: 'Enlace',
  folder: 'Carpeta',
  resource: 'Archivo',
};

export const FALLBACK_MODULE_LABEL = 'Actividad';

/** Null, empty or unknown modules (old rows) fall back to a neutral label. */
export function moduleLabel(module: string | null | undefined): string {
  const key = (module ?? '').trim().toLowerCase();
  return LABELS[key] ?? FALLBACK_MODULE_LABEL;
}
