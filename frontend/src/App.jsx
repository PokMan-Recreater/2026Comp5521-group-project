import { useCallback, useEffect, useMemo, useState } from "react";

import { MaxUint256, parseEther, parseUnits } from "ethers";

import ActivityLog from "./components/ActivityLog";
import LegCard from "./components/LegCard";
import PairingPanel from "./components/PairingPanel";
import SwapSetup from "./components/SwapSetup";
import WalletBar from "./components/WalletBar";
import { CHAINS, DEFAULT_DEPLOYMENT, LEG_CHAIN } from "./lib/config";
import {
  approveMst,
  claimLeg,
  decodeError,
  fetchRevealedPreimage,
  isValidAddress,
  lockLeg,
  readAllowance,
  readLeg,
  readMstBalance,
  readMstMeta,
  readNativeBalance,
  refundLeg,
} from "./lib/contracts";
import { formatAmount, formatDuration, nowSeconds, shortAddress, shortHash } from "./lib/format";
import {
  createSwapRecord,
  exportSwap,
  loadDeployment,
  loadSettings,
  loadSwaps,
  parseImportedSwap,
  patchLeg,
  saveDeployment,
  saveSettings,
  saveSwaps,
} from "./lib/store";
import { generateSecret, hashPreimage, verifyLegPair } from "./lib/swapId";
import {
  connectWallet,
  hasWallet,
  silentAccounts,
  signer as walletSigner,
  switchChain,
  walletChainId,
  watchWallet,
} from "./lib/wallet";

const EMPTY_VIEW = { mst: null, eth: null, mstBalance: null, ethBalance: null };

