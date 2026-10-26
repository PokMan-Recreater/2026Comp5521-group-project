const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const ZERO_ADDRESS = ethers.ZeroAddress;

// Numeric values of IHTLC.SwapStatus (same ABI order as the shared interface).
const SwapStatus = { EMPTY: 0n, OPEN: 1n, CLAIMED: 2n, REFUNDED: 3n };

/** Off-chain mirror of HTLCBase.generateSwapId(sender, receiver, hashlock, timelock). */
function computeSwapId({ sender, receiver, hashlock, timelock }) {
  return ethers.solidityPackedKeccak256(
    ["address", "address", "bytes32", "uint256"],
    [sender, receiver, hashlock, timelock]
  );
}

/** Off-chain mirror of HTLCBase.hashPreimage. */
function computeHashlock(preimage) {
  return ethers.solidityPackedKeccak256(["bytes32"], [preimage]);
}

describe("ERC20HTLC - MST locking leg (Ethereum Sepolia)", function () {
  const TOTAL_SUPPLY = ethers.parseEther("1000000");

  let mst;
  let htlc;
  let htlcFactory;
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

  /** Deterministic id of the swap the default `lockMST` call below produces. */
  function defaultSwapId(overrides = {}) {
    return computeSwapId({ sender: sender.address, receiver: receiver.address, hashlock, timelock, ...overrides });
  }

  function lockMST(signer = sender, overrides = {}) {
    const {
      receiver: to = receiver.address,
      amount: value = amount,
      hashlock: lock = hashlock,
      timelock: deadline = timelock,
    } = overrides;
    return htlc.connect(signer).lockMST(to, value, lock, deadline);
  }

  beforeEach(async function () {
    [sender, receiver, stranger] = await ethers.getSigners();

    const MockMST = await ethers.getContractFactory("MockMST");
    mst = await MockMST.deploy();

    htlcFactory = await ethers.getContractFactory("ERC20HTLC");
    htlc = await htlcFactory.deploy(mst.target);

    await mst.mint(sender.address, TOTAL_SUPPLY);
    await mst.connect(sender).approve(htlc.target, ethers.MaxUint256);

    amount = ethers.parseEther("100");
    preimage = ethers.id("COMP5521-mst-preimage");
    hashlock = computeHashlock(preimage);
    timelock = await futureTimelock();
  });

  describe("constructor / MST configuration", function () {
    it("stores the MST token in an immutable public field", async function () {
      expect(await htlc.mstToken()).to.equal(mst.target);
    });

    it("reverts with InvalidZeroAddress for a zero token address", async function () {
      await expect(htlcFactory.deploy(ZERO_ADDRESS)).to.be.revertedWithCustomError(htlcFactory, "InvalidZeroAddress");
    });

    it("reverts with InvalidTokenContract when the token address has no code", async function () {
      await expect(htlcFactory.deploy(stranger.address)).to.be.revertedWithCustomError(
        htlcFactory,
        "InvalidTokenContract"
      );
    });

    it("rejects native value sent directly to the contract", async function () {
      await expect(sender.sendTransaction({ to: htlc.target, value: 1n })).to.be.reverted;
    });
  });

  describe("lockMST", function () {
    it("locks the MST, stores the swap as OPEN and emits SwapCreated", async function () {
      const swapId = defaultSwapId();
      const tx = lockMST();

      await expect(tx)
        .to.emit(htlc, "SwapCreated")
        .withArgs(swapId, sender.address, receiver.address, mst.target, amount, hashlock, timelock);
      await expect(tx).to.changeTokenBalance(mst, htlc, amount);
      await expect(tx).to.changeTokenBalance(mst, sender, -amount);

      const swap = await htlc.getSwap(swapId);
      expect(swap.swapId).to.equal(swapId);
      expect(swap.sender).to.equal(sender.address);
      expect(swap.receiver).to.equal(receiver.address);
      expect(swap.tokenContract).to.equal(mst.target);
      expect(swap.amount).to.equal(amount);
      expect(swap.hashlock).to.equal(hashlock);
      expect(swap.timelock).to.equal(timelock);
      expect(swap.status).to.equal(SwapStatus.OPEN);
    });

    it("returns the swap id that an off-chain client computes", async function () {
      const expected = defaultSwapId();
      const returned = await htlc.connect(sender).lockMST.staticCall(receiver.address, amount, hashlock, timelock);
      expect(returned).to.equal(expected);
    });

    it("lets the same secret fund independent swaps for different receivers", async function () {
      await lockMST();
      await lockMST(sender, { receiver: stranger.address });

      const first = defaultSwapId();
      const second = defaultSwapId({ receiver: stranger.address });
      expect(first).to.not.equal(second);
      expect((await htlc.getSwap(first)).status).to.equal(SwapStatus.OPEN);
      expect((await htlc.getSwap(second)).status).to.equal(SwapStatus.OPEN);
      expect(await mst.balanceOf(htlc.target)).to.equal(amount * 2n);
    });

    it("reverts with InvalidZeroAddress for a zero receiver", async function () {
      await expect(lockMST(sender, { receiver: ZERO_ADDRESS })).to.be.revertedWithCustomError(
        htlc,
        "InvalidZeroAddress"
      );
    });

    it("reverts with InvalidZeroAmount for a zero amount", async function () {
      await expect(lockMST(sender, { amount: 0n })).to.be.revertedWithCustomError(htlc, "InvalidZeroAmount");
    });

    it("reverts with InvalidTimelock for a current or past timelock", async function () {
      const now = BigInt(await time.latest());
      await expect(lockMST(sender, { timelock: now })).to.be.revertedWithCustomError(htlc, "InvalidTimelock");
      await expect(lockMST(sender, { timelock: now - 1n })).to.be.revertedWithCustomError(htlc, "InvalidTimelock");
    });

    it("reverts with InvalidPreimage for a zero hashlock", async function () {
      await expect(lockMST(sender, { hashlock: ethers.ZeroHash })).to.be.revertedWithCustomError(
        htlc,
        "InvalidPreimage"
      );
    });
  });

  describe("lockMST token interaction", function () {
    it("reverts with SwapAlreadyExists before moving any MST when the parameters repeat", async function () {
      await lockMST();
      await expect(lockMST()).to.be.revertedWithCustomError(htlc, "SwapAlreadyExists");

      // the failed attempt moved nothing: the first lock is still the only MST in the contract
      expect(await mst.balanceOf(htlc.target)).to.equal(amount);
    });

    it("bubbles the token's revert when the allowance is missing", async function () {
      await expect(lockMST(stranger)).to.be.revertedWithCustomError(mst, "ERC20InsufficientAllowance");
    });

    it("bubbles the token's revert when the balance is insufficient", async function () {
      await expect(lockMST(sender, { amount: TOTAL_SUPPLY + 1n })).to.be.revertedWithCustomError(
        mst,
        "ERC20InsufficientBalance"
      );
    });

    it("reverts with TransferFailed when the token returns false instead of reverting", async function () {
      const FalseToken = await ethers.getContractFactory("FalseReturningERC20");
      const falseToken = await FalseToken.deploy();
      const falseHtlc = await htlcFactory.deploy(falseToken.target);

      await expect(
        falseHtlc.connect(sender).lockMST(receiver.address, amount, hashlock, timelock)
      ).to.be.revertedWithCustomError(falseHtlc, "TransferFailed");
    });

    it("keeps the swap OPEN when the token returns false on the payout", async function () {
      const FalseToken = await ethers.getContractFactory("FalseReturningERC20");
      const falseToken = await FalseToken.deploy();
      const falseHtlc = await htlcFactory.deploy(falseToken.target);

      await falseToken.mint(sender.address, amount);
      await falseToken.connect(sender).approve(falseHtlc.target, amount);
      await falseToken.setFailTransferFrom(false); // the lock works and really moves the tokens

      const swapId = defaultSwapId();
      await falseHtlc.connect(sender).lockMST(receiver.address, amount, hashlock, timelock);
      expect(await falseToken.balanceOf(falseHtlc.target)).to.equal(amount);

      await falseToken.setFailTransfer(true); // now the payout reports failure
      await expect(falseHtlc.connect(receiver).claimMST(swapId, preimage)).to.be.revertedWithCustomError(
        falseHtlc,
        "TransferFailed"
      );

      // the failed payout reverted the whole transaction: the swap is still OPEN and funded
      expect((await falseHtlc.getSwap(swapId)).status).to.equal(SwapStatus.OPEN);
      expect(await falseToken.balanceOf(falseHtlc.target)).to.equal(amount);
    });

    it("blocks a re-entrant token during transferFrom", async function () {
      const Reentrant = await ethers.getContractFactory("ReentrantERC20");
      const reentrantToken = await Reentrant.deploy();
      const reentrantHtlc = await htlcFactory.deploy(reentrantToken.target);

      await reentrantToken.mint(sender.address, amount);
      await reentrantToken.connect(sender).approve(reentrantHtlc.target, amount);

      const deadline = await futureTimelock();
      const reentryData = reentrantHtlc.interface.encodeFunctionData("lockMST", [
        receiver.address,
        amount,
        hashlock,
        deadline,
      ]);
      await reentrantToken.setAttack(reentrantHtlc.target, reentryData);

      await expect(
        reentrantHtlc.connect(sender).lockMST(receiver.address, amount, hashlock, deadline)
      ).to.be.revertedWithCustomError(reentrantHtlc, "ReentrancyDetected");
    });
  });

  describe("claimMST", function () {
    it("releases the MST to the receiver and emits SwapClaimed", async function () {
      const swapId = defaultSwapId();
      await lockMST();

      const tx = htlc.connect(receiver).claimMST(swapId, preimage);
      await expect(tx).to.emit(htlc, "SwapClaimed").withArgs(swapId, receiver.address, preimage);
      await expect(tx).to.changeTokenBalance(mst, receiver, amount);
      await expect(tx).to.changeTokenBalance(mst, htlc, -amount);

      expect((await htlc.getSwap(swapId)).status).to.equal(SwapStatus.CLAIMED);
      expect(await mst.balanceOf(htlc.target)).to.equal(0n);
    });

    it("reverts with InvalidPreimage for the wrong preimage and keeps the swap OPEN", async function () {
      const swapId = defaultSwapId();
      await lockMST();

      await expect(htlc.connect(receiver).claimMST(swapId, ethers.id("wrong-preimage"))).to.be.revertedWithCustomError(
        htlc,
        "InvalidPreimage"
      );
      expect((await htlc.getSwap(swapId)).status).to.equal(SwapStatus.OPEN);
      expect(await mst.balanceOf(htlc.target)).to.equal(amount);
    });

    it("reverts with UnauthorizedReceiver for the sender or a third party", async function () {
      const swapId = defaultSwapId();
      await lockMST();

      await expect(htlc.connect(sender).claimMST(swapId, preimage)).to.be.revertedWithCustomError(
        htlc,
        "UnauthorizedReceiver"
      );
      await expect(htlc.connect(stranger).claimMST(swapId, preimage)).to.be.revertedWithCustomError(
        htlc,
        "UnauthorizedReceiver"
      );
    });

    it("reverts with TimelockExpired once the deadline has passed", async function () {
      const shortTimelock = await futureTimelock(60);
      await lockMST(sender, { timelock: shortTimelock });
      const swapId = defaultSwapId({ timelock: shortTimelock });

      await time.increase(60);
      await expect(htlc.connect(receiver).claimMST(swapId, preimage)).to.be.revertedWithCustomError(
        htlc,
        "TimelockExpired"
      );
    });

    it("reverts with SwapNotOpen when claimed twice", async function () {
      const swapId = defaultSwapId();
      await lockMST();
      await htlc.connect(receiver).claimMST(swapId, preimage);

      await expect(htlc.connect(receiver).claimMST(swapId, preimage)).to.be.revertedWithCustomError(
        htlc,
        "SwapNotOpen"
      );
    });

    it("reverts with SwapDoesNotExist for an unknown id", async function () {
      await expect(htlc.connect(receiver).claimMST(defaultSwapId(), preimage)).to.be.revertedWithCustomError(
        htlc,
        "SwapDoesNotExist"
      );
    });
  });

  describe("refundMST", function () {
    it("reverts with TimelockNotExpired before the deadline", async function () {
      const swapId = defaultSwapId();
      await lockMST();

      await expect(htlc.refundMST(swapId)).to.be.revertedWithCustomError(htlc, "TimelockNotExpired");
      expect((await htlc.getSwap(swapId)).status).to.equal(SwapStatus.OPEN);
    });

    it("reverts with UnauthorizedSender for the receiver or a third party", async function () {
      const shortTimelock = await futureTimelock(60);
      await lockMST(sender, { timelock: shortTimelock });
      const swapId = defaultSwapId({ timelock: shortTimelock });
      await time.increase(60);

      await expect(htlc.connect(receiver).refundMST(swapId)).to.be.revertedWithCustomError(
        htlc,
        "UnauthorizedSender"
      );
      await expect(htlc.connect(stranger).refundMST(swapId)).to.be.revertedWithCustomError(
        htlc,
        "UnauthorizedSender"
      );
    });

    it("returns the MST to the sender after the deadline and emits SwapRefunded", async function () {
      const shortTimelock = await futureTimelock(60);
      await lockMST(sender, { timelock: shortTimelock });
      const swapId = defaultSwapId({ timelock: shortTimelock });

      await time.increase(60);

      const tx = htlc.refundMST(swapId);
      await expect(tx).to.emit(htlc, "SwapRefunded").withArgs(swapId, sender.address);
      await expect(tx).to.changeTokenBalance(mst, sender, amount);
      await expect(tx).to.changeTokenBalance(mst, htlc, -amount);

      expect((await htlc.getSwap(swapId)).status).to.equal(SwapStatus.REFUNDED);
      expect(await mst.balanceOf(htlc.target)).to.equal(0n);
    });

    it("reverts with SwapNotOpen when the swap was already claimed", async function () {
      const swapId = defaultSwapId();
      await lockMST();
      await htlc.connect(receiver).claimMST(swapId, preimage);

      await expect(htlc.refundMST(swapId)).to.be.revertedWithCustomError(htlc, "SwapNotOpen");
    });

    it("reverts with SwapDoesNotExist for an unknown id", async function () {
      await expect(htlc.refundMST(defaultSwapId())).to.be.revertedWithCustomError(htlc, "SwapDoesNotExist");
    });
  });

  describe("IHTLC-compatible surface (createSwap / claimSwap / refundSwap)", function () {
    it("createSwap locks the configured MST and emits the same SwapCreated as lockMST", async function () {
      const swapId = defaultSwapId();
      const tx = htlc.connect(sender).createSwap(receiver.address, mst.target, amount, hashlock, timelock);

      await expect(tx)
        .to.emit(htlc, "SwapCreated")
        .withArgs(swapId, sender.address, receiver.address, mst.target, amount, hashlock, timelock);

      expect((await htlc.getSwap(swapId)).status).to.equal(SwapStatus.OPEN);
      expect(await mst.balanceOf(htlc.target)).to.equal(amount);
    });

    it("createSwap reverts with NativeValueNotAllowed when native value is attached", async function () {
      await expect(
        htlc.connect(sender).createSwap(receiver.address, mst.target, amount, hashlock, timelock, { value: 1n })
      ).to.be.revertedWithCustomError(htlc, "NativeValueNotAllowed");
    });

    it("createSwap reverts with InvalidTokenContract for a token other than MST", async function () {
      await expect(
        htlc.connect(sender).createSwap(receiver.address, stranger.address, amount, hashlock, timelock)
      ).to.be.revertedWithCustomError(htlc, "InvalidTokenContract");
    });

    it("claimSwap and refundSwap delegate to the MST implementation", async function () {
      await lockMST();
      const claimedId = defaultSwapId();
      await expect(htlc.connect(receiver).claimSwap(claimedId, preimage)).to.emit(htlc, "SwapClaimed");
      expect((await htlc.getSwap(claimedId)).status).to.equal(SwapStatus.CLAIMED);

      const shortTimelock = await futureTimelock(60);
      await lockMST(sender, { timelock: shortTimelock });
      const refundedId = defaultSwapId({ timelock: shortTimelock });
      await time.increase(60);
      await expect(htlc.refundSwap(refundedId)).to.emit(htlc, "SwapRefunded");
      expect((await htlc.getSwap(refundedId)).status).to.equal(SwapStatus.REFUNDED);

      expect(await mst.balanceOf(htlc.target)).to.equal(0n);
    });

    it("never strands MST: the contract balance always equals the sum of the OPEN swaps", async function () {
      await lockMST();
      await lockMST(sender, { receiver: stranger.address });
      expect(await mst.balanceOf(htlc.target)).to.equal(amount * 2n);

      await htlc.connect(receiver).claimMST(defaultSwapId(), preimage);
      expect(await mst.balanceOf(htlc.target)).to.equal(amount);

      await htlc.connect(stranger).claimMST(defaultSwapId({ receiver: stranger.address }), preimage);
      expect(await mst.balanceOf(htlc.target)).to.equal(0n);
    });
  });

  describe("re-entrancy protection on every entry point", function () {
    /** Deploys a leg whose token can call back into the HTLC, and funds one swap on it. */
    async function setUpReentrantSwap(timelockSeconds = 3600) {
      const Reentrant = await ethers.getContractFactory("ReentrantERC20");
      const token = await Reentrant.deploy();
      const leg = await htlcFactory.deploy(token.target);

      const deadline = await futureTimelock(timelockSeconds);
      await token.mint(sender.address, amount);
      await token.connect(sender).approve(leg.target, amount);
      await leg.connect(sender).lockMST(receiver.address, amount, hashlock, deadline);

      const swapId = computeSwapId({
        sender: sender.address,
        receiver: receiver.address,
        hashlock,
        timelock: deadline,
      });
      return { token, leg, swapId };
    }

    it("blocks a token re-entering createSwap during transferFrom", async function () {
      const Reentrant = await ethers.getContractFactory("ReentrantERC20");
      const token = await Reentrant.deploy();
      const leg = await htlcFactory.deploy(token.target);

      await token.mint(sender.address, amount);
      await token.connect(sender).approve(leg.target, amount);

      const deadline = await futureTimelock();
      const reentry = leg.interface.encodeFunctionData("createSwap", [
        receiver.address,
        token.target,
        amount,
        hashlock,
        deadline,
      ]);
      await token.setAttack(leg.target, reentry);

      await expect(
        leg.connect(sender).createSwap(receiver.address, token.target, amount, hashlock, deadline)
      ).to.be.revertedWithCustomError(leg, "ReentrancyDetected");
    });

    it("blocks a token re-entering claimMST during the payout", async function () {
      const { token, leg, swapId } = await setUpReentrantSwap();
      await token.setAttack(leg.target, leg.interface.encodeFunctionData("claimMST", [swapId, preimage]));

      await expect(leg.connect(receiver).claimMST(swapId, preimage)).to.be.revertedWithCustomError(
        leg,
        "ReentrancyDetected"
      );
      // the whole transaction reverted, so no swap was marked CLAIMED and no MST left the contract
      expect((await leg.getSwap(swapId)).status).to.equal(SwapStatus.OPEN);
      expect(await token.balanceOf(leg.target)).to.equal(amount);
    });

    it("blocks a token re-entering claimSwap during the payout", async function () {
      const { token, leg, swapId } = await setUpReentrantSwap();
      await token.setAttack(leg.target, leg.interface.encodeFunctionData("claimSwap", [swapId, preimage]));

      await expect(leg.connect(receiver).claimSwap(swapId, preimage)).to.be.revertedWithCustomError(
        leg,
        "ReentrancyDetected"
      );
      expect((await leg.getSwap(swapId)).status).to.equal(SwapStatus.OPEN);
    });

    it("blocks a token re-entering refundMST during the payout", async function () {
      const { token, leg, swapId } = await setUpReentrantSwap(60);
      await time.increase(60);
      await token.setAttack(leg.target, leg.interface.encodeFunctionData("refundMST", [swapId]));

      await expect(leg.refundMST(swapId)).to.be.revertedWithCustomError(leg, "ReentrancyDetected");
      expect((await leg.getSwap(swapId)).status).to.equal(SwapStatus.OPEN);
      expect(await token.balanceOf(leg.target)).to.equal(amount);
    });

    it("blocks a token re-entering refundSwap during the payout", async function () {
      const { token, leg, swapId } = await setUpReentrantSwap(60);
      await time.increase(60);
      await token.setAttack(leg.target, leg.interface.encodeFunctionData("refundSwap", [swapId]));

      await expect(leg.refundSwap(swapId)).to.be.revertedWithCustomError(leg, "ReentrancyDetected");
      expect((await leg.getSwap(swapId)).status).to.equal(SwapStatus.OPEN);
    });
  });
});
