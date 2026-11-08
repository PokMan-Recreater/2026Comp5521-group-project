// SPDX-License-Identifier: MIT
"use strict";

/**
 * Network, actor and contract plumbing shared by every script in `scripts/`.
 *
 * The two swap legs live on two independent chains that never talk to each other, so every script states
 * explicitly which chain it writes to (`--network sepolia` / `--network arbitrumSepolia`) and reads the
 * counterparty chain through a read-only JSON-RPC provider built from `.env`. That is how the coordinator
 * can "see" both legs without any bridge, oracle or relayer.
 *
 * Roles (fixed for the whole protocol, see `scripts/1_generateSecret.js`):
 *   Alice - owns the MST on Ethereum Sepolia, locks it first and claims the ETH leg (she makes the secret)
 *   Bob   - owns the ETH on Arbitrum Sepolia, locks it second and claims the MST leg with the revealed secret
 */

require("dotenv").config();

const hre = require("hardhat");

const { ethers } = hre;

/** The two supported chains and everything the scripts need to know about them. */
const CHAINS = {
  sepolia: {
    key: "sepolia",
    label: "Ethereum Sepolia",
    chainId: 11155111,
    leg: "mst",
    legContract: "ERC20HTLC",
    contractVar: "ERC20_HTLC_ADDRESS",
    rpcVar: "SEPOLIA_RPC_URL",
    explorer: "https://sepolia.etherscan.io",
    /** The party that funds this leg (and may refund it). */
    sender: "alice",
    /** The party that may claim this leg with the preimage. */
    receiver: "bob",
  },
  arbitrumSepolia: {
    key: "arbitrumSepolia",
    label: "Arbitrum Sepolia",
    chainId: 421614,
    leg: "eth",
    legContract: "ETHHTLC",
    contractVar: "ETH_HTLC_ADDRESS",
    rpcVar: "ARBITRUM_SEPOLIA_RPC_URL",
    explorer: "https://sepolia.arbiscan.io",
    sender: "bob",
    receiver: "alice",
  },
};

/** Looks up a chain descriptor and fails loudly for an unsupported name. */
function chainInfo(name) {
  const info = CHAINS[name];
  if (!info) {
    throw new Error(`Unsupported chain "${name}". Use one of: ${Object.keys(CHAINS).join(", ")}`);
  }
  return info;
}

/** Descriptor of the chain selected by `--network`. */
function currentChain() {
  return chainInfo(hre.network.name);
}

/** Descriptor of the OTHER chain (the counterparty leg). */
function otherChain() {
  const current = currentChain();
  return Object.values(CHAINS).find((info) => info.key !== current.key);
}

/** Read-only provider for a chain built from its RPC URL (usable while `--network` is the other chain). */
function providerFor(chainName) {
  const info = chainInfo(chainName);
  return new ethers.JsonRpcProvider(requireEnv(info.rpcVar), info.chainId);
}

// ---------------------------------------------------------------------
// .env helpers
// ---------------------------------------------------------------------

function requireEnv(name) {
  const value = process.env[name];
  if (value === undefined || String(value).trim() === "") {
    throw new Error(`Missing ${name} in .env - copy .env.example and fill it in (see README §12).`);
  }
  return String(value).trim();
}

function optionalEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined || String(value).trim() === "") return fallback;
  return String(value).trim();
}

/** Positive integer from `.env` (timelock offsets, amounts, ...). */
function optionalNumber(name, fallback) {
  const raw = optionalEnv(name, undefined);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number, got "${raw}"`);
  return value;
}

/** Validated, checksummed address from `.env`. */
function requireAddress(name) {
  const raw = requireEnv(name);
  if (!ethers.isAddress(raw)) throw new Error(`${name} must be a 0x address, got "${raw}"`);
  return ethers.getAddress(raw);
}

// ---------------------------------------------------------------------
// Explorer links (printed next to every transaction hash)
// ---------------------------------------------------------------------

const txUrl = (chainName, hash) => `${chainInfo(chainName).explorer}/tx/${hash}`;
const addressUrl = (chainName, address) => `${chainInfo(chainName).explorer}/address/${address}`;

// ---------------------------------------------------------------------
// Actors (signers) and contracts
// ---------------------------------------------------------------------

/**
 * Signers in the order hardhat.config.js loads them: `[DEPLOYER, ALICE, BOB]`.
 * @returns {Promise<{deployer?: any, alice?: any, bob?: any}>}
 */
async function getActors() {
  const signers = await ethers.getSigners();
  if (signers.length === 0) throw new Error("No signers available: set DEPLOYER_PRIVATE_KEY in .env");
  const names = ["deployer", "alice", "bob"];
  const actors = {};
  names.forEach((name, index) => {
    if (signers[index]) actors[name] = signers[index];
  });
  return actors;
}

/** Returns the named actor or explains which key is missing. */
function requireActor(actors, name) {
  const actor = actors[name];
  if (!actor) {
    throw new Error(
      `Missing ${name.toUpperCase()}_PRIVATE_KEY in .env. hardhat.config.js loads accounts as ` +
        "[DEPLOYER, ALICE, BOB], so all three keys are needed by the protocol scripts."
    );
  }
  return actor;
}

/** The signer that funds (and may refund) the given leg. */
function senderOf(chainName, actors) {
  return requireActor(actors, chainInfo(chainName).sender);
}

/** The signer that may claim the given leg with the preimage. */
function receiverOf(chainName, actors) {
  return requireActor(actors, chainInfo(chainName).receiver);
}

/** Attaches the leg contract of `chainName` to a signer or provider. */
async function attachLeg(chainName, signerOrProvider) {
  const info = chainInfo(chainName);
  return ethers.getContractAt(info.legContract, requireAddress(info.contractVar), signerOrProvider);
}

/** Attaches the MST token (`MockMST` also exposes the demo `mint` that the helper script uses). */
async function attachMst(signerOrProvider) {
  return ethers.getContractAt("MockMST", requireAddress("MST_ADDRESS"), signerOrProvider);
}

/** Read-only view of a leg through that chain's own RPC endpoint (works from the other network). */
async function readOnlyLeg(chainName) {
  const info = chainInfo(chainName);
  return ethers.getContractAt(info.legContract, requireAddress(info.contractVar), providerFor(chainName));
}

/** Latest block timestamp of the chain selected by `--network`, as a bigint. */
async function currentTimestamp() {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block.timestamp);
}

/** Latest block timestamp of any supported chain, as a bigint. */
async function timestampOf(chainName) {
  const block = await providerFor(chainName).getBlock("latest");
  return BigInt(block.timestamp);
}

module.exports = {
  CHAINS,
  chainInfo,
  currentChain,
  otherChain,
  providerFor,
  requireEnv,
  optionalEnv,
  optionalNumber,
  requireAddress,
  txUrl,
  addressUrl,
  getActors,
  requireActor,
  senderOf,
  receiverOf,
  attachLeg,
  attachMst,
  readOnlyLeg,
  currentTimestamp,
  timestampOf,
};
