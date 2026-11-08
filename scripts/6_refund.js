// SPDX-License-Identifier: MIT
"use strict";

/**
 * Task B4 - timeout recovery.
 *
 *   npx hardhat run scripts/6_refund.js --network arbitrumSepolia   # Bob refunds the (shorter) ETH leg
 *   npx hardhat run scripts/6_refund.js --network sepolia           # Alice refunds the (longer) MST leg
 *
 * Each run only touches the leg of the network it is pointed at, and only once that leg's own deadline has
 * passed. The order matters: the ETH leg expires first, so Bob can always get his ETH back before Alice's
 * MST window closes - which is exactly why the timelocks are asymmetric.
 */

const { attachLeg, currentChain, currentTimestamp, getActors, readLeg, senderOf, txUrl } = require("./lib/chain");
const { refundLeg } = require("./lib/protocol");
const { latestSwap, recordLeg } = require("./lib/swapStore");

/** Refuses to send a refund that the contract would reject anyway, and says how long is left. */
function assertRefundable(swap, label, now) {
  if (!swap) throw new Error(`No ${label} swap found for this group`);
  if (swap.statusName !== "OPEN") {
    throw new Error(`The ${label} leg is already ${swap.statusName} - there is nothing to refund`);
  }
  if (now < swap.timelock) {
    const remaining = swap.timelock - now;
    throw new Error(
      `The ${label} timelock has not expired yet: ${remaining}s left (deadline ${swap.timelock}, now ${now}). ` +
        "Wait for the deadline - an early refund would revert with TimelockNotExpired."
    );
  }
}

async function refundEthSide(record) {
  const actors = await getActors();
  const bob = senderOf("arbitrumSepolia", actors); // Bob funded the ETH leg, so only he can refund it
  const leg = await attachLeg("arbitrumSepolia", bob);
  const swap = await readLeg(leg, record.legs.eth.swapId);
  const now = await currentTimestamp();

  assertRefundable(swap, "ETH", now);
  console.log(`Bob (${bob.address}) refunds the ETH leg ${swap.swapId} (expired ${now - swap.timelock}s ago)`);

  const result = await refundLeg({ leg, sender: bob, swapId: swap.swapId, method: "refundETH" });
  recordLeg(record.groupId, "eth", { status: "REFUNDED", refundTxHash: result.txHash }, { status: "ETH_REFUNDED" });

  console.log(`  tx   ${txUrl("arbitrumSepolia", result.txHash)}`);
  console.log("\nThe MST leg is a separate swap on Sepolia: refund it with --network sepolia once its deadline passes.");
}

async function refundMstSide(record) {
  const actors = await getActors();
  const alice = senderOf("sepolia", actors); // Alice funded the MST leg
  const leg = await attachLeg("sepolia", alice);
  const swap = await readLeg(leg, record.legs.mst.swapId);
  const now = await currentTimestamp();

  assertRefundable(swap, "MST", now);
  console.log(`Alice (${alice.address}) refunds the MST leg ${swap.swapId} (expired ${now - swap.timelock}s ago)`);

  const result = await refundLeg({ leg, sender: alice, swapId: swap.swapId, method: "refundMST" });
  recordLeg(record.groupId, "mst", { status: "REFUNDED", refundTxHash: result.txHash }, { status: "REFUNDED" });

  console.log(`  tx   ${txUrl("sepolia", result.txHash)}`);
  console.log("\nBoth legs are back with their original owners - no asset changed hands.");
  console.log("Check it with: npx hardhat run scripts/inspect.js");
}

async function main() {
  const info = currentChain();
  const record = latestSwap();

  console.log(`\nSwap group ${record.groupId} on ${info.label}\n`);

  if (record.legs && record.legs.eth && record.legs.eth.revealedPreimage) {
    console.log(
      "WARNING: the preimage is already public (the ETH leg was claimed), so the MST receiver can still " +
        "claim that leg. Use scripts/5_claimBoth.js --network sepolia instead of refunding.\n"
    );
  }

  if (info.leg === "eth") {
    if (!record.legs || !record.legs.eth || !record.legs.eth.swapId) throw new Error("The ETH leg was never locked");
    await refundEthSide(record);
  } else {
    if (!record.legs || !record.legs.mst || !record.legs.mst.swapId) throw new Error("The MST leg was never locked");
    await refundMstSide(record);
  }
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
});
