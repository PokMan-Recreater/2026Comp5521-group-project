// SPDX-License-Identifier: MIT
"use strict";

/**
 * JSON record store for the cross-chain coordinator.
 *
 * The two legs are linked by THIS record, not by an on-chain id: it holds the shared secret, the two
 * independently derived swap ids, the two timelocks and the transaction hashes of every step. Because the
 * legs live on different chains and derive different ids (see `scripts/lib/swapId.js`), the group record is
 * the only place where the pair is associated.
 *
 * Default file: `scripts/.state/swaps.json` (git-ignored). Set `SWAP_STATE_FILE` to point elsewhere.
 * It contains the preimage, so treat it as a secret while the swap is in flight.
 *
 * Everything the contracts return is a bigint, which JSON cannot hold, so amounts/timelocks are stored as
 * decimal strings and converted back with `BigInt(...)` where they are used.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function stateFile() {
  const override = process.env.SWAP_STATE_FILE;
  if (override && override.trim() !== "") return path.resolve(override.trim());
  return path.join(__dirname, "..", ".state", "swaps.json");
}

function emptyState() {
  return { version: 1, updatedAt: null, swaps: {} };
}

function loadState() {
  const file = stateFile();
  if (!fs.existsSync(file)) return emptyState();
  const raw = fs.readFileSync(file, "utf8").trim();
  if (raw === "") return emptyState();

  const parsed = JSON.parse(raw);
  if (!parsed.swaps) parsed.swaps = {};
  return parsed;
}

function saveState(state) {
  const file = stateFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return state;
}

/** Human-friendly group id, e.g. `swap-1f3c9ab2`. */
function newGroupId() {
  return `swap-${crypto.randomBytes(4).toString("hex")}`;
}

/** Creates and persists a new swap group. */
function createSwap(record) {
  const state = loadState();
  const groupId = record.groupId || newGroupId();
  if (state.swaps[groupId]) throw new Error(`swap group "${groupId}" already exists in ${stateFile()}`);

  const stored = {
    createdAt: new Date().toISOString(),
    status: "CREATED",
    ...record,
    legs: { ...(record.legs || {}) },
    groupId,
  };

  state.swaps[groupId] = stored;
  saveState(state);
  return stored;
}

function listSwaps() {
  return Object.values(loadState().swaps);
}

/** The most recently created swap group (what the step scripts operate on by default). */
function latestSwap() {
  const swaps = listSwaps();
  if (swaps.length === 0) {
    throw new Error("No swap in the state file yet - run `scripts/1_generateSecret.js` first.");
  }
  return swaps[swaps.length - 1];
}

function getSwap(groupId) {
  const swap = loadState().swaps[groupId];
  if (!swap) throw new Error(`Unknown swap group "${groupId}" (state file: ${stateFile()})`);
  return swap;
}

/** Merges a patch into a swap group and optionally into one of its legs. */
function updateSwap(groupId, patch = {}, legKey = null, legPatch = null) {
  const state = loadState();
  const swap = state.swaps[groupId];
  if (!swap) throw new Error(`Unknown swap group "${groupId}" (state file: ${stateFile()})`);

  Object.assign(swap, patch);
  if (legKey) {
    swap.legs = swap.legs || {};
    swap.legs[legKey] = { ...(swap.legs[legKey] || {}), ...legPatch, updatedAt: new Date().toISOString() };
  }
  swap.updatedAt = new Date().toISOString();

  saveState(state);
  return swap;
}

/** Records one step of one leg (used by the step scripts). */
function recordLeg(groupId, legKey, legPatch, swapPatch = {}) {
  return updateSwap(groupId, swapPatch, legKey, legPatch);
}

module.exports = {
  stateFile,
  loadState,
  saveState,
  newGroupId,
  createSwap,
  listSwaps,
  latestSwap,
  getSwap,
  updateSwap,
  recordLeg,
};
