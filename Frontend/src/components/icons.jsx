// Small stroke icons (24×24 grid), sized by font-size via 1em.

function Icon({ children, className = '', size = '1em', strokeWidth = 2, ...rest }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      {...rest}
    >
      {children}
    </svg>
  );
}

export const Play = (p) => (
  <Icon {...p}>
    <path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5Z" fill="currentColor" />
  </Icon>
);
export const Pause = (p) => (
  <Icon {...p}>
    <rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor" />
    <rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor" />
  </Icon>
);
export const SkipBack = (p) => (
  <Icon {...p}>
    <path d="M19 20 9 12l10-8v16Z" fill="currentColor" />
    <path d="M5 19V5" />
  </Icon>
);
export const SkipForward = (p) => (
  <Icon {...p}>
    <path d="m5 4 10 8-10 8V4Z" fill="currentColor" />
    <path d="M19 5v14" />
  </Icon>
);
export const Undo = (p) => (
  <Icon {...p}>
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
  </Icon>
);
export const Redo = (p) => (
  <Icon {...p}>
    <path d="m15 14 5-5-5-5" />
    <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
  </Icon>
);
export const Scissors = (p) => (
  <Icon {...p}>
    <circle cx="6" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <path d="M20 4 8.12 15.88" />
    <path d="M14.47 14.48 20 20" />
    <path d="M8.12 8.12 12 12" />
  </Icon>
);
/** Selection tool (arrow cursor). */
export const Pointer = (p) => (
  <Icon {...p}>
    <path d="M4 3l7.5 18 2.4-7.6L21.5 11z" />
  </Icon>
);
export const Trash = (p) => (
  <Icon {...p}>
    <path d="M3 6h18" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </Icon>
);
export const Restore = (p) => (
  <Icon {...p}>
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
  </Icon>
);
export const Sun = (p) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
  </Icon>
);
export const Moon = (p) => (
  <Icon {...p}>
    <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
  </Icon>
);
export const ZoomIn = (p) => (
  <Icon {...p}>
    <path d="M5 12h14M12 5v14" />
  </Icon>
);
export const ZoomOut = (p) => (
  <Icon {...p}>
    <path d="M5 12h14" />
  </Icon>
);
export const Fit = (p) => (
  <Icon {...p}>
    <path d="M3 12h7M14 12h7M7 8l-4 4 4 4M17 8l4 4-4 4" />
  </Icon>
);
export const Crosshair = (p) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
  </Icon>
);
export const Magnet = (p) => (
  <Icon {...p}>
    <path d="m6 15-4-4 6.75-6.77a7.79 7.79 0 0 1 11 11L13 22l-4-4 6.39-6.36a2.14 2.14 0 0 0-3-3L6 15" />
    <path d="m5 8 4 4M12 15l4 4" />
  </Icon>
);
export const Volume = (p) => (
  <Icon {...p}>
    <path d="M11 5 6 9H2v6h4l5 4V5Z" fill="currentColor" />
    <path d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14" />
  </Icon>
);
export const Mute = (p) => (
  <Icon {...p}>
    <path d="M11 5 6 9H2v6h4l5 4V5Z" fill="currentColor" />
    <path d="m22 9-6 6M16 9l6 6" />
  </Icon>
);
export const Expand = (p) => (
  <Icon {...p}>
    <path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M16 21h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
  </Icon>
);
export const Download = (p) => (
  <Icon {...p}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="m7 10 5 5 5-5M12 15V3" />
  </Icon>
);
export const Upload = (p) => (
  <Icon {...p}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="m17 8-5-5-5 5M12 3v12" />
  </Icon>
);
export const Plus = (p) => (
  <Icon {...p}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);
export const Film = (p) => (
  <Icon {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M7 3v18M17 3v18M3 7.5h4M3 12h18M3 16.5h4M17 7.5h4M17 16.5h4" />
  </Icon>
);
export const Text = (p) => (
  <Icon {...p}>
    <path d="M4 7V5h16v2M9 19h6M12 5v14" />
  </Icon>
);
export const Wave = (p) => (
  <Icon {...p}>
    <path d="M2 12h2M6 8v8M10 5v14M14 9v6M18 7v10M22 12h-2" />
  </Icon>
);
export const Cpu = (p) => (
  <Icon {...p}>
    <rect x="5" y="5" width="14" height="14" rx="2" />
    <rect x="9" y="9" width="6" height="6" rx="1" />
    <path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" />
  </Icon>
);
export const Shield = (p) => (
  <Icon {...p}>
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
  </Icon>
);
export const Sparkle = (p) => (
  <Icon {...p}>
    <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z" fill="currentColor" />
  </Icon>
);
export const X = (p) => (
  <Icon {...p}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Icon>
);
export const Keyboard = (p) => (
  <Icon {...p}>
    <rect x="2" y="5" width="20" height="14" rx="2" />
    <path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M18 13h.01M8 16h8" />
  </Icon>
);