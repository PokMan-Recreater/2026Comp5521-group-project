/**
 * MetaMask plumbing: connect, watch, and switch to the right chain for a leg.
 *
 * Transactions always go through the injected wallet, so the user sees and confirms every step. Reads use
 * plain JSON-RPC providers (`lib/contracts.js`), which is why the app can show both chains at once.
 */

import { BrowserProvider } from "ethers";

import { CHAINS, chainOfId } from "./config";

/** Is an EIP-1193 wallet injected? */
export function hasWallet() {
  return typeof window !== "undefined" && Boolean(window.ethereum);
}

/** Asks for accounts (first user gesture) and returns the selected address. */
export async function connectWallet() {
  if (!hasWallet()) throw new Error("No wallet found. Install MetaMask to use the swap console.");
  const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
  return accounts && accounts[0] ? accounts[0] : null;
}

/** Chain id the wallet is currently on, as a number. */
export async function walletChainId() {
  if (!hasWallet()) return null;
  return Number(await window.ethereum.request({ method: "eth_chainId" }));
}

/** Already-authorised accounts, without prompting (safe on page load). */
export async function silentAccounts() {
  if (!hasWallet()) return [];
  try {
    return await window.ethereum.request({ method: "eth_accounts" });
  } catch {
    return [];
  }
}

/** `BrowserProvider` for signing; `null` when there is no wallet. */
export async function browserProvider() {
  if (!hasWallet()) return null;
  return new BrowserProvider(window.ethereum);
}

/** Signer for the connected account. */
export async function signer() {
  const provider = await browserProvider();
  if (!provider) throw new Error("No wallet found.");
  return provider.getSigner();
}

/** Adds a chain to the wallet (EIP-3085); only used when the wallet does not know it yet. */
async function addChain(chain) {
  await window.ethereum.request({
    method: "wallet_addEthereumChain",
    params: [
      {
        chainId: chain.chainIdHex,
        chainName: chain.label,
        nativeCurrency: chain.currency,
        rpcUrls: [chain.rpc],
        blockExplorerUrls: [chain.explorer],
      },
    ],
  });
}

/**
 * Switches the wallet to a supported chain, adding it first if the wallet has never seen it (error 4902).
 * Returns the chain id actually selected.
 */
export async function switchChain(chain) {
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: chain.chainIdHex }],
    });
  } catch (error) {
    if (error && (error.code === 4902 || error.code === -32603)) {
      await addChain(chain);
    } else {
      throw error;
    }
  }
  return walletChainId();
}

/** True when the wallet sits on one of the two chains the app supports. */
export function isSupportedChain(chainId) {
  return Boolean(chainOfId(chainId));
}

/**
 * Subscribes to wallet events. Returns an unsubscribe function.
 * @param {{onAccounts?: (accounts: string[]) => void, onChain?: (chainId: number) => void}} handlers
 */
export function watchWallet({ onAccounts, onChain }) {
  if (!hasWallet() || !window.ethereum.on) return () => {};

  const accountsHandler = (accounts) => onAccounts && onAccounts(accounts || []);
  const chainHandler = (chainIdHex) => onChain && onChain(Number(chainIdHex));

  window.ethereum.on("accountsChanged", accountsHandler);
  window.ethereum.on("chainChanged", chainHandler);

  return () => {
    if (!window.ethereum.removeListener) return;
    window.ethereum.removeListener("accountsChanged", accountsHandler);
    window.ethereum.removeListener("chainChanged", chainHandler);
  };
}

/** Label for the header badge. */
export function chainLabel(chainId) {
  const chain = chainOfId(chainId);
  return chain ? chain.label : `Unsupported network (${chainId ?? "?"})`;
}

export const SUPPORTED_CHAINS = Object.values(CHAINS);
