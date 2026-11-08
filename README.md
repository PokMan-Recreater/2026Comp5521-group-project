# COMP 5521 Group Project — Cross-Chain Atomic Swap (HTLC) Foundation

Shared Solidity foundation for the COMP 5521 Distributed Ledger Technology project: a hash time-locked
contract (HTLC) suite that performs an atomic swap between an **ERC20 token on Ethereum Sepolia** and
**native ETH on Arbitrum Sepolia**.

This repository contains the **complete on-chain half of the project (Task A)**: the shared foundation
(interface, custom error library, abstract base contract), **both swap legs** — `ERC20HTLC.sol` for MST on
Ethereum Sepolia and `ETHHTLC.sol` for native ETH on Arbitrum Sepolia — and the off-chain protocol
primitives (`scripts/lib/swapId.js`) that the Task B scripts and the Task C frontend build on. The
cross-chain coordinator scripts, the web interface, the testnet deployments and the report are the
remaining work (see §11).

---

## 1. Deliverables

| File | Purpose | Brief requirements covered |
| --- | --- | --- |
| `contracts/interfaces/IHTLC.sol` | Shared interface | `SwapStatus` enum (`EMPTY, OPEN, CLAIMED, REFUNDED`), `Swap` struct (8 fields), `SwapCreated` / `SwapClaimed` / `SwapRefunded` events with indexed parameters, shared function signatures |
| `contracts/libraries/HTLCErrors.sol` | Gas-optimised custom errors | All 12 required errors, declared with Solidity's `error` syntax (no `require` strings), plus `ReentrancyDetected` for the custom guard |
| `contracts/HTLCBase.sol` | Abstract base contract | `mapping(bytes32 => Swap) public swaps`, custom `nonReentrant` guard, `generateSwapId(...)` via `keccak256(abi.encodePacked(...))`, plus shared validation/state-transition helpers |
| `contracts/ERC20HTLC.sol` | **Ethereum Sepolia leg (Member 1)** | Immutable MST token address, `lockMST` / `claimMST` / `refundMST`, `createSwap` / `claimSwap` / `refundSwap` shims for `IHTLC`, `TransferFailed` on a `false` token return |
| `contracts/ETHHTLC.sol` | **Arbitrum Sepolia leg (Member 2)** | Native-ETH escrow via `msg.value`, `lockETH` / `claimETH` / `refundETH`, `createSwap` / `claimSwap` / `refundSwap` shims for `IHTLC`, `InvalidZeroAmount` on a zero-value lock, `TransferFailed` when the recipient rejects the payout |
| `scripts/lib/swapId.js` | Off-chain protocol primitives (Task B foundation) | Both on-chain swap-id derivations, secret/hashlock generation and `verifyLegPair` (shared hashlock + crossed parties + timelock ordering) |
| `contracts/mocks/*.sol` | **Test-only** harnesses | A native-value harness, a re-entrancy attacker, an ETH-rejecting receiver, a re-entering native receiver and ERC20 mocks (MST, false-returning token, re-entrant token). Not part of the production architecture. |
| `test/HTLCBase.test.js` | Foundation test suite | 42 tests covering the enum/struct ABI layout, id derivation, every error path, the re-entrancy guard and payout atomicity |
| `test/ERC20HTLC.test.js` | ERC20 leg test suite | 38 tests covering the MST configuration, `lockMST` validations, token-interaction failures, claim/refund paths, the `IHTLC` surface, accounting invariants and re-entrancy on every entry point |
| `test/ETHHTLC.test.js` | Native-ETH leg test suite | 37 tests covering the `lockETH` validations, claim/refund paths, the `IHTLC` surface, ETH accounting invariants, rejecting/re-entering receivers, re-entrancy on every entry point and cross-leg parity |
| `test/swapIdLib.test.js` | Off-chain helper test suite | 13 tests asserting both id derivations against the deployed contracts and every `verifyLegPair` rule |

Technical constraints: **Solidity `^0.8.20`** (compiled with `0.8.20`, EVM target `shanghai`) and
**MIT** licence on every file.

---

## 2. Repository layout

