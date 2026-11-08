import { formatDuration, shortAddress, shortHash } from "../lib/format";
import { hashPreimage, verifyLegPair } from "../lib/swapId";

const same = (a, b) => Boolean(a && b) && String(a).toLowerCase() === String(b).toLowerCase();

/**
 * The four rules that turn two independent swaps into one atomic swap.
 *
 * This is the browser equivalent of `scripts/4_verify.js`: it never compares the two swap ids (those differ
 * by design, see README §7.14), it compares the hashlock, the party mapping, the timelock ordering and the
 * preimage.
 */
export default function PairingPanel({ mstSwap, ethSwap, preimage, revealedPreimage, now }) {
  if (!mstSwap || !ethSwap) {
    return (
      <p className="hint">
        Both legs are needed before the pair can be checked. {!mstSwap ? "The MST leg is not locked yet." : "The ETH leg is not funded yet."}
      </p>
    );
  }

  const secret = revealedPreimage || preimage || null;
  const finished = mstSwap.status !== 1 || ethSwap.status !== 1;

  const checks = [
    {
      label: "One shared hashlock",
      ok: same(mstSwap.hashlock, ethSwap.hashlock),
      detail: shortHash(mstSwap.hashlock),
    },
    {
      label: "Parties crossed",
      ok: same(mstSwap.receiver, ethSwap.sender) && same(mstSwap.sender, ethSwap.receiver),
      detail: `${shortAddress(mstSwap.sender, 4)} ⇄ ${shortAddress(mstSwap.receiver, 4)}`,
    },
    {
      label: "ETH leg expires first",
      ok: Number(ethSwap.timelock) < Number(mstSwap.timelock),
      detail:
        Number(ethSwap.timelock) < Number(mstSwap.timelock)
          ? `${formatDuration(Number(mstSwap.timelock) - Number(ethSwap.timelock))} earlier`
          : "ordering is unsafe",
    },
    {
      label: "Preimage opens the hashlock",
      ok: secret ? hashPreimage(secret) === mstSwap.hashlock.toLowerCase() : false,
      detail: secret ? "verified locally" : "not published yet - revealed by the ETH claim",
    },
  ];

  const verdict = verifyLegPair({
    mst: mstSwap,
    eth: ethSwap,
    preimage: secret || undefined,
    now,
    ignoreExpiry: finished,
  });

  return (
    <div className="stack" style={{ gap: 10 }}>
      {checks.map((check) => (
        <div key={check.label} className={`check ${check.ok ? "" : "check--bad"}`}>
          <span className="check__mark" aria-hidden="true">
            {check.ok ? "✓" : "!"}
          </span>
          <span>
            <strong>{check.label}</strong>
            <span className="faint"> · {check.detail}</span>
            <span className="sr-only">{check.ok ? " (ok)" : " (failing)"}</span>
          </span>
        </div>
      ))}

      {verdict.ok ? (
        <div className="banner banner--good">
          <span aria-hidden="true">✓</span>
          <span>The two legs form one atomic swap. Claiming either side reveals the secret that settles the other.</span>
        </div>
      ) : (
        <div className="banner banner--error">
          <span aria-hidden="true">!</span>
          <span>
            <strong>Do not claim either leg.</strong> {verdict.issues.join("; ")}.
          </span>
        </div>
      )}
    </div>
  );
}
