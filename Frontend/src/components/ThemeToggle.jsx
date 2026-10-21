import { useTheme } from '../store/useTheme.js';
import * as I from './icons.jsx';

/** Sun / moon switch with a sliding knob. */
export default function ThemeToggle() {
  const theme = useTheme((s) => s.theme);
  const toggle = useTheme((s) => s.toggle);
  const dark = theme === 'dark';
  return (
    <button
      type="button"
      onClick={toggle}
      role="switch"
      aria-checked={dark}
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      title={dark ? 'Light mode' : 'Dark mode'}
      className="relative flex h-9 w-[68px] items-center rounded-full border border-line bg-raised px-1 transition-colors hover:border-line-strong"
    >
      <span
        className={`absolute left-[3px] top-[3px] grid h-7 w-7 place-items-center rounded-full bg-surface text-[14px] shadow-md ring-1 ring-line transition-transform duration-300 ease-[cubic-bezier(.3,1.4,.5,1)] ${
          dark ? 'translate-x-[32px] text-amber-200' : 'translate-x-0 text-amber-500'
        }`}
      >
        {dark ? <I.Moon /> : <I.Sun />}
      </span>
      <I.Sun className={`ml-1.5 text-[12px] transition-opacity ${dark ? 'opacity-50' : 'opacity-0'}`} />
      <I.Moon className={`ml-auto mr-1.5 text-[12px] transition-opacity ${dark ? 'opacity-0' : 'opacity-50'}`} />
    </button>
  );
}