export default function App() {
  const [account, setAccount] = useState(null);
  const [chainId, setChainId] = useState(null);
  const [deployment, setDeployment] = useState(loadDeployment);
  const [settings, setSettings] = useState(loadSettings);
  const [swaps, setSwaps] = useState(loadSwaps);
  const [selectedId, setSelectedId] = useState(() => (loadSwaps()[0] ? loadSwaps()[0].id : null));
  const [view, setView] = useState(EMPTY_VIEW);
  const [mstMeta, setMstMeta] = useState({ symbol: "MST", decimals: 18 });
  const [busy, setBusy] = useState(null);
  const [activity, setActivity] = useState([]);
  const [notice, setNotice] = useState(null);
  const [now, setNow] = useState(nowSeconds);
  const [showSettings, setShowSettings] = useState(false);

  const selected = useMemo(() => swaps.find((swap) => swap.id === selectedId) || null, [swaps, selectedId]);
  const preimage = selected?.legs?.eth?.revealedPreimage || selected?.preimage || null;
  const mstRecordLeg = selected?.legs?.mst ?? null;
  const ethRecordLeg = selected?.legs?.eth ?? null;

  useEffect(() => {
    saveSwaps(swaps);
  }, [swaps]);
  useEffect(() => {
    saveDeployment(deployment);
  }, [deployment]);
  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  // one clock for every countdown on the page
  useEffect(() => {
    const timer = setInterval(() => setNow(nowSeconds()), 1000);
    return () => clearInterval(timer);
  }, []);

  // wallet: restore a silent connection and follow account/chain changes
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!hasWallet()) return;
      const accounts = await silentAccounts();
      if (!cancelled && accounts[0]) setAccount(accounts[0]);
      const id = await walletChainId();
      if (!cancelled) setChainId(id);
    })();

    const unwatch = watchWallet({
      onAccounts: (accounts) => setAccount(accounts[0] || null),
      onChain: (id) => setChainId(id),
    });
    return () => {
      cancelled = true;
      unwatch();
    };
  }, []);

  /** Reads both legs plus both balances from the chains (no wallet needed). */
  const refresh = useCallback(async () => {
    try {
      const [mst, eth, mstBalance, ethBalance, meta] = await Promise.all([
        readLeg({ deployment, leg: "mst", swapId: selected?.legs?.mst?.swapId ?? null }),
        readLeg({ deployment, leg: "eth", swapId: selected?.legs?.eth?.swapId ?? null }),
        readMstBalance({ deployment, account }),
        readNativeBalance({ account }),
        readMstMeta({ deployment }),
      ]);
      setView({ mst, eth, mstBalance, ethBalance });
      setMstMeta(meta);
    } catch (error) {
      setNotice({ tone: "error", text: decodeError(error) });
    }
  }, [deployment, account, selected]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const timer = setInterval(() => refresh(), 15_000);
    return () => clearInterval(timer);
  }, [refresh]);

  // once the ETH leg is claimed its preimage is public: pick it up from the chain, not from a file
  useEffect(() => {
    const record = selected;
    if (!record || !record.legs?.eth?.swapId || record.legs.eth.revealedPreimage) return undefined;

    let cancelled = false;
    (async () => {
      try {
        const revealed = await fetchRevealedPreimage({
          deployment,
          leg: "eth",
          swapId: record.legs.eth.swapId,
          fromBlock: record.legs.eth.blockNumber || 0,
        });
        if (!cancelled && revealed) setSwaps((list) => patchLeg(list, record.id, "eth", { revealedPreimage: revealed }));
      } catch {
        // not claimed yet (or the RPC is busy) - retried on the next refresh tick
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [deployment, selected]);

  function pushActivity(entry) {
    setActivity((list) =>
      [{ key: `${Date.now()}-${list.length}`, at: new Date().toLocaleTimeString(), ...entry }, ...list].slice(0, 30)
    );
  }

  /** Makes sure the wallet is on the chain the next transaction must go to. */
  async function ensureChain(chain) {
    const current = await walletChainId();
    if (current === chain.chainId) return;
    await switchChain(chain);
    const after = await walletChainId();
    if (after !== chain.chainId) throw new Error(`Switch the wallet to ${chain.label} to continue.`);
    setChainId(after);
  }

  /** Wraps one transaction: busy state, activity entry, error decoding, then a state refresh. */
  async function run(label, chainKey, action) {
    setBusy(label);
    setNotice(null);
    try {
      const signer = await walletSigner();
      const result = await action(signer);
      pushActivity({ label, status: "ok", chainKey, hash: result && result.txHash });
      await refresh();
      return result;
    } catch (error) {
      const message = decodeError(error);
      pushActivity({ label, status: "error", message });
      setNotice({ tone: "error", text: message });
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function handleConnect() {
    try {
      const address = await connectWallet();
      setAccount(address);
      setChainId(await walletChainId());
    } catch (error) {
      setNotice({ tone: "error", text: decodeError(error) });
    }
  }

  async function handleSwitch(chain) {
    try {
      await ensureChain(chain);
    } catch (error) {
      setNotice({ tone: "error", text: decodeError(error) });
    }
  }

  /** Step 1: generate the secret locally, approve MST, lock the MST leg. */
  async function handleCreate(payload) {
    if (!account) {
      setNotice({ tone: "error", text: "Connect a wallet first." });
      return;
    }

    const secret = generateSecret();
    const hashlock = hashPreimage(secret);
    const mstAmount = parseUnits(payload.mstAmount, mstMeta.decimals ?? 18);
    const ethAmount = parseEther(payload.ethAmount);
    const mstTimelock = BigInt(nowSeconds() + payload.mstTimelock);

    const created = await run("Approve + lock MST leg", "sepolia", async (signer) => {
      await ensureChain(CHAINS.sepolia);
      const owner = await signer.getAddress();
      const allowance = await readAllowance({ deployment, owner });
      if (allowance === null || allowance < mstAmount) {
        await approveMst({ signer, deployment, amount: MaxUint256 });
      }
      return lockLeg({
        signer,
        deployment,
        leg: "mst",
        receiver: payload.counterparty,
        amount: mstAmount,
        hashlock,
        timelock: mstTimelock,
      });
    });
    if (!created) return;

    const record = createSwapRecord({
      hashlock,
      preimage: secret,
      mstAmount: mstAmount.toString(),
      ethAmount: ethAmount.toString(),
      ethTimelock: payload.ethTimelock,
      mstTimelock: payload.mstTimelock,
      counterparty: payload.counterparty,
    });
    record.legs.mst = {
      swapId: created.swapId,
      txHash: created.txHash,
      blockNumber: created.blockNumber,
      timelock: mstTimelock.toString(),
      amount: mstAmount.toString(),
      sender: account,
      receiver: payload.counterparty,
    };

    setSwaps((list) => [record, ...list]);
    setSelectedId(record.id);
    setSettings({
      ...settings,
      counterparty: payload.counterparty,
      ethTimelock: payload.ethTimelock,
      mstTimelock: payload.mstTimelock,
    });
    setNotice({
      tone: "good",
      text: "MST leg locked. Send the swap to the counterparty (Copy swap JSON) so they can fund the ETH leg.",
    });
  }

  /** Step 2: the ETH owner funds the shorter leg; the receiver is taken from the MST leg on chain. */
  async function handleLockEth() {
    if (!selected) return;
    const mstSwap = view.mst;
    if (!mstSwap) {
      setNotice({ tone: "error", text: "The MST leg must be locked before the ETH leg can be funded." });
      return;
    }
    if (mstSwap.status !== 1) {
      setNotice({ tone: "error", text: "The MST leg is no longer open, so there is nothing to swap against." });
      return;
    }

    const currentTime = nowSeconds();
    if (currentTime >= Number(mstSwap.timelock)) {
      setNotice({
        tone: "error",
        text: "The MST leg has already expired - start a new swap instead of funding the ETH leg.",
      });
      return;
    }

    const amount = BigInt(selected.amounts.eth);
    const timelock = BigInt(currentTime + Number(selected.offsets.eth));
    if (timelock >= mstSwap.timelock) {
      setNotice({
        tone: "error",
        text: `An ETH deadline of +${formatDuration(
          Number(selected.offsets.eth)
        )} would land after the MST deadline. Use a shorter ETH offset, or restart with a longer MST deadline.`,
      });
      return;
    }

    const result = await run("Lock ETH leg", "arbitrumSepolia", async (signer) => {
      await ensureChain(CHAINS.arbitrumSepolia);
      return lockLeg({
        signer,
        deployment,
        leg: "eth",
        receiver: mstSwap.sender, // on-chain truth: the MST sender receives the ETH
        amount,
        hashlock: selected.hashlock,
        timelock,
      });
    });
    if (!result) return;

    setSwaps((list) =>
      patchLeg(list, selected.id, "eth", {
        swapId: result.swapId,
        txHash: result.txHash,
        blockNumber: result.blockNumber,
        timelock: timelock.toString(),
        amount: amount.toString(),
        sender: account,
        receiver: mstSwap.sender,
      })
    );
    setNotice({ tone: "good", text: "Both legs are funded - the pair is atomic now. Verify it below, then claim." });
  }

  /** Claim a leg. The preimage comes from the ETH leg's claim event, never from a shared file. */
  async function handleClaim(leg) {
    if (!selected) return;
    const swap = leg === "mst" ? view.mst : view.eth;
    if (!swap) return;

    let secret = preimage;
    if (!secret && selected.legs?.eth?.swapId) {
      try {
        secret = await fetchRevealedPreimage({
          deployment,
          leg: "eth",
          swapId: selected.legs.eth.swapId,
          fromBlock: selected.legs.eth.blockNumber || 0,
        });
      } catch {
        // not claimed yet
      }
    }
    if (!secret) {
      setNotice({
        tone: "error",
        text: "No preimage yet: it becomes public when the ETH leg is claimed, and that claim has to happen first.",
      });
      return;
    }
    if (hashPreimage(secret) !== swap.hashlock.toLowerCase()) {
      setNotice({ tone: "error", text: "That preimage does not open this hashlock - refusing to claim." });
      return;
    }

    const chain = LEG_CHAIN[leg];
    const result = await run(`Claim ${leg === "mst" ? "MST" : "ETH"} leg`, chain.key, async (signer) => {
      await ensureChain(chain);
      return claimLeg({ signer, deployment, leg, swapId: swap.swapId, preimage: secret });
    });
    if (!result) return;

    setSwaps((list) =>
      patchLeg(list, selected.id, leg, {
        status: 2,
        claimTxHash: result.txHash,
        revealedPreimage: result.revealedPreimage || secret,
      })
    );
    setNotice({
      tone: "good",
      text:
        leg === "eth"
          ? "ETH claimed. The preimage is now public on Arbitrum Sepolia - the MST receiver can settle the other leg."
          : "MST claimed. Both legs are settled: the swap is complete.",
    });
  }

  /** Refund an expired leg to its sender. */
  async function handleRefund(leg) {
    if (!selected) return;
    const swap = leg === "mst" ? view.mst : view.eth;
    if (!swap) return;

    const chain = LEG_CHAIN[leg];
    const result = await run(`Refund ${leg === "mst" ? "MST" : "ETH"} leg`, chain.key, async (signer) => {
      await ensureChain(chain);
      return refundLeg({ signer, deployment, leg, swapId: swap.swapId });
    });
    if (!result) return;

    setSwaps((list) => patchLeg(list, selected.id, leg, { status: 3, refundTxHash: result.txHash }));
    setNotice({ tone: "good", text: "Refunded: the funds are back with the sender of that leg." });
  }

  function handleImport(text) {
    const record = parseImportedSwap(text);
    setSwaps((list) => [record, ...list.filter((swap) => swap.id !== record.id)]);
    setSelectedId(record.id);
    setNotice({ tone: "good", text: "Swap imported. Fund your ETH leg from the card on the right." });
  }

  async function handleCopy() {
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(exportSwap(selected));
      setNotice({ tone: "good", text: "Swap JSON copied - send it to the counterparty." });
    } catch {
      setNotice({ tone: "error", text: "The browser blocked the clipboard; the JSON is shown in the swap details." });
    }
  }

  // ---- derived view data -------------------------------------------------

  const pairOk =
    view.mst && view.eth
      ? verifyLegPair({
          mst: view.mst,
          eth: view.eth,
          preimage: preimage || undefined,
          now,
          ignoreExpiry: view.mst.status !== 1 || view.eth.status !== 1,
        }).ok
      : false;

  const steps = [
    { label: "Secret generated and MST leg locked", done: Boolean(view.mst) },
    { label: "ETH leg funded with the same hashlock", done: Boolean(view.eth) },
    { label: "Pairing verified", done: pairOk },
    { label: "ETH claimed - preimage now public", done: Boolean(view.eth) && view.eth.status === 2 },
    { label: "MST claimed - swap complete", done: Boolean(view.mst) && view.mst.status === 2 },
  ];
  const nextStep = steps.findIndex((step) => !step.done);
  const noticeTone = notice ? (notice.tone === "good" ? "good" : notice.tone === "warn" ? "warn" : "error") : null;

  return (
    <div className="shell">
      <header className="masthead">
        <div className="brand">
          <span className="brand__mark" aria-hidden="true">
            ⇄
          </span>
          <div>
            <h1>Cross-chain HTLC swap console</h1>
            <p>MST on Ethereum Sepolia ⇄ native ETH on Arbitrum Sepolia · COMP 5521</p>
          </div>
        </div>
        <span className="pill pill--muted">Task C · web interface</span>
      </header>

      {!hasWallet() && (
        <div className="banner banner--warn" style={{ marginTop: 16 }}>
          <span aria-hidden="true">!</span>
          <span>
            No injected wallet detected. Install MetaMask (or any EIP-1193 wallet) to send transactions - the panels stay
            readable without one.
          </span>
        </div>
      )}

      <div className="layout">
        <div className="stack">
          <WalletBar
            account={account}
            chainId={chainId}
            mstMeta={mstMeta}
            mstBalance={view.mstBalance}
            ethBalance={view.ethBalance}
            busy={busy}
            onConnect={handleConnect}
            onSwitch={handleSwitch}
            onOpenSettings={() => setShowSettings((open) => !open)}
          />

          {notice && (
            <div className={`banner banner--${noticeTone}`} role="status">
              <span aria-hidden="true">{noticeTone === "good" ? "✓" : "!"}</span>
              <span>{notice.text}</span>
            </div>
          )}

          {showSettings && (
            <section className="card" aria-labelledby="settings-title">
              <div className="card__head">
                <h2 className="card__title" id="settings-title">
                  Contract addresses
                </h2>
                <button type="button" className="linkish" onClick={() => setShowSettings(false)}>
                  close
                </button>
              </div>
              <div className="card__body">
                <p className="hint">
                  Paste the addresses printed by <code>npx hardhat run scripts/deploy.js</code>. They stay in this browser;
                  anything left empty falls back to <code>frontend/.env</code>.
                </p>
                {[
                  ["mstToken", "MST token · Sepolia"],
                  ["erc20Htlc", "ERC20HTLC · Sepolia"],
                  ["ethHtlc", "ETHHTLC · Arbitrum Sepolia"],
                ].map(([key, label]) => (
                  <label className="field" key={key}>
                    <span>{label}</span>
                    <input
                      className="mono"
                      value={deployment[key] || ""}
                      onChange={(event) => setDeployment({ ...deployment, [key]: event.target.value.trim() })}
                      placeholder="0x…"
                      spellCheck="false"
                    />
                    <small>{isValidAddress(deployment[key]) ? "valid address" : "not set or invalid"}</small>
                  </label>
                ))}
                <div className="row">
                  <button type="button" className="btn btn--sm" onClick={() => setDeployment(DEFAULT_DEPLOYMENT)}>
                    Reset to .env defaults
                  </button>
                </div>
              </div>
            </section>
          )}

          <SwapSetup
            account={account}
            mstMeta={mstMeta}
            settings={settings}
            busy={busy}
            onCreate={handleCreate}
            onImport={handleImport}
          />
          {swaps.length > 0 && (
            <section className="card" aria-labelledby="swaps-title">
              <div className="card__head">
                <h2 className="card__title" id="swaps-title">
                  Your swaps
                </h2>
                <span className="pill pill--muted">{swaps.length}</span>
              </div>
              <div className="card__body">
                <ul className="log">
                  {swaps.map((swap) => (
                    <li
                      key={swap.id}
                      className="log__item"
                      style={swap.id === selectedId ? { borderColor: "rgba(34,211,238,0.6)" } : undefined}
                    >
                      <div className="log__top">
                        <button type="button" className="linkish" onClick={() => setSelectedId(swap.id)}>
                          {swap.id}
                        </button>
                        <span className="faint mono">{shortHash(swap.hashlock)}</span>
                      </div>
                      <span className="faint">created {new Date(swap.createdAt).toLocaleString()}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          )}

          <section className="card" aria-labelledby="activity-title">
            <div className="card__head">
              <h2 className="card__title" id="activity-title">
                Activity
              </h2>
              <span className="pill pill--muted">{activity.length}</span>
            </div>
            <div className="card__body">
              <ActivityLog entries={activity} />
            </div>
          </section>
        </div>

        <div className="stack">
          {selected ? (
            <section className="card" aria-labelledby="selected-title">
              <div className="card__head">
                <h2 className="card__title" id="selected-title">
                  {selected.id}
                </h2>
                <div className="row">
                  <button type="button" className="btn btn--sm" onClick={handleCopy}>
                    Copy swap JSON
                  </button>
                  <button type="button" className="btn btn--sm btn--ghost" onClick={() => refresh()}>
                    Refresh
                  </button>
                </div>
              </div>
              <div className="card__body">
                <dl className="kv">
                  <div>
                    <dt>Hashlock</dt>
                    <dd className="mono" title={selected.hashlock}>
                      {shortHash(selected.hashlock)}
                    </dd>
                  </div>
                  <div>
                    <dt>Preimage</dt>
                    <dd className="mono">{preimage ? shortHash(preimage) : "not public yet"}</dd>
                  </div>
                  <div>
                    <dt>Amounts</dt>
                    <dd className="num">
                      {formatAmount(selected.amounts.mst, mstMeta.decimals)} {mstMeta.symbol} ⇄{" "}
                      {formatAmount(selected.amounts.eth, 18)} ETH
                    </dd>
                  </div>
                  <div>
                    <dt>Counterparty</dt>
                    <dd className="mono">
                      {selected.counterparty ? shortAddress(selected.counterparty, 5) : "provided on import"}
                    </dd>
                  </div>
                </dl>

                <ol className="steps">
                  {steps.map((step, index) => (
                    <li key={step.label} className={step.done ? "is-done" : index === nextStep ? "is-active" : undefined}>
                      {step.label}
                    </li>
                  ))}
                </ol>
              </div>
            </section>
          ) : (
            <section className="card">
              <div className="card__body">
                <p className="hint">No swap selected. Create one on the left, or import one the counterparty exported.</p>
              </div>
            </section>
          )}


          <LegCard
            leg="mst"
            swap={view.mst}
            recordLeg={mstRecordLeg}
            account={account}
            now={now}
            decimals={mstMeta.decimals}
            busy={busy}
            onClaim={() => handleClaim("mst")}
            onRefund={() => handleRefund("mst")}
          />

          <LegCard
            leg="eth"
            swap={view.eth}
            recordLeg={ethRecordLeg}
            account={account}
            now={now}
            decimals={mstMeta.decimals}
            busy={busy}
            onClaim={() => handleClaim("eth")}
            onRefund={() => handleRefund("eth")}
            onLock={selected ? handleLockEth : undefined}
          />

          <section className="card" aria-labelledby="pairing-title">
            <div className="card__head">
              <h2 className="card__title" id="pairing-title">
                Atomicity check
              </h2>
              <span className={`pill ${pairOk ? "pill--good" : "pill--muted"}`}>
                <span className="dot" />
                {pairOk ? "pair valid" : "waiting"}
              </span>
            </div>
            <div className="card__body">
              <PairingPanel
                mstSwap={view.mst}
                ethSwap={view.eth}
                preimage={selected ? selected.preimage : null}
                revealedPreimage={ethRecordLeg?.revealedPreimage ?? null}
                now={now}
              />
            </div>
          </section>
        </div>
      </div>

      {busy && (
        <div className="busy" role="status">
          <div className="busy__inner">
            <span className="spinner" aria-hidden="true" />
            {busy} - confirm in your wallet…
          </div>
        </div>
      )}

      <footer className="footer">
        <span>
          The secret is generated in this browser and stored in <code>localStorage</code>; only the hashlock ever leaves it.
        </span>
        <span>Two independent chains, no bridge, no relayer, no oracle - a shared hashlock and two ordered timelocks.</span>
      </footer>
    </div>
  );
}

