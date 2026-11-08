// SPDX-License-Identifier: MIT
"use strict";

/**
 * Demo helper - fund the participants with MST and grant the ERC20HTLC its allowance.
 *
 *   npx hardhat run scripts/mintApproveMST.js --network sepolia
 *
 * `lockMST` pulls the tokens with `transferFrom`, so Alice needs both a balance and an allowance. This
 * helper only works with the repo's demo `MockMST` (its `mint` is open on purpose); if you deployed MST in
 * Lab 3, mint through that token instead - the `approve` half is identical.
 */

const hre = require("hardhat");

const { ethers } = hre;

const { addressUrl, attachMst, currentChain, getActors, optionalEnv, requireAddress } = require("./lib/chain");

const DEFAULT_MINT = ethers.parseEther("1000");

async function main() {
  currentChain(); // refuse to run against an unsupported network
  const actors = await getActors();
  const deployer = actors.deployer ?? actors.alice;
  if (!deployer) throw new Error("No signer: set DEPLOYER_PRIVATE_KEY in .env");

  const token = await attachMst(deployer);
  const legAddress = requireAddress("ERC20_HTLC_ADDRESS");

  const amount = optionalEnv("DEMO_MINT_AMOUNT", "") ? ethers.parseEther(process.env.DEMO_MINT_AMOUNT) : DEFAULT_MINT;

  const recipients = [actors.alice, actors.bob].filter(Boolean);
  if (recipients.length === 0) throw new Error("Set ALICE_PRIVATE_KEY (and BOB_PRIVATE_KEY) in .env");

  console.log(`Minting ${amount} MST to ${recipients.length} participant(s) on ${hre.network.name}`);
  for (const recipient of recipients) {
    const tx = await token.mint(recipient.address, amount);
    await tx.wait();
    console.log(`  minted -> ${recipient.address}  (balance ${await token.balanceOf(recipient.address)})`);
  }

  const alice = actors.alice;
  if (!alice) throw new Error("Set ALICE_PRIVATE_KEY in .env (she is the MST sender)");
  const approveTx = await token.connect(alice).approve(legAddress, ethers.MaxUint256);
  await approveTx.wait();

  console.log(`\nAlice approved ERC20HTLC ${legAddress} to spend her MST`);
  console.log(`  token   ${await token.getAddress()}  ${addressUrl(hre.network.name, await token.getAddress())}`);
  console.log(`  leg     ${legAddress}  ${addressUrl(hre.network.name, legAddress)}`);
  console.log(`  allowance ${await token.allowance(alice.address, legAddress)}`);
  console.log("\nNext: npx hardhat run scripts/2_lockERC20.js --network sepolia");
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
});
