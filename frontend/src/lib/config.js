/**
 * Chain metadata, contract addresses and demo defaults.
 *
 * Everything here is either a constant of the protocol (two chains, two legs, the roles) or comes from
 * `frontend/.env` (`VITE_*`). Addresses can also be edited in the UI at runtime and are then kept in
 * localStorage, so a freshly deployed swap can be demoed without rebuilding the bundle.
 */

const env = import.meta.env;

/** The two chains, exactly as `scripts/lib/chain.js` describes them. */
export const CHAINS = {
  sepolia: {
    key: "sepolia",
    leg: "mst",
    label: "Ethereum Sepolia",
    short: "Sepolia",
    chainId: 11155111,
    chainIdHex: "0xaa36a7",
    currency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
    rpc: env.VITE_SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com",
    explorer: "https://sepolia.etherscan.io",
    role: "MST leg (ERC20)",
  },
  arbitrumSepolia: {
    key: "arbitrumSepolia",
    leg: "eth",
    label: "Arbitrum Sepolia",
    short: "Arbitrum",
    chainId: 421614,
    chainIdHex: "0x66eee",
    currency: { name: "Arbitrum Sepolia Ether", symbol: "ETH", decimals: 18 },
    rpc: env.VITE_ARBITRUM_SEPOLIA_RPC_URL || "https://sepolia-rollup.arbitrum.io/rpc",
    explorer: "https://sepolia.arbiscan.io",
    role: "ETH leg (native)",
  },
};

/** Leg keys used throughout the app: `mst` lives on Sepolia, `eth` on Arbitrum Sepolia. */
export const LEG_KEYS = ["mst", "eth"];

/** Which chain hosts which leg. */
export const LEG_CHAIN = { mst: CHAINS.sepolia, eth: CHAINS.arbitrumSepolia };

/** Chain descriptor from a leg key. */
export function chainOfLeg(leg) {
  return LEG_CHAIN[leg];
}

/** Chain descriptor from an EIP-155 chain id (or `null` when the wallet is on an unsupported network). */
export function chainOfId(chainId) {
  return Object.values(CHAINS).find((chain) => chain.chainId === Number(chainId)) || null;
}

/** Contract addresses: `.env` defaults, overridable from the UI (see `lib/store.js`). */
export const DEFAULT_DEPLOYMENT = {
  mstToken: env.VITE_MST_ADDRESS || "",
  erc20Htlc: env.VITE_ERC20_HTLC_ADDRESS || "",
  ethHtlc: env.VITE_ETH_HTLC_ADDRESS || "",
};

/** Address of the leg contract for a leg key, given the current deployment. */
export function legAddress(deployment, leg) {
  return leg === "mst" ? deployment.erc20Htlc : deployment.ethHtlc;
}

/**
 * Demo timelock offsets in seconds. The ETH leg is claimed first, so it must be strictly shorter than the
 * MST leg; `SwapSetup` enforces that before it will create a swap.
 */
export const DEFAULT_TIMELOCKS = {
  eth: Number(env.VITE_ETH_TIMELOCK_SECONDS) || 900,
  mst: Number(env.VITE_ERC20_TIMELOCK_SECONDS) || 1800,
};

/** Optional pre-filled counterparty (the ETH owner / MST receiver). */
export const DEFAULT_COUNTERPARTY = env.VITE_COUNTERPARTY_ADDRESS || "";

/** localStorage keys. */
export const STORAGE_KEYS = {
  deployment: "comp5521.deployment.v1",
  swaps: "comp5521.swaps.v1",
  settings: "comp5521.settings.v1",
};

export const explorerTx = (chainKey, hash) => `${CHAINS[chainKey].explorer}/tx/${hash}`;
export const explorerAddress = (chainKey, address) => `${CHAINS[chainKey].explorer}/address/${address}`;
