// SPDX-License-Identifier: MIT
"use strict";

/**
 * Task B3 - observe the state of the swap on both chains, independently.
 *
 *   npx hardhat run scripts/inspect.js
 *   npx hardhat run scripts/inspect.js --network sepolia
 *
 * The two contracts do not know about each other, so "the state of the swap" only exists in the coordinator:
 * this script reads each leg from its own chain, classifies it (CLAIMABLE / REFUNDABLE / CLAIMED / REFUNDED /
 * MISSING), re-checks the pairing and prints the actions that are legally possible right now.
 * Read-only: it never sends a transaction, so it is safe to run at any time during a demo.
 */

const { loadSnapshot } = require("./lib/snapshot");
const { CHAINS, txUrl } = require("./lib/chain");
const { formatStateReport } = require("./lib/state");

async function main() {
  const { record, mstSwap, ethSwap, view, now } = await loadSnapshot(process.env.SWAP_GROUP_ID);

  console.log(`\nSwap group ${record.groupId}   status=${record.status}   now=${now}`);
  console.log(`  MST amount ${record.amounts.mst}  ETH amount ${record.amounts.eth}`);
  console.log(
    `  MST leg sender ${record.parties.mstSender} receiver ${record.parties.mstReceiver}`
  );
  console.log(
    `  ETH leg sender ${record.parties.ethSender} receiver ${record.parties.ethReceiver}`
  );

  console.log("\nOn-chain state");
  console.log(formatStateReport({ chainName: "sepolia", chainLabel: CHAINS.sepolia.label, swap: mstSwap, state: view.mst, now }));
  console.log(
    formatStateReport({
      chainName: "arbitrumSepolia",
      chainLabel: CHAINS.arbitrumSepolia.label,
      swap: ethSwap,
      state: view.eth,
      now,
    })
  );

  console.log("\nTransactions");
  console.log(`  MST lock  ${record.legs?.mst?.txHash ? txUrl("sepolia", record.legs.mst.txHash) : "-"}`);
  console.log(`  ETH lock  ${record.legs?.eth?.txHash ? txUrl("arbitrumSepolia", record.legs.eth.txHash) : "-"}`);
  console.log(`  ETH claim ${record.legs?.eth?.claimTxHash ? txUrl("arbitrumSepolia", record.legs.eth.claimTxHash) : "-"}`);
  console.log(`  MST claim ${record.legs?.mst?.claimTxHash ? txUrl("sepolia", record.legs.mst.claimTxHash) : "-"}`);

  console.log(`\nPairing ${view.pairing.ok ? "OK" : "INVALID"}`);
  for (const issue of view.pairing.issues) console.log(`  FAIL - ${issue}`);

  console.log("\nPossible actions");
  if (view.nextActions.length === 0) console.log("  none - wait for a deadline or lock the missing leg");
  for (const action of view.nextActions) console.log(`  ${action}`);
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
});
