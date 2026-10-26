// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IHTLC
 * @notice Shared interface for the COMP 5521 cross-chain atomic swap (Hash Time-Locked Contract) suite.
 *
 * @dev This interface is the single source of truth for the data model shared by both swap legs:
 *      - `ERC20HTLC.sol` (Ethereum Sepolia)  -> `tokenContract` = ERC20 token address, `amount` = token units.
 *      - `ETHHTLC.sol`   (Arbitrum Sepolia)  -> `tokenContract` = address(0),        `amount` = wei.
 *
 *      Both legs use the SAME swap lifecycle and the SAME event/struct layout, which is what makes the
 *      two on-chain legs comparable off-chain (same swapId derivation, same status machine).
 */
interface IHTLC {
    /**
     * @notice Lifecycle of a swap.
     * @dev `EMPTY` is deliberately the zero value so that "swap does not exist" can be detected with a
     *      single storage read (`swaps[swapId].status == SwapStatus.EMPTY`) instead of a separate
     *      boolean existence mapping. This saves one SLOAD + one SSTORE per swap creation.
     */
    enum SwapStatus {
        EMPTY, // 0 - no swap is stored under this id
        OPEN, // 1 - funded by the sender, waiting for claim or refund
        CLAIMED, // 2 - valid preimage supplied, funds released to the receiver
        REFUNDED // 3 - timelock expired, funds returned to the sender
    }

    /**
     * @notice On-chain representation of a single atomic swap leg.
     * @param swapId        Deterministic id: keccak256 of the swap parameters (see HTLCBase.generateSwapId).
     * @param sender        Party that locks the funds and may refund after the timelock.
     * @param receiver      Party that may claim the funds by revealing the preimage.
     * @param tokenContract ERC20 token address for the ERC20 leg, address(0) for the native-ETH leg.
     * @param amount        Amount locked: ERC20 units, or wei for the native-ETH leg.
     * @param hashlock      keccak256(abi.encodePacked(preimage)) - the lock that must be solved to claim.
     * @param timelock      Unix timestamp (seconds) after which the sender may refund.
     * @param status        Current state of the swap.
     */
    struct Swap {
        bytes32 swapId;
        address payable sender;
        address payable receiver;
        address tokenContract;
        uint256 amount;
        bytes32 hashlock;
        uint256 timelock;
        SwapStatus status;
    }

    /**
     * @notice Emitted when a new swap is funded and opened.
     * @dev `swapId`, `sender` and `receiver` are indexed (3 indexed topics = the maximum for a
     *      non-anonymous event) so an off-chain relayer can filter by any of them.
     */
    event SwapCreated(
        bytes32 indexed swapId,
        address indexed sender,
        address indexed receiver,
        address tokenContract,
        uint256 amount,
        bytes32 hashlock,
        uint256 timelock
    );

    /**
     * @notice Emitted when a swap is claimed; `preimage` is the secret that solved the hashlock.
     * @dev The preimage is indexed so the counterparty leg can be settled by filtering on the revealed
     *      secret. 3 indexed topics (swapId, receiver, preimage) is the maximum for a non-anonymous event.
     */
    event SwapClaimed(bytes32 indexed swapId, address indexed receiver, bytes32 preimage);

    /// @notice Emitted when a swap is refunded back to the sender after the timelock expired.
    event SwapRefunded(bytes32 indexed swapId, address indexed sender);

    /**
     * @notice Locks `amount` and opens a new swap.
     * @dev Implementations MUST be `payable` so that the native-ETH leg can lock `msg.value`.
     *      The ERC20 implementation MUST reject `msg.value != 0` (no native value is accepted there).
     *      `msg.sender` is always the swap sender, it is never passed in as an argument.
     * @param receiver      Address allowed to claim the swap.
     * @param tokenContract ERC20 token address, or address(0) for the native-ETH leg.
     * @param amount        Amount to lock (ignored by the native-ETH leg, which uses `msg.value`).
     * @param hashlock      keccak256(abi.encodePacked(preimage)).
     * @param timelock      Unix timestamp after which the sender may refund.
     * @return swapId       Deterministic id of the newly created swap.
     */
    function createSwap(
        address payable receiver,
        address tokenContract,
        uint256 amount,
        bytes32 hashlock,
        uint256 timelock
    ) external payable returns (bytes32 swapId);

    /**
     * @notice Claims an OPEN swap by revealing the preimage, releasing the funds to the receiver.
     * @dev Only callable by the swap receiver, and only before `timelock` expires.
     */
    function claimSwap(bytes32 swapId, bytes32 preimage) external;

    /**
     * @notice Refunds an OPEN swap to the sender once `timelock` has expired.
     * @dev Only callable by the swap sender.
     */
    function refundSwap(bytes32 swapId) external;

    /**
     * @notice Returns the full `Swap` struct for `swapId`.
     * @dev Reverts with `HTLCErrors.SwapDoesNotExist` when the id is unknown, so callers never receive
     *      a zero-filled struct that could be mistaken for a real swap.
     */
    function getSwap(bytes32 swapId) external view returns (Swap memory);
}
