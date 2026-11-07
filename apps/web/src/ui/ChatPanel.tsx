import { DOMAINS } from '@tv/core';
import { useEffect, useRef, useState } from 'react';
import { sendChat, startOver } from '../actions';
import { scrollBehavior } from '../motion';
import { useStore } from '../store';
import './ChatPanel.css';

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
    <aside className="panel left">
      <header>
        <div className="head-row">
          <span className="domain-tag">{domain.label}</span>
          <button onClick={startOver}>New system</button>
        </div>
        <h2>{environment.name}</h2>
        <p>{environment.summary}</p>
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
      </header>
      <div className="messages">
        {messages.map((m, i) => (
          <div key={i} className="message" data-role={m.role}>
            {m.text}
          </div>
        ))}
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
      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          submit(text);
        }}
      >
        <input aria-label="Ask or change something" value={text} placeholder="Ask, change or break something" onChange={(e) => setText(e.target.value)} />
        <button type="submit" disabled={chatting || !text.trim()}>
          Send
        </button>
      </form>
    </aside>
  );
}
