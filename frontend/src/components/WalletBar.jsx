import { CHAINS, chainOfId } from "../lib/config";
import { formatAmount, shortAddress } from "../lib/format";

/**
 * Header strip: who is connected, which chain the wallet is on, and both balances.
 *
 * The two balances live on different chains on purpose (MST only exists on Sepolia, the ETH leg escrows
 * value on Arbitrum Sepolia), so they are always labelled with their chain.
 */
export default function WalletBar({
  account,
  chainId,
  mstMeta,
  mstBalance,
  ethBalance,
  busy,
  onConnect,
  onSwitch,
  onOpenSettings,
}) {
  const chain = chainOfId(chainId);

  return (
    <section className="card" aria-label="Wallet">
      <div className="card__body">
        <div className="spread">
          <div className="row">
            {account ? (
              <span className="mono" title={account}>
                {shortAddress(account, 6)}
              </span>
            ) : (
              <span className="hint">No wallet connected</span>
            )}
            <span className={`pill ${chain ? "pill--open" : "pill--bad"}`}>
              <span className="dot" />
              {chain ? chain.label : chainId ? "unsupported network" : "not connected"}
            </span>
          </div>

          <div className="row">
            {!account && (
              <button type="button" className="btn btn--primary" onClick={onConnect} disabled={Boolean(busy)}>
                Connect wallet
              </button>
            )}
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => onSwitch(CHAINS.sepolia)}
              disabled={!account || Boolean(busy)}
            >
              Sepolia
            </button>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => onSwitch(CHAINS.arbitrumSepolia)}
              disabled={!account || Boolean(busy)}
            >
              Arbitrum
            </button>
            <button type="button" className="btn btn--sm btn--ghost" onClick={onOpenSettings}>
              Settings
            </button>
          </div>
        </div>

        <div className="spread">
          <div>
            <div className="faint">MST · Ethereum Sepolia</div>
            <div className="num" style={{ fontSize: 20, fontWeight: 700 }}>
              {mstBalance === null || mstBalance === undefined ? "–" : formatAmount(mstBalance, mstMeta.decimals)}{" "}
              <small style={{ fontSize: 13, color: "var(--text-dim)" }}>{mstMeta.symbol}</small>
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div className="faint">ETH · Arbitrum Sepolia</div>
            <div className="num" style={{ fontSize: 20, fontWeight: 700 }}>
              {ethBalance === null || ethBalance === undefined ? "–" : formatAmount(ethBalance, 18)}{" "}
              <small style={{ fontSize: 13, color: "var(--text-dim)" }}>ETH</small>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
