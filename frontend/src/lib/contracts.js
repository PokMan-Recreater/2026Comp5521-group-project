/**
 * Contract access: one shared ABI for both legs, read-only JSON-RPC providers for the chain the wallet is
 * NOT on, and thin transaction helpers that always return the parsed receipt facts the UI needs.
 *
 * Both contracts implement the same `IHTLC` surface (`createSwap` / `claimSwap` / `refundSwap` / `swaps`),
 * which is why a single ABI drives the MST leg and the ETH leg - the UI never has to care which chain a
 * call goes to beyond choosing the signer.
 */

import { Contract, Interface, JsonRpcProvider, ZeroAddress, isAddress } from "ethers";

import { CHAINS, LEG_CHAIN, legAddress } from "./config";

/** `IHTLC` + the leg-specific error list (so reverts can be decoded on either chain). */
export const legAbi = [
  "function createSwap(address receiver, address tokenContract, uint256 amount, bytes32 hashlock, uint256 timelock) payable returns (bytes32)",
  "function claimSwap(bytes32 swapId, bytes32 preimage)",
  "function refundSwap(bytes32 swapId)",
  "function swaps(bytes32 swapId) view returns (bytes32 swapId, address sender, address receiver, address tokenContract, uint256 amount, bytes32 hashlock, uint256 timelock, uint8 status)",
  "function mstToken() view returns (address)",
  "event SwapCreated(bytes32 indexed swapId, address indexed sender, address indexed receiver, address tokenContract, uint256 amount, bytes32 hashlock, uint256 timelock)",
  "event SwapClaimed(bytes32 indexed swapId, address indexed receiver, bytes32 preimage)",
  "event SwapRefunded(bytes32 indexed swapId, address indexed sender)",
  "error SwapAlreadyExists()",
  "error SwapDoesNotExist()",
  "error SwapNotOpen()",
  "error InvalidZeroAddress()",
  "error InvalidZeroAmount()",
  "error InvalidTimelock()",
  "error UnauthorizedReceiver()",
  "error UnauthorizedSender()",
  "error InvalidPreimage()",
  "error TimelockNotExpired()",
  "error TimelockExpired()",
  "error TransferFailed()",
  "error InvalidTokenContract()",
  "error NativeValueNotAllowed()",
  "error ReentrancyDetected()",
];

/** Minimal ERC20 surface (the MST is an 18-decimals OpenZeppelin token). */
export const erc20Abi = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
];

export const legInterface = new Interface(legAbi);

const providers = new Map();

/** Read-only provider for a chain, cached (cross-chain reads do not go through the wallet). */
export function readProvider(chainKey) {
  if (!providers.has(chainKey)) {
    const chain = CHAINS[chainKey];
    providers.set(chainKey, new JsonRpcProvider(chain.rpc, chain.chainId, { staticNetwork: true }));
  }
  return providers.get(chainKey);
}

/** Is this a usable, checksummed address? */
export function isValidAddress(value) {
  return typeof value === "string" && isAddress(value);
}

/**
 * Reads one leg. Returns `null` when the id is unknown, the leg address is not configured, or the contract
 * still reports status EMPTY - callers treat all three as "not locked yet".
 */
export async function readLeg({ deployment, leg, swapId }) {
  const address = legAddress(deployment, leg);
  if (!swapId || !isValidAddress(address)) return null;

  const chain = LEG_CHAIN[leg];
  const contract = new Contract(address, legAbi, readProvider(chain.key));
  const raw = await contract.swaps(swapId);

  const status = Number(raw[7]);
  if (status === 0) return null;

  return {
    leg,
    chainKey: chain.key,
    swapId,
    sender: raw[1],
    receiver: raw[2],
    tokenContract: raw[3],
    amount: raw[4],
    hashlock: raw[5],
    timelock: raw[6],
    status,
  };
}

/** MST metadata for display; falls back to 18 decimals when the token is not configured. */
export async function readMstMeta({ deployment }) {
  if (!isValidAddress(deployment.mstToken)) return { symbol: "MST", decimals: 18 };
  try {
    const token = new Contract(deployment.mstToken, erc20Abi, readProvider("sepolia"));
    const [symbol, decimals] = await Promise.all([token.symbol(), token.decimals()]);
    return { symbol, decimals: Number(decimals) };
  } catch {
    return { symbol: "MST", decimals: 18 };
  }
}

/** MST balance on Sepolia (the token only exists there). */
export async function readMstBalance({ deployment, account }) {
  if (!isValidAddress(deployment.mstToken) || !account) return null;
  try {
    const token = new Contract(deployment.mstToken, erc20Abi, readProvider("sepolia"));
    return await token.balanceOf(account);
  } catch {
    return null;
  }
}

/** Native balance on Arbitrum Sepolia (the chain that escrows the ETH). */
export async function readNativeBalance({ account }) {
  if (!account) return null;
  try {
    return await readProvider("arbitrumSepolia").getBalance(account);
  } catch {
    return null;
  }
}

