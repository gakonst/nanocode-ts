export const css = `
:host {
  all: initial;
  --accent: #2f6fef;
  --bg: #ffffff;
  --danger: #c62828;
  --line: #d6d6d6;
  --muted: #5c5c5c;
  --on-accent: #ffffff;
  --shadow: 0 4px 18px rgb(0 0 0 / 0.16);
  --text: #141414;
  color-scheme: light dark;
}

@media (prefers-color-scheme: dark) {
  :host {
    --accent: #7aa5ff;
    --bg: #1c1c1c;
    --danger: #ff8a80;
    --line: #3b3b3b;
    --muted: #a6a6a6;
    --on-accent: #0c0c0c;
    --shadow: 0 4px 18px rgb(0 0 0 / 0.5);
    --text: #f1f1f1;
  }
}

* {
  box-sizing: border-box;
}

[hidden] {
  display: none !important;
}

.launcher,
.panel,
.editor {
  color: var(--text);
  font: 13px/1.45 system-ui, -apple-system, 'Segoe UI', sans-serif;
}

.launcher {
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 999px;
  bottom: 16px;
  box-shadow: var(--shadow);
  cursor: pointer;
  padding: 8px 14px;
  position: fixed;
  right: 16px;
}

.launcher[aria-expanded='true'] {
  background: var(--text);
  border-color: var(--text);
  color: var(--bg);
}

.count {
  font-variant-numeric: tabular-nums;
  margin-left: 6px;
  opacity: 0.7;
}

.overlay {
  cursor: crosshair;
  inset: 0;
  position: fixed;
}

.highlight {
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  border: 2px solid var(--accent);
  border-radius: 4px;
  left: 0;
  pointer-events: none;
  position: fixed;
  top: 0;
}

.pin {
  background: var(--accent);
  border-radius: 50%;
  color: var(--on-accent);
  font: 600 11px/20px system-ui, sans-serif;
  height: 20px;
  left: 0;
  pointer-events: none;
  position: fixed;
  text-align: center;
  top: 0;
  width: 20px;
}

.editor,
.panel {
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 10px;
  box-shadow: var(--shadow);
  display: grid;
  gap: 10px;
  padding: 12px;
  position: fixed;
}

.editor {
  left: 0;
  top: 0;
  width: min(320px, calc(100vw - 24px));
}

.panel {
  bottom: 62px;
  max-height: calc(100vh - 96px);
  overflow: auto;
  right: 16px;
  width: min(360px, calc(100vw - 32px));
}

h2 {
  font-size: 14px;
  font-weight: 600;
  margin: 0;
}

p {
  margin: 0;
}

label {
  display: grid;
  gap: 6px;
}

textarea {
  background: transparent;
  border: 1px solid var(--line);
  border-radius: 6px;
  color: inherit;
  font: inherit;
  min-height: 76px;
  padding: 6px 8px;
  resize: vertical;
  width: 100%;
}

button,
.button {
  background: transparent;
  border: 1px solid var(--line);
  border-radius: 6px;
  color: var(--text);
  cursor: pointer;
  display: inline-block;
  font: inherit;
  padding: 6px 12px;
  text-decoration: none;
}

.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
}

button:disabled {
  cursor: default;
  opacity: 0.5;
}

.quiet {
  border: none;
  color: var(--muted);
  padding: 0;
  text-decoration: underline;
}

button:focus-visible,
.button:focus-visible,
textarea:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.muted {
  color: var(--muted);
}

.code {
  font: 600 26px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: 0.08em;
}

.error {
  color: var(--danger);
}

ol {
  display: grid;
  gap: 10px;
  list-style: none;
  margin: 0;
  padding: 0;
}

li {
  align-items: start;
  display: grid;
  gap: 8px;
  grid-template-columns: 20px 1fr auto;
}

li .pin {
  position: static;
}

.row {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: flex-end;
}

.head {
  justify-content: space-between;
}

@media (prefers-reduced-motion: no-preference) {
  .editor,
  .panel {
    animation: rise 120ms ease-out;
  }

  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
  }
}
`
