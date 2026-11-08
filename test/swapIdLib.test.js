const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const {
  NATIVE_TOKEN,
  hashPreimage,
  generateSecret,
  deriveMstLegSwapId,
  deriveEthLegSwapId,
  verifyLegPair,
} = require("../scripts/lib/swapId");

/**
 * These tests keep `scripts/lib/swapId.js` honest: the off-chain derivations must match what the deployed
 * contracts actually store, otherwise the Task B scripts (and later the frontend) would print or claim the
 * wrong swap ids. They are also the executable statement of the corrected cross-chain rule: the two legs
 * are linked by the shared hashlock + crossed parties + timelock ordering, never by id equality.
 */
describe("scripts/lib/swapId.js - off-chain protocol helpers", function () {
  let sender; // Alice: holds MST, receives ETH
  let receiver; // Bob: receives MST, holds ETH
  let stranger;
  let mst;
  let mstLeg; // ERC20HTLC (Ethereum Sepolia)
  let ethLeg; // ETHHTLC (Arbitrum Sepolia)
  let amount;
  let mstAmount;
  let preimage;
  let hashlock;
  let ethTimelock;
  let mstTimelock;

  async function futureTimelock(seconds) {
    return BigInt(await time.latest()) + BigInt(seconds);
  }

  function mstDescriptor(overrides = {}) {
    return { sender: sender.address, receiver: receiver.address, amount: mstAmount, hashlock, timelock: mstTimelock, ...overrides };
  }

  function ethDescriptor(overrides = {}) {
    return { sender: receiver.address, receiver: sender.address, amount, hashlock, timelock: ethTimelock, ...overrides };
  }

  beforeEach(async function () {
    [sender, receiver, stranger] = await ethers.getSigners();

    const MockMST = await ethers.getContractFactory("MockMST");
    mst = await MockMST.deploy();

    const ERC20HTLC = await ethers.getContractFactory("ERC20HTLC");
    mstLeg = await ERC20HTLC.deploy(mst.target);

    const ETHHTLC = await ethers.getContractFactory("ETHHTLC");
    ethLeg = await ETHHTLC.deploy();

    amount = ethers.parseEther("1");
    mstAmount = ethers.parseEther("100");
    await mst.mint(sender.address, mstAmount);
    await mst.connect(sender).approve(mstLeg.target, mstAmount);

    preimage = generateSecret(); // the module under test generates the secret too
    hashlock = hashPreimage(preimage);
    ethTimelock = await futureTimelock(1800); // claimed first => expires first
    mstTimelock = await futureTimelock(3600);
  });

  describe("hashPreimage / generateSecret", function () {
    it("produces a hashlock the contracts actually accept and open", async function () {
      const swapId = deriveEthLegSwapId(ethDescriptor());
      await expect(ethLeg.connect(receiver).lockETH(sender.address, hashlock, ethTimelock, { value: amount })).to.not.be
        .reverted;

      // the swap stored by the contract uses exactly the hashlock the helper computed
      expect((await ethLeg.getSwap(swapId)).hashlock).to.equal(hashlock);

      // ...and the secret the helper generated opens it
      await expect(ethLeg.connect(sender).claimETH(swapId, preimage)).to.emit(ethLeg, "SwapClaimed");
    });

    it("generates a fresh 32-byte secret on every call", async function () {
      const first = generateSecret();
      const second = generateSecret();

      expect(first).to.match(/^0x[0-9a-f]{64}$/);
      expect(second).to.match(/^0x[0-9a-f]{64}$/);
      expect(first).to.not.equal(second);
    });
  });

  describe("swap id derivations", function () {
    it("deriveMstLegSwapId matches the id ERC20HTLC stores", async function () {
      const expected = deriveMstLegSwapId(mstDescriptor());
      const returned = await mstLeg
        .connect(sender)
        .lockMST.staticCall(receiver.address, mstAmount, hashlock, mstTimelock);
      expect(returned).to.equal(expected);

      await mstLeg.connect(sender).lockMST(receiver.address, mstAmount, hashlock, mstTimelock);
      expect((await mstLeg.getSwap(expected)).swapId).to.equal(expected);
    });

    it("deriveEthLegSwapId matches the id ETHHTLC stores", async function () {
      const expected = deriveEthLegSwapId(ethDescriptor());
      const returned = await ethLeg
        .connect(receiver)
        .lockETH.staticCall(sender.address, hashlock, ethTimelock, { value: amount });
      expect(returned).to.equal(expected);

      await ethLeg.connect(receiver).lockETH(sender.address, hashlock, ethTimelock, { value: amount });
      expect((await ethLeg.getSwap(expected)).swapId).to.equal(expected);
    });

    it("derives different ids for the two legs, even with identical parameters", async function () {
      const sharedTimelock = await futureTimelock(3600);
      const mstId = deriveMstLegSwapId(mstDescriptor({ timelock: sharedTimelock }));
      const ethId = deriveEthLegSwapId(ethDescriptor({ timelock: sharedTimelock }));

      expect(mstId).to.not.equal(ethId);
      expect(ethId).to.equal(
        ethers.solidityPackedKeccak256(
          ["address", "address", "address", "uint256", "bytes32", "uint256"],
          [receiver.address, sender.address, ethers.ZeroAddress, amount, hashlock, sharedTimelock]
        )
      );
    });
  });

  describe("verifyLegPair", function () {
    /** "now" taken from the chain, so the expiry checks are deterministic. */
    async function nowSeconds() {
      return Number(await time.latest());
    }

    it("accepts a correctly crossed pair with asymmetric timelocks", async function () {
      const result = verifyLegPair({
        mst: mstDescriptor(),
        eth: ethDescriptor(),
        preimage,
        now: await nowSeconds(),
      });

      expect(result.issues).to.deep.equal([]);
      expect(result.ok).to.equal(true);
    });

    it("rejects legs whose parties are not crossed", async function () {
      const result = verifyLegPair({
        mst: mstDescriptor(),
        // same direction instead of the crossed (sender <-> receiver) mapping
        eth: ethDescriptor({ sender: sender.address, receiver: receiver.address }),
        preimage,
        now: await nowSeconds(),
      });

      expect(result.ok).to.equal(false);
      expect(result.issues.join(" | ")).to.match(/crossed/);
    });

    it("rejects legs that do not share the same hashlock", async function () {
      const result = verifyLegPair({
        mst: mstDescriptor(),
        eth: ethDescriptor({ hashlock: hashPreimage(generateSecret()) }),
        now: await nowSeconds(),
      });

      expect(result.ok).to.equal(false);
      expect(result.issues).to.deep.include("the two legs do not share the same hashlock");
    });

    it("rejects a pair whose ETH leg does not expire strictly first", async function () {
      const result = verifyLegPair({
        mst: mstDescriptor({ timelock: ethTimelock }), // same deadline as the ETH leg
        eth: ethDescriptor({ timelock: ethTimelock }),
        now: await nowSeconds(),
      });

      expect(result.ok).to.equal(false);
      expect(result.issues.join(" | ")).to.match(/asymmetric timelocks/);
    });

    it("rejects a pair whose legs have already expired", async function () {
      const result = verifyLegPair({
        mst: mstDescriptor(),
        eth: ethDescriptor(),
        now: Number(mstTimelock) + 1, // both deadlines are behind "now"
      });

      expect(result.ok).to.equal(false);
      expect(result.issues).to.include("the ETH leg has already expired");
      expect(result.issues).to.include("the MST leg has already expired");
    });

    it("rejects a preimage that does not open the shared hashlock", async function () {
      const result = verifyLegPair({
        mst: mstDescriptor(),
        eth: ethDescriptor(),
        preimage: generateSecret(), // unrelated secret
        now: await nowSeconds(),
      });

      expect(result.ok).to.equal(false);
      expect(result.issues).to.deep.include("the preimage does not match the shared hashlock");
    });

    it("rejects zero amounts on either leg", async function () {
      const result = verifyLegPair({
        mst: mstDescriptor({ amount: 0n }),
        eth: ethDescriptor({ amount: 0n }),
        now: await nowSeconds(),
      });

      expect(result.ok).to.equal(false);
      expect(result.issues).to.include("the MST amount must be non-zero");
      expect(result.issues).to.include("the ETH amount must be non-zero");
    });

    it("exposes the native-value token marker used by the shared Swap struct", function () {
      expect(NATIVE_TOKEN).to.equal(ethers.ZeroAddress);
    });
  });
});
