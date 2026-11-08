import { explorerTx } from "../lib/config";
import { shortHash } from "../lib/format";

/**
 * Every transaction the user sent in this session, newest first, with the explorer link.
 * `aria-live="polite"` so a screen reader announces progress without stealing focus.
 */
export default function ActivityLog({ entries }) {
  if (!entries.length) {
    return <p className="hint">No transactions yet. Every step you send is listed here with its explorer link.</p>;
  }

  return (
    <ul className="log" aria-live="polite">
      {entries.map((entry) => (
        <li key={entry.key} className={`log__item ${entry.status === "error" ? "log__item--error" : ""}`}>
          <div className="log__top">
            <span className="log__label">{entry.label}</span>
            <span className="faint mono">{entry.at}</span>
          </div>

          {entry.status === "error" ? (
            <span className="log__msg">{entry.message}</span>
          ) : (
            <span className="faint">
              <span className="pill pill--good" style={{ marginRight: 8 }}>
                <span className="dot" />
                confirmed
              </span>
              {entry.chainKey && <span style={{ marginRight: 8 }}>{entry.chainKey}</span>}
              {entry.hash && (
                <a href={explorerTx(entry.chainKey, entry.hash)} target="_blank" rel="noreferrer" className="mono">
                  {shortHash(entry.hash)}
                </a>
              )}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