```
E:\comp5521 group project\
├─ contracts\
│  ├─ interfaces\IHTLC.sol         # shared enum / struct / events / signatures
│  ├─ libraries\HTLCErrors.sol     # all custom errors (gas-optimised, no strings)
│  ├─ HTLCBase.sol                 # abstract base: storage, guard, ids, state machine
│  ├─ ERC20HTLC.sol                # Ethereum Sepolia leg: locks the MST token (immutable address)
│  ├─ ETHHTLC.sol                  # Arbitrum Sepolia leg: escrows native ETH (msg.value)
│  └─ mocks\                       # test-only: HTLCBaseHarness, ReentrancyAttacker, EtherRejector,
│                                  #            ReenteringReceiver, ERC20Mocks
├─ scripts\
│  └─ lib\swapId.js                # off-chain id derivation, secret generation, leg-pair verification
├─ test\
│  ├─ HTLCBase.test.js             # 42 tests for the shared foundation
│  ├─ ERC20HTLC.test.js            # 38 tests for the MST locking leg
│  ├─ ETHHTLC.test.js              # 37 tests for the native-ETH leg (+ cross-leg parity)
│  └─ swapIdLib.test.js            # 13 tests for the off-chain protocol helpers
├─ hardhat.config.js               # 0.8.20 + optimizer, hardhat / localhost / sepolia / arbitrumSepolia
├─ .env.example                    # RPC URLs, deployer key, explorer keys (copy to .env)
├─ .solhint.json                   # Solidity linter rules
└─ package.json                    # npm scripts (compile / test / coverage / gas / lint / node)
```

---

## 3. Quick start

```powershell
cd 'E:\comp5521 group project'
npm install          # Node >= 18 (verified with Node 22 / npm 10)
npm run compile      # npx hardhat compile
npm test             # 130 passing tests (42 foundation + 38 ERC20 leg + 37 ETH leg + 13 helpers)
npm run lint         # solhint over contracts/**
npm run gas          # test suite with a gas report (REPORT_GAS=true)
```

Deploying to the testnets requires the Task B deploy scripts (§11); once they exist the entry points are:

```powershell
Copy-Item .env.example .env      # then fill in RPC URLs and DEPLOYER_PRIVATE_KEY
npx hardhat run scripts/deploy.js --network sepolia           # MST + ERC20HTLC
npx hardhat run scripts/deploy.js --network arbitrumSepolia   # ETHHTLC
```

> The folder name contains a space, so always quote the path in shell commands.

---

## 4. Data model (`IHTLC.sol`)

### `SwapStatus`

| Value | Name | Meaning |
| --- | --- | --- |
| 0 | `EMPTY` | No swap is stored under this id (this is the zero value, so no extra existence flag is needed) |
| 1 | `OPEN` | Funded by the sender, waiting for a claim or a refund |
| 2 | `CLAIMED` | Valid preimage supplied, funds released to the receiver |
| 3 | `REFUNDED` | Timelock expired, funds returned to the sender |

### `Swap`

```solidity
struct Swap {
    bytes32 swapId;         // keccak256 of the swap parameters (deterministic)
    address payable sender;   // funds the swap, may refund after the timelock
    address payable receiver; // may claim with the preimage
    address tokenContract;    // ERC20 address on Sepolia, address(0) for the native-ETH leg
    uint256 amount;           // ERC20 units, or wei for the native-ETH leg
    bytes32 hashlock;         // keccak256(abi.encodePacked(preimage))
    uint256 timelock;         // unix seconds after which the sender may refund
    SwapStatus status;
}
```

### Events

```solidity
event SwapCreated(bytes32 indexed swapId, address indexed sender, address indexed receiver,
                  address tokenContract, uint256 amount, bytes32 hashlock, uint256 timelock);
event SwapClaimed(bytes32 indexed swapId, address indexed receiver, bytes32 preimage);
event SwapRefunded(bytes32 indexed swapId, address indexed sender);
```

`SwapCreated` indexes the maximum three topics (swapId, sender, receiver) so an off-chain relayer can
filter the legs of a swap directly. `SwapClaimed` indexes the revealed preimage, which is what the
counterparty leg needs in order to settle.

### Functions

```solidity
function createSwap(address payable receiver, address tokenContract, uint256 amount,
                    bytes32 hashlock, uint256 timelock) external payable returns (bytes32 swapId);
function claimSwap(bytes32 swapId, bytes32 preimage) external;
function refundSwap(bytes32 swapId) external;
function getSwap(bytes32 swapId) external view returns (Swap memory);
```

`createSwap` is `payable` in the shared interface so the native-ETH leg can lock `msg.value`; the ERC20
leg must reject any native value it receives.

---

## 5. Custom errors (`HTLCErrors.sol`)

All errors are declared inside a library so they are namespaced (`HTLCErrors.SwapNotOpen`) while keeping
the canonical 4-byte selector of a plain `SwapNotOpen()` — the declaring library/contract name is *not*
part of an error signature, so this costs nothing in gas and nothing in ABI compatibility
(asserted by a test).