/** Current MST allowance for the ERC20HTLC contract. */
export async function readAllowance({ deployment, owner }) {
  if (!isValidAddress(deployment.mstToken) || !isValidAddress(deployment.erc20Htlc) || !owner) return null;
  try {
    const token = new Contract(deployment.mstToken, erc20Abi, readProvider("sepolia"));
    return await token.allowance(owner, deployment.erc20Htlc);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------
// Writes (always through the wallet, so the user confirms each step)
// ---------------------------------------------------------------------

/** Parses one event of a mined receipt. */
function findEvent(receipt, name) {
  for (const log of receipt.logs) {
    try {
      const parsed = legInterface.parseLog({ topics: log.topics, data: log.data });
      if (parsed && parsed.name === name) return parsed.args;
    } catch {
      // log from another contract - ignore
    }
  }
  return null;
}

/** Approves the ERC20HTLC to pull `amount` MST. */
export async function approveMst({ signer, deployment, amount }) {
  const token = new Contract(deployment.mstToken, erc20Abi, signer);
  const tx = await token.approve(deployment.erc20Htlc, amount);
  const receipt = await tx.wait();
  return { txHash: receipt.hash, blockNumber: receipt.blockNumber };
}

/**
 * Locks a leg through the shared `createSwap` entry point.
 *
 * - MST leg: token = MST address, `amount` = MST base units, no native value
 * - ETH leg: token = address(0) and `msg.value` is the amount (the `amount` argument is accepted for ABI
 *            symmetry and ignored by the contract on purpose)
 *
 * The swap id comes back from the `SwapCreated` event, so the UI never has to trust its own derivation.
 */
export async function lockLeg({ signer, deployment, leg, receiver, amount, hashlock, timelock }) {
  const address = legAddress(deployment, leg);
  if (!isValidAddress(address)) throw new Error(`No ${leg === "mst" ? "ERC20HTLC" : "ETHHTLC"} address configured.`);

  const contract = new Contract(address, legAbi, signer);
  const isNative = leg === "eth";
  const tokenArg = isNative ? ZeroAddress : deployment.mstToken;
  const amountArg = isNative ? 0n : amount;
  const overrides = isNative ? { value: amount } : {};

  const tx = await contract.createSwap(receiver, tokenArg, amountArg, hashlock, timelock, overrides);
  const receipt = await tx.wait();
  const created = findEvent(receipt, "SwapCreated");

  return { txHash: receipt.hash, blockNumber: receipt.blockNumber, swapId: created ? created.swapId : null };
}

/** Claims a leg with the preimage; returns the preimage the event published. */
export async function claimLeg({ signer, deployment, leg, swapId, preimage }) {
  const address = legAddress(deployment, leg);
  if (!isValidAddress(address)) throw new Error(`No ${leg} leg address configured.`);

  const contract = new Contract(address, legAbi, signer);
  const tx = await contract.claimSwap(swapId, preimage);
  const receipt = await tx.wait();
  const claimed = findEvent(receipt, "SwapClaimed");

  return {
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    revealedPreimage: claimed ? claimed.preimage : null,
  };
}

/** Refunds an expired leg to its sender. */
export async function refundLeg({ signer, deployment, leg, swapId }) {
  const address = legAddress(deployment, leg);
  if (!isValidAddress(address)) throw new Error(`No ${leg} leg address configured.`);

  const contract = new Contract(address, legAbi, signer);
  const tx = await contract.refundSwap(swapId);
  const receipt = await tx.wait();
  return { txHash: receipt.hash, blockNumber: receipt.blockNumber };
}

/**
 * Reads the preimage from the `SwapClaimed` event of a leg. This is how the counterparty learns the secret:
 * not from a file, but from the chain that revealed it.
 */
export async function fetchRevealedPreimage({ deployment, leg, swapId, fromBlock = 0 }) {
  const address = legAddress(deployment, leg);
  if (!isValidAddress(address) || !swapId) return null;

  const chain = LEG_CHAIN[leg];
  const contract = new Contract(address, legAbi, readProvider(chain.key));
  const events = await contract.queryFilter(contract.filters.SwapClaimed(swapId), fromBlock);
  if (events.length === 0) return null;
  return events[events.length - 1].args.preimage;
}

const REVERT_MESSAGES = {
  InvalidPreimage: "Wrong preimage: keccak256(preimage) does not match the hashlock.",
  TimelockExpired: "The claim window has closed - only a refund is possible now.",
  TimelockNotExpired: "The timelock has not expired yet.",
  UnauthorizedReceiver: "Only the swap receiver can claim this leg.",
  UnauthorizedSender: "Only the swap sender can refund this leg.",
  SwapNotOpen: "This swap is no longer open (already claimed or refunded).",
  SwapDoesNotExist: "No swap with that id exists on this chain.",
  SwapAlreadyExists: "An identical swap already exists - change one parameter.",
  InvalidZeroAmount: "The amount must be greater than zero.",
  InvalidZeroAddress: "Address zero is not allowed here.",
  InvalidTimelock: "The timelock must be in the future.",
  TransferFailed: "The asset transfer failed (the recipient refused it).",
  InvalidTokenContract: "Wrong token address for this leg.",
  NativeValueNotAllowed: "This leg does not accept native value.",
  ReentrancyDetected: "Re-entrant call blocked.",
};

/** Turns a wallet/RPC error into one readable sentence (decodes the contracts' custom errors). */
export function decodeError(error) {
  const candidates = [
    error?.data?.data,
    error?.data,
    error?.info?.error?.data,
    error?.error?.data,
    error?.error?.error?.data,
    error?.revert?.data,
  ];

  for (const data of candidates) {
    if (typeof data !== "string" || !data.startsWith("0x") || data.length < 10) continue;
    try {
      const parsed = legInterface.parseError(data);
      if (parsed) return REVERT_MESSAGES[parsed.name] || `Reverted with ${parsed.name}().`;
    } catch {
      // not one of our custom errors - keep looking
    }
  }

  const message = error?.shortMessage || error?.reason || error?.message || "Transaction failed.";
  if (/user rejected|ACTION_REJECTED/i.test(message)) return "Rejected in the wallet.";
  if (/insufficient funds/i.test(message)) return "Not enough native balance to pay for gas.";
  return message;
}
