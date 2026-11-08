// SPDX-License-Identifier: MIT
"use strict";

/**
 * Task B2 - verify that the two independently locked legs really form ONE atomic swap.
 *
 *   npx hardhat run scripts/4_verify.js
 *   npx hardhat run scripts/4_verify.js --network sepolia   (also fine: only RPC reads are used)
 *
 * Reads both chains through their own RPC endpoints and checks what actually defines atomicity - a shared
 * hashlock, crossed parties, an ETH deadline strictly before the MST deadline, and a preimage that opens the
 * hashlock. It never compares the two swap ids: those differ by design (`scripts/lib/swapId.js`).
 * Exits with a non-zero status if any check fails, so it can gate the later steps.
 */

const { loadSnapshot } = require("./lib/snapshot");
const { txUrl } = require("./lib/chain");
const { formatStateReport } = require("./lib/state");

async function main() {
  const { record, mstSwap, ethSwap, view, now } = await loadSnapshot(process.env.SWAP_GROUP_ID);

  console.log(`\nSwap group ${record.groupId} (created ${record.createdAt})\n`);
  console.log(formatStateReport({ chainName: "sepolia", chainLabel: "Ethereum Sepolia", swap: mstSwap, state: view.mst, now }));
  console.log(
    formatStateReport({ chainName: "arbitrumSepolia", chainLabel: "Arbitrum Sepolia", swap: ethSwap, state: view.eth, now })
  );

  console.log("\nPairing checks");
  if (view.pairing.ok) {
    console.log("  OK - one shared hashlock, crossed parties, ETH expires strictly first, preimage matches");
  } else {
    for (const issue of view.pairing.issues) console.log(`  FAIL - ${issue}`);
  }

  console.log(`\n  preimage ${record.preimage}`);
  console.log(`  hashlock ${record.hashlock}`);
  if (record.legs && record.legs.mst && record.legs.mst.txHash) {
    console.log(`  MST lock tx ${txUrl("sepolia", record.legs.mst.txHash)}`);
  }
  if (record.legs && record.legs.eth && record.legs.eth.txHash) {
    console.log(`  ETH lock tx ${txUrl("arbitrumSepolia", record.legs.eth.txHash)}`);
  }

  if (!view.pairing.ok) {
    throw new Error("The two legs are not a valid atomic pair - do not claim either of them.");
  }
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
});
