// SPDX-License-Identifier: MIT
"use strict";

/**
 * Task B2, step 2 - Alice locks the MST on Ethereum Sepolia.
 *
 *   npx hardhat run scripts/2_lockERC20.js --network sepolia
 *
 * This is the leg with the LONGER timelock: Alice funds first (she is the one who will reveal the secret),
 * so she needs the longer window to refund if Bob never locks the ETH leg.
 */

const hre = require("hardhat");

const {
  attachLeg,
  attachMst,
  currentChain,
  currentTimestamp,
  getActors,
  receiverOf,
  senderOf,
  txUrl,
} = require("./lib/chain");
const { lockMstLeg } = require("./lib/protocol");
const { latestSwap, recordLeg } = require("./lib/swapStore");

async function main() {
  const info = currentChain();
  if (info.leg !== "mst") {
    throw new Error(`Run this with --network sepolia (it locks the MST leg); current network is ${hre.network.name}`);
  }

  const record = latestSwap();
  if (record.legs && record.legs.mst && record.legs.mst.swapId) {
    console.log(`The MST leg is already locked: ${record.legs.mst.swapId} (tx ${record.legs.mst.txHash})`);
    return;
  }

  const actors = await getActors();
  const sender = senderOf("sepolia", actors); // Alice funds the MST leg
  const receiver = receiverOf("sepolia", actors); // Bob may claim it

  const amount = BigInt(record.amounts.mst);
  const token = await attachMst(sender);

  const balance = await token.balanceOf(sender.address);
  if (balance < amount) {
    throw new Error(
      `Alice (${sender.address}) holds ${balance} MST but the swap needs ${amount}.\n` +
        "Fund her first: npx hardhat run scripts/mintApproveMST.js --network sepolia"
    );
  }

  const leg = await attachLeg("sepolia", sender);
  const now = await currentTimestamp();
  const timelock = now + BigInt(record.timelockOffsets.mst);

  console.log(`Locking ${amount} MST for ${receiver.address} on ${info.label}`);
  console.log(`  group    ${record.groupId}`);
  console.log(`  hashlock ${record.hashlock}`);
  console.log(`  timelock ${timelock}  (+${record.timelockOffsets.mst}s from chain time ${now})`);

  const result = await lockMstLeg({
    leg,
    token,
    sender,
    receiver: receiver.address,
    amount,
    hashlock: record.hashlock,
    timelock,
  });

  recordLeg(
    record.groupId,
    "mst",
    {
      chain: "sepolia",
      contract: await leg.getAddress(),
      swapId: result.swapId,
      txHash: result.txHash,
      blockNumber: result.blockNumber,
      timelock: timelock.toString(),
      amount: amount.toString(),
      sender: sender.address,
      receiver: receiver.address,
      hashlock: record.hashlock,
      status: "OPEN",
    },
    { status: "MST_LOCKED" }
  );

  console.log(`\n  swapId ${result.swapId}`);
  console.log(`  tx     ${txUrl("sepolia", result.txHash)}`);
  console.log("\nNext: npx hardhat run scripts/3_lockETH.js --network arbitrumSepolia");
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
});
