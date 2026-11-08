// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IHTLC} from "../interfaces/IHTLC.sol";

/**
 * @title ReenteringReceiver
 * @notice TEST-ONLY contract that acts as a swap receiver and tries to re-enter the HTLC while the
 *         native-value payout is in flight.
 *
 * @dev The ERC20 leg can be attacked through a malicious token (`ReentrantERC20`), but the native-value
 *      leg is attacked through the RECEIVER, because `_sendValue` hands control to it mid-payout. This
 *      mock therefore implements several roles at once:
 *        1. `claim(...)` / `refund(...)` - so the contract itself can be the `msg.sender` that claims a
 *           swap (the swap receiver must claim its own swap) or refunds it (when it is the sender);
 *        2. `lock(...)`      - so the contract can also be the SENDER of a swap, which is what makes the
 *           refund payout land here;
 *        3. `receive()`      - which fires inside `HTLCBase._sendValue` and calls back into the HTLC.
 *
 *      The re-entrant attempt is always BLOCKED by `HTLCBase.nonReentrant`. As the reverted call happens
 *      inside `_sendValue`, the leg reports the failure as `TransferFailed`, so the mock records what the
 *      inner call actually reverted with (`attackRevertData`) - the tests assert that it is exactly the
 *      `ReentrancyDetected` selector, which proves the guard (and not some unrelated failure) did the
 *      blocking. `bubbleAttackFailure` additionally lets a test turn the attack into a hard revert, which
 *      proves the payout atomicity rule: a failed payout leaves the swap OPEN and funded.
 */
contract ReenteringReceiver {
    /// @notice Address the re-entrant call is aimed at (normally the HTLC contract).
    address public target;

    /// @notice Calldata of the re-entrant call (normally `claimETH` / `claimSwap`).
    bytes public attackCalldata;

    /// @notice `true` => a failed re-entrant call reverts the whole payout instead of being recorded.
    bool public bubbleAttackFailure;

    /// @notice `true` once the re-entrant call has been attempted (guards against infinite recursion).
    bool public attackAttempted;

    /// @notice `true` if the re-entrant call unexpectedly succeeded (it must not).
    bool public attackSucceeded;

    /// @notice Raw revert data of the blocked re-entrant call (`ReentrancyDetected` selector expected).
    bytes public attackRevertData;

    /// @notice Configures the re-entrant call this contract performs while receiving ETH.
    function configure(address target_, bytes calldata attackCalldata_, bool bubbleAttackFailure_) external {
        target = target_;
        attackCalldata = attackCalldata_;
        bubbleAttackFailure = bubbleAttackFailure_;
    }

    /// @notice Claims a swap on the HTLC while this contract is the designated receiver.
    function claim(address htlc, bytes32 swapId, bytes32 preimage) external {
        IHTLC(htlc).claimSwap(swapId, preimage);
    }

    /// @notice Refunds a swap on the HTLC while this contract is the swap sender (the refund pays it,
    ///         which triggers `receive()` mid-refund).
    function refund(address htlc, bytes32 swapId) external {
        IHTLC(htlc).refundSwap(swapId);
    }

    /// @notice Funds a swap so that this contract becomes the SENDER (used to test re-entrancy during a
    ///         refund payout, which pays the sender instead of the receiver).
    function lock(address htlc, address payable receiver, bytes32 hashlock, uint256 timelock) external payable {
        // the received ETH must be forwarded with the call, otherwise the HTLC sees a zero-value swap
        IHTLC(htlc).createSwap{value: msg.value}(receiver, address(0), msg.value, hashlock, timelock);
    }

    /// @dev Fires inside the payout. Attempts the configured call exactly once and records the outcome.
    // The attack is the whole point of this mock, so it is allowed to be "complex" for a receive().
    // solhint-disable-next-line no-complex-fallback
    receive() external payable {
        address target_ = target;
        if (target_ == address(0) || attackAttempted) return;

        attackAttempted = true;
        // Intentional low-level call: this mock exists precisely to attempt re-entrancy in tests.
        // solhint-disable-next-line avoid-low-level-calls
        (bool success, bytes memory data) = target_.call(attackCalldata);
        attackSucceeded = success;

        if (success) return;

        attackRevertData = data;
        if (bubbleAttackFailure) {
            assembly {
                revert(add(data, 0x20), mload(data))
            }
        }
    }
}
