/**
 * Browser-side coordinator record.
 *
 * The two legs are independent swaps on two chains, so something has to remember that they belong together:
 * that is this record (the same role `scripts/lib/swapStore.js` plays for the CLI). It holds the preimage,
 * both swap ids, both deadlines and the addresses the user pasted or signed with.
 *
 * It lives in localStorage - per browser, never on a server - and can be exported/imported as JSON so the
 * counterparty can join from another machine.
 */

import { DEFAULT_DEPLOYMENT, DEFAULT_TIMELOCKS, STORAGE_KEYS } from "./config";

function readJson(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage full / disabled: the app still works for the current session
  }
}

/** Contract addresses: `.env` defaults merged with whatever the user typed in Settings. */
export function loadDeployment() {
  return { ...DEFAULT_DEPLOYMENT, ...readJson(STORAGE_KEYS.deployment, {}) };
}

export function saveDeployment(deployment) {
  writeJson(STORAGE_KEYS.deployment, deployment);
  return deployment;
}

/** Demo settings (timelock offsets, counterparty, MST amount) remembered between sessions. */
export function loadSettings() {
  return {
    ethTimelock: DEFAULT_TIMELOCKS.eth,
    mstTimelock: DEFAULT_TIMELOCKS.mst,
    ...readJson(STORAGE_KEYS.settings, {}),
  };
}

export function saveSettings(settings) {
  writeJson(STORAGE_KEYS.settings, settings);
  return settings;
}

/** All swap groups, newest first. */
export function loadSwaps() {
  const swaps = readJson(STORAGE_KEYS.swaps, []);
  return Array.isArray(swaps) ? swaps : [];
}

export function saveSwaps(swaps) {
  writeJson(STORAGE_KEYS.swaps, swaps);
  return swaps;
}

/** A new, empty group. Amounts are decimal strings so JSON stays exact. */
export function createSwapRecord({ hashlock, preimage, mstAmount, ethAmount, ethTimelock, mstTimelock, counterparty }) {
  return {
    id: `swap-${Math.random().toString(16).slice(2, 10)}`,
    createdAt: new Date().toISOString(),
    hashlock,
    preimage,
    counterparty: counterparty || null,
    amounts: { mst: mstAmount, eth: ethAmount },
    offsets: { eth: ethTimelock, mst: mstTimelock },
    legs: { mst: null, eth: null },
    notes: "",
  };
}

/** Merges a patch into one leg of a group (used after every transaction). */
export function patchLeg(swaps, id, leg, patch) {
  return swaps.map((swap) =>
    swap.id === id ? { ...swap, legs: { ...swap.legs, [leg]: { ...(swap.legs[leg] || {}), ...patch } } } : swap
  );
}

/** Merges a patch into the group itself. */
export function patchSwap(swaps, id, patch) {
  return swaps.map((swap) => (swap.id === id ? { ...swap, ...patch } : swap));
}

/** Validates an imported group (paste from the counterparty) before it is trusted. */
export function parseImportedSwap(text) {
  const parsed = JSON.parse(text);
  const required = ["hashlock", "amounts"];
  for (const field of required) {
    if (!parsed[field]) throw new Error(`Imported swap is missing "${field}".`);
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(parsed.hashlock)) throw new Error("Imported swap has an invalid hashlock.");

  return {
    id: parsed.id || `swap-${Math.random().toString(16).slice(2, 10)}`,
    createdAt: parsed.createdAt || new Date().toISOString(),
    hashlock: parsed.hashlock,
    // the counterparty's export never carries a preimage the receiver should not have
    preimage: parsed.preimage || null,
    counterparty: parsed.counterparty || null,
    amounts: { mst: String(parsed.amounts.mst || "0"), eth: String(parsed.amounts.eth || "0") },
    offsets: parsed.offsets || DEFAULT_TIMELOCKS,
    legs: { mst: parsed.legs?.mst || null, eth: parsed.legs?.eth || null },
    notes: parsed.notes || "",
  };
}

/** Export shape: copy-pasteable JSON for the counterparty, without our private notes. */
export function exportSwap(swap) {
  return JSON.stringify(
    {
      id: swap.id,
      createdAt: swap.createdAt,
      hashlock: swap.hashlock,
      counterparty: swap.counterparty,
      amounts: swap.amounts,
      offsets: swap.offsets,
      legs: swap.legs,
    },
    null,
    2
  );
}
