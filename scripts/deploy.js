// SPDX-License-Identifier: MIT
"use strict";

/**
 * Task B1 - deployment and configuration.
 *
 *   npx hardhat run scripts/deploy.js --network sepolia           # MST token (if needed) + ERC20HTLC
 *   npx hardhat run scripts/deploy.js --network arbitrumSepolia   # ETHHTLC
 *
 * `ERC20HTLC`'s constructor rejects a token address without code, so the MST must exist first: on Sepolia
 * this script reuses `MST_ADDRESS` when it is already set (your Lab 3 deployment) and otherwise deploys the
 * demo `MockMST` with an open `mint`. At the end it prints the exact `.env` lines to copy.
 */

const hre = require("hardhat");

const { ethers } = hre;

const { addressUrl, currentChain, optionalEnv } = require("./lib/chain");

const DEMO_MST_SUPPLY = ethers.parseEther("1000000");

/** Deploys (or reuses) the MST, then the ERC20 leg. */
async function deploySepolia(deployer) {
  let mstAddress = optionalEnv("MST_ADDRESS", "");

  if (mstAddress) {
    const code = await ethers.provider.getCode(mstAddress);
    if (code === "0x") throw new Error(`MST_ADDRESS ${mstAddress} has no code on ${hre.network.name}`);
    console.log(`Reusing the existing MST token at ${mstAddress}`);
  } else {
    const MockMST = await ethers.getContractFactory("MockMST");
    const mst = await MockMST.deploy();
    await mst.waitForDeployment();
    mstAddress = await mst.getAddress();

    const mintTx = await mst.mint(deployer.address, DEMO_MST_SUPPLY);
    await mintTx.wait();
    console.log(`Deployed the demo MST at ${mstAddress} and minted 1,000,000 MST to the deployer`);
  }

  const ERC20HTLC = await ethers.getContractFactory("ERC20HTLC");
  const leg = await ERC20HTLC.deploy(mstAddress);
  await leg.waitForDeployment();
  const legAddress = await leg.getAddress();

  console.log(`\nDeployment summary (${hre.network.name})`);
  console.log(`  MST token   ${mstAddress}  ${addressUrl(hre.network.name, mstAddress)}`);
  console.log(`  ERC20HTLC   ${legAddress}  ${addressUrl(hre.network.name, legAddress)}`);
  console.log("\nAdd these to .env:");
  console.log(`MST_ADDRESS=${mstAddress}`);
  console.log(`ERC20_HTLC_ADDRESS=${legAddress}`);
}

/** Deploys the native-value leg (no constructor arguments, nothing to deploy first). */
async function deployArbitrum() {
  const ETHHTLC = await ethers.getContractFactory("ETHHTLC");
  const leg = await ETHHTLC.deploy();
  await leg.waitForDeployment();
  const legAddress = await leg.getAddress();

  console.log(`\nDeployment summary (${hre.network.name})`);
  console.log(`  ETHHTLC     ${legAddress}  ${addressUrl(hre.network.name, legAddress)}`);
  console.log("\nAdd this to .env:");
  console.log(`ETH_HTLC_ADDRESS=${legAddress}`);
}

async function main() {
  const info = currentChain();
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No signer: set DEPLOYER_PRIVATE_KEY in .env");

  const { chainId } = await ethers.provider.getNetwork();
  console.log(`Deploying to ${info.label} (chainId ${chainId}) as ${deployer.address}`);

  if (info.leg === "mst") await deploySepolia(deployer);
  else await deployArbitrum();

  console.log("\nNext: verify with `npx hardhat verify --network <network> <address> [constructor args]`.");
}

main().catch((error) => {
  console.error(`\nDeployment failed: ${error.message}`);
  process.exitCode = 1;
});
