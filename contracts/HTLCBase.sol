// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IHTLC} from "./interfaces/IHTLC.sol";
import {HTLCErrors} from "./libraries/HTLCErrors.sol";

/**
 * @title HTLCBase
 * @notice Abstract foundation shared by `ERC20HTLC.sol` (Ethereum Sepolia) and `ETHHTLC.sol`
 *         (Arbitrum Sepolia) for the COMP 5521 cross-chain atomic swap.
 *
 * @dev Separation of concerns:
 *      - THIS contract owns the state machine: storage, id derivation, validation, status transitions,
 *        events and the reentrancy guard. It performs NO asset transfers.
 *      - The concrete legs own the asset movement only: `ERC20HTLC` (SafeERC20) and `ETHHTLC`
 *        (native value). Each leg is then ~30 lines of code and cannot drift from the other leg's
 *        semantics, which is exactly what an atomic swap requires.
 *
 *      Concrete contracts must implement `createSwap`, `claimSwap` and `refundSwap` from {IHTLC},
 *      normally in this shape (checks-effects-interactions is already handled inside the base helpers):
 *
 *      ```solidity
 *      function createSwap(...) external payable nonReentrant returns (bytes32) {
 *          // (asset specific validation, e.g. token != address(0))
 *          return _openSwap(msg.sender, receiver, tokenContract, amount, hashlock, timelock);
 *      }
 *
 *      function claimSwap(bytes32 swapId, bytes32 preimage) external nonReentrant {
 *          Swap memory swap = _settleClaim(swapId, preimage); // state already CLAIMED
 *          // ... transfer swap.amount to swap.receiver (token or native value)
 *      }
 *
 *      function refundSwap(bytes32 swapId) external nonReentrant {
 *          Swap memory swap = _settleRefund(swapId); // state already REFUNDED
 *          // ... transfer swap.amount back to swap.sender
 *      }
 *      ```
 */