| Error | Raised when |
| --- | --- |
| `SwapAlreadyExists` | `createSwap` is called with parameters that hash to an existing swap id |
| `SwapDoesNotExist` | The swap id is unknown (status `EMPTY`) |
| `SwapNotOpen` | The swap exists but is already `CLAIMED` or `REFUNDED` |
| `InvalidZeroAddress` | An address argument is `address(0)` |
| `InvalidZeroAmount` | An amount argument is zero |
| `InvalidTimelock` | The timelock is not strictly in the future |
| `UnauthorizedReceiver` | The caller of `claimSwap` is not the swap receiver |
| `UnauthorizedSender` | The caller of `refundSwap` is not the swap sender |
| `InvalidPreimage` | `keccak256(preimage)` does not match the hashlock (also used for a zero hashlock) |
| `TimelockNotExpired` | A refund is attempted before the deadline |
| `TimelockExpired` | A claim is attempted at/after the deadline |
| `TransferFailed` | A native-value transfer reverted |
| `ReentrancyDetected` | A `nonReentrant` function was re-entered (added for the custom guard) |

Why custom errors instead of `require(cond, "message")`:

* the string is embedded in the deployed bytecode (higher deployment cost) and ABI-encoded into every
  revert (much higher revert cost);
* a custom error reverts with a 4-byte selector only — the test suite asserts the revert data is
  exactly 4 bytes and is *not* an `Error(string)` payload (`0x08c379a0`);
* the errors are parameterless on purpose: error arguments would have to be encoded into the revert data
  (extra memory copy + gas). Use the events and `getSwap` for debugging instead.

---

## 6. Abstract base (`HTLCBase.sol`)

State and mechanics owned by the base contract:

* `mapping(bytes32 => Swap) public swaps` — the single source of truth for every swap on that chain.
* `nonReentrant` — a custom two-value guard (`_NOT_ENTERED = 1`, `_ENTERED = 2`). It does not depend on
  OpenZeppelin, reverts with `ReentrancyDetected`, and the guard is released at the end of the call.
* `generateSwapId(...)` — two overloads, both `keccak256(abi.encodePacked(...))`, so clients can predict a
  swap id off-chain before sending the transaction:
  * 6 arguments `(sender, receiver, tokenContract, amount, hashlock, timelock)` — used by `_openSwap`
    (the native-value leg hashes in the amount, which *is* `msg.value`).
  * 4 arguments `(sender, receiver, hashlock, timelock)` — the brief-mandated variant used by
    `ERC20HTLC.lockMST`: the MST address is immutable per deployment and the amount is funding rather
    than identity.
  * The two legs therefore derive **different** ids for the same logical swap. That is by design and
    unavoidable (different amounts, and the required asymmetric timelocks), so cross-chain correlation
    must never compare ids — use the shared hashlock, the crossed parties and the timelock ordering
    (§7.1, §7.14, `scripts/lib/swapId.js`).
* The state-machine helper is split into three steps so a leg can fail fast *before* moving any asset:
  `_validateSwapParams` → `_requireSwapIdAvailable` → *(the leg funds the swap)* → `_storeSwap`.
  `_openSwap` composes all three for legs that receive the asset with the call itself (`msg.value`).
* `hashPreimage(preimage)` — `keccak256(abi.encodePacked(preimage))`, matching
  `ethers.solidityPackedKeccak256(["bytes32"], [preimage])`.
* Validation helpers: `_checkNonZeroAddress`, `_checkNonZeroAmount`, `_checkFutureTimelock`,
  `_checkNonZeroHashlock`, `_checkReceiver`, `_checkSender`.
* State-machine helpers: `_openSwap`, `_settleClaim`, `_settleRefund` — each validates, writes the new
  status and emits the corresponding event, following **checks-effects-interactions** (state is written
  before the concrete contract performs the external transfer).
* `_sendValue(to, amount)` — native-value payout via `call` (no 2300-gas stipend), reverting with
  `TransferFailed` instead of bubbling a low-level failure.
* `getSwap(swapId)` — reverts with `SwapDoesNotExist` for unknown ids, so a caller can never mistake a
  zero-filled struct for a real swap.

### Lifecycle

