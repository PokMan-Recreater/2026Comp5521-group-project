// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IHTLC} from "../interfaces/IHTLC.sol";

/**
 * @title EtherRejector
 * @notice TEST-ONLY contract that refuses every native-value transfer.
 *
 * @dev Used to prove that `HTLCBase._sendValue` surfaces a failed transfer as
 *      `HTLCErrors.TransferFailed` instead of silently succeeding or bubbling a raw low-level failure.
 */
contract EtherRejector {
    receive() external payable {
        revert("EtherRejector: refusing native value");
    }
}

/**
 * @title RejectingReceiver
 * @notice TEST-ONLY contract that acts as a swap receiver which cannot accept native value.
 *
 * @dev Used to prove the atomicity guarantee of the base contract: if the payout fails, the whole
 *      transaction reverts and the swap stays OPEN (it was never left CLAIMED without the funds moving).
 */
contract RejectingReceiver {
    receive() external payable {
        revert("RejectingReceiver: refusing native value");
    }

    /// @notice Calls `claimSwap` on the HTLC so that the payout is attempted to this contract and fails.
    function claim(address htlc, bytes32 swapId, bytes32 preimage) external {
        IHTLC(htlc).claimSwap(swapId, preimage);
    }
}
