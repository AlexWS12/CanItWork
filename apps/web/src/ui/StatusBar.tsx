import type { KeyCheck } from '@tv/core';
import { useStore } from '../store';
import './StatusBar.css';

const CHECK_LABEL: Record<KeyCheck, string> = { ok: 'key works', failing: 'key failing', unchecked: 'key not checked' };

export function StatusBar() {
  const status = useStore((s) => s.status);
  const chips: Array<[string, boolean, string, KeyCheck | undefined]> = status
    ? [
        ['Gemini', status.gemini !== 'off', status.gemini, status.checks?.gemini],
        ['Swarms', status.swarms, status.swarms ? 'hosted' : 'off', status.checks?.swarms],
        ['Prune', status.prune, status.prune ? 'gateway' : 'off', status.checks?.prune],
      ]
    : [];
  const live = chips.some(([, on]) => on);
  return (
    <div className="status">
      <span className="wordmark">tv</span>
      {status && !live && <span className="offline">Local rules, no AI connected</span>}
      {!status && <span className="offline">Server offline</span>}
      {chips.map(([name, on, how, check]) => (
        <span key={name} className="chip" data-on={on} data-check={on ? check : undefined} title={`${name}: ${how}${on && check ? `, ${CHECK_LABEL[check]}` : ''}`}>
          {name}
        </span>
      ))}
    </div>
  );
}
