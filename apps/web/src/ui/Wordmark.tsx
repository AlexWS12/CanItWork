import './Wordmark.css';

export type WordmarkState = 'idle' | 'running' | 'paused' | 'incident';

// The landing title's circuit in miniature: an amber power dot, the word with "It" coloured, and an end dot.
// In the running top bar, "It" and the end dot follow the run state; idle (the landing) looks like running.
export function Wordmark({ state = 'idle' }: { state?: WordmarkState }) {
  return (
    <span className="wordmark wordmark-circuit" data-state={state} role="img" aria-label="CanItWork">
      <span className="wordmark-dot wordmark-power" aria-hidden />
      <span aria-hidden>
        Can<span className="wordmark-it">It</span>Work
      </span>
      <span className="wordmark-dot wordmark-end" aria-hidden />
    </span>
  );
}
