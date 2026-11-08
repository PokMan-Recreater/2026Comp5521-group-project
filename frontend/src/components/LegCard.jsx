import { LEG_CHAIN, explorerTx } from "../lib/config";
import { STATUS, formatAmount, shortAddress, shortHash, timelockLabel } from "../lib/format";

/**
 * One leg of the swap.
 *
 * Everything shown here comes from the chain, and every action is gated on the connected account: the card
 * decides whether you are the sender, the receiver, or a bystander, and explains why a button is disabled
 * instead of hiding the rule.
 */
export default function LegCard({ leg, swap, recordLeg, account, now, decimals, busy, onClaim, onRefund, onLock }) {
  const isMst = leg === "mst";
  const chain = LEG_CHAIN[leg];
  const symbol = isMst ? "MST" : "ETH";

  const status = swap ? swap.status : 0;
  const meta = STATUS[status] || STATUS[0];
  const timelock = swap ? Number(swap.timelock) : recordLeg && recordLeg.timelock ? Number(recordLeg.timelock) : null;

  const isOpen = status === 1;
  const claimable = Boolean(swap) && isOpen && timelock !== null && now < timelock;
  const refundable = Boolean(swap) && isOpen && timelock !== null && now >= timelock;

  const same = (a, b) => Boolean(a && b) && a.toLowerCase() === b.toLowerCase();
  const isReceiver = same(swap && swap.receiver, account);
  const isSender = same(swap && swap.sender, account);

  const amount = swap ? swap.amount : recordLeg && recordLeg.amount ? BigInt(recordLeg.amount) : null;
  const amountDecimals = isMst ? decimals : 18;

  let pill = { tone: meta.tone, label: meta.label };
  if (swap && isOpen) pill = claimable ? { tone: "open", label: "Locked · claimable" } : { tone: "warn", label: "Locked · expired" };

  return (
    <article className={`leg ${isMst ? "" : "leg--eth"}`}>
      <header className="leg__head">
        <div>
          <div className="leg__name">
            <span className="leg__iso" aria-hidden="true" />
            {isMst ? "MST leg" : "ETH leg"}
          </div>
          <div className="leg__chain">
            {chain.label} · {isMst ? "ERC20HTLC" : "ETHHTLC"}
          </div>
        </div>
        <span className={`pill pill--${pill.tone}`}>
          <span className="dot" />
          {pill.label}
        </span>
      </header>

      <div className="leg__amount num">
        {amount === null ? "–" : formatAmount(amount, amountDecimals)}
        <small>{symbol}</small>
      </div>

      <dl className="kv">
        <div>
          <dt>Sender</dt>
          <dd className="mono">{swap ? shortAddress(swap.sender, 5) : recordLeg && recordLeg.sender ? shortAddress(recordLeg.sender, 5) : "–"}</dd>
        </div>
        <div>
          <dt>Receiver</dt>
          <dd className="mono">{swap ? shortAddress(swap.receiver, 5) : recordLeg && recordLeg.receiver ? shortAddress(recordLeg.receiver, 5) : "–"}</dd>
        </div>
        <div>
          <dt>Deadline</dt>
          <dd className="num">{timelock ? timelockLabel(timelock, now) : "–"}</dd>
        </div>
        <div>
          <dt>Swap id</dt>
          <dd className="mono" title={swap ? swap.swapId : ""}>
            {swap ? shortHash(swap.swapId) : "–"}
          </dd>
        </div>
        <div>
          <dt>Lock tx</dt>
          <dd className="mono">
            {recordLeg && recordLeg.txHash ? (
              <a href={explorerTx(chain.key, recordLeg.txHash)} target="_blank" rel="noreferrer">
                {shortHash(recordLeg.txHash)}
              </a>
            ) : (
              "–"
            )}
          </dd>
        </div>
      </dl>

      {!swap && (
        <div className="leg__actions">
          {!isMst && onLock ? (
            <button type="button" className="btn btn--primary" onClick={onLock} disabled={Boolean(busy)}>
              Lock {symbol}
            </button>
          ) : (
            <span className="faint">
              Not locked yet{isMst ? " - the MST owner locks first (setup panel)." : " - it can be funded once the MST leg exists."}
            </span>
          )}
        </div>
      )}

      {claimable && (
        <div className="leg__actions">
          <button
            type="button"
            className="btn btn--primary"
            onClick={onClaim}
            disabled={!isReceiver || Boolean(busy)}
            title={isReceiver ? "Reveal the preimage and take this leg" : "Only the swap receiver can claim this leg"}
          >
            Claim {symbol}
          </button>
          <span className="faint">
            {isReceiver
              ? isMst
                ? "You are the receiver: claiming publishes the preimage on Sepolia."
                : "You are the receiver: this claim is what reveals the preimage to the other party."
              : "Only the swap receiver can claim this leg."}
          </span>
        </div>
      )}

      {refundable && (
        <div className="leg__actions">
          <button
            type="button"
            className="btn btn--danger"
            onClick={onRefund}
            disabled={!isSender || Boolean(busy)}
            title={isSender ? "Take the funds back after the deadline" : "Only the swap sender can refund this leg"}
          >
            Refund {symbol}
          </button>
          <span className="faint">
            {isSender ? "You are the sender and the deadline has passed." : "Only the swap sender can refund this leg."}
          </span>
        </div>
      )}

      {swap && status === 2 && <span className="faint">Settled with the preimage - nothing left to do on this leg.</span>}
      {swap && status === 3 && <span className="faint">Refunded to the sender after the deadline.</span>}
    </article>
  );
}
