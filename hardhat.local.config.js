/**
 * LOCAL DRY-RUN CONFIG - not part of the submission, never committed.
 *
 * Maps the two testnet network names onto two local Hardhat nodes so the whole Task B flow can be
 * rehearsed without spending testnet funds:
 *
 *   npx hardhat node --port 8545
 *   npx hardhat node --port 8546
 *   npx hardhat run scripts/deploy.js --network sepolia --config hardhat.local.config.js
 *
 * Both nodes report chainId 31337, so the network entries below declare 31337 too.
 */
const base = require("./hardhat.config.js");

module.exports = {
  ...base,
  networks: {
    ...base.networks,
    sepolia: { ...base.networks.sepolia, url: "http://127.0.0.1:8545", chainId: 31337 },
    arbitrumSepolia: { ...base.networks.arbitrumSepolia, url: "http://127.0.0.1:8546", chainId: 31337 },
  },
};
