// SPDX-License-Identifier: MIT
"use strict";

/**
 * Task B2, step 3 - Bob locks native ETH on Arbitrum Sepolia with the SAME hashlock.
 *
 *   npx hardhat run scripts/3_lockETH.js --network arbitrumSepolia
 *
 * This script is where the cross-chain part actually happens: it writes on Arbitrum Sepolia while reading
 * the MST leg from Ethereum Sepolia over that chain's RPC endpoint, and it refuses to lock unless
 *   - the MST leg exists and is still OPEN,
 *   - both legs carry the same hashlock,
 *   - the ETH deadline lands STRICTLY BEFORE the MST deadline (the atomicity condition).
 */

const hre = require("hardhat");

const { ethers } = hre;

const {
  attachLeg,
  currentChain,
  currentTimestamp,
  futureDeadline,
  getActors,
  readOnlyLeg,
  receiverOf,
  senderOf,
  txUrl,
} = require("./lib/chain");
const { assertAsymmetricTimelocks, readLeg, lockEthLeg } = require("./lib/protocol");
const { latestSwap, recordLeg } = require("./lib/swapStore");

async function main() {
  const info = currentChain();
  if (info.leg !== "eth") {
    throw new Error(
      `Run this with --network arbitrumSepolia (it locks the ETH leg); current network is ${hre.network.name}`
    );
  }

  const record = latestSwap();
  if (!record.legs || !record.legs.mst || !record.legs.mst.swapId) {
    throw new Error("The MST leg must be locked first: npx hardhat run scripts/2_lockERC20.js --network sepolia");
  }
  if (record.legs.eth && record.legs.eth.swapId) {
    console.log(`The ETH leg is already locked: ${record.legs.eth.swapId} (tx ${record.legs.eth.txHash})`);
    return;
  }

  // --- read the counterparty chain (no bridge, no oracle: just the public RPC endpoint) -------------
  const mstLeg = await readOnlyLeg("sepolia");
  const mstSwap = await readLeg(mstLeg, record.legs.mst.swapId);
  if (!mstSwap) throw new Error(`No MST swap ${record.legs.mst.swapId} on Ethereum Sepolia - was it locked?`);
  if (mstSwap.statusName !== "OPEN") {
    throw new Error(`The MST leg is ${mstSwap.statusName}, it must be OPEN before the ETH leg is funded`);
  }
  if (mstSwap.hashlock.toLowerCase() !== record.hashlock.toLowerCase()) {
    throw new Error(
      `Hashlock mismatch: the MST leg on-chain says ${mstSwap.hashlock} but the coordinator holds ${record.hashlock}`
    );
  }

  const actors = await getActors();
  const sender = senderOf("arbitrumSepolia", actors); // Bob funds the ETH leg
  const receiver = receiverOf("arbitrumSepolia", actors); // Alice may claim it

  const amount = BigInt(record.amounts.eth);
  const balance = await ethers.provider.getBalance(sender.address);
  if (balance <= amount) {
    throw new Error(
      `Bob (${sender.address}) holds ${balance} wei on ${info.label} but the swap needs ${amount} wei plus gas`
    );
  }

  const leg = await attachLeg("arbitrumSepolia", sender);
  const timelock = await futureDeadline(record.timelockOffsets.eth);

  // the MST leg must still be claimable by the time the ETH leg closes, or there is nothing left to swap
  const now = await currentTimestamp();
  if (now >= mstSwap.timelock) {
    throw new Error(
      `The MST leg already expired ${now - mstSwap.timelock}s ago (deadline ${mstSwap.timelock}). ` +
        "Do not fund the ETH leg: start a new swap with scripts/1_generateSecret.js."
    );
  }

  assertAsymmetricTimelocks({ ethTimelock: timelock, mstTimelock: mstSwap.timelock });

  console.log(`Locking ${ethers.formatEther(amount)} ETH for ${receiver.address} on ${info.label}`);
  console.log(`  group    ${record.groupId}`);
  console.log(`  hashlock ${mstSwap.hashlock}  (read back from Ethereum Sepolia)`);
  console.log(`  ETH lock ${timelock}  (${record.timelockOffsets.eth}s from now)`);
  console.log(`  MST lock ${mstSwap.timelock}  -> the ETH leg expires ${mstSwap.timelock - timelock}s earlier`);

  const result = await lockEthLeg({
    leg,
    sender,
    receiver: receiver.address,
    amount,
    hashlock: mstSwap.hashlock,
    timelock,
  });

  recordLeg(
    record.groupId,
    "eth",
    {
      chain: "arbitrumSepolia",
      contract: await leg.getAddress(),
      swapId: result.swapId,
      txHash: result.txHash,
      timelock: timelock.toString(),
      amount: amount.toString(),
      sender: sender.address,
      receiver: receiver.address,
      hashlock: mstSwap.hashlock,
      status: "OPEN",
    },
    { status: "BOTH_LOCKED" }
  );

  console.log(`\n  swapId ${result.swapId}`);
  console.log(`  tx     ${txUrl("arbitrumSepolia", result.txHash)}`);
  console.log("\nBoth legs are funded. Verify the pair with: npx hardhat run scripts/4_verify.js");
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
});
