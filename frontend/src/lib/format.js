/**
 * Display helpers. Kept free of chain access so the components stay dumb.
 */

import { formatUnits } from "ethers";

/** Numeric `IHTLC.SwapStatus` values, with the wording used in the UI. */
export const STATUS = {
  0: { key: "empty", label: "Not locked", tone: "muted" },
  1: { key: "open", label: "Locked", tone: "open" },
  2: { key: "claimed", label: "Claimed", tone: "good" },
  3: { key: "refunded", label: "Refunded", tone: "muted" },
};

/** Current unix time in seconds (the unit every timelock uses). */
export const nowSeconds = () => Math.floor(Date.now() / 1000);

/** `0x1234…abcd` */
export function shortAddress(address, size = 4) {
  if (!address || address === "0x") return "-";
  return `${address.slice(0, 2 + size)}…${address.slice(-size)}`;
}

/** Human amount from base units, trailing zeros removed (`100.0`, `0.01`). */
export function formatAmount(value, decimals = 18, maxFractionDigits = 6) {
  if (value === undefined || value === null) return "-";
  const raw = formatUnits(value, decimals);
  const [whole, fraction = ""] = raw.split(".");
  const trimmed = fraction.slice(0, maxFractionDigits).replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole;
}

/** `1234` -> `20m 34s`, `-30` -> `30s ago`. */
export function formatDuration(seconds) {
  const total = Math.abs(Math.trunc(seconds));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const secs = total % 60;

  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (secs || parts.length === 0) parts.push(`${secs}s`);
  return parts.slice(0, 2).join(" ");
}

/** Live countdown label for a timelock. */
export function timelockLabel(timelock, now = nowSeconds()) {
  if (!timelock) return "not set";
  const delta = Number(timelock) - now;
  return delta >= 0 ? `expires in ${formatDuration(delta)}` : `expired ${formatDuration(delta)} ago`;
}

/** Short hash for the activity log. */
export const shortHash = (hash) => (hash ? `${hash.slice(0, 10)}…${hash.slice(-6)}` : "-");
