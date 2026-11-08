const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const ZERO_ADDRESS = ethers.ZeroAddress;
const ZERO_HASH = ethers.ZeroHash;

// Numeric values of IHTLC.SwapStatus (same ABI order as the shared interface).
const SwapStatus = { EMPTY: 0n, OPEN: 1n, CLAIMED: 2n, REFUNDED: 3n };

/** Off-chain mirror of HTLCBase.generateSwapId(sender, receiver, tokenContract, amount, hashlock, timelock). */
function computeSwapId({ sender, receiver, tokenContract = ZERO_ADDRESS, amount, hashlock, timelock }) {
  return ethers.solidityPackedKeccak256(
    ["address", "address", "address", "uint256", "bytes32", "uint256"],
    [sender, receiver, tokenContract, amount, hashlock, timelock]
  );
}

/** Off-chain mirror of HTLCBase.hashPreimage. */
function computeHashlock(preimage) {
  return ethers.solidityPackedKeccak256(["bytes32"], [preimage]);
}

/**
 * Off-chain mirror of `ERC20HTLC`'s 4-argument id derivation (`lockMST` / its `createSwap` shim).
 * Used only by the cross-leg parity tests, which show that the two legs derive DIFFERENT ids.
 */
function computeMstLegSwapId({ sender, receiver, hashlock, timelock }) {
  return ethers.solidityPackedKeccak256(
    ["address", "address", "bytes32", "uint256"],
    [sender, receiver, hashlock, timelock]
  );
}

