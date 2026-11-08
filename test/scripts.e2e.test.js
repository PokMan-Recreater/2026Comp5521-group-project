const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const { generateSecret, hashPreimage, verifyLegPair } = require("../scripts/lib/swapId");
const protocol = require("../scripts/lib/protocol");
const { LegState, classifyLeg, describeGroup } = require("../scripts/lib/state");
const store = require("../scripts/lib/swapStore");

/**
 * Exercises the Task B coordinator library end to end.
 *
 * The step scripts (`2_lockERC20.js`, `3_lockETH.js`, ...) are thin wrappers: they read `.env`, attach the
 * contracts and hand over to the functions tested here. Both "chains" are two contract instances on the
 * in-process Hardhat network, which is enough to prove the protocol logic, the off-chain id agreement, the
 * pairing checks and the state classification that the scripts rely on.
 */
describe("scripts/ - Task B coordinator (end-to-end on a local chain)", function () {
  let alice; // owns the MST, claims the ETH leg
  let bob; // owns the ETH, claims the MST leg
  let mst;
  let mstLeg; // "Ethereum Sepolia" leg
  let ethLeg; // "Arbitrum Sepolia" leg
  let stateFile;

  const MST_AMOUNT = ethers.parseEther("100");
  const ETH_AMOUNT = ethers.parseEther("0.5");

  async function nowSeconds() {
    return Number(await time.latest());
  }

  before(function () {
    stateFile = path.join(os.tmpdir(), `comp5521-swaps-${process.pid}-${Date.now()}.json`);
    process.env.SWAP_STATE_FILE = stateFile;
  });

  after(function () {
    delete process.env.SWAP_STATE_FILE;
    if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
  });

  beforeEach(async function () {
    [alice, bob] = await ethers.getSigners();

    const MockMST = await ethers.getContractFactory("MockMST");
    mst = await MockMST.deploy();

    const ERC20HTLC = await ethers.getContractFactory("ERC20HTLC");
    mstLeg = await ERC20HTLC.deploy(mst.target);

    const ETHHTLC = await ethers.getContractFactory("ETHHTLC");
    ethLeg = await ETHHTLC.deploy();

    await mst.mint(alice.address, ethers.parseEther("1000"));

    // every test starts from an empty coordinator state
    if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
  });

  /** Creates the group record and locks both legs with asymmetric timelocks. */
  async function openSwap({ mstOffset = 1800, ethOffset = 900 } = {}) {
    const preimage = generateSecret();
    const hashlock = hashPreimage(preimage);
    const now = BigInt(await time.latest());
    const mstTimelock = now + BigInt(mstOffset);
    const ethTimelock = now + BigInt(ethOffset);

    const record = store.createSwap({
      preimage,
      hashlock,
      amounts: { mst: MST_AMOUNT.toString(), eth: ETH_AMOUNT.toString() },
      timelockOffsets: { mst: mstOffset, eth: ethOffset },
      parties: {
        mstSender: alice.address,
        mstReceiver: bob.address,
        ethSender: bob.address,
        ethReceiver: alice.address,
      },
      legs: {},
    });

    const mstResult = await protocol.lockMstLeg({
      leg: mstLeg,
      token: mst,
      sender: alice,
      receiver: bob.address,
      amount: MST_AMOUNT,
      hashlock,
      timelock: mstTimelock,
    });

    const ethResult = await protocol.lockEthLeg({
      leg: ethLeg,
      sender: bob,
      receiver: alice.address,
      amount: ETH_AMOUNT,
      hashlock,
      timelock: ethTimelock,
    });

    store.recordLeg(record.groupId, "mst", { swapId: mstResult.swapId, txHash: mstResult.txHash }, {
      status: "MST_LOCKED",
    });
    store.recordLeg(record.groupId, "eth", { swapId: ethResult.swapId, txHash: ethResult.txHash }, {
      status: "BOTH_LOCKED",
    });

    return { record, preimage, hashlock, mstSwapId: mstResult.swapId, ethSwapId: ethResult.swapId };
  }

  describe("successful swap (Task B2)", function () {
    it("locks both legs, verifies the pair, claims the ETH leg, then claims the MST leg", async function () {
      const { record, preimage, hashlock, mstSwapId, ethSwapId } = await openSwap();

      // 4_verify: both legs read back from "their own chain" and paired
      const mstSwap = await protocol.readLeg(mstLeg, mstSwapId);
      const ethSwap = await protocol.readLeg(ethLeg, ethSwapId);
      const view = describeGroup({ mstSwap, ethSwap, preimage, now: await nowSeconds() });

      expect(view.pairing.ok).to.equal(true);
      expect(view.mst).to.equal(LegState.CLAIMABLE);
      expect(view.eth).to.equal(LegState.CLAIMABLE);
      expect(ethSwap.hashlock).to.equal(hashlock);

      // 5_claimBoth --network arbitrumSepolia: Alice claims the ETH leg and the event reveals the preimage
      const ethClaim = await protocol.claimLeg({
        leg: ethLeg,
        claimer: alice,
        swapId: ethSwapId,
        preimage,
        method: "claimETH",
      });
      expect(ethClaim.revealedPreimage).to.equal(preimage);

      store.recordLeg(
        record.groupId,
        "eth",
        { status: "CLAIMED", revealedPreimage: ethClaim.revealedPreimage, claimTxHash: ethClaim.txHash },
        { status: "ETH_CLAIMED" }
      );

      // 5_claimBoth --network sepolia: Bob settles the MST leg with the preimage he just learned
      const mstClaim = await protocol.claimLeg({
        leg: mstLeg,
        claimer: bob,
        swapId: mstSwapId,
        preimage: ethClaim.revealedPreimage,
        method: "claimMST",
      });
      expect(mstClaim.txHash).to.have.lengthOf(66);

      // the assets really moved
      expect(await mst.balanceOf(bob.address)).to.equal(MST_AMOUNT);
      expect(await mst.balanceOf(mstLeg.target)).to.equal(0n);
      expect(await ethers.provider.getBalance(ethLeg.target)).to.equal(0n);
      expect((await protocol.readLeg(ethLeg, ethSwapId)).statusName).to.equal("CLAIMED");

      const finalView = describeGroup({
        mstSwap: await protocol.readLeg(mstLeg, mstSwapId),
        ethSwap: await protocol.readLeg(ethLeg, ethSwapId),
        preimage,
        now: await nowSeconds(),
      });
      expect(finalView.nextActions.join(" | ")).to.match(/swap complete/);

      // the group record on disk links the two independent on-chain ids
      const stored = store.getSwap(record.groupId);
      expect(stored.legs.mst.swapId).to.not.equal(stored.legs.eth.swapId);
      expect(stored.legs.eth.revealedPreimage).to.equal(preimage);
      expect(stored.status).to.equal("ETH_CLAIMED");
    });

    it("approves exactly the amount it needs, once", async function () {
      const { hashlock } = await openSwap();
      // the allowance is consumed by the pull, so nothing is left behind
      expect(await mst.allowance(alice.address, mstLeg.target)).to.equal(0n);
      expect(hashlock).to.have.lengthOf(66);
    });
  });

  describe("timeout recovery (Task B4)", function () {
    it("refunds the ETH leg first, then the MST leg after its longer deadline", async function () {
      const { mstSwapId, ethSwapId, preimage } = await openSwap({ mstOffset: 1800, ethOffset: 60 });

      await time.increase(60);

      const view = describeGroup({
        mstSwap: await protocol.readLeg(mstLeg, mstSwapId),
        ethSwap: await protocol.readLeg(ethLeg, ethSwapId),
        preimage,
        now: await nowSeconds(),
      });
      expect(view.eth).to.equal(LegState.REFUNDABLE);
      expect(view.mst).to.equal(LegState.CLAIMABLE);
      expect(view.nextActions.join(" | ")).to.match(/refunds the ETH leg/);

      // 6_refund --network arbitrumSepolia
      const refund = await protocol.refundLeg({ leg: ethLeg, sender: bob, swapId: ethSwapId, method: "refundETH" });
      expect(refund.txHash).to.have.lengthOf(66);
      expect(await ethers.provider.getBalance(ethLeg.target)).to.equal(0n);

      // the MST leg is untouched and its own deadline is still in the future
      const mstSwap = await protocol.readLeg(mstLeg, mstSwapId);
      expect(mstSwap.statusName).to.equal("OPEN");
      await expect(
        protocol.refundLeg({ leg: mstLeg, sender: alice, swapId: mstSwapId, method: "refundMST" })
      ).to.be.revertedWithCustomError(mstLeg, "TimelockNotExpired");

      await time.increase(1800);
      await protocol.refundLeg({ leg: mstLeg, sender: alice, swapId: mstSwapId, method: "refundMST" });

      expect(await mst.balanceOf(alice.address)).to.equal(ethers.parseEther("1000")); // MST came back
      const finalView = describeGroup({
        mstSwap: await protocol.readLeg(mstLeg, mstSwapId),
        ethSwap: await protocol.readLeg(ethLeg, ethSwapId),
        preimage,
        now: await nowSeconds(),
      });
      expect(finalView.mst).to.equal(LegState.REFUNDED);
      expect(finalView.eth).to.equal(LegState.REFUNDED);
      expect(finalView.nextActions.join(" | ")).to.match(/swap cancelled/);
    });

    it("rejects an unsafe timelock ordering before anything is locked", async function () {
      const now = BigInt(await time.latest());
      expect(() => protocol.assertAsymmetricTimelocks({ ethTimelock: now + 1800n, mstTimelock: now + 900n })).to.throw(
        /must expire STRICTLY BEFORE/
      );
      expect(() => protocol.assertAsymmetricTimelocks({ ethTimelock: now + 900n, mstTimelock: now + 900n })).to.throw(
        /STRICTLY BEFORE/
      );
      expect(() => protocol.assertAsymmetricTimelocks({ ethTimelock: now + 900n, mstTimelock: now + 1800n })).to.not.throw();
    });
  });

  describe("state observation and the coordinator record (Task B3)", function () {
    it("returns null for a swap id the contract does not know", async function () {
      expect(await protocol.readLeg(mstLeg, ethers.ZeroHash)).to.equal(null);
      expect(await protocol.readLeg(ethLeg, ethers.id("no-such-swap"))).to.equal(null);
    });

    it("classifies a leg from its status, timelock and the current time", function () {
      const now = 1_000_000;
      expect(classifyLeg(null, now)).to.equal(LegState.MISSING);
      expect(classifyLeg({ statusName: "CLAIMED", timelock: 2_000_000n }, now)).to.equal(LegState.CLAIMED);
      expect(classifyLeg({ statusName: "REFUNDED", timelock: 2_000_000n }, now)).to.equal(LegState.REFUNDED);
      expect(classifyLeg({ statusName: "OPEN", timelock: 2_000_000n }, now)).to.equal(LegState.CLAIMABLE);
      expect(classifyLeg({ statusName: "OPEN", timelock: 999_999n }, now)).to.equal(LegState.REFUNDABLE);
      expect(classifyLeg({ statusName: "EMPTY", timelock: 2_000_000n }, now)).to.equal(LegState.MISSING);
    });

    it("flags a pair whose parties are not crossed or whose hashlocks differ", async function () {
      const { mstSwapId, ethSwapId, preimage } = await openSwap();
      const now = await nowSeconds();
      const mstSwap = await protocol.readLeg(mstLeg, mstSwapId);
      const ethSwap = await protocol.readLeg(ethLeg, ethSwapId);

      const uncrossed = describeGroup({
        mstSwap: { ...mstSwap, receiver: alice.address },
        ethSwap,
        preimage,
        now,
      });
      expect(uncrossed.pairing.ok).to.equal(false);
      expect(uncrossed.pairing.issues.join(" | ")).to.match(/crossed/);

      const mismatched = describeGroup({
        mstSwap,
        ethSwap: { ...ethSwap, hashlock: hashPreimage(generateSecret()) },
        preimage,
        now,
      });
      expect(mismatched.pairing.issues).to.include("the two legs do not share the same hashlock");

      const halfLocked = describeGroup({ mstSwap, ethSwap: null, preimage, now });
      expect(halfLocked.pairing.ok).to.equal(false);
      expect(halfLocked.eth).to.equal(LegState.MISSING);
    });

    it("keeps every group in the state file, newest last, with amounts as decimal strings", function () {
      const first = store.createSwap({ groupId: "swap-test0001", preimage: generateSecret(), amounts: { mst: "1", eth: "2" } });
      const second = store.createSwap({ preimage: generateSecret(), amounts: { mst: "3", eth: "4" } });

      expect(store.stateFile()).to.equal(stateFile);
      expect(store.latestSwap().groupId).to.equal(second.groupId);
      expect(store.listSwaps().map((swap) => swap.groupId)).to.deep.equal([first.groupId, second.groupId]);
      expect(store.getSwap(first.groupId).amounts.mst).to.equal("1"); // JSON-safe, not a bigint
      expect(() => store.getSwap("swap-missing")).to.throw(/Unknown swap group/);
    });

    it("records each step of a leg without losing the earlier fields", async function () {
      const { record, mstSwapId } = await openSwap();

      store.recordLeg(record.groupId, "mst", { claimTxHash: "0xabc", status: "CLAIMED" }, { status: "COMPLETE" });

      const stored = store.getSwap(record.groupId);
      expect(stored.status).to.equal("COMPLETE");
      expect(stored.legs.mst.swapId).to.equal(mstSwapId); // recorded by 2_lockERC20.js
      expect(stored.legs.mst.claimTxHash).to.equal("0xabc"); // recorded by 5_claimBoth.js
      expect(stored.legs.mst.txHash).to.have.lengthOf(66);
    });
  });
});
