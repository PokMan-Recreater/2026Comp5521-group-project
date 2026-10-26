// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {HTLCBase} from "../HTLCBase.sol";

/**
 * @title HTLCBaseHarness
 * @notice TEST-ONLY contract. Not part of the production architecture.
 *
 * @dev Implements the native-value leg of the swap lifecycle on top of {HTLCBase} so that the shared
 *      foundation can be exercised end to end without waiting for `ETHHTLC.sol` / `ERC20HTLC.sol`.
 *      It also exposes the base contract's `internal` helpers so the unit tests can call them directly.
 */
contract HTLCBaseHarness is HTLCBase {
    // ---------------------------------------------------------------------
    // Minimal native-value leg (mirrors what ETHHTLC will do)
    // ---------------------------------------------------------------------

    /// @dev Native-value swap creation: `amount` always equals `msg.value`, `tokenContract` is
    ///      normally address(0) but is kept as an argument so the base storage layout is exercised.
    function createSwap(
        address payable receiver,
        address tokenContract,
        uint256, // amount is unused: the native-value leg always locks msg.value
        bytes32 hashlock,
        uint256 timelock
    ) external payable override returns (bytes32 swapId) {
        return _openSwap(msg.sender, receiver, tokenContract, msg.value, hashlock, timelock);
    }

    function claimSwap(bytes32 swapId, bytes32 preimage) external override nonReentrant {
        Swap memory swap = _settleClaim(swapId, preimage);
        _sendValue(swap.receiver, swap.amount);
    }

    function refundSwap(bytes32 swapId) external override nonReentrant {
        Swap memory swap = _settleRefund(swapId);
        _sendValue(swap.sender, swap.amount);
    }

    // ---------------------------------------------------------------------
    // Exposure of internal helpers (unit-test access only)
    // ---------------------------------------------------------------------

    function generateSwapIdExposed(
        address sender,
        address receiver,
        address tokenContract,
        uint256 amount,
        bytes32 hashlock,
        uint256 timelock
    ) external pure returns (bytes32) {
        return generateSwapId(sender, receiver, tokenContract, amount, hashlock, timelock);
    }

    function hashPreimageExposed(bytes32 preimage) external pure returns (bytes32) {
        return hashPreimage(preimage);
    }

    function checkNonZeroAddressExposed(address account) external pure {
        _checkNonZeroAddress(account);
    }

    function checkNonZeroAmountExposed(uint256 amount) external pure {
        _checkNonZeroAmount(amount);
    }

    function checkFutureTimelockExposed(uint256 timelock) external view {
        _checkFutureTimelock(timelock);
    }

    function checkNonZeroHashlockExposed(bytes32 hashlock) external pure {
        _checkNonZeroHashlock(hashlock);
    }

    function checkReceiverExposed(Swap memory swap) external view {
        _checkReceiver(swap);
    }

    function checkSenderExposed(Swap memory swap) external view {
        _checkSender(swap);
    }

    function sendValueExposed(address payable to, uint256 amount) external {
        _sendValue(to, amount);
    }

    /// @dev Entry point used by the reentrancy tests: makes an arbitrary external call from inside a
    ///      `nonReentrant` frame and bubbles up any revert data unchanged.
    function nonReentrantProbe(address target, bytes calldata data) external nonReentrant returns (bytes memory) {
        // Intentional low-level call: this probe exists precisely to attempt re-entrancy in tests.
        // solhint-disable-next-line avoid-low-level-calls
        (bool success, bytes memory returnData) = target.call(data);
        if (!success) {
            assembly {
                revert(add(returnData, 0x20), mload(returnData))
            }
        }
        return returnData;
    }
}
