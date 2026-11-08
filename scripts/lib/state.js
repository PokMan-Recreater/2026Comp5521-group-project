// SPDX-License-Identifier: MIT
"use strict";

/**
 * Cross-chain state observation (Task B3).
 *
 * The two chains are independent: neither contract knows the other exists, so "the state of the swap" is
 * something only the coordinator can compute, by reading both legs and comparing them with the shared
 * secret and the two deadlines. This module turns the two on-chain records into
 *   - a per-leg state (`CLAIMABLE` / `REFUNDABLE` / `CLAIMED` / `REFUNDED` / `MISSING`),
 *   - the pairing verdict from `verifyLegPair`,
 *   - the ordered list of actions that are actually possible right now.
 */

const { verifyLegPair } = require("./swapId");

const LegState = {
  MISSING: "MISSING",
  CLAIMABLE: "CLAIMABLE",
  REFUNDABLE: "REFUNDABLE",
  CLAIMED: "CLAIMED",
  REFUNDED: "REFUNDED",
};

/** Seconds between `now` and `timelock` (negative once the deadline has passed). */
function secondsUntil(timelock, now) {
  return Number(BigInt(timelock) - BigInt(now));
}

/** Classifies one leg relative to `now` (unix seconds). */
function classifyLeg(swap, now) {
  if (!swap) return LegState.MISSING;
  if (swap.statusName === "CLAIMED") return LegState.CLAIMED;
  if (swap.statusName === "REFUNDED") return LegState.REFUNDED;
  if (swap.statusName !== "OPEN") return LegState.MISSING;
  return BigInt(now) < BigInt(swap.timelock) ? LegState.CLAIMABLE : LegState.REFUNDABLE;
}

/**
 * Builds the descriptor pair `verifyLegPair` expects from the two normalised on-chain legs.
 * `tokenContract` is dropped on purpose: it differs by design (MST address vs address(0)).
 */
function legPairFromChain({ mstSwap, ethSwap }) {
  return {
    mst: {
      sender: mstSwap.sender,
      receiver: mstSwap.receiver,
      amount: mstSwap.amount,
      hashlock: mstSwap.hashlock,
      timelock: mstSwap.timelock,
    },
    eth: {
      sender: ethSwap.sender,
      receiver: ethSwap.receiver,
      amount: ethSwap.amount,
      hashlock: ethSwap.hashlock,
      timelock: ethSwap.timelock,
    },
  };
}

/**
 * Full picture of one swap group across both chains.
 * @param {{mstSwap: object|null, ethSwap: object|null, preimage?: string, now: number|bigint}} params
 */
function describeGroup({ mstSwap, ethSwap, preimage, now }) {
  const mst = classifyLeg(mstSwap, now);
  const eth = classifyLeg(ethSwap, now);

  // a finished swap is judged on identity alone: its deadlines have necessarily passed by then
  const terminal = (state) =>
    state === LegState.CLAIMED || state === LegState.REFUNDED || state === LegState.MISSING;
  const finished = terminal(mst) || terminal(eth);

  const pairing =
    mstSwap && ethSwap
      ? verifyLegPair({ ...legPairFromChain({ mstSwap, ethSwap }), preimage, now, ignoreExpiry: finished })
      : { ok: false, issues: ["both legs must be locked before the pair can be verified"] };

  const nextActions = [];
  if (eth === LegState.CLAIMABLE) {
    nextActions.push("Alice claims the ETH leg:   scripts/5_claimBoth.js --network arbitrumSepolia");
  }
  if (eth === LegState.CLAIMED && mst === LegState.CLAIMABLE) {
    nextActions.push("Bob claims the MST leg:     scripts/5_claimBoth.js --network sepolia");
  }
  if (eth === LegState.REFUNDABLE) {
    nextActions.push("Bob refunds the ETH leg:    scripts/6_refund.js --network arbitrumSepolia");
  }
  if (mst === LegState.REFUNDABLE) {
    nextActions.push("Alice refunds the MST leg:  scripts/6_refund.js --network sepolia");
  }
  if (mst === LegState.CLAIMED && eth === LegState.CLAIMED) {
    nextActions.push("swap complete: the MST is with Bob and the ETH is with Alice");
  }
  if (mst === LegState.REFUNDED && eth === LegState.REFUNDED) {
    nextActions.push("swap cancelled: both legs were refunded, no asset changed hands");
  }

  return { mst, eth, pairing, nextActions, secondsUntilMst: mstSwap ? secondsUntil(mstSwap.timelock, now) : null,
    secondsUntilEth: ethSwap ? secondsUntil(ethSwap.timelock, now) : null };
}

/** One-line-per-leg report, used by `4_verify.js` and `inspect.js`. */
function formatStateReport({ chainName, chainLabel, swap, state, now }) {
  if (!swap) return `${chainLabel.padEnd(18)} no swap recorded under this id yet`;
  const left = secondsUntil(swap.timelock, now);
  const when = left >= 0 ? `expires in ${left}s` : `expired ${-left}s ago`;
  return (
    `${chainLabel.padEnd(18)} [${state}] amount=${swap.amount} hashlock=${swap.hashlock} ` +
    `timelock=${swap.timelock} (${when}) swapId=${swap.swapId} chain=${chainName}`
  );
}

module.exports = {
  LegState,
  secondsUntil,
  classifyLeg,
  legPairFromChain,
  describeGroup,
  formatStateReport,
};