```
        createSwap (payable, nonReentrant)
                │  _openSwap: validate → generateSwapId → store OPEN → emit SwapCreated
                ▼
             ┌──────┐
             │ OPEN │
             └──┬───┘
   claimSwap    │    refundSwap
   (receiver,   │    (sender, block.timestamp >= timelock)
   timestamp <  │
   timelock,    │
   preimage ok) │
                ▼
        _settleClaim / _settleRefund: write status → emit event → transfer asset
                │
      ┌─────────┴──────────┐
      ▼                    ▼
  ┌─────────┐         ┌──────────┐
  │ CLAIMED │         │ REFUNDED │   (both terminal; any further call reverts with SwapNotOpen)
  └─────────┘         └──────────┘
```

---

## 7. Design decisions (and their trade-offs)

1. **Deterministic swap ids + `SwapAlreadyExists`.** The id is `keccak256` over the swap parameters, so
   clients can compute it before sending the transaction and the same parameter set can never open two
   swaps. Consequence: after a swap has been refunded, re-creating an *identical* swap is rejected —
   change one parameter (receiver, amount or timelock) or add a `nonce` argument to `generateSwapId`
   if that is ever needed. The two legs use **different derivation variants** (4-argument for
   `ERC20HTLC`, 6-argument for `ETHHTLC`), so their ids differ for the same logical swap; that is
   expected and cannot be avoided anyway because the legs carry different amounts and the required
   asymmetric timelocks (§7.14).
2. **The claim window closes at the timelock** (`block.timestamp >= timelock` → `TimelockExpired`).
   After expiry only the refund path is available, which removes any claim/refund race at the deadline.
   If the group prefers "claim any time until the sender refunds", relax that single check in
   `_settleClaim`.
3. **Refunds are restricted to the sender** (`UnauthorizedSender`) and claims to the receiver
   (`UnauthorizedReceiver`), matching the required error list.
4. **`EMPTY` is the zero value of `SwapStatus`**, so existence checks cost a single storage read and no
   extra `mapping(bytes32 => bool)`.
5. **Checks-effects-interactions + `nonReentrant`.** Every helper writes the new status and emits the
   event *before* the concrete leg transfers value, and each external entry point is guarded. A test
   proves a reverting payout leaves the swap `OPEN` rather than `CLAIMED`.
6. **The foundation has no external dependencies** (no OpenZeppelin imports), so both legs inherit
   identical state-machine semantics. OpenZeppelin is used only where a leg genuinely needs it —
   `ERC20HTLC` imports `IERC20` for the token interface, and the test mocks use `ERC20`.
7. **Payouts use `call`, not `transfer`/`send`** (no 2300-gas stipend), and `_sendValue` maps any failure
   to `TransferFailed` (native leg). The ERC20 leg checks the `bool` returned by `IERC20.transfer`
   instead of using `SafeERC20`, as the brief requires: `false` → `TransferFailed`, while a token that
   reverts bubbles its own revert. Both paths are tested, including that a failed payout leaves the swap
   `OPEN` (never `CLAIMED` with the MST still inside the contract).
8. **Parameterless, library-namespaced custom errors** — cheapest revert path while keeping readable
   names in tests and block explorers.

### ERC20 leg specifics (`ERC20HTLC.sol`)

9. **The MST address is `immutable`** — written once in the constructor and embedded in the bytecode, so
   every read is a `PUSH20` instead of a 2100/100-gas SLOAD. The constructor rejects `address(0)`
   (`InvalidZeroAddress`) and an address without code (`InvalidTokenContract`), which is why the MST must
   be deployed before the HTLC.
10. **Two entry-point surfaces.** `lockMST` / `claimMST` / `refundMST` are the brief-mandated MST API;
    `createSwap` / `claimSwap` / `refundSwap` implement the inherited {IHTLC} interface (needed for the
    contract to be deployable and to share one ABI with the native leg and the relayer). Both delegate to
    the same internal `_lockMST` / `_claimMST` / `_refundMST`, so there is exactly one implementation.
11. **Order of operations in `lockMST`:** validate → derive id → require id unused → `transferFrom` →
    store + emit. Fail fast before the external call, and the MST is inside the contract before the swap
    is stored, so an `OPEN` swap is always funded. `nonReentrant` guards every entry point and a
    malicious re-entrant token is used in the tests to prove it on both the funding and payout paths.
12. **Leg-specific errors are declared locally** (`NativeValueNotAllowed`, `InvalidTokenContract`) so
    `HTLCErrors.sol` stays exactly the shared set from the brief (12 errors + `ReentrancyDetected`).

### Native leg specifics (`ETHHTLC.sol`)

