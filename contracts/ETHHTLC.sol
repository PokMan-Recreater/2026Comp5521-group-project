// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {HTLCBase} from "./HTLCBase.sol";

/**
 * @title ETHHTLC
 * @notice Arbitrum Sepolia leg of the COMP 5521 cross-chain atomic swap: it escrows native ETH and
 *         releases it to the receiver on a valid claim, or refunds it to the sender after the timelock
 *         expires.
 *
 * @dev Inherits the whole state machine (storage, id derivation, validation, status transitions, events
 *      and the `nonReentrant` guard) from {HTLCBase}; this contract only owns the native-value movement,
 *      which is what keeps both swap legs semantically identical. The Sepolia leg (`ERC20HTLC`) is the
 *      mirror image of this file: same lifecycle, same events, same errors - only the asset differs.
 *
 *      Two entry-point surfaces are exposed on purpose (exactly like `ERC20HTLC`):
 *      - `lockETH` / `claimETH` / `refundETH` - the ETH-named API for scripts and the frontend.
 *      - `createSwap` / `claimSwap` / `refundSwap` - the {IHTLC} surface, so both legs share one ABI:
 *        the off-chain coordinator and the web interface can drive either leg with the same call shape.
 *      Both surfaces call the same internal implementation, so they cannot drift apart.
 *
 *      Native-value policy:
 *      - the locked amount is ALWAYS `msg.value`; the `amount` argument of {IHTLC.createSwap} is accepted
 *        only to keep the ABI identical to the ERC20 leg and is ignored on purpose,
 *      - `msg.value == 0` is rejected with `InvalidZeroAmount` (a zero-value swap would be meaningless),
 *      - `tokenContract` must be `address(0)`, the marker the shared `Swap` struct uses for "native value",
 *      - payouts go through {HTLCBase._sendValue} (`call`, no 2300-gas stipend) and revert with
 *        `TransferFailed` if the recipient refuses the ETH, so a swap can never be left in a terminal
 *        status without the funds having moved.
 *
 *      Cross-chain note: this leg derives its id with the 6-argument variant
 *      `keccak256(sender, receiver, tokenContract, amount, hashlock, timelock)` (inside `_openSwap`),
 *      while the MST leg uses the 4-argument variant. The two ids are therefore DIFFERENT for the same
 *      logical swap - by design, because the legs also carry different amounts and (required) different
 *      timelocks. Legs are correlated off-chain by the shared `hashlock` plus the crossed party mapping,
 *      never by id equality (see `scripts/lib/swapId.js`).
 */
contract ETHHTLC is HTLCBase {
    /// @dev Thrown when a non-zero `tokenContract` is supplied: this leg only escrows native value and
    ///      always stores `address(0)` as its token marker. Declared locally, like the ERC20 leg's own
    ///      errors, so `HTLCErrors.sol` stays exactly the shared set from the brief.
    error InvalidTokenContract();

    // ---------------------------------------------------------------------
    // ETH-named public API
    // ---------------------------------------------------------------------

    /**
     * @notice Locks `msg.value` wei into a new swap for `receiver`.
     * @dev Same order of operations as the MST leg: validate -> derive id -> require the id unused ->
     *      store the swap as OPEN and emit `SwapCreated`. The ETH has already arrived with the call, so
     *      `_openSwap` is the whole funding path: a swap can never be OPEN without the value behind it,
     *      and a duplicate parameter set reverts with `SwapAlreadyExists`.
     * @param receiver Account allowed to claim the swap by revealing the preimage.
     * @param hashlock keccak256(abi.encodePacked(preimage)).
     * @param timelock Unix timestamp after which the sender may refund.
     * @return swapId Deterministic id of the created swap.
     */
    function lockETH(
        address payable receiver,
        bytes32 hashlock,
        uint256 timelock
    ) external payable nonReentrant returns (bytes32 swapId) {
        return _lockETH(receiver, hashlock, timelock);
    }

    /// @notice Claims an OPEN swap by revealing the preimage; the ETH goes to the swap receiver.
    function claimETH(bytes32 swapId, bytes32 preimage) external nonReentrant {
        _claimETH(swapId, preimage);
    }

    /// @notice Refunds an OPEN swap to the sender once its timelock has expired.
    function refundETH(bytes32 swapId) external nonReentrant {
        _refundETH(swapId);
    }

    // ---------------------------------------------------------------------
    // IHTLC surface (shared ABI, inherited by HTLCBase)
    // ---------------------------------------------------------------------

    /**
     * @notice {IHTLC}-compatible wrapper around `lockETH`.
     * @dev The `amount` argument exists only because the shared interface must also fit the ERC20 leg;
     *      this leg always locks `msg.value` and ignores it. `tokenContract` must be `address(0)`.
     */
    function createSwap(
        address payable receiver,
        address tokenContract,
        uint256, // unused: the native-value leg always locks msg.value
        bytes32 hashlock,
        uint256 timelock
    ) external payable override nonReentrant returns (bytes32 swapId) {
        if (tokenContract != address(0)) revert InvalidTokenContract();
        return _lockETH(receiver, hashlock, timelock);
    }

    /// @notice {IHTLC}-compatible wrapper around `claimETH`.
    function claimSwap(bytes32 swapId, bytes32 preimage) external override nonReentrant {
        _claimETH(swapId, preimage);
    }

    /// @notice {IHTLC}-compatible wrapper around `refundETH`.
    function refundSwap(bytes32 swapId) external override nonReentrant {
        _refundETH(swapId);
    }

    // ---------------------------------------------------------------------
    // Internal implementation (single source of truth for both surfaces)
    // ---------------------------------------------------------------------

    /**
     * @dev Validates, derives the id, requires it to be unused, then stores the swap as OPEN and emits
     *      `SwapCreated` with `amount = msg.value` and `tokenContract = address(0)`.
     *      Must be called from a `nonReentrant` entry point.
     */
    function _lockETH(address payable receiver, bytes32 hashlock, uint256 timelock) internal returns (bytes32 swapId) {
        // _openSwap: _validateSwapParams (InvalidZeroAddress / InvalidZeroAmount / InvalidTimelock /
        // InvalidPreimage) -> generateSwapId -> _requireSwapIdAvailable (SwapAlreadyExists) -> _storeSwap.
        // msg.value is the amount, so a zero-value call fails with InvalidZeroAmount.
        return _openSwap(msg.sender, receiver, address(0), msg.value, hashlock, timelock);
    }

    /**
     * @dev Settles the claim (status becomes CLAIMED, `SwapClaimed` is emitted) and only then pays the
     *      receiver. Must be called from a `nonReentrant` entry point.
     */
    function _claimETH(bytes32 swapId, bytes32 preimage) internal {
        Swap memory swap = _settleClaim(swapId, preimage);
        _sendValue(swap.receiver, swap.amount);
    }

    /**
     * @dev Settles the refund (status becomes REFUNDED, `SwapRefunded` is emitted) and only then pays the
     *      sender. Must be called from a `nonReentrant` entry point.
     */
    function _refundETH(bytes32 swapId) internal {
        Swap memory swap = _settleRefund(swapId);
        _sendValue(swap.sender, swap.amount);
    }
}
