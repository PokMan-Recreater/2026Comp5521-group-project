// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title MockMST
 * @notice TEST-ONLY stand-in for the project's custom "My Simple Token (MST)": a plain OpenZeppelin
 *         ERC20 (18 decimals) with an open `mint` so tests can fund accounts.
 *
 * @dev If the group also needs a deployable MST for the Sepolia demo, this is the pattern to promote out
 *      of `mocks/` - only the mint access control would change (e.g. owner-only or a fixed supply).
 */
contract MockMST is ERC20 {
    constructor() ERC20("My Simple Token", "MST") {}

    /// @notice Mints `amount` MST to `to` (test helper, unrestricted on purpose).
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/**
 * @title FalseReturningERC20
 * @notice TEST-ONLY token whose `transfer` / `transferFrom` can return `false` instead of reverting.
 *
 * @dev Exists purely to exercise the `if (!token.transferFrom(...)) revert TransferFailed();` and
 *      `if (!token.transfer(...)) revert TransferFailed();` branches of {ERC20HTLC}. Real
 *      (OpenZeppelin-style) ERC20 tokens revert instead, which is also covered by the test suite.
 *      Both failure switches default to `true`, i.e. the token reports failure until told otherwise.
 */
contract FalseReturningERC20 is IERC20 {
    string public name = "False Returning Token";
    string public symbol = "FRT";
    uint8 public decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    bool public failTransfer = true;
    bool public failTransferFrom = true;

    function setFailTransfer(bool value) external {
        failTransfer = value;
    }

    function setFailTransferFrom(bool value) external {
        failTransferFrom = value;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        if (failTransfer) return false;

        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        emit Transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        if (failTransferFrom) return false;

        allowance[from][msg.sender] -= value;
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
        return true;
    }
}

/**
 * @title ReentrantERC20
 * @notice TEST-ONLY token that calls back into a configured target during `transfer`/`transferFrom`.
 *
 * @dev Used to prove that the `nonReentrant` guard inherited from {HTLCBase} protects the ERC20 leg's
 *      entry points, and that a malicious token cannot re-enter `lockMST` / `claimMST` mid-transfer.
 */
contract ReentrantERC20 is ERC20 {
    address public attackTarget;
    bytes public attackCalldata;
    bool private _attacking;

    constructor() ERC20("Reentrant Token", "REENT") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Configures the call this token performs while a transfer is in flight.
    function setAttack(address target, bytes calldata data) external {
        attackTarget = target;
        attackCalldata = data;
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        _reenter();
        return super.transfer(to, value);
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        _reenter();
        return super.transferFrom(from, to, value);
    }

    /// @dev Performs the configured call once per transfer and bubbles up any revert data unchanged.
    function _reenter() private {
        address target = attackTarget;
        if (target == address(0) || _attacking) return;

        _attacking = true;
        // Intentional low-level call: this mock exists precisely to attempt re-entrancy in tests.
        // solhint-disable-next-line avoid-low-level-calls
        (bool success, bytes memory data) = target.call(attackCalldata);
        if (!success) {
            assembly {
                revert(add(data, 0x20), mload(data))
            }
        }
    }
}