13. **`msg.value` is the amount; the `IHTLC` `amount` argument is ignored on purpose.** The shared
    interface has to fit both assets, so `createSwap(receiver, tokenContract, amount, hashlock, timelock)`
    keeps its shape on the ETH leg, but the locked value is always `msg.value`. A zero-value lock reverts
    with `InvalidZeroAmount` (from `_openSwap` → `_checkNonZeroAmount`) and any non-zero `tokenContract`
    with the leg's locally declared `InvalidTokenContract`, which keeps `Swap.tokenContract == address(0)`
    a reliable "this is the native leg" marker for the coordinator and the UI.
14. **The two legs derive different ids, and that is correct.** `ERC20HTLC` uses the 4-argument
    `generateSwapId` (token fixed per deployment, amount treated as funding) while `ETHHTLC` funds through
    `_openSwap` and the 6-argument form (which also commits to `tokenContract` and `amount`). Even with
    one shared variant the ids could not match, because a cross-chain swap carries a different amount and,
    more importantly, **asymmetric timelocks**: the ETH leg must expire strictly before the MST leg.
    Cross-chain correlation therefore keys on the shared `hashlock`, the crossed party mapping and the
    timelock ordering — implemented once in `scripts/lib/swapId.js` (`verifyLegPair`) and asserted against
    both deployed contracts in `test/swapIdLib.test.js`.
15. **Re-entrancy on the native path is attacked through the receiver, not a token.** `_sendValue` hands
    control to the ETH recipient, so the tests use `ReenteringReceiver` — a contract that claims its own
    swap and calls back into the HTLC from inside `receive()`. It records the inner revert, so the tests
    assert that the revert data is exactly the `ReentrancyDetected` selector (i.e. the guard, not an
    unrelated failure, did the blocking) on **every** entry point, including the refund payout where the
    contract is the sender. Its `bubbleAttackFailure` mode additionally proves the atomicity rule: a
    failed payout leaves the swap `OPEN` and funded.

---

## 8. How the other members inherit this foundation

### Member 1 — `ERC20HTLC.sol` (Ethereum Sepolia) — **implemented**

Delivered as `contracts/ERC20HTLC.sol`. The essential shape (full NatSpec lives in the file):

```solidity
contract ERC20HTLC is HTLCBase {
    IERC20 public immutable mstToken;   // set once in the constructor, must have code
    error NativeValueNotAllowed();      // leg-specific errors are declared locally
    error InvalidTokenContract();

    function lockMST(address receiver, uint256 amount, bytes32 hashlock, uint256 timelock)
        external nonReentrant returns (bytes32 swapId)
    {
        _validateSwapParams(receiver, amount, hashlock, timelock);         // InvalidZeroAddress / Amount / Timelock
        swapId = generateSwapId(msg.sender, receiver, hashlock, timelock); // 4-argument id variant
        _requireSwapIdAvailable(swapId);                                   // SwapAlreadyExists
        if (!mstToken.transferFrom(msg.sender, address(this), amount)) revert HTLCErrors.TransferFailed();
        _storeSwap(msg.sender, payable(receiver), address(mstToken), amount, hashlock, timelock, swapId);
    }

    function claimMST(bytes32 swapId, bytes32 preimage) external nonReentrant {
        Swap memory swap = _settleClaim(swapId, preimage);                 // status is CLAIMED already
        if (!mstToken.transfer(swap.receiver, swap.amount)) revert HTLCErrors.TransferFailed();
    }

    function refundMST(bytes32 swapId) external nonReentrant {
        Swap memory swap = _settleRefund(swapId);                          // status is REFUNDED already
        if (!mstToken.transfer(swap.sender, swap.amount)) revert HTLCErrors.TransferFailed();
    }

    // createSwap / claimSwap / refundSwap are IHTLC shims over the same internal functions
}
```

Public API: `mstToken()`, `lockMST(receiver, amount, hashlock, timelock)`, `claimMST(swapId, preimage)`,
`refundMST(swapId)`, the `IHTLC` shims `createSwap` / `claimSwap` / `refundSwap`, and the inherited
`swaps(id)` / `getSwap(id)` views. Deployment order: **MST token first, then `ERC20HTLC(mstAddress)`**.

### Member 2 — `ETHHTLC.sol` (Arbitrum Sepolia) — **implemented**

Delivered as `contracts/ETHHTLC.sol`: the mirror image of the MST leg (`lockETH` / `claimETH` /
`refundETH` plus the same `IHTLC` shims over one internal implementation). The essential shape:

