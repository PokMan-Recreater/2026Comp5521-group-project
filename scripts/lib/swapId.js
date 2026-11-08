// SPDX-License-Identifier: MIT
"use strict";

/**
 * Off-chain protocol primitives shared by the scripts (Task B) and, later, the web interface (Task C).
 *
 * WHY THIS FILE EXISTS - the corrected cross-chain id story
 * ---------------------------------------------------------
 * The two legs do NOT derive the same swap id for the same logical swap, and they must not be expected to:
 *
 *   ERC20HTLC (Sepolia)   id = keccak256(abi.encodePacked(sender, receiver, hashlock, timelock))
 *   ETHHTLC   (Arbitrum)  id = keccak256(abi.encodePacked(sender, receiver, address(0), amount, hashlock, timelock))
 *
 * Even leaving the derivation variants aside, the legs carry different amounts (MST vs wei) and - because
 * the protocol requires ASYMMETRIC timelocks - different timelocks as well. So "verify the second lock by
 * comparing the two swap ids" is wrong, and an earlier note in the README that told both legs to use the
 * same `generateSwapId` overload could not have worked.
 *
 * The coordinator therefore links the legs with its own group record (see `scripts/lib/swapStore.js`) and
 * verifies a leg pair with `verifyLegPair`, which checks what actually defines atomicity:
 *
 *   1. both legs share the SAME non-zero hashlock,
 *   2. the parties are CROSSED (the MST receiver is the ETH sender and vice versa),
 *   3. the ETH leg expires STRICTLY BEFORE the MST leg, so the preimage is revealed on the leg that is
 *      claimed first while the second leg is still claimable,
 *   4. both deadlines are still in the future when the second lock is created,
 *   5. the preimage the coordinator holds really hashes to the shared hashlock.
 *
 * `deriveMstLegSwapId` / `deriveEthLegSwapId` mirror each contract exactly so a client can print the id
 * before sending the transaction; `test/swapIdLib.test.js` asserts both against the live contracts.
 */

const { ethers } = require("ethers");

/** Token marker the shared `Swap` struct uses for the native-value leg. */
const NATIVE_TOKEN = ethers.ZeroAddress;

/**
 * Off-chain mirror of `HTLCBase.hashPreimage`: `keccak256(abi.encodePacked(preimage))`.
 * @param {string} preimage 32-byte hex secret.
 * @returns {string} The 32-byte hashlock.
 */
function hashPreimage(preimage) {
  return ethers.solidityPackedKeccak256(["bytes32"], [preimage]);
}

/**
 * Generates a fresh 32-byte secret.
 * @returns {string} A cryptographically random bytes32 hex string.
 */
function generateSecret() {
  return ethers.hexlify(ethers.randomBytes(32));
}

/**
 * Off-chain mirror of `ERC20HTLC`'s id derivation (the 4-argument `generateSwapId` overload, used by both
 * `lockMST` and the `IHTLC.createSwap` shim).
 * @param {{sender: string, receiver: string, hashlock: string, timelock: number|bigint|string}} leg
 * @returns {string} The 32-byte swap id stored by `ERC20HTLC`.
 */
function deriveMstLegSwapId({ sender, receiver, hashlock, timelock }) {
  return ethers.solidityPackedKeccak256(
    ["address", "address", "bytes32", "uint256"],
    [ethers.getAddress(sender), ethers.getAddress(receiver), hashlock, BigInt(timelock)]
  );
}

/**
 * Off-chain mirror of `ETHHTLC`'s id derivation (the 6-argument `generateSwapId`, reached through
 * `_openSwap`; `tokenContract` is always `address(0)` and `amount` is the locked `msg.value`).
 * @param {{sender: string, receiver: string, amount: bigint|number|string, hashlock: string,
 *          timelock: number|bigint|string}} leg
 * @returns {string} The 32-byte swap id stored by `ETHHTLC`.
 */
function deriveEthLegSwapId({ sender, receiver, amount, hashlock, timelock }) {
  return ethers.solidityPackedKeccak256(
    ["address", "address", "address", "uint256", "bytes32", "uint256"],
    [ethers.getAddress(sender), ethers.getAddress(receiver), NATIVE_TOKEN, BigInt(amount), hashlock, BigInt(timelock)]
  );
}

/** Case-insensitive address equality. */
function sameAddress(a, b) {
  try {
    return ethers.getAddress(a) === ethers.getAddress(b);
  } catch {
    return false;
  }
}

/**
 * Checks that two on-chain legs really form one atomic swap (see the header for why the ids cannot be
 * compared). Never throws: returns the list of problems so a script or the UI can display them.
 *
 * @param {object} params
 * @param {{sender: string, receiver: string, amount: bigint|number|string, hashlock: string,
 *          timelock: number|bigint|string}} params.mst The Sepolia leg (`ERC20HTLC`).
 * @param {{sender: string, receiver: string, amount: bigint|number|string, hashlock: string,
 *          timelock: number|bigint|string}} params.eth The Arbitrum Sepolia leg (`ETHHTLC`).
 * @param {string} [params.preimage] Secret held by the coordinator; verified when supplied.
 * @param {number|bigint} [params.now] Unix seconds treated as "now" (defaults to the wall clock).
 * @returns {{ok: boolean, issues: string[]}}
 */
function verifyLegPair({ mst, eth, preimage, now = Math.floor(Date.now() / 1000) }) {
  const issues = [];
  const currentTime = BigInt(now);

  // 1. one shared, non-zero hashlock
  const mstHashlock = String(mst.hashlock).toLowerCase();
  const ethHashlock = String(eth.hashlock).toLowerCase();
  if (mstHashlock === ethers.ZeroHash) issues.push("the MST leg has a zero hashlock (unclaimable swap)");
  if (ethHashlock === ethers.ZeroHash) issues.push("the ETH leg has a zero hashlock (unclaimable swap)");
  if (mstHashlock !== ethHashlock) issues.push("the two legs do not share the same hashlock");

  // 2. crossed parties
  if (!sameAddress(mst.receiver, eth.sender)) {
    issues.push("the MST receiver must be the ETH sender (parties are not crossed)");
  }
  if (!sameAddress(mst.sender, eth.receiver)) {
    issues.push("the MST sender must be the ETH receiver (parties are not crossed)");
  }

  // 3. asymmetric timelocks: the leg claimed first must expire first
  const mstTimelock = BigInt(mst.timelock);
  const ethTimelock = BigInt(eth.timelock);
  if (ethTimelock >= mstTimelock) {
    issues.push("the ETH leg must expire strictly before the MST leg (asymmetric timelocks)");
  }

  // 4. the deadlines must still be usable when the second leg is funded
  if (ethTimelock <= currentTime) issues.push("the ETH leg has already expired");
  if (mstTimelock <= currentTime) issues.push("the MST leg has already expired");

  // 5. amounts
  if (BigInt(mst.amount) <= 0n) issues.push("the MST amount must be non-zero");
  if (BigInt(eth.amount) <= 0n) issues.push("the ETH amount must be non-zero");

  // 6. the coordinator's secret must actually open the shared hashlock
  if (preimage !== undefined && hashPreimage(preimage) !== mstHashlock) {
    issues.push("the preimage does not match the shared hashlock");
  }

  return { ok: issues.length === 0, issues };
}

module.exports = {
  NATIVE_TOKEN,
  hashPreimage,
  generateSecret,
  deriveMstLegSwapId,
  deriveEthLegSwapId,
  verifyLegPair,
};
