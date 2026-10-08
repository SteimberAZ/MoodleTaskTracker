import type { ReactNode } from 'react';

/** Small stroke icons (decorative: the label next to them carries the meaning). */
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      className="icon"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const TasksIcon = () => (
  <Icon>
    <path d="m4 6 1.5 1.5L8 5" />
    <path d="m4 13 1.5 1.5L8 12" />
    <path d="M12 6.5h8" />
    <path d="M12 13.5h8" />
    <path d="M4 20h16" />
  </Icon>
);

export const ClockIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Icon>
);

export const UserIcon = () => (
  <Icon>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7" />
  </Icon>
);

export const ShieldIcon = () => (
  <Icon>
    <path d="M12 3 4 6v6c0 4.5 3.4 8 8 9 4.6-1 8-4.5 8-9V6l-8-3Z" />
    <path d="m9 12 2 2 4-4" />
  </Icon>
);

export const LogOutIcon = () => (
  <Icon>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="m16 17 5-5-5-5" />
    <path d="M21 12H9" />
  </Icon>
);

export const CalendarIcon = () => (
  <Icon>
    <rect x="3" y="5" width="18" height="16" rx="2" />
    <path d="M3 10h18" />
    <path d="M8 3v4M16 3v4" />
  </Icon>
);

export const BellIcon = () => (
  <Icon>
    <path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8" />
    <path d="M10.3 21a2 2 0 0 0 3.4 0" />
  </Icon>
);

export const BellOffIcon = () => (
  <Icon>
    <path d="M8.7 3A6 6 0 0 1 18 8c0 2.3.3 4 .8 5.2" />
    <path d="M17 17H3s3-1 3-8c0-.7.1-1.3.3-1.9" />
    <path d="M10.3 21a2 2 0 0 0 3.4 0" />
    <path d="m2 2 20 20" />
  </Icon>
);

export const ChevronLeftIcon = () => (
  <Icon>
    <path d="m15 18-6-6 6-6" />
  </Icon>
);

export const ChevronRightIcon = () => (
  <Icon>
    <path d="m9 18 6-6-6-6" />
  </Icon>
);

export const ExternalIcon = () => (
  <Icon>
    <path d="M14 4h6v6" />
    <path d="M20 4 10 14" />
    <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </Icon>
);

export const CloseIcon = () => (
  <Icon>
    <path d="M6 6l12 12M18 6 6 18" />
  </Icon>
);

export const ShareIcon = () => (
  <Icon>
    <path d="M12 3v12" />
    <path d="m8 7 4-4 4 4" />
    <path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1" />
  </Icon>
);

export const CheckIcon = () => (
  <Icon>
    <path d="m5 12 5 5L20 7" />
  </Icon>
);
