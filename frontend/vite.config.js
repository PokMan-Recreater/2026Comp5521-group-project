import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The root Hardhat project owns contracts/ and scripts/; this app only imports ethers and talks to the
// deployed contracts over JSON-RPC + MetaMask, so it builds completely independently of Hardhat.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  preview: { port: 4173 },
  build: { outDir: "dist", sourcemap: true },
});