```solidity
contract ETHHTLC is HTLCBase {
    error InvalidTokenContract();   // leg-specific, declared locally (native value only)

    function lockETH(address payable receiver, bytes32 hashlock, uint256 timelock)
        external payable nonReentrant returns (bytes32 swapId)
    {
        return _lockETH(receiver, hashlock, timelock);
    }

    function createSwap(
        address payable receiver,
        address tokenContract,
        uint256, // unused: the native leg always locks msg.value
        bytes32 hashlock,
        uint256 timelock
    ) external payable override nonReentrant returns (bytes32 swapId) {
        if (tokenContract != address(0)) revert InvalidTokenContract(); // address(0) is the native marker
        return _lockETH(receiver, hashlock, timelock);
    }

    function _lockETH(address payable receiver, bytes32 hashlock, uint256 timelock)
        internal returns (bytes32 swapId)
    {
        // validate (InvalidZeroAmount for msg.value == 0) -> 6-argument generateSwapId
        // -> _requireSwapIdAvailable -> store + emit SwapCreated
        return _openSwap(msg.sender, receiver, address(0), msg.value, hashlock, timelock);
    }

    function _claimETH(bytes32 swapId, bytes32 preimage) internal {
        Swap memory swap = _settleClaim(swapId, preimage);   // status is CLAIMED already
        _sendValue(swap.receiver, swap.amount);              // TransferFailed on a rejecting receiver
    }

    function _refundETH(bytes32 swapId) internal {
        Swap memory swap = _settleRefund(swapId);            // status is REFUNDED already
        _sendValue(swap.sender, swap.amount);
    }

    // claimETH / refundETH and the claimSwap / refundSwap shims delegate to the same internals
}
```

Public API: `lockETH(receiver, hashlock, timelock)`, `claimETH(swapId, preimage)`, `refundETH(swapId)`, the
`IHTLC` shims `createSwap` / `claimSwap` / `refundSwap` (identical call shape to the MST leg, which is what
lets one coordinator or UI drive both chains), and the inherited `swaps(id)` / `getSwap(id)` views. The
constructor takes no arguments, so this side has no deployment-ordering constraint.

Both contracts stay thin by design: validation, id derivation, status transitions, events and the
re-entrancy guard all live in `HTLCBase`, so the two legs cannot drift apart. They use different id
derivation variants on purpose (§7.14), so a client derives each leg's id with the matching function —
`scripts/lib/swapId.js` provides both, and `test/swapIdLib.test.js` asserts them against the deployed
contracts.

---

## 9. Test suites

`npm test` → **130 passing** (42 foundation + 38 ERC20 leg + 37 ETH leg + 13 off-chain helpers) in ~4 s on
the in-process Hardhat network. `npm run coverage` reports **100 % statements / branches / functions /
lines** for `ERC20HTLC.sol`, `ETHHTLC.sol`, `HTLCBase.sol`, `IHTLC.sol` and `HTLCErrors.sol`.

### `test/HTLCBase.test.js` (42 tests)

Runs against `HTLCBaseHarness`, a native-value implementation of the lifecycle built on the foundation
(the shape `ETHHTLC` now ships in production form).

| Group | Tests | What is proven |
| --- | --- | --- |
| `IHTLC.SwapStatus` | 2 | `EMPTY == 0` (unknown swaps read as `EMPTY`); `OPEN → CLAIMED`/`REFUNDED` use the documented ABI values |
| `generateSwapId` | 3 | matches the off-chain `keccak256(abi.encodePacked(...))`, is deterministic, and changes for each of the six parameters |
| `hashPreimage` | 2 | matches `solidityPackedKeccak256(["bytes32"], [preimage])` |
| `createSwap / _openSwap` | 8 | storage + `SwapCreated` event + locked balance; independent swaps per receiver; `SwapAlreadyExists`, `InvalidZeroAddress`, `InvalidZeroAmount`, `InvalidTimelock` (current and past), `InvalidPreimage` (zero hashlock) |
| `getSwap` | 2 | `SwapDoesNotExist` for unknown ids; agrees with the public `swaps` getter |
| `claimSwap / _settleClaim` | 7 | payout to the receiver + `SwapClaimed` event with preimage; `InvalidPreimage` (and swap stays `OPEN`), `UnauthorizedReceiver`, `TimelockExpired`, `SwapNotOpen` (double claim, after refund), `SwapDoesNotExist` |
| `refundSwap / _settleRefund` | 5 | payout to the sender + `SwapRefunded` event; `TimelockNotExpired`, `UnauthorizedSender`, `SwapNotOpen` (after claim), `SwapDoesNotExist` |
| `HTLCErrors` | 3 | every required error is declared on the inherited ABI; selectors equal `bytes4(keccak256("Name()"))`; revert data is exactly 4 bytes and not `Error(string)` |
| shared validation helpers | 5 | each `_check*` helper reverts with the documented error |
| `nonReentrant guard` | 2 | the guard is released after a normal call; a re-entrant call reverts with `ReentrancyDetected` |
| `_sendValue` / payout atomicity | 3 | native transfer to an EOA; `TransferFailed` for a rejecting recipient; a failed payout leaves the swap `OPEN` |

