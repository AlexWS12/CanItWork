import { useEffect, useRef, useState } from 'react';
import './Dictation.css';

// The browser's own speech recognition: free and keyless. Chrome, Edge and Safari have it; Firefox does not, so the button hides there.
interface Recognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}
type RecognitionClass = new () => Recognition;

const Speech: RecognitionClass | undefined =
  typeof window === 'undefined'
    ? undefined
    : ((window as unknown as { SpeechRecognition?: RecognitionClass; webkitSpeechRecognition?: RecognitionClass }).SpeechRecognition ??
      (window as unknown as { webkitSpeechRecognition?: RecognitionClass }).webkitSpeechRecognition);

const ERRORS: Record<string, string> = {
  'not-allowed': 'Microphone access is blocked. Allow it in the address bar to dictate.',
  'service-not-allowed': 'Dictation is turned off in this browser.',
  'audio-capture': 'No microphone was found.',
  network: 'Dictation needs a connection to the browser’s speech service.',
};

// Speech is added after whatever is already typed, words appear as they are heard, and the text stays editable before it is sent.
// Any change the dictation did not make (typing, sending, clearing) ends it, so it never writes over the user.
export function MicButton({ text, onText, disabled }: { text: string; onText: (text: string) => void; disabled?: boolean }) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recognition = useRef<Recognition | null>(null);
  const written = useRef<string | null>(null);

  const stop = () => {
    recognition.current?.stop();
  };

  useEffect(() => () => recognition.current?.abort(), []);
  useEffect(() => {
    if (disabled) stop();
  }, [disabled]);
  useEffect(() => {
    if (listening && written.current !== null && text !== written.current) stop();
  }, [text, listening]);

  if (!Speech) return null;

  const start = () => {
    setError(null);
    const base = text.trim() ? `${text.trimEnd()} ` : '';
    const r = new Speech();
    r.continuous = true;
    r.interimResults = true;
    r.lang = navigator.language || 'en-US';
    r.onresult = (e) => {
      let heard = '';
      for (let i = 0; i < e.results.length; i++) heard += e.results[i][0].transcript;
      const next = base + heard.trimStart();
      written.current = next;
      onText(next);
    };
    r.onerror = (e) => {
      if (e.error !== 'aborted' && e.error !== 'no-speech') setError(ERRORS[e.error] ?? 'Dictation stopped unexpectedly.');
    };
    r.onend = () => {
      setListening(false);
      written.current = null;
      if (recognition.current === r) recognition.current = null;
    };
    recognition.current = r;
    written.current = text;
    try {
      r.start();
      setListening(true);
    } catch {
      setError('Dictation could not start.');
    }
  };

  return (
    <>
      <button
        type="button"
        className="mic"
        aria-pressed={listening}
        aria-label={listening ? 'Stop dictating' : 'Dictate'}
        title={listening ? 'Stop dictating' : 'Dictate'}
        disabled={disabled && !listening}
        onClick={() => (listening ? stop() : start())}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" />
          <path d="M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
      {error && (
        <span className="mic-error" role="status">
          {error}
        </span>
      )}
    </>
  );
}
