# HTLC swap console — Task C frontend

Web interface for the COMP 5521 cross-chain atomic swap: **MST on Ethereum Sepolia ⇄ native ETH on Arbitrum
Sepolia**. It drives the two contracts from `contracts/` and mirrors the CLI run book in the root `README.md`
§12, with the same safety checks performed in the browser.

```
frontend/
├─ index.html
├─ vite.config.js
├─ .env.example
└─ src/
   ├─ App.jsx                    # orchestration: state machine, handlers, layout
   ├─ components/
   │  ├─ WalletBar.jsx           # connect, chain badge, both balances, settings toggle
   │  ├─ SwapSetup.jsx           # create a swap (MST owner) / import one (ETH owner)
   │  ├─ LegCard.jsx             # one leg: status, countdown, role-gated actions
   │  ├─ PairingPanel.jsx        # the four atomicity rules, live
   │  └─ ActivityLog.jsx         # every transaction with its explorer link
   └─ lib/
      ├─ config.js               # chains, contract addresses, demo defaults
      ├─ wallet.js               # MetaMask connect / chain switching / events
      ├─ contracts.js            # one ABI for both legs, reads, writes, error decoding
      ├─ swapId.js               # browser mirror of scripts/lib/swapId.js (parity-tested)
      ├─ store.js                # swap records + addresses in localStorage
      └─ format.js               # amount / duration / status formatting
```

## Run it

```bash
cd frontend
npm install
cp .env.example .env      # fill in the three addresses printed by scripts/deploy.js
npm run dev               # http://localhost:5173
```

`npm run build` produces a static bundle in `dist/`; it needs no backend and no API keys — the browser reads
each chain through its own public JSON-RPC endpoint and signs through MetaMask.

Contract addresses can also be pasted into the **Settings** panel at runtime (kept in `localStorage`), which
is handy right after a fresh deployment when you do not want to rebuild the bundle.

## What the interface does

| Task C requirement | Where |
| --- | --- |
| wallet connection + network switching | `WalletBar`, `lib/wallet.js` (`wallet_switchEthereumChain`, adds the chain if the wallet does not know it) |
| swap setup, MST approval, state display | `SwapSetup` + `LegCard` (amounts, timelocks, hashlock, sender/receiver, both balances) |
| swap and recovery workflow | the stepper in `App` + the per-leg actions: lock → verify → claim → (or refund after the deadline) |
| transaction progress, errors, explorer links | `ActivityLog` + `lib/contracts.js#decodeError` (decodes all 15 custom errors into sentences) |

Two design decisions worth knowing:

1. **Roles come from the chain, not from a "I am Alice/Bob" switch.** The connected account is compared with
   the on-chain `sender` / `receiver` of each leg, so every button explains itself: "only the swap receiver
   can claim this leg", "you are the sender and the deadline has passed", and so on. Switching the MetaMask
   account flips the UI to the other party automatically.
2. **The secret travels through the chain.** The ETH owner does not need the preimage: `fetchRevealedPreimage`
   reads it from the `SwapClaimed` event of the ETH leg once that leg is claimed. That is exactly the atomic
   reveal the protocol is built on, and it is why the MST claim button stays disabled until the ETH claim
   exists.

## Demo script (two accounts, one browser)

1. Connect **Alice**, create a swap: MST amount, ETH amount, Bob's address, ETH deadline 90 s, MST deadline
   240 s → confirms *approve* + *createSwap* on Sepolia.
2. Click **Copy swap JSON**, switch MetaMask to **Bob**, paste it into *Join a swap*, then press **Lock ETH**
   (the app switches the wallet to Arbitrum Sepolia by itself and reads the receiver from the MST leg).
3. The **Atomicity check** panel turns green: one hashlock, crossed parties, ETH expires first, preimage
   matches.
4. Switch back to **Alice** → *Claim ETH* (this reveals the preimage in the transaction log).
5. Switch to **Bob** → *Claim MST* (the preimage is picked up from the ETH chain).
6. For the recovery path, repeat 1–2 with a short MST deadline and press **Refund** on each leg after its own
   deadline passes — the buttons only appear when the contract would accept the call.

Keep both deadlines short for a live demo but never invert them: the UI refuses to create a swap whose ETH
deadline is not strictly shorter than the MST deadline, and `verifyLegPair` would flag the pair as invalid.
