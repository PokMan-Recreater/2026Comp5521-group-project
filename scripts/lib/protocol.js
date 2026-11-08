// SPDX-License-Identifier: MIT
"use strict";

/**
 * The swap protocol operations, written once and reused by every step script.
 *
 * Each function takes live contract objects instead of reaching for global state, so the same code that
 * drives two public testnets can be exercised end to end on a local chain (see `test/scripts.e2e.test.js`).
 *
 * Every write also checks its own work:
 *   - the swap id is derived off-chain FIRST and compared with the id the contract returns, so a mismatch
 *     between `scripts/lib/swapId.js` and the deployed contract fails loudly instead of silently;
 *   - the MST allowance is topped up only when needed;
 *   - `assertAsymmetricTimelocks` refuses to open a pair whose ordering would break atomicity.
 */

const { ethers } = require("hardhat");

const { deriveMstLegSwapId, deriveEthLegSwapId } = require("./swapId");

/** Numeric `IHTLC.SwapStatus` values. */
const STATUS_NAMES = { 0: "EMPTY", 1: "OPEN", 2: "CLAIMED", 3: "REFUNDED" };

const NOT_FOUND_SELECTOR = ethers.id("SwapDoesNotExist()").slice(0, 10);

/** Reverts with the raw revert data attached, so callers can tell the error selectors apart. */
function revertDataOf(error) {
  const data = error?.data ?? error?.info?.error?.data ?? error?.error?.data;
  return typeof data === "string" ? data : null;
}

/**
 * Reads one leg and normalises it.
 * @returns {Promise<null | {swapId: string, sender: string, receiver: string, tokenContract: string,
 *   amount: bigint, hashlock: string, timelock: bigint, status: number, statusName: string}>}
 *          `null` when the contract has no swap under that id.
 */
async function readLeg(leg, swapId) {
  if (!swapId) return null;

  try {
    const swap = await leg.getSwap(swapId);
    const status = Number(swap.status);
    return {
      swapId,
      sender: swap.sender,
      receiver: swap.receiver,
      tokenContract: swap.tokenContract,
      amount: swap.amount,
      hashlock: swap.hashlock,
      timelock: swap.timelock,
      status,
      statusName: STATUS_NAMES[status] ?? String(status),
    };
  } catch (error) {
    if (revertDataOf(error) === NOT_FOUND_SELECTOR) return null;
    throw error;
  }
}

/** Pulls the preimage out of the `SwapClaimed` event of a mined receipt. */
function findClaimedPreimage(receipt, leg) {
  for (const log of receipt.logs) {
    try {
      const parsed = leg.interface.parseLog({ topics: log.topics, data: log.data });
      if (parsed && parsed.name === "SwapClaimed") return parsed.args.preimage;
    } catch {
      // log from another contract (or an unparsable topic) - ignore
    }
  }
  return null;
}

/** Refuses to open a pair whose ordering would let one party steal both assets. */
function assertAsymmetricTimelocks({ ethTimelock, mstTimelock }) {
  if (BigInt(ethTimelock) >= BigInt(mstTimelock)) {
    throw new Error(
      `Timelock ordering is unsafe: the ETH leg expires at ${ethTimelock} but the MST leg at ${mstTimelock}. ` +
        "The leg that is claimed first (ETH) must expire STRICTLY BEFORE the leg claimed second (MST)."
    );
  }
}

/**
 * Alice locks MST on Ethereum Sepolia: approves the leg if needed, then `lockMST`.
 * @returns {Promise<{swapId: string, txHash: string, blockNumber: number}>}
 */
async function lockMstLeg({ leg, token, sender, receiver, amount, hashlock, timelock }) {
  const legAddress = await leg.getAddress();
  const expectedSwapId = deriveMstLegSwapId({ sender: sender.address, receiver, hashlock, timelock });

  const allowance = await token.allowance(sender.address, legAddress);
  if (allowance < amount) {
    const approveTx = await token.connect(sender).approve(legAddress, amount);
    await approveTx.wait();
  }

  // the contract must derive the same id the coordinator computes off-chain
  const predictedSwapId = await leg.connect(sender).lockMST.staticCall(receiver, amount, hashlock, timelock);
  if (predictedSwapId !== expectedSwapId) {
    throw new Error(
      `Off-chain swap id ${expectedSwapId} does not match the id ERC20HTLC returns (${predictedSwapId}). ` +
        "scripts/lib/swapId.js and the deployed contract disagree."
    );
  }

  const tx = await leg.connect(sender).lockMST(receiver, amount, hashlock, timelock);
  const receipt = await tx.wait();
  return { swapId: predictedSwapId, txHash: receipt.hash, blockNumber: receipt.blockNumber };
}

/**
 * Bob locks native ETH on Arbitrum Sepolia: `lockETH` with `value = amount`.
 * @returns {Promise<{swapId: string, txHash: string}>}
 */
async function lockEthLeg({ leg, sender, receiver, amount, hashlock, timelock }) {
  const expectedSwapId = deriveEthLegSwapId({ sender: sender.address, receiver, amount, hashlock, timelock });

  const predictedSwapId = await leg
    .connect(sender)
    .lockETH.staticCall(receiver, hashlock, timelock, { value: amount });
  if (predictedSwapId !== expectedSwapId) {
    throw new Error(
      `Off-chain swap id ${expectedSwapId} does not match the id ETHHTLC returns (${predictedSwapId}). ` +
        "scripts/lib/swapId.js and the deployed contract disagree."
    );
  }

  const tx = await leg.connect(sender).lockETH(receiver, hashlock, timelock, { value: amount });
  const receipt = await tx.wait();
  return { swapId: predictedSwapId, txHash: receipt.hash };
}

/**
 * Claims a leg with the preimage and returns the preimage the event made public (what the counterparty
 * needs in order to settle its own leg).
 * @returns {Promise<{txHash: string, revealedPreimage: string|null}>}
 */
async function claimLeg({ leg, claimer, swapId, preimage, method = "claimSwap" }) {
  const tx = await leg.connect(claimer)[method](swapId, preimage);
  const receipt = await tx.wait();
  return { txHash: receipt.hash, revealedPreimage: findClaimedPreimage(receipt, leg) };
}

/** Refunds an expired leg to its sender. */
async function refundLeg({ leg, sender, swapId, method = "refundSwap" }) {
  const tx = await leg.connect(sender)[method](swapId);
  const receipt = await tx.wait();
  return { txHash: receipt.hash };
}

module.exports = {
  STATUS_NAMES,
  NOT_FOUND_SELECTOR,
  readLeg,
  findClaimedPreimage,
  assertAsymmetricTimelocks,
  lockMstLeg,
  lockEthLeg,
  claimLeg,
  refundLeg,
};
