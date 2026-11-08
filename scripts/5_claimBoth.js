// SPDX-License-Identifier: MIT
"use strict";

/**
 * Task B2, step 4 - claim both legs with the same preimage.
 *
 * Step 4a (Arbitrum Sepolia) - Alice claims the ETH leg. This is the transaction that REVEALS the preimage:
 *   npx hardhat run scripts/5_claimBoth.js --network arbitrumSepolia
 *
 * Step 4b (Ethereum Sepolia) - Bob claims the MST leg with the preimage he just learned:
 *   npx hardhat run scripts/5_claimBoth.js --network sepolia
 *
 * The two runs are separate on purpose: they are two independent transactions on two chains that never
 * communicate. The preimage travels off-chain (through this state file), exactly as in the protocol design.
 */

const { attachLeg, currentChain, currentTimestamp, getActors, readOnlyLeg, receiverOf, txUrl } = require("./lib/chain");
const { claimLeg, readLeg } = require("./lib/protocol");
const { hashPreimage } = require("./lib/swapId");
const { latestSwap, recordLeg } = require("./lib/swapStore");

/** Alice (ETH receiver) claims the ETH leg and thereby publishes the preimage on Arbitrum Sepolia. */
async function claimEthSide(record) {
  if (!record.legs || !record.legs.eth || !record.legs.eth.swapId) {
    throw new Error("The ETH leg is not locked yet: run scripts/3_lockETH.js --network arbitrumSepolia first");
  }

  const actors = await getActors();
  const alice = receiverOf("arbitrumSepolia", actors);
  const leg = await attachLeg("arbitrumSepolia", alice);
  const swap = await readLeg(leg, record.legs.eth.swapId);

  if (!swap) throw new Error(`No ETH swap ${record.legs.eth.swapId} on Arbitrum Sepolia`);
  if (swap.statusName !== "OPEN") throw new Error(`The ETH leg is ${swap.statusName} - nothing to claim`);
  const now = await currentTimestamp();
  if (now >= swap.timelock) {
    throw new Error(`The ETH claim window closed ${now - swap.timelock}s ago: run scripts/6_refund.js instead`);
  }
  if (hashPreimage(record.preimage).toLowerCase() !== swap.hashlock.toLowerCase()) {
    throw new Error("The stored preimage does not open the on-chain hashlock - refusing to claim");
  }

  console.log(`Alice (${alice.address}) claims the ETH leg ${swap.swapId}`);
  const result = await claimLeg({ leg, claimer: alice, swapId: swap.swapId, preimage: record.preimage, method: "claimETH" });

  const revealed = result.revealedPreimage;
  if (!revealed || revealed.toLowerCase() !== record.preimage.toLowerCase()) {
    throw new Error("The claim succeeded but the SwapClaimed event did not carry the expected preimage");
  }

  recordLeg(record.groupId, "eth", { status: "CLAIMED", claimTxHash: result.txHash, revealedPreimage: revealed }, {
    status: "ETH_CLAIMED",
  });

  console.log(`  tx        ${txUrl("arbitrumSepolia", result.txHash)}`);
  console.log(`  preimage  ${revealed}  <- now public on Arbitrum Sepolia`);
  console.log("\nNext: npx hardhat run scripts/5_claimBoth.js --network sepolia");
}

/** Bob (MST receiver) claims the MST leg with the preimage revealed by the ETH claim. */
async function claimMstSide(record) {
  if (!record.legs || !record.legs.mst || !record.legs.mst.swapId) {
    throw new Error("The MST leg is not locked yet: run scripts/2_lockERC20.js --network sepolia first");
  }

  const preimage = record.legs.eth && record.legs.eth.revealedPreimage;
  if (!preimage) {
    throw new Error(
      "No revealed preimage yet. Run this with --network arbitrumSepolia first: the ETH claim is what " +
        "makes the preimage public, and Bob is supposed to learn it from that chain, not from this file."
    );
  }

  // cross-chain check: only claim the MST leg once the ETH leg was really claimed
  const ethLegRemote = await readOnlyLeg("arbitrumSepolia");
  const ethSwap = await readLeg(ethLegRemote, record.legs.eth.swapId);
  if (!ethSwap || ethSwap.statusName !== "CLAIMED") {
    throw new Error(
      `The ETH leg is ${ethSwap ? ethSwap.statusName : "missing"} on Arbitrum Sepolia; ` +
        "claim it first so the preimage is public before the MST leg is settled"
    );
  }

  const actors = await getActors();
  const bob = receiverOf("sepolia", actors);
  const leg = await attachLeg("sepolia", bob);
  const swap = await readLeg(leg, record.legs.mst.swapId);

  if (!swap) throw new Error(`No MST swap ${record.legs.mst.swapId} on Ethereum Sepolia`);
  if (swap.statusName !== "OPEN") throw new Error(`The MST leg is ${swap.statusName} - nothing to claim`);
  const now = await currentTimestamp();
  if (now >= swap.timelock) {
    throw new Error(`The MST claim window closed ${now - swap.timelock}s ago: run scripts/6_refund.js instead`);
  }
  if (hashPreimage(preimage).toLowerCase() !== swap.hashlock.toLowerCase()) {
    throw new Error("The revealed preimage does not open the MST hashlock - refusing to claim");
  }

  console.log(`Bob (${bob.address}) claims the MST leg ${swap.swapId} with the revealed preimage`);
  const result = await claimLeg({ leg, claimer: bob, swapId: swap.swapId, preimage, method: "claimMST" });

  recordLeg(record.groupId, "mst", { status: "CLAIMED", claimTxHash: result.txHash }, { status: "COMPLETE" });

  console.log(`  tx   ${txUrl("sepolia", result.txHash)}`);
  console.log("\nSwap complete: Alice received the ETH, Bob received the MST.");
  console.log("Check it with: npx hardhat run scripts/inspect.js");
}

async function main() {
  const info = currentChain();
  const record = latestSwap();

  console.log(`\nSwap group ${record.groupId} on ${info.label}\n`);
  if (info.leg === "eth") await claimEthSide(record);
  else await claimMstSide(record);
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
});
