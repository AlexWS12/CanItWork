import { DOMAINS } from '@tv/core';
import { useEffect, useRef, useState } from 'react';
import { sendChat } from '../actions';
import { scrollBehavior } from '../motion';
import { useStore } from '../store';
import './ChatPanel.css';
import { AGENT_LABEL, ENGINE_LABEL } from './labels';

export function ChatPanel() {
  const messages = useStore((s) => s.messages);
  const chatting = useStore((s) => s.chatting);
  const environment = useStore((s) => s.environment);
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: scrollBehavior(), block: 'end' });
  }, [messages]);
  if (!environment) return null;
  const domain = DOMAINS[environment.domain];
  const submit = (message: string) => {
    if (!message.trim() || chatting) return;
    setText('');
    void sendChat(message.trim());
  };
  return (
    <aside className="panel left" aria-label="Chat">
      <div className="messages">
        {messages.map((m, i) =>
          m.role === 'user' ? (
            <div key={i} className="message" data-role="user">
              {m.text}
            </div>
          ) : (
            <div key={i} className="app-message">
              {m.source && (
                <span className="attribution">
                  {AGENT_LABEL[m.source.agent]} · {ENGINE_LABEL[m.source.engine]}
                </span>
              )}
              <div className="message" data-role="app">
                {m.text}
              </div>
            </div>
          ),
        )}
        {chatting && (
          <div className="message" data-role="app" data-pending="true">
            Working…
          </div>
        )}
        <div ref={end} />
      </div>
      <div className="suggestions">
        {domain.suggestions.map((s) => (
          <button key={s} onClick={() => submit(s)} disabled={chatting}>
            {s}
          </button>
        ))}
      </div>
      <div className="chat-limits">
        {environment.unmodelled.length > 0 ? (
          <details className="limits">
            <summary>Not modelled in this design ({environment.unmodelled.length})</summary>
            <ul>
              {environment.unmodelled.map((item) => (
                <li key={item} className="unmodelled">
                  {item}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        <details className="limits">
          <summary>
            {domain.label} simulator limits ({domain.limits.length})
          </summary>
          <ul>
            {domain.limits.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </details>
      </div>
      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          submit(text);
        }}
      >
        <textarea
          aria-label="Ask or change something"
          rows={1}
          value={text}
          placeholder="Ask, change or break something"
          onChange={(e) => {
            setText(e.target.value);
            // Grows with what is typed, up to five lines
            e.target.style.height = 'auto';
            e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit(text);
            }
          }}
        />
        <button type="submit" className="chat-send" aria-label="Send" disabled={chatting || !text.trim()}>
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
            <path d="M8 13 V3 M3.5 7.5 L8 3 L12.5 7.5" fill="none" stroke="currentColor" strokeWidth="2" />
          </svg>
        </button>
      </form>
    </aside>
  );
}