abstract contract HTLCBase is IHTLC {
    // ---------------------------------------------------------------------
    // Reentrancy guard storage (custom, gas-optimised)
    // ---------------------------------------------------------------------

    /// @dev Guard value while no guarded function is executing.
    uint256 private constant _NOT_ENTERED = 1;

    /// @dev Guard value while a guarded function is executing.
    uint256 private constant _ENTERED = 2;

    /// @dev Current guard value. Initialised inline (no constructor needed, keeps the guard slot
    ///      independent of the derived contract's constructor order).
    uint256 private _reentrancyStatus = _NOT_ENTERED;

    // ---------------------------------------------------------------------
    // Swap storage
    // ---------------------------------------------------------------------

    /**
     * @notice All swaps ever created, keyed by their deterministic swap id.
     * @dev `status == SwapStatus.EMPTY` means "no such swap", which is why no extra existence
     *      mapping is needed. The public getter returns the struct fields as a tuple.
     */
    mapping(bytes32 => Swap) public swaps;

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------

    /**
     * @dev Reverts if a guarded function is re-entered. A two-value guard (instead of a bool) keeps the
     *      "not entered" state distinguishable from "entered". Cost: ~2.9k gas for the cold set and
     *      100 gas for the reset, because the slot returns to its original value and therefore also
     *      earns the EIP-2200 refund. Implemented in-house (no OpenZeppelin dependency) so that both
     *      swap legs inherit the identical guard, and the failure path reverts with
     *      `HTLCErrors.ReentrancyDetected` - 4 bytes of revert data, no revert string.
     */
    modifier nonReentrant() {
        if (_reentrancyStatus == _ENTERED) revert HTLCErrors.ReentrancyDetected();
        _reentrancyStatus = _ENTERED;
        _;
        _reentrancyStatus = _NOT_ENTERED;
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /**
     * @notice Returns the full `Swap` struct for `swapId`.
     * @dev Unlike the auto-generated `swaps` getter this reverts for unknown ids, so a caller can
     *      never mistake a zero-filled struct for a real swap.
     */
    function getSwap(bytes32 swapId) external view override returns (Swap memory swap) {
        swap = swaps[swapId];
        if (swap.status == SwapStatus.EMPTY) revert HTLCErrors.SwapDoesNotExist();
    }

    // ---------------------------------------------------------------------
    // Swap id / hashlock derivation
    // ---------------------------------------------------------------------

    /**
     * @notice Derives the deterministic id of a swap from its parameters.
     * @dev `keccak256(abi.encodePacked(...))` over exactly the parameters that define a swap, so both
     *      legs (and any off-chain client) can predict the id before the transaction is mined, and the
     *      same parameter set can never open two different swaps (see `SwapAlreadyExists`).
     *
     *      Note: the id is intentionally chain-agnostic - the same parameter set produces the same id
     *      on Sepolia and Arbitrum Sepolia, which is convenient for off-chain indexing. If per-chain
     *      uniqueness is ever required, mix `block.chainid` / `address(this)` in as extra arguments.
     *
     * @param sender        Account funding the swap (normally `msg.sender`).
     * @param receiver      Account allowed to claim the swap.
     * @param tokenContract ERC20 address, or address(0) for the native-ETH leg.
     * @param amount        Amount locked (ERC20 units, or wei).
     * @param hashlock      keccak256(abi.encodePacked(preimage)).
     * @param timelock      Unix timestamp after which the sender may refund.
     */
    function generateSwapId(
        address sender,
        address receiver,
        address tokenContract,
        uint256 amount,
        bytes32 hashlock,
        uint256 timelock
    ) internal pure returns (bytes32 swapId) {
        swapId = keccak256(abi.encodePacked(sender, receiver, tokenContract, amount, hashlock, timelock));
    }

    /**
     * @notice Derives the swap id from the four parameters that identify a swap secret.
     * @dev Overload required by the ERC20 leg (`ERC20HTLC.lockMST`): the token is fixed per deployment
     *      (`mstToken` is immutable) and the amount is part of the funding, not of the swap identity, so
     *      `keccak256(abi.encodePacked(sender, receiver, hashlock, timelock))` is enough. Excluding the
     *      token and the amount also means the same (sender, receiver, secret, deadline) tuple produces
     *      the same id on both legs, which is convenient for off-chain correlation.
     *
     *      IMPORTANT: both legs must use the SAME variant. `ETHHTLC` should call this 4-argument
     *      overload too, otherwise the two legs derive different ids for the same logical swap.
     *
     * @param sender   Account funding the swap (normally `msg.sender`).
     * @param receiver Account allowed to claim the swap.
     * @param hashlock keccak256(abi.encodePacked(preimage)).
     * @param timelock Unix timestamp after which the sender may refund.
     */
    function generateSwapId(
        address sender,
        address receiver,
        bytes32 hashlock,
        uint256 timelock
    ) internal pure returns (bytes32 swapId) {
        swapId = keccak256(abi.encodePacked(sender, receiver, hashlock, timelock));
    }

    /**
     * @notice Computes the hashlock for a preimage.
     * @dev Must match the off-chain client exactly: `keccak256(abi.encodePacked(preimage))`
     *      (in ethers.js: `solidityPackedKeccak256(["bytes32"], [preimage])`).
     */
    function hashPreimage(bytes32 preimage) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(preimage));
    }

    // ---------------------------------------------------------------------
    // Shared validation helpers (used by the base and by both legs)
    // ---------------------------------------------------------------------

    /// @dev Reverts with `InvalidZeroAddress` when `account` is address(0).
    function _checkNonZeroAddress(address account) internal pure {
        if (account == address(0)) revert HTLCErrors.InvalidZeroAddress();
    }

    /// @dev Reverts with `InvalidZeroAmount` when `amount` is zero.
    function _checkNonZeroAmount(uint256 amount) internal pure {
        if (amount == 0) revert HTLCErrors.InvalidZeroAmount();
    }

    /// @dev Reverts with `InvalidTimelock` unless `timelock` is strictly in the future.
    function _checkFutureTimelock(uint256 timelock) internal view {
        if (timelock <= block.timestamp) revert HTLCErrors.InvalidTimelock();
    }

    /// @dev Reverts with `InvalidPreimage` when the hashlock is bytes32(0), which would be unclaimable.
    function _checkNonZeroHashlock(bytes32 hashlock) internal pure {
        if (hashlock == bytes32(0)) revert HTLCErrors.InvalidPreimage();
    }

    /// @dev Reverts with `UnauthorizedReceiver` unless the caller is the swap receiver.
    function _checkReceiver(Swap memory swap) internal view {
        if (msg.sender != swap.receiver) revert HTLCErrors.UnauthorizedReceiver();
    }

    /// @dev Reverts with `UnauthorizedSender` unless the caller is the swap sender.
    function _checkSender(Swap memory swap) internal view {
        if (msg.sender != swap.sender) revert HTLCErrors.UnauthorizedSender();
    }

    // ---------------------------------------------------------------------
    // Shared state-machine helpers
    // ---------------------------------------------------------------------

    /**
     * @notice Validates the parameters, stores the swap as OPEN and emits `SwapCreated`.
     * @dev Called by the concrete legs AFTER the asset has been secured (tokens pulled in, or
     *      `msg.value` received), so a swap can never be OPEN without funds behind it.
     *      `amount` is passed explicitly: the ERC20 leg uses its `amount` argument, the native-ETH
     *      leg passes `msg.value`.
     * @return swapId Deterministic id of the created swap.
     */
    function _openSwap(
        address sender,
        address payable receiver,
        address tokenContract,
        uint256 amount,
        bytes32 hashlock,
        uint256 timelock
    ) internal returns (bytes32 swapId) {
        _validateSwapParams(receiver, amount, hashlock, timelock);
        swapId = generateSwapId(sender, receiver, tokenContract, amount, hashlock, timelock);
        _requireSwapIdAvailable(swapId);
        _storeSwap(sender, receiver, tokenContract, amount, hashlock, timelock, swapId);
    }

    /**
     * @notice Runs every parameter check that must pass before a swap may be funded.
     * @dev Exposed as a separate step so a concrete leg can fail fast (and cheaply) BEFORE it moves any
     *      asset: `ERC20HTLC.lockMST` validates, checks the id, then calls `transferFrom`, and only then
     *      stores the swap. `_openSwap` composes the same three steps for legs that receive the asset
     *      with the call itself (native value).
     */
    function _validateSwapParams(address receiver, uint256 amount, bytes32 hashlock, uint256 timelock) internal view {
        _checkNonZeroAddress(receiver);
        _checkNonZeroAmount(amount);
        _checkFutureTimelock(timelock);
        _checkNonZeroHashlock(hashlock);
    }

    /// @dev Reverts with `SwapAlreadyExists` unless `swapId` is still unused (status EMPTY).
    function _requireSwapIdAvailable(bytes32 swapId) internal view {
        if (swaps[swapId].status != SwapStatus.EMPTY) revert HTLCErrors.SwapAlreadyExists();
    }

    /// @dev Stores the swap as OPEN and emits `SwapCreated`.
    function _storeSwap(
        address sender,
        address payable receiver,
        address tokenContract,
        uint256 amount,
        bytes32 hashlock,
        uint256 timelock,
        bytes32 swapId
    ) internal {
        swaps[swapId] = Swap({
            swapId: swapId,
            sender: payable(sender),
            receiver: receiver,
            tokenContract: tokenContract,
            amount: amount,
            hashlock: hashlock,
            timelock: timelock,
            status: SwapStatus.OPEN
        });

        emit SwapCreated(swapId, sender, receiver, tokenContract, amount, hashlock, timelock);
    }

    /**
     * @notice Verifies a claim, flips the swap to CLAIMED and emits `SwapClaimed`.
     * @dev Checks-effects-interactions: the status is written BEFORE the concrete leg performs the
     *      external transfer, and the leg additionally wraps the call in `nonReentrant`.
     *      Claim window policy: a claim is only valid while `block.timestamp < timelock`; after that
     *      only the refund path is available, which removes any claim/refund race at expiry.
     * @return swap The swap as CLAIMED - use `swap.receiver`, `swap.amount` and `swap.tokenContract`
     *              to perform the payout.
     */
    function _settleClaim(bytes32 swapId, bytes32 preimage) internal returns (Swap memory swap) {
        swap = swaps[swapId];
        if (swap.status == SwapStatus.EMPTY) revert HTLCErrors.SwapDoesNotExist();
        if (swap.status != SwapStatus.OPEN) revert HTLCErrors.SwapNotOpen();

        _checkReceiver(swap);

        if (block.timestamp >= swap.timelock) revert HTLCErrors.TimelockExpired();
        if (hashPreimage(preimage) != swap.hashlock) revert HTLCErrors.InvalidPreimage();

        swap.status = SwapStatus.CLAIMED;
        swaps[swapId].status = SwapStatus.CLAIMED;

        emit SwapClaimed(swapId, swap.receiver, preimage);
    }

    /**
     * @notice Verifies a refund, flips the swap to REFUNDED and emits `SwapRefunded`.
     * @dev Checks-effects-interactions: the status is written BEFORE the concrete leg performs the
     *      external transfer.
     * @return swap The swap as REFUNDED - use `swap.sender`, `swap.amount` and `swap.tokenContract`
     *              to perform the payout.
     */
    function _settleRefund(bytes32 swapId) internal returns (Swap memory swap) {
        swap = swaps[swapId];
        if (swap.status == SwapStatus.EMPTY) revert HTLCErrors.SwapDoesNotExist();
        if (swap.status != SwapStatus.OPEN) revert HTLCErrors.SwapNotOpen();

        _checkSender(swap);

        if (block.timestamp < swap.timelock) revert HTLCErrors.TimelockNotExpired();

        swap.status = SwapStatus.REFUNDED;
        swaps[swapId].status = SwapStatus.REFUNDED;

        emit SwapRefunded(swapId, swap.sender);
    }

    // ---------------------------------------------------------------------
    // Shared asset-movement helper
    // ---------------------------------------------------------------------

    /**
     * @notice Sends native value, reverting with `TransferFailed` instead of bubbling a low-level failure.
     * @dev Deliberately uses `call` (no 2300-gas stipend limit, forwards all available gas) instead of
     *      `transfer`/`send`. A failed transfer simply reverts the whole transaction, so the swap can
     *      never end up in a terminal status without the funds having moved.
     *      Used by `ETHHTLC`; the ERC20 leg uses SafeERC20 for its own transfers.
     */
    function _sendValue(address payable to, uint256 amount) internal {
        (bool success, ) = to.call{value: amount}("");
        if (!success) revert HTLCErrors.TransferFailed();
    }
}
