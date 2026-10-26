// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title HTLCErrors
 * @notice Gas-optimised custom errors shared by every contract in the COMP 5521 HTLC suite.
 *
 * @dev Why custom errors instead of `require(cond, "string message")`:
 *      1. A `require` string is stored in the deployed bytecode and ABI-encoded into the revert data,
 *         which makes deployment more expensive and every revert much more expensive.
 *      2. A custom error only costs a 4-byte selector in the revert data: `PUSH4 selector; REVERT`
 *         (roughly 50 gas overhead) versus the ABI-encoded `Error(string)` payload of a require string.
 *      3. `error` declarations are also checked at compile time, so a typo cannot silently ship.
 *
 *      The errors are declared inside a library purely to namespace them (`HTLCErrors.SwapNotOpen`);
 *      a library is used here for organisation only, it is never deployed and adds no gas or link
 *      reference. Because the error *signature* does not include the declaring library/contract name,
 *      `HTLCErrors.SwapNotOpen()` is ABI-identical to a file-level `SwapNotOpen()`
 *      (selector = bytes4(keccak256("SwapNotOpen()"))).
 *
 *      All errors are parameterless on purpose: arguments would have to be ABI-encoded into the revert
 *      data (extra memory copy + extra gas). Use the emitted events / `getSwap` to debug instead.
 */
library HTLCErrors {
    /// @dev Thrown when `createSwap` is called twice with parameters that hash to an existing swap id.
    error SwapAlreadyExists();

    /// @dev Thrown when a swap id has no stored swap (status EMPTY) or is otherwise unknown.
    error SwapDoesNotExist();

    /// @dev Thrown when the swap exists but is no longer OPEN (already CLAIMED or REFUNDED).
    error SwapNotOpen();

    /// @dev Thrown when an address argument is address(0) (receiver, token contract, ...).
    error InvalidZeroAddress();

    /// @dev Thrown when an amount argument is zero.
    error InvalidZeroAmount();

    /// @dev Thrown when the timelock is not strictly in the future.
    error InvalidTimelock();

    /// @dev Thrown when a claim is attempted by an account that is not the swap receiver.
    error UnauthorizedReceiver();

    /// @dev Thrown when a refund is attempted by an account that is not the swap sender.
    error UnauthorizedSender();

    /// @dev Thrown when keccak256(preimage) does not match the swap hashlock.
    error InvalidPreimage();

    /// @dev Thrown when a refund is attempted before the swap timelock has expired.
    error TimelockNotExpired();

    /// @dev Thrown when a claim is attempted at/after the timelock, i.e. the claim window is closed.
    error TimelockExpired();

    /// @dev Thrown when a native-value or token transfer fails.
    error TransferFailed();

    /// @dev Thrown when a `nonReentrant` function is re-entered while it is still executing.
    ///      (Not part of the minimum required error list, but a string require would violate the
    ///      gas-optimised requirement of this file.)
    error ReentrancyDetected();
}
