import { useEffect, useRef, useState } from 'react';
import { createGameApp, type GameApp } from './game/GameApp';
import { isTextEntry } from './game/input';
import { startNet, type ChatMessage, type Net } from './net/sync';

const NAME_KEY = 'maple.name';
const MAX_NAME = 16;
const MAX_CHAT = 120;
const CHAT_BACKLOG = 50; // how many messages React keeps
const CHAT_VISIBLE = 6; // how many the log renders

export function App() {
  const hostRef = useRef<HTMLDivElement>(null);
  const netRef = useRef<Net>(null);
  const chatInputRef = useRef<HTMLInputElement>(null);

  // Auto-apply a previously chosen name and skip the prompt; only first-time
  // players (no stored name) see the overlay.
  const storedName = localStorage.getItem(NAME_KEY) ?? '';
  const [showOverlay, setShowOverlay] = useState(storedName === '');
  const [draft, setDraft] = useState(storedName);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatDraft, setChatDraft] = useState('');

  useEffect(() => {
    let game: GameApp | undefined;
    let net: Net | undefined;
    let cancelled = false;

    void (async () => {
      const created = await createGameApp(hostRef.current!);
      // The effect may have been torn down (StrictMode double-invoke) while we
      // were awaiting init; if so, dispose immediately and never mount.
      if (cancelled) {
        created.destroy();
        return;
      }
      game = created;
      net = startNet(created);
      netRef.current = net;
      // Append incoming chat, capping the backlog so it can't grow unbounded.
      net.onChat((msg) => setMessages((prev) => [...prev, msg].slice(-CHAT_BACKLOG)));
      // setName latches until the connection is ready, so it's safe to fire the
      // stored name immediately.
      if (storedName !== '') net.setName(storedName);
    })();

    return () => {
      cancelled = true;
      net?.dispose();
      netRef.current = null;
      game?.destroy();
    };
    // storedName is read once at mount; the overlay drives later name changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Enter focuses the chat input when the game (not chat, not the name overlay)
  // has focus, so players can start typing without reaching for the mouse. We
  // skip it while the overlay is open so its own Enter (start game) isn't
  // hijacked, and when an input already has focus (chat's own Enter sends).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || showOverlay) return;
      // Skip when an input already has focus (chat's own Enter sends).
      if (isTextEntry(e.target)) return;
      e.preventDefault();
      chatInputRef.current?.focus();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showOverlay]);

  function submit() {
    const name = draft.trim();
    if (name === '') return;
    localStorage.setItem(NAME_KEY, name);
    netRef.current?.setName(name);
    setShowOverlay(false);
  }

  function sendChat() {
    const text = chatDraft.trim();
    if (text === '') return;
    netRef.current?.sendChat(text);
    setChatDraft('');
    // Keep focus in the input so a back-and-forth conversation needs no clicks.
    chatInputRef.current?.focus();
  }

  return (
    <div ref={hostRef}>
      {showOverlay && (
        <div style={overlayStyle}>
          <div style={panelStyle}>
            <label style={labelStyle} htmlFor="name">
              キャラクター名
            </label>
            <input
              id="name"
              autoFocus
              maxLength={MAX_NAME}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
              }}
              style={inputStyle}
            />
            <button onClick={submit} disabled={draft.trim() === ''} style={buttonStyle}>
              ゲームを始める
            </button>
          </div>
        </div>
      )}
      <div style={chatStyle}>
        <div style={chatLogStyle}>
          {messages.slice(-CHAT_VISIBLE).map((m) => (
            <div key={String(m.id)} style={chatLineStyle}>
              <span style={m.mine ? chatNameMineStyle : chatNameStyle}>{m.name}</span>
              {`: ${m.text}`}
            </div>
          ))}
        </div>
        <div style={chatRowStyle}>
          <input
            ref={chatInputRef}
            maxLength={MAX_CHAT}
            value={chatDraft}
            placeholder="チャット…"
            onChange={(e) => setChatDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') sendChat();
              // Escape returns focus to the game so movement keys work again.
              else if (e.key === 'Escape') e.currentTarget.blur();
            }}
            style={chatInputStyle}
          />
          <button onClick={sendChat} style={chatSendStyle}>
            送信
          </button>
        </div>
      </div>
    </div>
  );
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(11, 13, 18, 0.85)',
  zIndex: 10,
};

const panelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  padding: 24,
  minWidth: 260,
  borderRadius: 8,
  background: '#1b1f2a',
  border: '1px solid #3b4252',
  fontFamily: 'sans-serif',
  color: '#eceff4',
};

const labelStyle: React.CSSProperties = { fontSize: 14 };

const inputStyle: React.CSSProperties = {
  padding: '8px 10px',
  fontSize: 16,
  borderRadius: 4,
  border: '1px solid #3b4252',
  background: '#10131b',
  color: '#eceff4',
};

const buttonStyle: React.CSSProperties = {
  padding: '8px 10px',
  fontSize: 15,
  borderRadius: 4,
  border: 'none',
  background: '#5e81ac',
  color: '#eceff4',
  cursor: 'pointer',
};

// Chat overlay: an HTML layer (not Pixi) so Japanese IME composition works. It
// sits bottom-left above the canvas; the HUD lives in Pixi on the same corner,
// so the chat box is pinned to the very bottom and the log stacks upward.
const chatStyle: React.CSSProperties = {
  position: 'fixed',
  left: 12,
  bottom: 12,
  width: 320,
  maxWidth: 'calc(100vw - 24px)',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  fontFamily: 'sans-serif',
  zIndex: 5, // below the name overlay (10), above the canvas
};

const chatLogStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  padding: '6px 8px',
  borderRadius: 6,
  background: 'rgba(16, 19, 27, 0.6)',
  color: '#eceff4',
  fontSize: 12,
  lineHeight: 1.35,
  pointerEvents: 'none', // the log is read-only; clicks fall through to the game
};

const chatLineStyle: React.CSSProperties = {
  wordBreak: 'break-word',
};

const chatNameStyle: React.CSSProperties = { color: '#88c0d0', fontWeight: 600 };
// Own lines reuse the local-player accent so they stand out in the log.
const chatNameMineStyle: React.CSSProperties = { color: '#a3be8c', fontWeight: 600 };

const chatRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 6,
};

const chatInputStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: '6px 8px',
  fontSize: 14,
  borderRadius: 4,
  border: '1px solid #3b4252',
  background: 'rgba(16, 19, 27, 0.85)',
  color: '#eceff4',
};

const chatSendStyle: React.CSSProperties = {
  padding: '6px 12px',
  fontSize: 14,
  borderRadius: 4,
  border: 'none',
  background: '#5e81ac',
  color: '#eceff4',
  cursor: 'pointer',
};