Useful extras: `npm run coverage` (solidity-coverage) and `npm run gas` (gas report per function).

### `test/ERC20HTLC.test.js` (38 tests)

| Group | Tests | What is proven |
| --- | --- | --- |
| constructor / MST configuration | 4 | `mstToken` stored immutably; `InvalidZeroAddress` for `address(0)`; `InvalidTokenContract` for an address without code; the contract refuses plain native value |
| `lockMST` | 8 | `SwapCreated` event, storage fields, MST balances, status `OPEN`; returned id matches the off-chain 4-argument derivation; independent swaps per receiver; `InvalidZeroAddress`, `InvalidZeroAmount`, `InvalidTimelock` (current and past), `InvalidPreimage` |
| `lockMST` token interaction | 6 | `SwapAlreadyExists` reverts *before* any token movement; a token revert bubbles (`ERC20InsufficientAllowance`, `ERC20InsufficientBalance`); `TransferFailed` when the token returns `false`; a re-entrant token cannot re-enter during `transferFrom` |
| `claimMST` | 6 | MST released to the receiver + `SwapClaimed` with the preimage; `InvalidPreimage` (swap stays `OPEN` and funded), `UnauthorizedReceiver`, `TimelockExpired`, `SwapNotOpen`, `SwapDoesNotExist` |
| `refundMST` | 5 | `TimelockNotExpired`; `UnauthorizedSender`; refund after the deadline + `SwapRefunded`; `SwapNotOpen` after a claim; `SwapDoesNotExist` |
| `IHTLC` surface | 5 | `createSwap` locks the configured MST and emits the same event as `lockMST`; `NativeValueNotAllowed`; `InvalidTokenContract`; `claimSwap` / `refundSwap` delegate correctly; the MST balance always equals the sum of `OPEN` swaps |
| re-entrancy on every entry point | 5 | a malicious token cannot re-enter `createSwap`, `claimMST`, `claimSwap`, `refundMST` or `refundSwap` — `ReentrancyDetected`, and the swap stays `OPEN` and funded |

### `test/ETHHTLC.test.js` (37 tests)

| Group | Tests | What is proven |
| --- | --- | --- |
| `lockETH` | 9 | `SwapCreated` event, storage fields (`tokenContract == address(0)`, `amount == msg.value`), contract ETH balance, status `OPEN`; returned id matches the off-chain 6-argument derivation; independent swaps per receiver; `InvalidZeroAmount`, `InvalidZeroAddress`, `InvalidTimelock` (current and past), `InvalidPreimage`; `SwapAlreadyExists` *before* any ETH is taken; plain ETH with no calldata rejected (no `receive`) |
| `claimETH` | 7 | ETH released to the receiver + `SwapClaimed` with the preimage; `InvalidPreimage` (stays `OPEN` and funded), `UnauthorizedReceiver`, `TimelockExpired`, `SwapNotOpen` (double claim, after refund), `SwapDoesNotExist` |
| `refundETH` | 5 | `TimelockNotExpired`; `UnauthorizedSender`; refund after the deadline + `SwapRefunded`; `SwapNotOpen` after a claim; `SwapDoesNotExist` |
| `IHTLC` surface | 5 | `createSwap` locks `msg.value` and ignores the `amount` argument; `InvalidZeroAmount`; `InvalidTokenContract`; `claimSwap` / `refundSwap` delegate correctly; the contract balance always equals the sum of `OPEN` swaps |
| payout safety and re-entrancy | 3 | a rejecting receiver → `TransferFailed` and the swap stays `OPEN` and funded; a re-entering receiver is blocked, with the raw revert data asserted to be the `ReentrancyDetected` selector; the bubbled variant also leaves the swap `OPEN` |
| re-entrancy on every entry point | 5 | `ReentrancyDetected` for `lockETH`, `createSwap` and `claimSwap` during a payout, and for `refundETH` / `refundSwap` during a refund payout to a contract sender |
| cross-leg parity | 3 | one preimage settles both legs (the ETH claim reveals it, the MST claim spends it); the two legs derive different ids for the same logical swap; the ETH leg expires and refunds first while the MST leg keeps its longer window and is refunded afterwards |

