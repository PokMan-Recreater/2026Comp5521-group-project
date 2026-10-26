// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {HTLCBaseHarness} from "./HTLCBaseHarness.sol";

/**
 * @title ReentrancyAttacker
 * @notice TEST-ONLY contract used to prove that `HTLCBase.nonReentrant` actually blocks re-entrancy.
 *
 * @dev Flow: `attack()` -> `harness.nonReentrantProbe(...)` (guard now set) -> the harness calls back
 *      into `reenter()` -> `reenter()` tries to enter `nonReentrantProbe` again, which must revert with
 *      `HTLCErrors.ReentrancyDetected` and bubble that revert all the way out.
 */
contract ReentrancyAttacker {
    HTLCBaseHarness private immutable _harness;

    constructor(HTLCBaseHarness harness) {
        _harness = harness;
    }

    /// @notice Starts the attack: enters a guarded harness function and calls back into this contract.
    function attack() external returns (bytes memory) {
        return _harness.nonReentrantProbe(address(this), abi.encodeCall(ReentrancyAttacker.reenter, ()));
    }

    /// @notice Re-entrant step: attempts to enter the guarded function again while the guard is set.
    function reenter() external returns (bytes memory) {
        return _harness.nonReentrantProbe(address(this), "");
    }
}
