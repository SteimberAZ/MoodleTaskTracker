import Link from 'next/link';
import { ChevronLeftIcon, ChevronRightIcon } from './Icons';
import LinkPending from './LinkPending';

interface Props {
  page: number;
  pages: number;
  /** Builds the link for a page, preserving the state of the other list. */
  hrefFor: (page: number) => string;
  label: string;
}

/**
 * Anterior / "Página X de Y" / Siguiente. Plain links, so it works without client JS. Links scroll like a
 * normal navigation: to the list anchor in `hrefFor` ("#tareas"), else to the top, so the new page is in view.
 */
export default function Pagination({ page, pages, hrefFor, label }: Props) {
  if (pages <= 1) return null;
  return (
    <nav className="pager" aria-label={label}>
      {page > 1 ? (
        <Link href={hrefFor(page - 1)} className="btn" rel="prev">
          <ChevronLeftIcon />
          <span>Anterior</span>
          <LinkPending />
        </Link>
      ) : (
        <span className="btn is-disabled" aria-disabled="true">
          <ChevronLeftIcon />
          <span>Anterior</span>
        </span>
      )}
      <span className="pager-status" aria-live="polite">
        Página {page} de {pages}
      </span>
      {page < pages ? (
        <Link href={hrefFor(page + 1)} className="btn" rel="next">
          <span>Siguiente</span>
          <ChevronRightIcon />
          <LinkPending />
        </Link>
      ) : (
        <span className="btn is-disabled" aria-disabled="true">
          <span>Siguiente</span>
          <ChevronRightIcon />
        </span>
      )}
    </nav>
  );
}
