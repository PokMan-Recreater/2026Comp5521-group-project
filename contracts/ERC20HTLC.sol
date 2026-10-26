// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {HTLCBase} from "./HTLCBase.sol";
import {HTLCErrors} from "./libraries/HTLCErrors.sol";

/**
 * @title ERC20HTLC
 * @notice Ethereum Sepolia leg of the COMP 5521 cross-chain atomic swap: it locks the custom
 *         My Simple Token (MST) and releases it to the receiver on a valid claim, or refunds it to the
 *         sender after the timelock expires.
 *
 * @dev Inherits the whole state machine (storage, id derivation, validation, status transitions, events
 *      and the `nonReentrant` guard) from {HTLCBase}; this contract only owns the MST movement, which is
 *      what keeps both swap legs semantically identical.
 *
 *      Two entry-point surfaces are exposed on purpose:
 *      - `lockMST` / `claimMST` / `refundMST` - the MST-named API required by the ERC20 leg brief.
 *      - `createSwap` / `claimSwap` / `refundSwap` - the {IHTLC} surface that `HTLCBase` inherits, so the
 *        contract is deployable and shares one ABI with the native-value leg and the off-chain relayer.
 *      Both surfaces call the same internal implementation, so they cannot drift apart.
 *
 *      Token interaction policy: `IERC20.transferFrom` / `IERC20.transfer` are called directly and their
 *      boolean return value is checked, reverting with `HTLCErrors.TransferFailed` on `false` (as the
 *      brief requires). A token that reverts instead of returning `false` (e.g. OpenZeppelin's ERC20)
 *      simply bubbles its own revert - either way the transaction cannot succeed silently.
 */
