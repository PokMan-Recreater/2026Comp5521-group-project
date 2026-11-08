const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const { expect } = require("chai");
const { ethers } = require("hardhat");

const scriptsLib = require("../scripts/lib/swapId");

/**
 * Parity test for the browser mirror.
 *
 * `frontend/src/lib/swapId.js` re-implements the protocol maths for the ESM bundle (the scripts are CommonJS).
 * These tests import the frontend module and assert that it agrees with the CommonJS original on every
 * function, so the two implementations cannot drift apart without a failing test.
 */
describe("frontend/src/lib/swapId.js - parity with scripts/lib/swapId.js", function () {
  let frontend;

  before(async function () {
    const file = path.join(__dirname, "..", "frontend", "src", "lib", "swapId.js");
    expect(fs.existsSync(file), "the frontend module must exist").to.equal(true);
    frontend = await import(pathToFileURL(file).href);
  });

  const secret = ethers.id("COMP5521 frontend parity secret");
  const hashlock = scriptsLib.hashPreimage(secret);
  const parties = {
    alice: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    bob: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  };

  it("exposes the same native-value marker", function () {
    expect(frontend.NATIVE_TOKEN).to.equal(scriptsLib.NATIVE_TOKEN);
    expect(frontend.NATIVE_TOKEN).to.equal(ethers.ZeroAddress);
  });

  it("hashes preimages identically", function () {
    expect(frontend.hashPreimage(secret)).to.equal(scriptsLib.hashPreimage(secret));
    expect(frontend.hashPreimage(secret)).to.equal(hashlock);
  });

  it("generates 32-byte secrets that open their own hashlock", function () {
    const generated = frontend.generateSecret();
    expect(generated).to.match(/^0x[0-9a-f]{64}$/);
    expect(frontend.hashPreimage(generated)).to.equal(scriptsLib.hashPreimage(generated));
  });

  it("derives the same MST leg swap id", function () {
    const leg = { sender: parties.alice, receiver: parties.bob, hashlock, timelock: 1_800_000_000n };
    expect(frontend.deriveMstLegSwapId(leg)).to.equal(scriptsLib.deriveMstLegSwapId(leg));
  });

  it("derives the same ETH leg swap id", function () {
    const leg = {
      sender: parties.bob,
      receiver: parties.alice,
      amount: ethers.parseEther("0.5"),
      hashlock,
      timelock: 1_799_999_000n,
    };
    expect(frontend.deriveEthLegSwapId(leg)).to.equal(scriptsLib.deriveEthLegSwapId(leg));
  });

  it("returns the same verifyLegPair verdict and issues", function () {
    const mst = {
      sender: parties.alice,
      receiver: parties.bob,
      amount: ethers.parseEther("100"),
      hashlock,
      timelock: 1_800_000_000n,
    };
    const eth = {
      sender: parties.bob,
      receiver: parties.alice,
      amount: ethers.parseEther("0.5"),
      hashlock,
      timelock: 1_799_999_000n,
    };
    const now = 1_700_000_000;

    const a = scriptsLib.verifyLegPair({ mst, eth, preimage: secret, now });
    const b = frontend.verifyLegPair({ mst, eth, preimage: secret, now });
    expect(b).to.deep.equal(a);
    expect(b.ok).to.equal(true);

    const bad = frontend.verifyLegPair({ mst, eth: { ...eth, hashlock: ethers.id("other") }, now });
    expect(bad).to.deep.equal(scriptsLib.verifyLegPair({ mst, eth: { ...eth, hashlock: ethers.id("other") }, now }));
    expect(bad.ok).to.equal(false);

    const stale = frontend.verifyLegPair({ mst, eth, now: 1_900_000_000, ignoreExpiry: true });
    expect(stale.ok).to.equal(true);
  });
});
