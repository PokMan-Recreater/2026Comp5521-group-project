// SPDX-License-Identifier: MIT
"use strict";

/**
 * Task B2, step 1 - create the shared secret and the swap record (no transaction is sent).
 *
 *   npx hardhat run scripts/1_generateSecret.js --network sepolia
 *
 * Alice generates the 32-byte preimage because she is the party that will reveal it when she claims the ETH
 * leg; Bob only ever sees the hashlock. The preimage is written to `scripts/.state/swaps.json`, which the
 * later steps read. Run this on either testnet - the two legs get their own deadlines from block time, so
 * only the offsets configured here matter.
 */

const hre = require("hardhat");

const { ethers } = hre;

const { currentChain, getActors, optionalNumber, requireActor } = require("./lib/chain");
const { generateSecret, hashPreimage } = require("./lib/swapId");
const { createSwap } = require("./lib/swapStore");

/** Defaults that work on a public testnet but keep the swap short enough to demo twice in one session. */
const DEFAULTS = {
  mstAmount: "100", // 100 MST
  ethAmount: "0.01", // 0.01 ETH
  ethTimelockSeconds: 900, // 15 minutes - claimed first, so it expires first
  mstTimelockSeconds: 1800, // 30 minutes - claimed second, so it expires last
};

async function main() {
  const info = currentChain(); // throws unless --network is one of the two testnets
  const actors = await getActors();
  const alice = requireActor(actors, "alice");
  const bob = requireActor(actors, "bob");

  const preimage = generateSecret();
  const hashlock = hashPreimage(preimage);

  const mstAmount = ethers.parseEther(optionalNumberString("SWAP_MST_AMOUNT", DEFAULTS.mstAmount));
  const ethAmount = ethers.parseEther(optionalNumberString("SWAP_ETH_AMOUNT", DEFAULTS.ethAmount));
  const ethTimelockSeconds = optionalNumber("ETH_TIMELOCK_SECONDS", DEFAULTS.ethTimelockSeconds);
  const mstTimelockSeconds = optionalNumber("ERC20_TIMELOCK_SECONDS", DEFAULTS.mstTimelockSeconds);

  if (ethTimelockSeconds >= mstTimelockSeconds) {
    throw new Error(
      `Unsafe timelock offsets: ETH_TIMELOCK_SECONDS (${ethTimelockSeconds}) must be strictly smaller than ` +
        `ERC20_TIMELOCK_SECONDS (${mstTimelockSeconds}). The ETH leg is claimed first, so it must expire first.`
    );
  }
  if (mstAmount <= 0n || ethAmount <= 0n) throw new Error("Both swap amounts must be non-zero");

  const record = createSwap({
    network: { mst: "sepolia", eth: "arbitrumSepolia" },
    contracts: {
      mstToken: process.env.MST_ADDRESS || null,
      erc20Htlc: process.env.ERC20_HTLC_ADDRESS || null,
      ethHtlc: process.env.ETH_HTLC_ADDRESS || null,
    },
    preimage,
    hashlock,
    parties: {
      mstSender: alice.address,
      mstReceiver: bob.address,
      ethSender: bob.address,
      ethReceiver: alice.address,
    },
    amounts: { mst: mstAmount.toString(), eth: ethAmount.toString() },
    timelockOffsets: { mst: mstTimelockSeconds, eth: ethTimelockSeconds },
    legs: {},
  });

  console.log(`\nSwap group created on ${info.label}\n`);
  console.log(`  group     ${record.groupId}`);
  console.log(`  preimage  ${preimage}   <-- SECRET, keep it local (Alice)`);
  console.log(`  hashlock  ${hashlock}   <-- send this to Bob`);
  console.log(`  MST leg   Alice ${alice.address} -> Bob ${bob.address}, amount ${mstAmount} wei-units`);
  console.log(`  ETH leg   Bob   ${bob.address} -> Alice ${alice.address}, amount ${ethAmount} wei`);
  console.log(`  deadlines MST +${mstTimelockSeconds}s, ETH +${ethTimelockSeconds}s (relative to each chain's clock)`);
  console.log("\nNext: npx hardhat run scripts/2_lockERC20.js --network sepolia");
}

/** Amounts are human-readable (`100` MST) but validated as numbers before `parseEther`. */
function optionalNumberString(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const value = String(raw).trim();
  if (!/^\d+(\.\d+)?$/.test(value) || Number(value) <= 0) {
    throw new Error(`${name} must be a positive decimal amount, got "${value}"`);
  }
  return value;
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
});
