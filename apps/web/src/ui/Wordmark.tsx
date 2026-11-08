import './Wordmark.css';

export type WordmarkState = 'idle' | 'running' | 'paused' | 'incident';

// The cube's two blueprint faces are a dashed draft; the third face is solid, the design that passed every check
const FACE_DRAFT = 'M0,-40 L34.6,-20 L0,0 L-34.6,-20 Z M-34.6,-20 L0,0 L0,40 L-34.6,20 Z';
const FACE_SOLID = 'M0,0 L34.6,-20 L34.6,20 L0,40 Z';

// Logo 2, "Blueprint to Solid": a cube half drawn as a blueprint and half solid amber
export function LogoMark({ size = 22, dashed = true }: { size?: number; dashed?: boolean }) {
  return (
    <svg className="logo-mark" width={size} height={size} viewBox="-50 -50 100 100" aria-hidden>
      <path className="logo-draft" d={FACE_DRAFT} fill="none" strokeWidth={size < 20 ? 7 : 5.5} strokeDasharray={dashed && size >= 20 ? '9 7' : undefined} strokeLinejoin="round" />
      <path className="logo-solid" d={FACE_SOLID} />
    </svg>
  );
}

// The mark, then "CanIt" light and "Work" solid, echoing the cube. In the running top bar the solid face follows the run state.
export function Wordmark({ state = 'idle' }: { state?: WordmarkState }) {
  return (
    <span className="wordmark" data-state={state} role="img" aria-label="CanItWork">
      <LogoMark />
      <span aria-hidden>
        <span className="wordmark-light">CanIt</span>Work
      </span>
    </span>
  );
}
