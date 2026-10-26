const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const ZERO_ADDRESS = ethers.ZeroAddress;
const ZERO_HASH = ethers.ZeroHash;

// Numeric values of IHTLC.SwapStatus - asserted explicitly so the ABI order cannot drift silently.
const SwapStatus = { EMPTY: 0n, OPEN: 1n, CLAIMED: 2n, REFUNDED: 3n };

// The complete error list required by the assignment brief.
const REQUIRED_ERRORS = [
  "SwapAlreadyExists",
  "SwapDoesNotExist",
  "SwapNotOpen",
  "InvalidZeroAddress",
  "InvalidZeroAmount",
  "InvalidTimelock",
  "UnauthorizedReceiver",
  "UnauthorizedSender",
  "InvalidPreimage",
  "TimelockNotExpired",
  "TimelockExpired",
  "TransferFailed",
];

/** Off-chain mirror of HTLCBase.generateSwapId (what a client computes before sending a tx). */
function computeSwapId({ sender, receiver, tokenContract, amount, hashlock, timelock }) {
  return ethers.solidityPackedKeccak256(
    ["address", "address", "address", "uint256", "bytes32", "uint256"],
    [sender, receiver, tokenContract, amount, hashlock, timelock]
  );
}

/** Off-chain mirror of HTLCBase.hashPreimage. */
function computeHashlock(preimage) {
  return ethers.solidityPackedKeccak256(["bytes32"], [preimage]);
}

/** Returns the raw revert data of a call that is expected to revert. */
async function revertDataOf(action) {
  try {
    await action();
  } catch (error) {
    const data = error.data ?? error.info?.error?.data;
    if (typeof data === "string") return data;
  }
  throw new Error("expected the call to revert, but it did not");
}