### `test/swapIdLib.test.js` (13 tests)

| Group | Tests | What is proven |
| --- | --- | --- |
| `hashPreimage` / `generateSecret` | 2 | the generated hashlock is accepted and then opened by the deployed `ETHHTLC`; every secret is a fresh 32-byte value |
| id derivations | 3 | `deriveMstLegSwapId` / `deriveEthLegSwapId` equal what `ERC20HTLC` / `ETHHTLC` return and store; the two legs differ even with identical parameters |
| `verifyLegPair` | 8 | accepts a correctly crossed pair; rejects non-crossed parties, mismatched hashlocks, a missing asymmetric timelock, already-expired legs, a wrong preimage and zero amounts; exposes the native token marker |

Gas snapshot from `npm run gas` (optimizer on, 200 runs, `solc 0.8.20`):

| Operation | Gas |
| --- | --- |
| `lockMST` (cold storage, first swap) | ~230k–247k |
| `claimMST` | ~79k–84k |
| `refundMST` | ~61k |
| `lockETH` / `createSwap` (native leg) | ~186k |
| `claimETH` / `claimSwap` (native leg) | ~55k |
| `refundETH` / `refundSwap` (native leg) | ~54k |
| `ERC20HTLC` deployment | ~2.67M |
| `ETHHTLC` deployment | ~843k |

---

## 10. Target networks

| Network | chainId | Contract | `.env` variable |
| --- | --- | --- | --- |
| Ethereum Sepolia | 11155111 | `ERC20HTLC.sol` (Member 1) | `SEPOLIA_RPC_URL`, `ETHERSCAN_API_KEY` |
| Arbitrum Sepolia | 421614 | `ETHHTLC.sol` (Member 2) | `ARBITRUM_SEPOLIA_RPC_URL`, `ARBISCAN_API_KEY` |
| Hardhat (in-process) | 31337 | tests | – |

The compiler output targets `shanghai`, which both chains support. Verification after deployment:

```powershell
npx hardhat verify --network sepolia <address>
npx hardhat verify --network arbitrumSepolia <address>
```

---

## 11. Next steps for the group

On-chain work (Task A) and the off-chain protocol primitives are **done**. What remains, in dependency
order:

0. ~~**Both legs** — `ERC20HTLC.sol` + `ETHHTLC.sol`, `scripts/lib/swapId.js`~~ **done**: 130 passing
   tests, 100 % statement/branch/function/line coverage on both legs and on `HTLCBase`, lint clean.
1. **Task B — `scripts/` coordinator (20 marks).** Build on `scripts/lib/swapId.js`:
   `deploy.js` (MST + `ERC20HTLC` on Sepolia, `ETHHTLC` on Arbitrum Sepolia, writes the addresses),
   `1_generateSecret.js`, `2_lockERC20.js` (approve + `lockMST`), `3_lockETH.js` (shorter timelock),
   `4_verify.js` (calls `verifyLegPair` and refuses a mismatched pair), `5_claimBoth.js` (claim the ETH leg,
   read the preimage from `SwapClaimed`, claim the MST leg), `6_refund.js` (expiry detection + refund) and
   `inspect.js` (B3: independent state report for both chains). Add the deployed addresses, MST address
   and demo timelocks to `.env.example`.
2. **Task C — frontend (10 marks).** MetaMask connect + network switching between 11155111 and 421614,
   balances, `approve` + lock both legs, `verifyLegPair` feedback, claim, refund and explorer links.
   The two legs share one ABI shape, so a single contract wrapper drives both chains.
3. **Task E — deployment and rehearsal (10 marks).** Deploy + verify both contracts, record the addresses
   here (§10), pre-fund two accounts and rehearse both the claim path and the timeout/refund path with
   shortened timelocks.
4. **Task D + F — report, slides, contribution table, `Changes.md` (25 marks).** §7 and §9 of this README
   are written to be lifted straight into the design/implementation and testing sections; state which
   functions were AI-assisted, as the AI policy requires.
5. **Optional Challenge Part (10 marks)** — private cross-chain linkage (ZK equality of preimages,
   adaptor signatures / point locks). Only after 1–4 are green; it must preserve the refund path.