contract ERC20HTLC is HTLCBase {
    /**
     * @notice The MST token this leg locks.
     * @dev `immutable`: written once in the constructor and embedded in the deployed bytecode, so every
     *      read is a `PUSH20` instead of a 2100/100-gas SLOAD. The MST address must be fixed for the
     *      lifetime of the deployment, which is also why `lockMST` does not need the token as an argument.
     */
    IERC20 public immutable mstToken;

    /// @dev Thrown when native value is sent to this leg (it only ever handles MST).
    error NativeValueNotAllowed();

    /// @dev Thrown when the token argument is not the configured MST (or is not a contract at all).
    error InvalidTokenContract();

    /**
     * @notice Deploys the ERC20 leg for a fixed MST token.
     * @dev Deploy the MST token first, then this contract: a token address without code is rejected.
     * @param mstToken_ Address of the MST ERC20 contract (non-zero, with code).
     */
    constructor(address mstToken_) {
        if (mstToken_ == address(0)) revert HTLCErrors.InvalidZeroAddress();
        if (mstToken_.code.length == 0) revert InvalidTokenContract();
        mstToken = IERC20(mstToken_);
    }

    // ---------------------------------------------------------------------
    // MST-named public API
    // ---------------------------------------------------------------------

    /**
     * @notice Locks `amount` MST from `msg.sender` into a new swap for `receiver`.
     * @dev Order of operations (fail fast, then interact, then effect):
     *      1. validate receiver / amount / timelock (and the hashlock),
     *      2. derive the swap id and require it to be unused,
     *      3. pull the MST in (the only external interaction, guarded by `nonReentrant`),
     *      4. store the swap as OPEN and emit `SwapCreated`.
     *      Because the MST is transferred before the swap is stored, a swap can never be OPEN without
     *      the MST behind it, and because the id is checked before the transfer, a duplicate lock reverts
     *      before any token movement.
     * @param receiver Account allowed to claim the swap by revealing the preimage.
     * @param amount   Amount of MST to lock.
     * @param hashlock keccak256(abi.encodePacked(preimage)).
     * @param timelock Unix timestamp after which the sender may refund.
     * @return swapId Deterministic id of the created swap.
     */
    function lockMST(
        address receiver,
        uint256 amount,
        bytes32 hashlock,
        uint256 timelock
    ) external nonReentrant returns (bytes32 swapId) {
        return _lockMST(receiver, amount, hashlock, timelock);
    }

    /// @notice Claims an OPEN swap by revealing the preimage; the MST goes to the swap receiver.
    function claimMST(bytes32 swapId, bytes32 preimage) external nonReentrant {
        _claimMST(swapId, preimage);
    }

    /// @notice Refunds an OPEN swap to the sender once its timelock has expired.
    function refundMST(bytes32 swapId) external nonReentrant {
        _refundMST(swapId);
    }

    // ---------------------------------------------------------------------
    // IHTLC surface (shared ABI, inherited by HTLCBase)
    // ---------------------------------------------------------------------

    /**
     * @notice {IHTLC}-compatible wrapper around `lockMST`.
     * @dev `payable` only because the shared interface must also fit the native-value leg; this leg
     *      rejects native value. The token must be the configured MST - `lockMST` is the entry point that
     *      does not need it, since the token is fixed per deployment.
     */
    function createSwap(
        address payable receiver,
        address tokenContract,
        uint256 amount,
        bytes32 hashlock,
        uint256 timelock
    ) external payable override nonReentrant returns (bytes32 swapId) {
        if (msg.value != 0) revert NativeValueNotAllowed();
        if (tokenContract != address(mstToken)) revert InvalidTokenContract();
        return _lockMST(receiver, amount, hashlock, timelock);
    }

    /// @notice {IHTLC}-compatible wrapper around `claimMST`.
    function claimSwap(bytes32 swapId, bytes32 preimage) external override nonReentrant {
        _claimMST(swapId, preimage);
    }

    /// @notice {IHTLC}-compatible wrapper around `refundMST`.
    function refundSwap(bytes32 swapId) external override nonReentrant {
        _refundMST(swapId);
    }

    // ---------------------------------------------------------------------
    // Internal implementation (single source of truth for both surfaces)
    // ---------------------------------------------------------------------

    /**
     * @dev Validates, checks the id, pulls the MST in, then stores the swap as OPEN and emits
     *      `SwapCreated`. Must be called from a `nonReentrant` entry point.
     */
    function _lockMST(
        address receiver,
        uint256 amount,
        bytes32 hashlock,
        uint256 timelock
    ) internal returns (bytes32 swapId) {
        // 1. validations (InvalidZeroAddress / InvalidZeroAmount / InvalidTimelock / InvalidPreimage)
        _validateSwapParams(receiver, amount, hashlock, timelock);

        // 2. deterministic id (token and amount excluded: the token is immutable, the amount is funding)
        swapId = generateSwapId(msg.sender, receiver, hashlock, timelock);
        _requireSwapIdAvailable(swapId); // SwapAlreadyExists

        // 3. interaction: lock the MST, reverting with TransferFailed if the token returns false
        if (!mstToken.transferFrom(msg.sender, address(this), amount)) revert HTLCErrors.TransferFailed();

        // 4. effects: store the swap and emit SwapCreated
        _storeSwap(msg.sender, payable(receiver), address(mstToken), amount, hashlock, timelock, swapId);
    }

    /**
     * @dev Settles the claim (status becomes CLAIMED, `SwapClaimed` is emitted) and only then pays the
     *      receiver. Must be called from a `nonReentrant` entry point.
     */
    function _claimMST(bytes32 swapId, bytes32 preimage) internal {
        Swap memory swap = _settleClaim(swapId, preimage);
        // Every swap stored by this contract is denominated in mstToken, so the token is known here.
        _transferMST(swap.receiver, swap.amount);
    }

    /**
     * @dev Settles the refund (status becomes REFUNDED, `SwapRefunded` is emitted) and only then pays the
     *      sender. Must be called from a `nonReentrant` entry point.
     */
    function _refundMST(bytes32 swapId) internal {
        Swap memory swap = _settleRefund(swapId);
        _transferMST(swap.sender, swap.amount);
    }

    /// @dev Pays MST out of this contract, reverting with `TransferFailed` if the token returns false.
    function _transferMST(address to, uint256 amount) internal {
        if (!mstToken.transfer(to, amount)) revert HTLCErrors.TransferFailed();
    }
}