describe("HTLCBase - COMP 5521 shared HTLC foundation", function () {
  let harness;
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

  /** Deterministic id of the swap the default `createSwap` call below produces. */
  function defaultSwapId(overrides = {}) {
    return computeSwapId({
      sender: sender.address,
      receiver: receiver.address,
      tokenContract: ZERO_ADDRESS,
      amount,
      hashlock,
      timelock,
      ...overrides,
    });
  }

  function createSwap(signer = sender, overrides = {}) {
    const {
      receiver: to = receiver.address,
      tokenContract = ZERO_ADDRESS,
      hashlock: lock = hashlock,
      timelock: deadline = timelock,
      value = amount,
    } = overrides;
    // The harness mirrors the native-value leg: the `amount` argument is ignored, msg.value is used.
    return harness.connect(signer).createSwap(to, tokenContract, value, lock, deadline, { value });
  }

  beforeEach(async function () {
    [sender, receiver, stranger] = await ethers.getSigners();
    const Harness = await ethers.getContractFactory("HTLCBaseHarness");
    harness = await Harness.deploy();

    amount = ethers.parseEther("1");
    preimage = ethers.id("COMP5521-super-secret-preimage");
    hashlock = computeHashlock(preimage);
    timelock = await futureTimelock();
  });

  describe("IHTLC.SwapStatus", function () {
    it("uses EMPTY as the zero value so an unknown swap needs no extra existence flag", async function () {
      const unknown = await harness.swaps(ZERO_HASH);
      expect(SwapStatus.EMPTY).to.equal(0n);
      expect(unknown.status).to.equal(SwapStatus.EMPTY);
    });

    it("exposes OPEN, CLAIMED and REFUNDED in the documented ABI order", async function () {
      const swapId = defaultSwapId();

      await createSwap();
      expect((await harness.swaps(swapId)).status).to.equal(SwapStatus.OPEN);

      await harness.connect(receiver).claimSwap(swapId, preimage);
      expect((await harness.swaps(swapId)).status).to.equal(SwapStatus.CLAIMED);

      // A second, independently refunded swap to observe REFUNDED.
      const shortTimelock = await futureTimelock(60);
      const refundable = computeSwapId({
        sender: sender.address,
        receiver: receiver.address,
        tokenContract: ZERO_ADDRESS,
        amount,
        hashlock,
        timelock: shortTimelock,
      });
      await createSwap(sender, { timelock: shortTimelock });
      await time.increase(60);
      await harness.refundSwap(refundable);
      expect((await harness.swaps(refundable)).status).to.equal(SwapStatus.REFUNDED);
    });
  });

  describe("generateSwapId", function () {
    it("matches keccak256(abi.encodePacked(...)) computed off-chain", async function () {
      const expected = defaultSwapId();
      const onChain = await harness.generateSwapIdExposed(
        sender.address,
        receiver.address,
        ZERO_ADDRESS,
        amount,
        hashlock,
        timelock
      );
      expect(onChain).to.equal(expected);
    });

    it("is deterministic for identical parameters", async function () {
      const first = await harness.generateSwapIdExposed(
        sender.address,
        receiver.address,
        ZERO_ADDRESS,
        amount,
        hashlock,
        timelock
      );
      const second = await harness.generateSwapIdExposed(
        sender.address,
        receiver.address,
        ZERO_ADDRESS,
        amount,
        hashlock,
        timelock
      );
      expect(first).to.equal(second);
    });

    it("changes when any single parameter changes", async function () {
      const base = {
        sender: sender.address,
        receiver: receiver.address,
        tokenContract: ZERO_ADDRESS,
        amount,
        hashlock,
        timelock,
      };
      const ids = new Set([await harness.generateSwapIdExposed(...Object.values(base))]);

      const variants = [
        { ...base, sender: stranger.address },
        { ...base, receiver: stranger.address },
        { ...base, tokenContract: stranger.address },
        { ...base, amount: amount + 1n },
        { ...base, hashlock: computeHashlock(ethers.id("another-preimage")) },
        { ...base, timelock: timelock + 1n },
      ];

      for (const variant of variants) {
        const id = await harness.generateSwapIdExposed(...Object.values(variant));
        expect(ids.has(id), "expected a distinct id for every parameter change").to.equal(false);
        ids.add(id);
      }
      expect(ids.size).to.equal(7);
    });
  });

  describe("hashPreimage", function () {
    it("matches keccak256(abi.encodePacked(preimage))", async function () {
      expect(await harness.hashPreimageExposed(preimage)).to.equal(hashlock);
      expect(await harness.hashPreimageExposed(preimage)).to.equal(
        ethers.solidityPackedKeccak256(["bytes32"], [preimage])
      );
    });

    it("produces a different hashlock for a different preimage", async function () {
      const other = ethers.id("wrong-preimage");
      expect(await harness.hashPreimageExposed(other)).to.not.equal(hashlock);
    });
  });

  describe("createSwap / _openSwap", function () {
    it("stores the swap, emits SwapCreated and holds the locked funds", async function () {
      const swapId = defaultSwapId();
      const tx = createSwap();

      await expect(tx)
        .to.emit(harness, "SwapCreated")
        .withArgs(swapId, sender.address, receiver.address, ZERO_ADDRESS, amount, hashlock, timelock);
      await expect(tx).to.changeEtherBalance(harness, amount);

      const swap = await harness.getSwap(swapId);
      expect(swap.swapId).to.equal(swapId);
      expect(swap.sender).to.equal(sender.address);
      expect(swap.receiver).to.equal(receiver.address);
      expect(swap.tokenContract).to.equal(ZERO_ADDRESS);
      expect(swap.amount).to.equal(amount);
      expect(swap.hashlock).to.equal(hashlock);
      expect(swap.timelock).to.equal(timelock);
      expect(swap.status).to.equal(SwapStatus.OPEN);
    });

    it("lets two different receivers open independent swaps with the same secret and amount", async function () {
      await createSwap();
      await createSwap(sender, { receiver: stranger.address });

      const first = defaultSwapId();
      const second = defaultSwapId({ receiver: stranger.address });
      expect(first).to.not.equal(second);
      expect((await harness.getSwap(first)).status).to.equal(SwapStatus.OPEN);
      expect((await harness.getSwap(second)).status).to.equal(SwapStatus.OPEN);
    });

    it("reverts with SwapAlreadyExists when identical parameters are submitted twice", async function () {
      await createSwap();
      await expect(createSwap()).to.be.revertedWithCustomError(harness, "SwapAlreadyExists");
    });

    it("reverts with InvalidZeroAddress for a zero receiver", async function () {
      await expect(createSwap(sender, { receiver: ZERO_ADDRESS })).to.be.revertedWithCustomError(
        harness,
        "InvalidZeroAddress"
      );
    });

    it("reverts with InvalidZeroAmount when nothing is locked", async function () {
      await expect(createSwap(sender, { value: 0n })).to.be.revertedWithCustomError(harness, "InvalidZeroAmount");
    });

    it("reverts with InvalidTimelock for a current or past timelock", async function () {
      const now = BigInt(await time.latest());
      await expect(createSwap(sender, { timelock: now })).to.be.revertedWithCustomError(harness, "InvalidTimelock");
      await expect(createSwap(sender, { timelock: now - 1n })).to.be.revertedWithCustomError(
        harness,
        "InvalidTimelock"
      );
    });

    it("reverts with InvalidPreimage for a zero hashlock (permanently unclaimable swap)", async function () {
      await expect(createSwap(sender, { hashlock: ZERO_HASH })).to.be.revertedWithCustomError(harness, "InvalidPreimage");
    });

    it("accepts address(0) as tokenContract (native-value leg marker)", async function () {
      const swapId = defaultSwapId();
      await createSwap();
      expect((await harness.getSwap(swapId)).tokenContract).to.equal(ZERO_ADDRESS);
    });
  });

  describe("getSwap", function () {
    it("reverts with SwapDoesNotExist for an unknown id", async function () {
      await expect(harness.getSwap(ZERO_HASH)).to.be.revertedWithCustomError(harness, "SwapDoesNotExist");
      await expect(harness.getSwap(defaultSwapId())).to.be.revertedWithCustomError(harness, "SwapDoesNotExist");
    });

    it("agrees with the auto-generated public `swaps` getter", async function () {
      const swapId = defaultSwapId();
      await createSwap();

      const fromGetter = await harness.swaps(swapId);
      const fromHelper = await harness.getSwap(swapId);
      expect(fromGetter.status).to.equal(fromHelper.status);
      expect(fromGetter.amount).to.equal(fromHelper.amount);
      expect(fromGetter.hashlock).to.equal(fromHelper.hashlock);
    });
  });

  describe("claimSwap / _settleClaim", function () {
    it("releases the funds to the receiver and emits SwapClaimed with the preimage", async function () {
      const swapId = defaultSwapId();
      await createSwap();

      const tx = harness.connect(receiver).claimSwap(swapId, preimage);
      await expect(tx).to.emit(harness, "SwapClaimed").withArgs(swapId, receiver.address, preimage);
      await expect(tx).to.changeEtherBalance(receiver, amount);
      await expect(tx).to.changeEtherBalance(harness, -amount);

      expect((await harness.getSwap(swapId)).status).to.equal(SwapStatus.CLAIMED);
    });

    it("reverts with InvalidPreimage for the wrong preimage and leaves the swap OPEN", async function () {
      const swapId = defaultSwapId();
      await createSwap();

      await expect(harness.connect(receiver).claimSwap(swapId, ethers.id("wrong-preimage"))).to.be.revertedWithCustomError(
        harness,
        "InvalidPreimage"
      );
      expect((await harness.getSwap(swapId)).status).to.equal(SwapStatus.OPEN);
    });

    it("reverts with UnauthorizedReceiver for the sender or any third party", async function () {
      const swapId = defaultSwapId();
      await createSwap();

      await expect(harness.connect(sender).claimSwap(swapId, preimage)).to.be.revertedWithCustomError(
        harness,
        "UnauthorizedReceiver"
      );
      await expect(harness.connect(stranger).claimSwap(swapId, preimage)).to.be.revertedWithCustomError(
        harness,
        "UnauthorizedReceiver"
      );
    });

    it("reverts with TimelockExpired once the claim window has closed", async function () {
      const shortTimelock = await futureTimelock(60);
      await createSwap(sender, { timelock: shortTimelock });
      const swapId = defaultSwapId({ timelock: shortTimelock });

      await time.increase(60);
      await expect(harness.connect(receiver).claimSwap(swapId, preimage)).to.be.revertedWithCustomError(
        harness,
        "TimelockExpired"
      );
    });

    it("reverts with SwapNotOpen when claimed twice", async function () {
      const swapId = defaultSwapId();
      await createSwap();

      await harness.connect(receiver).claimSwap(swapId, preimage);
      await expect(harness.connect(receiver).claimSwap(swapId, preimage)).to.be.revertedWithCustomError(
        harness,
        "SwapNotOpen"
      );
    });

    it("reverts with SwapNotOpen when the swap was already refunded", async function () {
      const shortTimelock = await futureTimelock(60);
      await createSwap(sender, { timelock: shortTimelock });
      const swapId = defaultSwapId({ timelock: shortTimelock });

      await time.increase(60);
      await harness.refundSwap(swapId);

      await expect(harness.connect(receiver).claimSwap(swapId, preimage)).to.be.revertedWithCustomError(
        harness,
        "SwapNotOpen"
      );
    });

    it("reverts with SwapDoesNotExist for an unknown id", async function () {
      await expect(harness.connect(receiver).claimSwap(defaultSwapId(), preimage)).to.be.revertedWithCustomError(
        harness,
        "SwapDoesNotExist"
      );
    });
  });

  describe("refundSwap / _settleRefund", function () {
    it("reverts with TimelockNotExpired before the deadline", async function () {
      const swapId = defaultSwapId();
      await createSwap();

      await expect(harness.refundSwap(swapId)).to.be.revertedWithCustomError(harness, "TimelockNotExpired");
      expect((await harness.getSwap(swapId)).status).to.equal(SwapStatus.OPEN);
    });

    it("reverts with UnauthorizedSender for the receiver or any third party", async function () {
      const shortTimelock = await futureTimelock(60);
      await createSwap(sender, { timelock: shortTimelock });
      const swapId = defaultSwapId({ timelock: shortTimelock });
      await time.increase(60);

      await expect(harness.connect(receiver).refundSwap(swapId)).to.be.revertedWithCustomError(
        harness,
        "UnauthorizedSender"
      );
      await expect(harness.connect(stranger).refundSwap(swapId)).to.be.revertedWithCustomError(
        harness,
        "UnauthorizedSender"
      );
    });

    it("returns the funds to the sender after the deadline and emits SwapRefunded", async function () {
      const shortTimelock = await futureTimelock(60);
      await createSwap(sender, { timelock: shortTimelock });
      const swapId = defaultSwapId({ timelock: shortTimelock });

      await time.increase(60);

      const tx = harness.refundSwap(swapId);
      await expect(tx).to.emit(harness, "SwapRefunded").withArgs(swapId, sender.address);
      await expect(tx).to.changeEtherBalance(sender, amount);
      await expect(tx).to.changeEtherBalance(harness, -amount);

      expect((await harness.getSwap(swapId)).status).to.equal(SwapStatus.REFUNDED);
    });

    it("reverts with SwapNotOpen when the swap was already claimed", async function () {
      const swapId = defaultSwapId();
      await createSwap();
      await harness.connect(receiver).claimSwap(swapId, preimage);

      await expect(harness.refundSwap(swapId)).to.be.revertedWithCustomError(harness, "SwapNotOpen");
    });

    it("reverts with SwapDoesNotExist for an unknown id", async function () {
      await expect(harness.refundSwap(defaultSwapId())).to.be.revertedWithCustomError(harness, "SwapDoesNotExist");
    });
  });

  describe("HTLCErrors (gas-optimised custom errors)", function () {
    it("declares every required error on the inherited ABI", async function () {
      const declared = harness.interface.fragments.filter((f) => f.type === "error").map((f) => f.name);
      for (const name of REQUIRED_ERRORS) {
        expect(declared, `${name} must be declared in HTLCErrors and used by HTLCBase`).to.include(name);
      }
      expect(declared).to.include("ReentrancyDetected");
    });

    it("keeps the canonical 4-byte selectors (library namespacing changes no ABI or gas cost)", async function () {
      for (const name of [...REQUIRED_ERRORS, "ReentrancyDetected"]) {
        const fragment = harness.interface.getError(name);
        expect(fragment.selector).to.equal(ethers.id(`${name}()`).slice(0, 10));
      }
    });

    it("reverts with 4 bytes of data and never with an ABI-encoded Error(string)", async function () {
      const data = await revertDataOf(() => harness.getSwap.staticCall(ZERO_HASH));

      expect(data).to.equal(harness.interface.getError("SwapDoesNotExist").selector);
      expect(data).to.have.lengthOf(10); // "0x" + 4 bytes
      expect(data.slice(0, 10)).to.not.equal("0x08c379a0"); // selector of Error(string)
    });
  });

  describe("shared validation helpers", function () {
    it("_checkNonZeroAddress accepts real accounts and rejects address(0)", async function () {
      await expect(harness.checkNonZeroAddressExposed(receiver.address)).to.not.be.reverted;
      await expect(harness.checkNonZeroAddressExposed(ZERO_ADDRESS)).to.be.revertedWithCustomError(
        harness,
        "InvalidZeroAddress"
      );
    });

    it("_checkNonZeroAmount accepts non-zero amounts and rejects zero", async function () {
      await expect(harness.checkNonZeroAmountExposed(1n)).to.not.be.reverted;
      await expect(harness.checkNonZeroAmountExposed(0n)).to.be.revertedWithCustomError(harness, "InvalidZeroAmount");
    });

    it("_checkFutureTimelock only accepts future timestamps", async function () {
      const now = BigInt(await time.latest());
      await expect(harness.checkFutureTimelockExposed(now + 1n)).to.not.be.reverted;
      await expect(harness.checkFutureTimelockExposed(now)).to.be.revertedWithCustomError(harness, "InvalidTimelock");
      await expect(harness.checkFutureTimelockExposed(now - 1n)).to.be.revertedWithCustomError(harness, "InvalidTimelock");
    });

    it("_checkNonZeroHashlock rejects bytes32(0)", async function () {
      await expect(harness.checkNonZeroHashlockExposed(hashlock)).to.not.be.reverted;
      await expect(harness.checkNonZeroHashlockExposed(ZERO_HASH)).to.be.revertedWithCustomError(harness, "InvalidPreimage");
    });

    it("_checkReceiver / _checkSender compare the caller against the swap parties", async function () {
      const swapTuple = [
        ZERO_HASH,
        sender.address,
        receiver.address,
        ZERO_ADDRESS,
        amount,
        hashlock,
        timelock,
        SwapStatus.OPEN,
      ];

      await expect(harness.connect(receiver).checkReceiverExposed(swapTuple)).to.not.be.reverted;
      await expect(harness.connect(stranger).checkReceiverExposed(swapTuple)).to.be.revertedWithCustomError(
        harness,
        "UnauthorizedReceiver"
      );

      await expect(harness.connect(sender).checkSenderExposed(swapTuple)).to.not.be.reverted;
      await expect(harness.connect(stranger).checkSenderExposed(swapTuple)).to.be.revertedWithCustomError(
        harness,
        "UnauthorizedSender"
      );
    });
  });

  describe("nonReentrant guard", function () {
    it("allows normal calls and releases the guard afterwards", async function () {
      await expect(harness.nonReentrantProbe(stranger.address, "0x")).to.not.be.reverted;

      // The guard must have been reset by the previous transaction, so a guarded swap still works.
      await createSwap();
      await expect(harness.nonReentrantProbe(stranger.address, "0x")).to.not.be.reverted;
    });

    it("blocks a re-entrant call and surfaces ReentrancyDetected", async function () {
      const Attacker = await ethers.getContractFactory("ReentrancyAttacker");
      const attacker = await Attacker.deploy(harness.target);

      await expect(attacker.attack()).to.be.revertedWithCustomError(harness, "ReentrancyDetected");
    });
  });

  describe("_sendValue and payout atomicity", function () {
    it("transfers native value to an EOA", async function () {
      // Fund the harness the same way the real native-value leg is funded: through a payable swap.
      await createSwap();

      await expect(harness.sendValueExposed(receiver.address, amount)).to.changeEtherBalance(receiver, amount);
    });

    it("reverts with TransferFailed when the recipient rejects native value", async function () {
      const Rejector = await ethers.getContractFactory("EtherRejector");
      const rejector = await Rejector.deploy();
      await createSwap();

      await expect(harness.sendValueExposed(rejector.target, 1n)).to.be.revertedWithCustomError(
        harness,
        "TransferFailed"
      );
    });

    it("leaves the swap OPEN when the payout fails (never CLAIMED without funds moving)", async function () {
      const Receiver = await ethers.getContractFactory("RejectingReceiver");
      const rejectingReceiver = await Receiver.deploy();

      await createSwap(sender, { receiver: rejectingReceiver.target });
      const swapId = defaultSwapId({ receiver: rejectingReceiver.target });

      await expect(rejectingReceiver.claim(harness.target, swapId, preimage)).to.be.revertedWithCustomError(
        harness,
        "TransferFailed"
      );
      expect((await harness.getSwap(swapId)).status).to.equal(SwapStatus.OPEN);
    });
  });
});
