require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const {
  SEPOLIA_RPC_URL,
  ARBITRUM_SEPOLIA_RPC_URL,
  DEPLOYER_PRIVATE_KEY,
  ETHERSCAN_API_KEY,
  ARBISCAN_API_KEY,
  REPORT_GAS,
} = process.env;

// An empty array keeps `npx hardhat compile` / `npx hardhat test` working without a .env file.
const accounts = DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [];

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      // Sepolia and Arbitrum Sepolia both support the Shanghai opcodes, which is also the 0.8.20
      // default, so the compiler output is usable on both target chains.
      evmVersion: "shanghai",
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
    },
    localhost: {
      url: "http://127.0.0.1:8545",
    },
    // Member 1 target chain (ERC20HTLC)
    sepolia: {
      url: SEPOLIA_RPC_URL || "",
      accounts,
      chainId: 11155111,
    },
    // Member 2 target chain (ETHHTLC)
    arbitrumSepolia: {
      url: ARBITRUM_SEPOLIA_RPC_URL || "",
      accounts,
      chainId: 421614,
    },
  },
  etherscan: {
    apiKey: {
      sepolia: ETHERSCAN_API_KEY || "",
      arbitrumSepolia: ARBISCAN_API_KEY || "",
    },
  },
  gasReporter: {
    enabled: REPORT_GAS === "true",
    currency: "USD",
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  mocha: {
    timeout: 60000,
  },
};
