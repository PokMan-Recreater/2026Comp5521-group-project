import { useState } from "react";

import { isValidAddress } from "../lib/contracts";
import { formatDuration } from "../lib/format";

const AMOUNT_PATTERN = /^\d+(\.\d{1,18})?$/;

/**
 * Step 1 of the protocol: the MST owner names the counterparty, sizes both legs and creates the secret.
 *
 * The secret is generated *in the browser* (never on a server) and stays in this browser's localStorage; only
 * the hashlock is ever sent to the other party or put on chain.
 */
export default function SwapSetup({ account, mstMeta, settings, busy, onCreate, onImport }) {
  const [mstAmount, setMstAmount] = useState("100");
  const [ethAmount, setEthAmount] = useState("0.01");
  const [counterparty, setCounterparty] = useState(settings.counterparty || "");
  const [ethTimelock, setEthTimelock] = useState(String(settings.ethTimelock ?? 900));
  const [mstTimelock, setMstTimelock] = useState(String(settings.mstTimelock ?? 1800));
  const [importText, setImportText] = useState("");
  const [error, setError] = useState(null);

  const problems = [];
  if (!account) problems.push("Connect a wallet first.");
  if (!AMOUNT_PATTERN.test(mstAmount.trim()) || Number(mstAmount) <= 0) problems.push("MST amount must be a positive number.");
  if (!AMOUNT_PATTERN.test(ethAmount.trim()) || Number(ethAmount) <= 0) problems.push("ETH amount must be a positive number.");
  if (!isValidAddress(counterparty.trim())) {
    problems.push("Counterparty must be a valid address (it becomes the MST receiver).");
  } else if (account && counterparty.trim().toLowerCase() === account.toLowerCase()) {
    problems.push("The counterparty must be a different account from yours.");
  }
  if (!(Number(ethTimelock) < Number(mstTimelock))) {
    problems.push("The ETH deadline must be strictly shorter than the MST deadline.");
  }

  function handleSubmit(event) {
    event.preventDefault();
    setError(null);
    if (problems.length > 0) {
      setError(problems[0]);
      return;
    }
    onCreate({
      mstAmount: mstAmount.trim(),
      ethAmount: ethAmount.trim(),
      counterparty: counterparty.trim(),
      ethTimelock: Number(ethTimelock),
      mstTimelock: Number(mstTimelock),
    });
  }

  function handleImport() {
    setError(null);
    try {
      onImport(importText);
      setImportText("");
    } catch (importError) {
      setError(importError.message);
    }
  }

  return (
    <section className="card" aria-labelledby="setup-title">
      <div className="card__head">
        <h2 className="card__title" id="setup-title">
          Start a swap <span className="faint">· MST owner</span>
        </h2>
        <span className="pill pill--muted">step 1</span>
      </div>

      <form className="card__body" onSubmit={handleSubmit}>
        <p className="hint">
          You lock <strong>{mstMeta.symbol}</strong> on Sepolia first; the counterparty then locks ETH on Arbitrum with the
          same hashlock. Your secret is generated locally and never leaves this browser.
        </p>

        <div className="grid-2">
          <label className="field">
            <span>MST amount</span>
            <input
              inputMode="decimal"
              value={mstAmount}
              onChange={(event) => setMstAmount(event.target.value)}
              placeholder="100"
            />
            <small>{mstMeta.symbol} on Ethereum Sepolia</small>
          </label>

          <label className="field">
            <span>ETH amount</span>
            <input
              inputMode="decimal"
              value={ethAmount}
              onChange={(event) => setEthAmount(event.target.value)}
              placeholder="0.01"
            />
            <small>native ETH on Arbitrum Sepolia</small>
          </label>
        </div>

        <label className="field">
          <span>Counterparty address</span>
          <input
            className="mono"
            value={counterparty}
            onChange={(event) => setCounterparty(event.target.value)}
            placeholder="0x… (becomes the MST receiver and the ETH sender)"
            spellCheck="false"
          />
        </label>

        <div className="grid-2">
          <label className="field">
            <span>ETH deadline</span>
            <input inputMode="numeric" value={ethTimelock} onChange={(event) => setEthTimelock(event.target.value)} />
            <small>+{formatDuration(Number(ethTimelock) || 0)} · claimed first</small>
          </label>

          <label className="field">
            <span>MST deadline</span>
            <input inputMode="numeric" value={mstTimelock} onChange={(event) => setMstTimelock(event.target.value)} />
            <small>+{formatDuration(Number(mstTimelock) || 0)} · claimed second</small>
          </label>
        </div>

        {(error || problems.length > 0) && (
          <div className="banner banner--warn">
            <span aria-hidden="true">!</span>
            <span>{error || problems[0]}</span>
          </div>
        )}

        <div className="row">
          <button type="submit" className="btn btn--primary" disabled={Boolean(busy) || problems.length > 0}>
            Create swap &amp; lock {mstMeta.symbol}
          </button>
          <span className="faint">
            {problems.length === 0
              ? "Approves the MST allowance once, then locks the MST leg."
              : `${problems.length} item(s) to fix`}
          </span>
        </div>
      </form>

      <div className="card__head">
        <h2 className="card__title">
          Join a swap <span className="faint">· ETH owner</span>
        </h2>
        <span className="pill pill--muted">paste</span>
      </div>

      <div className="card__body">
        <p className="hint">
          Paste the swap the other party exported. You only need the hashlock and the amounts - the receiver of your ETH
          leg is read from the MST leg on chain, so it cannot be spoofed.
        </p>
        <label className="field">
          <span className="sr-only">Imported swap JSON</span>
          <textarea
            value={importText}
            onChange={(event) => setImportText(event.target.value)}
            placeholder='{ "hashlock": "0x…", "amounts": { "mst": "…", "eth": "…" } }'
            spellCheck="false"
          />
        </label>
        <div className="row">
          <button type="button" className="btn" onClick={handleImport} disabled={Boolean(busy) || !importText.trim()}>
            Import swap
          </button>
          <span className="faint">Then lock your ETH leg from the card on the right.</span>
        </div>
      </div>
    </section>
  );
}
