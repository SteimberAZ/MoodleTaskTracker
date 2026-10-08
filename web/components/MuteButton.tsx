import { setTaskMute } from '@/app/actions';
import { BellIcon, BellOffIcon } from './Icons';

interface Props {
  taskId: string;
  /** Current state: true when the task is muted (is_dismissed = 1). */
  muted: boolean;
  /** Task title, used for the accessible name. */
  title: string;
}

/** Mute / restore toggle. A plain form posting to a server action, so it works without client JS. */
export default function MuteButton({ taskId, muted, title }: Props) {
  return (
    <form action={setTaskMute.bind(null, taskId, !muted)} className="inline-form">
      <button
        type="submit"
        className="btn ghost"
        aria-label={`${muted ? 'Activar avisos de' : 'Silenciar'} ${title}`}
      >
        {muted ? <BellIcon /> : <BellOffIcon />}
        <span>{muted ? 'Activar' : 'Silenciar'}</span>
      </button>
    </form>
  );
}