describe("ETHHTLC - native ETH locking leg (Arbitrum Sepolia)", function () {
  let htlc;
  let sender;
  let receiver;
  let stranger;
  let amount;
  let preimage;
  let hashlock;
  let timelock;

  /** Timelock `seconds` in the future, as a bigint (block.timestamp is a uint256). */
  async function futureTimelock(seconds = 3600) {
    return BigInt(await time.latest()) + BigInt(seconds);
  }

  /** Deterministic id of the swap the default `lockETH` call below produces. */
  function defaultSwapId(overrides = {}) {
    return computeSwapId({ sender: sender.address, receiver: receiver.address, amount, hashlock, timelock, ...overrides });
  }

  function lockETH(signer = sender, overrides = {}) {
    const {
      receiver: to = receiver.address,
      value = amount,
      hashlock: lock = hashlock,
      timelock: deadline = timelock,
    } = overrides;
    return htlc.connect(signer).lockETH(to, lock, deadline, { value });
  }

  beforeEach(async function () {
    [sender, receiver, stranger] = await ethers.getSigners();

    const ETHHTLC = await ethers.getContractFactory("ETHHTLC");
    htlc = await ETHHTLC.deploy();

    amount = ethers.parseEther("1");
    preimage = ethers.id("COMP5521-eth-preimage");
    hashlock = computeHashlock(preimage);
    timelock = await futureTimelock();
  });

  describe("lockETH", function () {
    it("locks msg.value, stores the swap as OPEN and emits SwapCreated", async function () {
      const swapId = defaultSwapId();
      const tx = lockETH();

      await expect(tx)
        .to.emit(htlc, "SwapCreated")
        .withArgs(swapId, sender.address, receiver.address, ZERO_ADDRESS, amount, hashlock, timelock);
      await expect(tx).to.changeEtherBalance(htlc, amount);
      await expect(tx).to.changeEtherBalance(sender, -amount);

      const swap = await htlc.getSwap(swapId);
      expect(swap.swapId).to.equal(swapId);
      expect(swap.sender).to.equal(sender.address);
      expect(swap.receiver).to.equal(receiver.address);
      expect(swap.tokenContract).to.equal(ZERO_ADDRESS); // native-value marker
      expect(swap.amount).to.equal(amount); // amount is always msg.value
      expect(swap.hashlock).to.equal(hashlock);
      expect(swap.timelock).to.equal(timelock);
      expect(swap.status).to.equal(SwapStatus.OPEN);
    });

    it("returns the swap id that an off-chain client computes", async function () {
      const expected = defaultSwapId();
      const returned = await htlc
        .connect(sender)
        .lockETH.staticCall(receiver.address, hashlock, timelock, { value: amount });
      expect(returned).to.equal(expected);
    });

    it("lets the same secret fund independent swaps for different receivers", async function () {
      await lockETH();
      await lockETH(sender, { receiver: stranger.address });

      const first = defaultSwapId();
      const second = defaultSwapId({ receiver: stranger.address });
      expect(first).to.not.equal(second);
      expect((await htlc.getSwap(first)).status).to.equal(SwapStatus.OPEN);
      expect((await htlc.getSwap(second)).status).to.equal(SwapStatus.OPEN);
      expect(await ethers.provider.getBalance(htlc.target)).to.equal(amount * 2n);
    });

    it("reverts with InvalidZeroAmount when no native value is attached", async function () {
      await expect(lockETH(sender, { value: 0n })).to.be.revertedWithCustomError(htlc, "InvalidZeroAmount");
      expect(await ethers.provider.getBalance(htlc.target)).to.equal(0n);
    });

    it("reverts with InvalidZeroAddress for a zero receiver", async function () {
      await expect(lockETH(sender, { receiver: ZERO_ADDRESS })).to.be.revertedWithCustomError(
        htlc,
        "InvalidZeroAddress"
      );
    });

    it("reverts with InvalidTimelock for a current or past timelock", async function () {
      const now = BigInt(await time.latest());
      await expect(lockETH(sender, { timelock: now })).to.be.revertedWithCustomError(htlc, "InvalidTimelock");
      await expect(lockETH(sender, { timelock: now - 1n })).to.be.revertedWithCustomError(htlc, "InvalidTimelock");
    });

    it("reverts with InvalidPreimage for a zero hashlock", async function () {
      await expect(lockETH(sender, { hashlock: ZERO_HASH })).to.be.revertedWithCustomError(htlc, "InvalidPreimage");
    });

    it("reverts with SwapAlreadyExists before taking any ETH when the parameters repeat", async function () {
      await lockETH();
      await expect(lockETH()).to.be.revertedWithCustomError(htlc, "SwapAlreadyExists");

      // the failed attempt moved nothing: the first lock is still the only ETH in the contract
      expect(await ethers.provider.getBalance(htlc.target)).to.equal(amount);
    });

    it("rejects plain ETH sent to the contract without calldata (no receive/fallback)", async function () {
      await expect(sender.sendTransaction({ to: htlc.target, value: 1n })).to.be.reverted;
      expect(await ethers.provider.getBalance(htlc.target)).to.equal(0n);
    });
  });

  describe("claimETH", function () {
    it("releases the ETH to the receiver and emits SwapClaimed with the preimage", async function () {
      const swapId = defaultSwapId();
      await lockETH();

      const tx = htlc.connect(receiver).claimETH(swapId, preimage);
      await expect(tx).to.emit(htlc, "SwapClaimed").withArgs(swapId, receiver.address, preimage);
      await expect(tx).to.changeEtherBalance(receiver, amount);
      await expect(tx).to.changeEtherBalance(htlc, -amount);

      expect((await htlc.getSwap(swapId)).status).to.equal(SwapStatus.CLAIMED);
      expect(await ethers.provider.getBalance(htlc.target)).to.equal(0n);
    });

    it("reverts with InvalidPreimage for the wrong preimage and leaves the swap OPEN and funded", async function () {
      const swapId = defaultSwapId();
      await lockETH();

      await expect(
        htlc.connect(receiver).claimETH(swapId, ethers.id("wrong-preimage"))
      ).to.be.revertedWithCustomError(htlc, "InvalidPreimage");

      expect((await htlc.getSwap(swapId)).status).to.equal(SwapStatus.OPEN);
      expect(await ethers.provider.getBalance(htlc.target)).to.equal(amount);
    });

    it("reverts with UnauthorizedReceiver for the sender or a third party", async function () {
      const swapId = defaultSwapId();
      await lockETH();

      await expect(htlc.connect(sender).claimETH(swapId, preimage)).to.be.revertedWithCustomError(
        htlc,
        "UnauthorizedReceiver"
      );
      await expect(htlc.connect(stranger).claimETH(swapId, preimage)).to.be.revertedWithCustomError(
        htlc,
        "UnauthorizedReceiver"
      );
    });

    it("reverts with TimelockExpired once the deadline has passed", async function () {
      const shortTimelock = await futureTimelock(60);
      await lockETH(sender, { timelock: shortTimelock });
      const swapId = defaultSwapId({ timelock: shortTimelock });

      await time.increase(60);
      await expect(htlc.connect(receiver).claimETH(swapId, preimage)).to.be.revertedWithCustomError(
        htlc,
        "TimelockExpired"
      );
    });

    it("reverts with SwapNotOpen when claimed twice", async function () {
      const swapId = defaultSwapId();
      await lockETH();
      await htlc.connect(receiver).claimETH(swapId, preimage);

      await expect(htlc.connect(receiver).claimETH(swapId, preimage)).to.be.revertedWithCustomError(
        htlc,
        "SwapNotOpen"
      );
    });

    it("reverts with SwapNotOpen when the swap was already refunded", async function () {
      const shortTimelock = await futureTimelock(60);
      await lockETH(sender, { timelock: shortTimelock });
      const swapId = defaultSwapId({ timelock: shortTimelock });

      await time.increase(60);
      await htlc.refundETH(swapId);

      await expect(htlc.connect(receiver).claimETH(swapId, preimage)).to.be.revertedWithCustomError(
        htlc,
        "SwapNotOpen"
      );
    });

    it("reverts with SwapDoesNotExist for an unknown id", async function () {
      await expect(htlc.connect(receiver).claimETH(defaultSwapId(), preimage)).to.be.revertedWithCustomError(
        htlc,
        "SwapDoesNotExist"
      );
    });
  });

  describe("refundETH", function () {
    it("reverts with TimelockNotExpired before the deadline", async function () {
      const swapId = defaultSwapId();
      await lockETH();

      await expect(htlc.refundETH(swapId)).to.be.revertedWithCustomError(htlc, "TimelockNotExpired");
      expect((await htlc.getSwap(swapId)).status).to.equal(SwapStatus.OPEN);
    });

    it("reverts with UnauthorizedSender for the receiver or a third party", async function () {
      const shortTimelock = await futureTimelock(60);
      await lockETH(sender, { timelock: shortTimelock });
      const swapId = defaultSwapId({ timelock: shortTimelock });
      await time.increase(60);

      await expect(htlc.connect(receiver).refundETH(swapId)).to.be.revertedWithCustomError(
        htlc,
        "UnauthorizedSender"
      );
      await expect(htlc.connect(stranger).refundETH(swapId)).to.be.revertedWithCustomError(
        htlc,
        "UnauthorizedSender"
      );
    });

    it("returns the ETH to the sender after the deadline and emits SwapRefunded", async function () {
      const shortTimelock = await futureTimelock(60);
      await lockETH(sender, { timelock: shortTimelock });
      const swapId = defaultSwapId({ timelock: shortTimelock });

      await time.increase(60);

      const tx = htlc.refundETH(swapId);
      await expect(tx).to.emit(htlc, "SwapRefunded").withArgs(swapId, sender.address);
      await expect(tx).to.changeEtherBalance(sender, amount);
      await expect(tx).to.changeEtherBalance(htlc, -amount);

      expect((await htlc.getSwap(swapId)).status).to.equal(SwapStatus.REFUNDED);
      expect(await ethers.provider.getBalance(htlc.target)).to.equal(0n);
    });

    it("reverts with SwapNotOpen when the swap was already claimed", async function () {
      const swapId = defaultSwapId();
      await lockETH();
      await htlc.connect(receiver).claimETH(swapId, preimage);

      await expect(htlc.refundETH(swapId)).to.be.revertedWithCustomError(htlc, "SwapNotOpen");
    });

    it("reverts with SwapDoesNotExist for an unknown id", async function () {
      await expect(htlc.refundETH(defaultSwapId())).to.be.revertedWithCustomError(htlc, "SwapDoesNotExist");
    });
  });

  describe("IHTLC surface (createSwap / claimSwap / refundSwap)", function () {
    it("createSwap locks msg.value and emits the same SwapCreated as lockETH", async function () {
      const swapId = defaultSwapId();
      // the `amount` argument is ignored on purpose: the leg always locks msg.value
      const tx = htlc
        .connect(sender)
        .createSwap(receiver.address, ZERO_ADDRESS, 12345n, hashlock, timelock, { value: amount });

      await expect(tx)
        .to.emit(htlc, "SwapCreated")
        .withArgs(swapId, sender.address, receiver.address, ZERO_ADDRESS, amount, hashlock, timelock);

      const swap = await htlc.getSwap(swapId);
      expect(swap.status).to.equal(SwapStatus.OPEN);
      expect(swap.amount).to.equal(amount);
      expect(await ethers.provider.getBalance(htlc.target)).to.equal(amount);
    });

    it("createSwap reverts with InvalidZeroAmount when no native value is attached", async function () {
      await expect(
        htlc.connect(sender).createSwap(receiver.address, ZERO_ADDRESS, amount, hashlock, timelock)
      ).to.be.revertedWithCustomError(htlc, "InvalidZeroAmount");
    });

    it("createSwap reverts with InvalidTokenContract for a non-zero token address", async function () {
      const MockMST = await ethers.getContractFactory("MockMST");
      const mst = await MockMST.deploy();

      await expect(
        htlc.connect(sender).createSwap(receiver.address, mst.target, amount, hashlock, timelock, { value: amount })
      ).to.be.revertedWithCustomError(htlc, "InvalidTokenContract");
    });

    it("claimSwap and refundSwap delegate to the ETH implementation", async function () {
      await lockETH();
      const claimedId = defaultSwapId();
      await expect(htlc.connect(receiver).claimSwap(claimedId, preimage)).to.emit(htlc, "SwapClaimed");
      expect((await htlc.getSwap(claimedId)).status).to.equal(SwapStatus.CLAIMED);

      const shortTimelock = await futureTimelock(60);
      await lockETH(sender, { timelock: shortTimelock });
      const refundedId = defaultSwapId({ timelock: shortTimelock });
      await time.increase(60);
      await expect(htlc.refundSwap(refundedId)).to.emit(htlc, "SwapRefunded");
      expect((await htlc.getSwap(refundedId)).status).to.equal(SwapStatus.REFUNDED);

      expect(await ethers.provider.getBalance(htlc.target)).to.equal(0n);
    });

    it("never strands ETH: the contract balance always equals the sum of the OPEN swaps", async function () {
      await lockETH();
      await lockETH(sender, { receiver: stranger.address });
      expect(await ethers.provider.getBalance(htlc.target)).to.equal(amount * 2n);

      await htlc.connect(receiver).claimETH(defaultSwapId(), preimage);
      expect(await ethers.provider.getBalance(htlc.target)).to.equal(amount);

      await htlc.connect(stranger).claimETH(defaultSwapId({ receiver: stranger.address }), preimage);
      expect(await ethers.provider.getBalance(htlc.target)).to.equal(0n);
    });
  });

  describe("payout safety and re-entrancy", function () {
    it("leaves the swap OPEN and funded when the receiver refuses the ETH", async function () {
      const Rejector = await ethers.getContractFactory("RejectingReceiver");
      const rejector = await Rejector.deploy();

      const swapId = computeSwapId({ sender: sender.address, receiver: rejector.target, amount, hashlock, timelock });
      await htlc.connect(sender).lockETH(rejector.target, hashlock, timelock, { value: amount });

      await expect(rejector.connect(stranger).claim(htlc.target, swapId, preimage)).to.be.revertedWithCustomError(
        htlc,
        "TransferFailed"
      );

      // the failed payout reverted the whole transaction: never CLAIMED without the funds moving
      expect((await htlc.getSwap(swapId)).status).to.equal(SwapStatus.OPEN);
      expect(await ethers.provider.getBalance(htlc.target)).to.equal(amount);
    });

    it("blocks a receiver that re-enters claimETH during the payout", async function () {
      const Reentering = await ethers.getContractFactory("ReenteringReceiver");
      const attacker = await Reentering.deploy();

      const swapId = computeSwapId({ sender: sender.address, receiver: attacker.target, amount, hashlock, timelock });
      await htlc.connect(sender).lockETH(attacker.target, hashlock, timelock, { value: amount });

      // recorder mode: the inner revert is captured instead of bubbling, so the test can inspect it
      await attacker.configure(htlc.target, htlc.interface.encodeFunctionData("claimETH", [swapId, preimage]), false);

      await attacker.claim(htlc.target, swapId, preimage);

      expect(await attacker.attackAttempted()).to.equal(true);
      expect(await attacker.attackSucceeded()).to.equal(false);
      // exactly the nonReentrant guard stopped it, not some unrelated failure
      expect(await attacker.attackRevertData()).to.equal(htlc.interface.getError("ReentrancyDetected").selector);

      // the outer claim still completed exactly once
      expect((await htlc.getSwap(swapId)).status).to.equal(SwapStatus.CLAIMED);
      expect(await ethers.provider.getBalance(htlc.target)).to.equal(0n);
    });

    it("keeps the swap OPEN when the blocked re-entrant attempt is allowed to bubble", async function () {
      const Reentering = await ethers.getContractFactory("ReenteringReceiver");
      const attacker = await Reentering.deploy();

      const swapId = computeSwapId({ sender: sender.address, receiver: attacker.target, amount, hashlock, timelock });
      await htlc.connect(sender).lockETH(attacker.target, hashlock, timelock, { value: amount });

      await attacker.configure(htlc.target, htlc.interface.encodeFunctionData("claimETH", [swapId, preimage]), true);

      await expect(attacker.claim(htlc.target, swapId, preimage)).to.be.revertedWithCustomError(
        htlc,
        "TransferFailed"
      );
      expect((await htlc.getSwap(swapId)).status).to.equal(SwapStatus.OPEN);
      expect(await ethers.provider.getBalance(htlc.target)).to.equal(amount);
    });
  });

  describe("re-entrancy protection on every ETH entry point", function () {
    /** Deploys the re-entering mock as the swap RECEIVER and funds one swap for it. */
    async function setUpReceiverAttack() {
      const Reentering = await ethers.getContractFactory("ReenteringReceiver");
      const attacker = await Reentering.deploy();

      const swapId = computeSwapId({ sender: sender.address, receiver: attacker.target, amount, hashlock, timelock });
      await htlc.connect(sender).lockETH(attacker.target, hashlock, timelock, { value: amount });

      return { attacker, swapId };
    }

    /** Deploys the re-entering mock as the swap SENDER (short timelock) so that a refund pays it. */
    async function setUpSenderAttack() {
      const Reentering = await ethers.getContractFactory("ReenteringReceiver");
      const attacker = await Reentering.deploy();

      const shortTimelock = await futureTimelock(60);
      const swapId = computeSwapId({
        sender: attacker.target,
        receiver: receiver.address,
        amount,
        hashlock,
        timelock: shortTimelock,
      });
      await attacker.lock(htlc.target, receiver.address, hashlock, shortTimelock, { value: amount });
      await time.increase(60);

      return { attacker, swapId };
    }

    /** Asserts that the mock's re-entrant call was refused by the nonReentrant guard itself. */
    async function expectBlockedByGuard(attacker) {
      expect(await attacker.attackAttempted()).to.equal(true);
      expect(await attacker.attackSucceeded()).to.equal(false);
      expect(await attacker.attackRevertData()).to.equal(htlc.interface.getError("ReentrancyDetected").selector);
    }

    it("blocks a receiver re-entering lockETH during the payout", async function () {
      const { attacker, swapId } = await setUpReceiverAttack();
      await attacker.configure(
        htlc.target,
        htlc.interface.encodeFunctionData("lockETH", [stranger.address, hashlock, timelock]),
        false
      );

      await attacker.claim(htlc.target, swapId, preimage);

      await expectBlockedByGuard(attacker);
      expect((await htlc.getSwap(swapId)).status).to.equal(SwapStatus.CLAIMED);
    });

    it("blocks a receiver re-entering createSwap during the payout", async function () {
      const { attacker, swapId } = await setUpReceiverAttack();
      await attacker.configure(
        htlc.target,
        htlc.interface.encodeFunctionData("createSwap", [stranger.address, ZERO_ADDRESS, 0n, hashlock, timelock]),
        false
      );

      await attacker.claim(htlc.target, swapId, preimage);

      await expectBlockedByGuard(attacker);
      expect((await htlc.getSwap(swapId)).status).to.equal(SwapStatus.CLAIMED);
    });

    it("blocks a receiver re-entering claimSwap during the payout", async function () {
      const { attacker, swapId } = await setUpReceiverAttack();
      await attacker.configure(
        htlc.target,
        htlc.interface.encodeFunctionData("claimSwap", [swapId, preimage]),
        false
      );

      await attacker.claim(htlc.target, swapId, preimage);

      await expectBlockedByGuard(attacker);
      expect((await htlc.getSwap(swapId)).status).to.equal(SwapStatus.CLAIMED);
    });

    it("blocks a sender re-entering refundETH during the refund payout", async function () {
      const { attacker, swapId } = await setUpSenderAttack();
      await attacker.configure(htlc.target, htlc.interface.encodeFunctionData("refundETH", [swapId]), false);

      await attacker.refund(htlc.target, swapId); // the mock is the swap sender, so it must refund itself

      await expectBlockedByGuard(attacker);
      expect((await htlc.getSwap(swapId)).status).to.equal(SwapStatus.REFUNDED);
      expect(await ethers.provider.getBalance(htlc.target)).to.equal(0n);
    });

    it("blocks a sender re-entering refundSwap during the refund payout", async function () {
      const { attacker, swapId } = await setUpSenderAttack();
      await attacker.configure(htlc.target, htlc.interface.encodeFunctionData("refundSwap", [swapId]), false);

      await attacker.refund(htlc.target, swapId);

      await expectBlockedByGuard(attacker);
      expect((await htlc.getSwap(swapId)).status).to.equal(SwapStatus.REFUNDED);
      expect(await ethers.provider.getBalance(htlc.target)).to.equal(0n);
    });
  });

  describe("cross-leg protocol parity (one hashlock, two independent chains)", function () {
    /** Deploys the MST leg and funds Alice with MST. Returns { mst, mstLeg, mstAmount }. */
    async function deployMstLeg() {
      const MockMST = await ethers.getContractFactory("MockMST");
      const mst = await MockMST.deploy();
      const ERC20HTLC = await ethers.getContractFactory("ERC20HTLC");
      const mstLeg = await ERC20HTLC.deploy(mst.target);

      const mstAmount = ethers.parseEther("100");
      await mst.mint(sender.address, mstAmount);
      await mst.connect(sender).approve(mstLeg.target, mstAmount);

      return { mst, mstLeg, mstAmount };
    }

    it("settles both legs with the same preimage (the ETH claim reveals it to the MST receiver)", async function () {
      const { mst, mstLeg, mstAmount } = await deployMstLeg();

      // Alice (sender) escrows MST for Bob (receiver); Bob escrows ETH for Alice.
      // The ETH leg is claimed first, so it must expire first.
      const mstTimelock = await futureTimelock(3600);
      const ethTimelock = await futureTimelock(1800);
      const mstSwapId = computeMstLegSwapId({
        sender: sender.address,
        receiver: receiver.address,
        hashlock,
        timelock: mstTimelock,
      });
      const ethSwapId = computeSwapId({
        sender: receiver.address,
        receiver: sender.address,
        amount,
        hashlock,
        timelock: ethTimelock,
      });

      await mstLeg.connect(sender).lockMST(receiver.address, mstAmount, hashlock, mstTimelock);
      await htlc.connect(receiver).lockETH(sender.address, hashlock, ethTimelock, { value: amount });

      // 1. Alice claims the ETH leg: the preimage becomes public on Arbitrum Sepolia
      await expect(htlc.connect(sender).claimETH(ethSwapId, preimage)).to.emit(htlc, "SwapClaimed");
      expect((await htlc.getSwap(ethSwapId)).status).to.equal(SwapStatus.CLAIMED);

      // 2. Bob settles the MST leg with the preimage he just learned (same hashlock, different id)
      await expect(mstLeg.connect(receiver).claimMST(mstSwapId, preimage)).to.emit(mstLeg, "SwapClaimed");
      expect((await mstLeg.getSwap(mstSwapId)).status).to.equal(SwapStatus.CLAIMED);

      expect(await ethers.provider.getBalance(htlc.target)).to.equal(0n);
      expect(await mst.balanceOf(mstLeg.target)).to.equal(0n);
      expect(await mst.balanceOf(receiver.address)).to.equal(mstAmount);
    });

    it("derives different on-chain ids for the same logical swap (legs are matched by hashlock, not id)", async function () {
      const sharedTimelock = await futureTimelock(3600);

      const mstId = computeMstLegSwapId({
        sender: sender.address,
        receiver: receiver.address,
        hashlock,
        timelock: sharedTimelock,
      });
      const ethId = computeSwapId({
        sender: receiver.address,
        receiver: sender.address,
        amount,
        hashlock,
        timelock: sharedTimelock,
      });

      // even with identical parties/secret/deadline the two derivations differ, because the native leg
      // also commits to tokenContract and amount. Cross-chain correlation must therefore use the
      // hashlock + crossed parties + timelock ordering (see scripts/lib/swapId.js).
      expect(mstId).to.not.equal(ethId);
      expect(mstId).to.equal(
        ethers.solidityPackedKeccak256(
          ["address", "address", "bytes32", "uint256"],
          [sender.address, receiver.address, hashlock, sharedTimelock]
        )
      );
    });

    it("refunds the shorter ETH leg first while the MST leg keeps its longer window", async function () {
      const { mst, mstLeg, mstAmount } = await deployMstLeg();

      const ethTimelock = await futureTimelock(60);
      const mstTimelock = await futureTimelock(3600);
      const mstSwapId = computeMstLegSwapId({
        sender: sender.address,
        receiver: receiver.address,
        hashlock,
        timelock: mstTimelock,
      });
      const ethSwapId = computeSwapId({
        sender: receiver.address,
        receiver: sender.address,
        amount,
        hashlock,
        timelock: ethTimelock,
      });

      await mstLeg.connect(sender).lockMST(receiver.address, mstAmount, hashlock, mstTimelock);
      await htlc.connect(receiver).lockETH(sender.address, hashlock, ethTimelock, { value: amount });

      await time.increase(60);

      // the ETH claim window is closed: only the refund path is left
      await expect(htlc.connect(sender).claimETH(ethSwapId, preimage)).to.be.revertedWithCustomError(
        htlc,
        "TimelockExpired"
      );
      await expect(htlc.connect(receiver).refundETH(ethSwapId)).to.emit(htlc, "SwapRefunded");
      expect(await ethers.provider.getBalance(htlc.target)).to.equal(0n);

      // the MST leg is untouched and its deadline deliberately comes later, so Alice can still refund it
      expect((await mstLeg.getSwap(mstSwapId)).status).to.equal(SwapStatus.OPEN);
      await expect(mstLeg.connect(sender).refundMST(mstSwapId)).to.be.revertedWithCustomError(
        mstLeg,
        "TimelockNotExpired"
      );

      await time.increase(3600);
      await expect(mstLeg.connect(sender).refundMST(mstSwapId)).to.emit(mstLeg, "SwapRefunded");
      expect((await mstLeg.getSwap(mstSwapId)).status).to.equal(SwapStatus.REFUNDED);
      expect(await mst.balanceOf(sender.address)).to.equal(mstAmount);
      expect(await mst.balanceOf(mstLeg.target)).to.equal(0n);
    });
  });
});
