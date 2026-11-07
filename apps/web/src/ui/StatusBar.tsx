import { useStore } from '../store';
import './StatusBar.css';

export function StatusBar() {
  const status = useStore((s) => s.status);
  const chips: Array<[string, boolean, string]> = status
    ? [
        ['Gemini', status.gemini !== 'off', status.gemini],
        ['Swarms', status.swarms, status.swarms ? 'hosted' : 'off'],
        ['Prune', status.prune, status.prune ? 'gateway' : 'off'],
      ]
    : [];
  const live = chips.some(([, on]) => on);
  return (
    <div className="status">
      <span className="wordmark">tv</span>
      {status && !live && <span className="offline">Local rules, no AI connected</span>}
      {!status && <span className="offline">Server offline</span>}
      {chips.map(([name, on, how]) => (
        <span key={name} className="chip" data-on={on} title={`${name}: ${how}`}>
          {name}
        </span>
      ))}
    </div>
  );
}
