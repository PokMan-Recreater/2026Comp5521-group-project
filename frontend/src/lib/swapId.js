/**
 * Browser mirror of `scripts/lib/swapId.js`.
 *
 * It has to be a mirror rather than an import: the scripts are CommonJS (`require`) and this bundle is ESM.
 * `test/frontendLib.test.js` imports this file and asserts that every function agrees with the CommonJS
 * original, so the two can never drift apart silently.
 */

import { ZeroAddress, ZeroHash, getAddress, hexlify, randomBytes, solidityPackedKeccak256 } from "ethers";

/** Token marker the shared `Swap` struct uses for the native-value leg. */
export const NATIVE_TOKEN = ZeroAddress;

/** keccak256(abi.encodePacked(preimage)) - mirrors `HTLCBase.hashPreimage`. */
export function hashPreimage(preimage) {
  return solidityPackedKeccak256(["bytes32"], [preimage]);
}

/** Fresh 32-byte secret. */
export function generateSecret() {
  return hexlify(randomBytes(32));
}

/** Mirrors `ERC20HTLC`'s 4-argument derivation (used by `lockMST` and its `createSwap` shim). */
export function deriveMstLegSwapId({ sender, receiver, hashlock, timelock }) {
  return solidityPackedKeccak256(
    ["address", "address", "bytes32", "uint256"],
    [getAddress(sender), getAddress(receiver), hashlock, BigInt(timelock)]
  );
}

/** Mirrors `ETHHTLC`'s 6-argument derivation (`tokenContract` is always `address(0)`). */
export function deriveEthLegSwapId({ sender, receiver, amount, hashlock, timelock }) {
  return solidityPackedKeccak256(
    ["address", "address", "address", "uint256", "bytes32", "uint256"],
    [getAddress(sender), getAddress(receiver), NATIVE_TOKEN, BigInt(amount), hashlock, BigInt(timelock)]
  );
}

function sameAddress(a, b) {
  try {
    return getAddress(a) === getAddress(b);
  } catch {
    return false;
  }
}

/**
 * The rule that makes the two independent legs one atomic swap. The wording matches the CommonJS version
 * exactly (the parity test compares the arrays).
 *
 * @returns {{ok: boolean, issues: string[]}}
 */
export function verifyLegPair({ mst, eth, preimage, now = Math.floor(Date.now() / 1000), ignoreExpiry = false }) {
  const issues = [];
  const currentTime = BigInt(now);

  const mstHashlock = String(mst.hashlock).toLowerCase();
  const ethHashlock = String(eth.hashlock).toLowerCase();
  if (mstHashlock === ZeroHash) issues.push("the MST leg has a zero hashlock (unclaimable swap)");
  if (ethHashlock === ZeroHash) issues.push("the ETH leg has a zero hashlock (unclaimable swap)");
  if (mstHashlock !== ethHashlock) issues.push("the two legs do not share the same hashlock");

  if (!sameAddress(mst.receiver, eth.sender)) {
    issues.push("the MST receiver must be the ETH sender (parties are not crossed)");
  }
  if (!sameAddress(mst.sender, eth.receiver)) {
    issues.push("the MST sender must be the ETH receiver (parties are not crossed)");
  }

  const mstTimelock = BigInt(mst.timelock);
  const ethTimelock = BigInt(eth.timelock);
  if (ethTimelock >= mstTimelock) {
    issues.push("the ETH leg must expire strictly before the MST leg (asymmetric timelocks)");
  }

  if (!ignoreExpiry) {
    if (ethTimelock <= currentTime) issues.push("the ETH leg has already expired");
    if (mstTimelock <= currentTime) issues.push("the MST leg has already expired");
  }

  if (BigInt(mst.amount) <= 0n) issues.push("the MST amount must be non-zero");
  if (BigInt(eth.amount) <= 0n) issues.push("the ETH amount must be non-zero");

  if (preimage !== undefined && hashPreimage(preimage) !== mstHashlock) {
    issues.push("the preimage does not match the shared hashlock");
  }

  return { ok: issues.length === 0, issues };
}
