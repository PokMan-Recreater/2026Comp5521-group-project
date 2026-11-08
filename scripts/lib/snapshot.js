// SPDX-License-Identifier: MIT
"use strict";

/**
 * Reads BOTH legs of a swap in one go (Task B3).
 *
 * Each leg is read through its own chain's JSON-RPC endpoint, so a single command can observe the pair
 * without any bridge, oracle or relayer - which is exactly the property the assignment is about: the two
 * chains do not talk to each other, only the participants do.
 */

const { readOnlyLeg } = require("./chain");
const { readLeg } = require("./protocol");
const { describeGroup } = require("./state");
const { getSwap, latestSwap } = require("./swapStore");

/**
 * @param {string} [groupId] Defaults to the newest swap group in the state file.
 * @returns {Promise<{record: object, mstSwap: object|null, ethSwap: object|null, view: object,
 *   now: number, mstLeg: any, ethLeg: any}>}
 */
async function loadSnapshot(groupId) {
  const record = groupId ? getSwap(groupId) : latestSwap();

  const mstLeg = await readOnlyLeg("sepolia");
  const ethLeg = await readOnlyLeg("arbitrumSepolia");

  const mstSwap = await readLeg(mstLeg, record.legs && record.legs.mst ? record.legs.mst.swapId : null);
  const ethSwap = await readLeg(ethLeg, record.legs && record.legs.eth ? record.legs.eth.swapId : null);

  const now = Math.floor(Date.now() / 1000);
  const view = describeGroup({ mstSwap, ethSwap, preimage: record.preimage, now });

  return { record, mstSwap, ethSwap, view, now, mstLeg, ethLeg };
}

module.exports = { loadSnapshot };
