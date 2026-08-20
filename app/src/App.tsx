import { useEffect, useState } from "react";
import {
  Activity,
  ArrowUpRight,
  BadgeCheck,
  Check,
  ChevronRight,
  CircleAlert,
  CircleDollarSign,
  ClipboardCheck,
  Clock3,
  FileCheck2,
  Link2,
  LoaderCircle,
  LockKeyhole,
  Radar,
  RefreshCw,
  ScanLine,
  Server,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import { createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";

type Eip1193Provider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

type Installation = {
  install_id: number;
  client: string;
  installer: string;
  sla_spec: string;
  expires_at: number;
  amount_atto: string;
  status: string;
  decision: string;
  confidence_bps: number;
  diagnostics_digest: string;
  reason: string;
  verified_at: number;
  reclaimed_at: number;
  payout_atto: string;
  expired: boolean;
};

type Accounting = {
  atto_scale: number;
  bps_scale: number;
  escrow_balance_atto: string;
  total_funded_atto: string;
  total_claimable_atto: string;
  total_claimed_atto: string;
  total_reclaimed_atto: string;
  total_verified_atto: string;
  accounting_invariant: boolean;
  next_install_id: number;
};

type Notice = {
  tone: "good" | "bad" | "neutral";
  message: string;
};

const CONTRACT_ADDRESS = import.meta.env.VITE_INSTALL_SHIELD_ADDRESS ?? "";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ATTO_SCALE = 10n ** 18n;
const DEFAULT_SLA =
  "8 cameras, 5MP minimum, 8-channel NVR, remote health logs enabled";
const DEFAULT_DIAGNOSTICS =
  "NVR channels 1-8 online; cameras report 5MP; health API status OK";

const readClient = createClient({ chain: studionet });

function isValidContractAddress(address: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(address) && address !== ZERO_ADDRESS;
}

function shortAddress(address: string): string {
  if (!address) return "not connected";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatAtto(value: string | bigint | undefined): string {
  if (value === undefined) return "0.0000";
  const atto = typeof value === "bigint" ? value : BigInt(value || "0");
  const whole = atto / ATTO_SCALE;
  const fraction = (atto % ATTO_SCALE).toString().padStart(18, "0").slice(0, 4);
  return `${whole.toString()}.${fraction}`;
}

function parseGen(value: string): bigint {
  const cleaned = value.trim();
  if (!/^\d+(\.\d{1,18})?$/.test(cleaned)) {
    throw new Error("Enter a GEN amount with up to 18 decimal places");
  }
  const [whole, fraction = ""] = cleaned.split(".");
  return BigInt(whole) * ATTO_SCALE + BigInt(fraction.padEnd(18, "0"));
}

function formatDate(timestamp: number): string {
  if (!timestamp) return "--";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestamp * 1000));
}

function statusClass(status: string): string {
  return status.toLowerCase().replaceAll("_", "-");
}

function asInstallation(value: unknown): Installation {
  return value as Installation;
}

function asAccounting(value: unknown): Accounting {
  return value as Accounting;
}

export default function App() {
  const [walletAddress, setWalletAddress] = useState("");
  const [walletProvider, setWalletProvider] = useState<Eip1193Provider | null>(null);
  const [walletBusy, setWalletBusy] = useState(false);
  const [walletError, setWalletError] = useState("");
  const [accounting, setAccounting] = useState<Accounting | null>(null);
  const [installation, setInstallation] = useState<Installation | null>(null);
  const [lookupId, setLookupId] = useState("1");
  const [amount, setAmount] = useState("1.25");
  const [installer, setInstaller] = useState("");
  const [sla, setSla] = useState(DEFAULT_SLA);
  const [expiresAt, setExpiresAt] = useState(() => {
    const value = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    value.setSeconds(0, 0);
    return value.toISOString().slice(0, 16);
  });
  const [diagnostics, setDiagnostics] = useState(DEFAULT_DIAGNOSTICS);
  const [busyAction, setBusyAction] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  // Per-account claimable balance for the connected wallet. This gates the
  // payout button and is distinct from the global ledger total below.
  const [claimable, setClaimable] = useState("0");

  const contractReady = isValidContractAddress(CONTRACT_ADDRESS);
  const canWrite = contractReady && Boolean(walletAddress && walletProvider);
  const writeClient = canWrite
    ? createClient({
        chain: studionet,
        account: walletAddress as `0x${string}`,
        provider: walletProvider,
      })
    : null;

  async function refreshAccounting() {
    if (!contractReady) return;
    try {
      const result = await readClient.readContract({
        address: CONTRACT_ADDRESS as `0x${string}`,
        functionName: "get_accounting",
        args: [],
      });
      setAccounting(asAccounting(result));
    } catch (error) {
      setNotice({ tone: "bad", message: errorMessage(error, "Ledger read failed") });
    }
  }

  async function refreshClaimable(address = walletAddress) {
    // Read the connected account's own claimable balance via get_claimable so
    // the payout button reflects this wallet's funds, never the global ledger.
    if (!contractReady || !isValidContractAddress(address)) {
      setClaimable("0");
      return;
    }
    try {
      const result = await readClient.readContract({
        address: CONTRACT_ADDRESS as `0x${string}`,
        functionName: "get_claimable",
        args: [address],
      });
      setClaimable(String(result ?? "0"));
    } catch {
      setClaimable("0");
    }
  }

  async function loadInstallation(id = lookupId) {
    if (!contractReady) return;
    const parsedId = Number(id);
    if (!Number.isInteger(parsedId) || parsedId < 1) {
      setNotice({ tone: "bad", message: "Enter a positive installation ID" });
      return;
    }
    setBusyAction("load");
    try {
      const result = await readClient.readContract({
        address: CONTRACT_ADDRESS as `0x${string}`,
        functionName: "get_installation",
        args: [BigInt(parsedId)],
      });
      setInstallation(asInstallation(result));
      setLookupId(String(parsedId));
      setNotice({ tone: "good", message: `Installation #${parsedId} loaded` });
    } catch (error) {
      setInstallation(null);
      setNotice({ tone: "bad", message: errorMessage(error, "Installation not found") });
    } finally {
      setBusyAction("");
    }
  }

  useEffect(() => {
    void refreshAccounting();
    const interval = window.setInterval(() => void refreshAccounting(), 12_000);
    return () => window.clearInterval(interval);
  }, [contractReady]);

  useEffect(() => {
    void refreshClaimable();
    const interval = window.setInterval(() => void refreshClaimable(), 12_000);
    return () => window.clearInterval(interval);
  }, [contractReady, walletAddress]);

  async function connectWallet() {
    const provider = (window as Window & { ethereum?: Eip1193Provider }).ethereum;
    if (!provider) {
      setWalletError("No browser wallet detected");
      return;
    }
    setWalletBusy(true);
    setWalletError("");
    try {
      const accounts = (await provider.request({
        method: "eth_requestAccounts",
      })) as string[];
      const account = accounts[0] ?? "";
      if (!account) throw new Error("Wallet returned no account");
      const client = createClient({
        chain: studionet,
        account: account as `0x${string}`,
        provider,
      });
      await client.connect("studionet");
      setWalletProvider(provider);
      setWalletAddress(account);
      setInstaller((value) => value || account);
      await refreshClaimable(account);
      setNotice({ tone: "good", message: "Wallet connected to GenLayer StudioNet" });
    } catch (error) {
      setWalletError(errorMessage(error, "Wallet connection failed"));
    } finally {
      setWalletBusy(false);
    }
  }

  async function submitTransaction(
    action: string,
    functionName: string,
    args: Array<string | bigint>,
    value = 0n,
  ) {
    if (!writeClient) {
      setNotice({ tone: "bad", message: "Connect a wallet before writing" });
      return null;
    }
    setBusyAction(action);
    try {
      await writeClient.connect("studionet");
      const hash = await writeClient.writeContract({
        address: CONTRACT_ADDRESS as `0x${string}`,
        functionName,
        args,
        value,
      });
      await readClient.waitForTransactionReceipt({
        hash,
        status: TransactionStatus.ACCEPTED,
      });
      setNotice({ tone: "good", message: `${action} accepted on studionet` });
      await refreshAccounting();
      await refreshClaimable();
      return hash;
    } catch (error) {
      setNotice({ tone: "bad", message: errorMessage(error, `${action} failed`) });
      return null;
    } finally {
      setBusyAction("");
    }
  }

  async function createInstallation(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const amountAtto = parseGen(amount);
      const deadline = Math.floor(new Date(expiresAt).getTime() / 1000);
      const hash = await submitTransaction(
        "Installation funding",
        "create_installation",
        [installer, sla, BigInt(deadline)],
        amountAtto,
      );
      if (!hash) return;
      const refreshed = await readClient.readContract({
        address: CONTRACT_ADDRESS as `0x${string}`,
        functionName: "get_accounting",
        args: [],
      });
      const nextId = asAccounting(refreshed).next_install_id - 1;
      setLookupId(String(nextId));
      await loadInstallation(String(nextId));
    } catch (error) {
      setNotice({ tone: "bad", message: errorMessage(error, "Check the funding fields") });
    }
  }

  async function verifyInstallation(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!installation) {
      setNotice({ tone: "bad", message: "Load an installation before submitting evidence" });
      return;
    }
    const hash = await submitTransaction(
      "Consensus verification",
      "verify_installation",
      [BigInt(installation.install_id), diagnostics],
    );
    if (hash) await loadInstallation(String(installation.install_id));
  }

  async function reclaimInstallation() {
    if (!installation) return;
    const hash = await submitTransaction(
      "Expiry reclaim",
      "reclaim_funds",
      [BigInt(installation.install_id)],
    );
    if (hash) await loadInstallation(String(installation.install_id));
  }

  async function claimFunds() {
    const hash = await submitTransaction("Payout claim", "claim_funds", []);
    if (hash) {
      await refreshAccounting();
      await refreshClaimable();
    }
  }

  const isLoading = Boolean(busyAction);
  const status = installation?.status ?? "NO RECORD";
  const totalClaimable = accounting?.total_claimable_atto ?? "0";
  const hasClaimable = (() => {
    try {
      return BigInt(claimable) > 0n;
    } catch {
      return false;
    }
  })();

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="InstallShield home">
          <span className="brand-mark"><ShieldCheck size={18} strokeWidth={2.5} /></span>
          <span>installshield</span>
        </a>
        <div className="topbar-meta">
          <span className="network-status"><span className="status-dot" /> studionet</span>
          <span className="contract-address" title={CONTRACT_ADDRESS || "Contract address not configured"}>
            <Link2 size={14} /> {contractReady ? shortAddress(CONTRACT_ADDRESS) : "address needed"}
          </span>
          <button className="wallet-button" type="button" onClick={() => void connectWallet()} disabled={walletBusy}>
            {walletBusy ? <LoaderCircle className="spin" size={16} /> : <Wallet size={16} />}
            {walletAddress ? shortAddress(walletAddress) : "Connect wallet"}
          </button>
        </div>
      </header>

      <main>
        <section className="intro-band">
          <div className="intro-copy">
            <div className="eyebrow"><Radar size={14} /> FIELD CONSOLE / 001</div>
            <h1>Installation escrow</h1>
            <p>One handoff. One evidence trail. Funds move when the work is verifiable.</p>
          </div>
          <div className="intro-readout">
            <div className="readout-label"><Activity size={14} /> NETWORK PULSE</div>
            <strong>{contractReady ? "READY" : "CONFIG REQUIRED"}</strong>
            <span>{contractReady ? "reading the ledger" : "set VITE_INSTALL_SHIELD_ADDRESS"}</span>
          </div>
        </section>

        {(walletError || notice) && (
          <div className={`notice ${walletError ? "bad" : notice?.tone ?? "neutral"}`} role="status">
            {walletError || notice?.message}
            {walletError && <button type="button" onClick={() => setWalletError("")} aria-label="Dismiss wallet error">x</button>}
          </div>
        )}

        <section className="ledger-strip" aria-label="Escrow ledger summary">
          <div className="ledger-heading">
            <span className="section-kicker">LIVE LEDGER</span>
            <span className={`invariant ${accounting?.accounting_invariant ? "valid" : ""}`}>
              <span className="status-dot" /> {accounting ? (accounting.accounting_invariant ? "balanced" : "check required") : "waiting"}
            </span>
          </div>
          <Metric icon={<LockKeyhole size={17} />} label="Locked in escrow" value={`${formatAtto(accounting?.escrow_balance_atto)} GEN`} accent="mint" />
          <Metric icon={<CircleDollarSign size={17} />} label="Claimable" value={`${formatAtto(totalClaimable)} GEN`} accent="gold" />
          <Metric icon={<BadgeCheck size={17} />} label="Verified volume" value={`${formatAtto(accounting?.total_verified_atto)} GEN`} accent="blue" />
          <Metric icon={<RefreshCw size={17} />} label="Reclaimed volume" value={`${formatAtto(accounting?.total_reclaimed_atto)} GEN`} accent="coral" />
        </section>

        <div className="workspace-grid">
          <section className="record-section">
            <div className="section-header">
              <div>
                <span className="section-kicker">ACTIVE RECORD</span>
                <h2>Installation file</h2>
              </div>
              <div className={`record-status ${statusClass(status)}`}>
                <span className="status-dot" /> {status}
              </div>
            </div>
            <div className="record-lookup">
              <label htmlFor="lookup-id">Record ID</label>
              <div className="input-action">
                <span className="hash-prefix">#</span>
                <input id="lookup-id" value={lookupId} onChange={(event) => setLookupId(event.target.value)} inputMode="numeric" />
                <button className="icon-button" type="button" onClick={() => void loadInstallation()} disabled={isLoading || !contractReady} aria-label="Load installation record" title="Load record">
                  {busyAction === "load" ? <LoaderCircle className="spin" size={17} /> : <ChevronRight size={18} />}
                </button>
              </div>
            </div>
            {installation ? <InstallationDetail installation={installation} /> : (
              <div className="empty-record">
                <ScanLine size={29} />
                <strong>No installation loaded</strong>
                <span>Enter a record ID to inspect its escrow state.</span>
              </div>
            )}
          </section>

          <section className="timeline-section">
            <div className="section-header">
              <div>
                <span className="section-kicker">CONTROL SURFACE</span>
                <h2>Settlement path</h2>
              </div>
              <Server size={20} className="muted-icon" />
            </div>
            <div className="path-list">
              <PathStep icon={<ClipboardCheck size={17} />} title="Fund" detail="Client locks native GEN" state={installation ? "complete" : "idle"} />
              <PathStep icon={<FileCheck2 size={17} />} title="Verify" detail="Installer submits live evidence" state={installation?.status === "VERIFIED" || installation?.status === "REJECTED" ? "complete" : installation ? "active" : "idle"} />
              <PathStep icon={<BadgeCheck size={17} />} title="Release" detail="Consensus moves the balance" state={installation?.status === "VERIFIED" ? "complete" : "idle"} />
              <PathStep icon={<Clock3 size={17} />} title="Reclaim" detail="Client recovers after expiry" state={installation?.status === "RECLAIMED" ? "complete" : "idle"} />
            </div>
            <div className="rule-note">
              <span>CONSENSUS RULE</span>
              <strong>leader status = validator status</strong>
            </div>
          </section>
        </div>

        <section className="actions-section">
          <div className="actions-heading">
            <div>
              <span className="section-kicker">OPERATIONS</span>
              <h2>Move the handoff</h2>
            </div>
            <span className="wallet-context"><Wallet size={14} /> {walletAddress ? shortAddress(walletAddress) : "wallet required"}</span>
          </div>
          <div className="action-grid">
            <form className="operation-form create-form" onSubmit={(event) => void createInstallation(event)}>
              <div className="form-title"><span className="form-index">01</span><div><strong>Fund installation</strong><span>Open a new escrow record</span></div></div>
              <Field label="Installer address" htmlFor="installer">
                <input id="installer" value={installer} onChange={(event) => setInstaller(event.target.value)} placeholder="0x..." required />
              </Field>
              <Field label="SLA specification" htmlFor="sla">
                <textarea id="sla" value={sla} onChange={(event) => setSla(event.target.value)} rows={3} required />
              </Field>
              <div className="split-fields">
                <Field label="Escrow / GEN" htmlFor="amount"><input id="amount" value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" required /></Field>
                <Field label="Expires" htmlFor="expires"><input id="expires" type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} required /></Field>
              </div>
              <button className="primary-button" type="submit" disabled={!canWrite || isLoading}>
                {busyAction === "Installation funding" ? <LoaderCircle className="spin" size={17} /> : <ArrowUpRight size={17} />}
                Fund record
              </button>
            </form>

            <form className="operation-form verify-form" onSubmit={(event) => void verifyInstallation(event)}>
              <div className="form-title"><span className="form-index">02</span><div><strong>Submit evidence</strong><span>Run independent SLA consensus</span></div></div>
              <div className="selected-line"><span>Selected record</span><strong>{installation ? `#${installation.install_id}` : "none"}</strong></div>
              <Field label="Diagnostics data" htmlFor="diagnostics">
                <textarea id="diagnostics" value={diagnostics} onChange={(event) => setDiagnostics(event.target.value)} rows={6} required />
              </Field>
              <div className="form-footnote"><ShieldCheck size={15} /> Evidence is fenced and treated as untrusted input.</div>
              <button className="primary-button" type="submit" disabled={!canWrite || !installation || isLoading || installation.status === "VERIFIED" || installation.status === "RECLAIMED"}>
                {busyAction === "Consensus verification" ? <LoaderCircle className="spin" size={17} /> : <ClipboardCheck size={17} />}
                Verify installation
              </button>
            </form>

            <div className="operation-form settle-form">
              <div className="form-title"><span className="form-index">03</span><div><strong>Settle balance</strong><span>Finalize the next eligible movement</span></div></div>
              <div className="settle-actions">
                <button className="secondary-button" type="button" onClick={() => void reclaimInstallation()} disabled={!canWrite || !installation || isLoading || !installation.expired || installation.status === "VERIFIED" || installation.status === "RECLAIMED"}>
                  {busyAction === "Expiry reclaim" ? <LoaderCircle className="spin" size={17} /> : <RefreshCw size={17} />}
                  Reclaim after expiry
                </button>
                <button className="secondary-button dark" type="button" onClick={() => void claimFunds()} disabled={!canWrite || isLoading || !hasClaimable}>
                  {busyAction === "Payout claim" ? <LoaderCircle className="spin" size={17} /> : <CircleDollarSign size={17} />}
                  Claim {formatAtto(claimable)} GEN
                </button>
              </div>
              <div className="settle-note"><span className="status-dot" /> Effects are recorded before native transfer.</div>
            </div>
          </div>
        </section>
      </main>
      <footer className="footer-line">
        <span>INSTALLSHIELD / COMMERCIAL HARDWARE ESCROW</span>
        <span>GENLAYER STUDIONET <span className="status-dot" /></span>
      </footer>
    </div>
  );
}

function Metric({ icon, label, value, accent }: { icon: React.ReactNode; label: string; value: string; accent: string }) {
  return (
    <div className={`metric ${accent}`}>
      <div className="metric-icon">{icon}</div>
      <div><span>{label}</span><strong>{value}</strong></div>
    </div>
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return <label className="field" htmlFor={htmlFor}><span>{label}</span>{children}</label>;
}

function PathStep({ icon, title, detail, state }: { icon: React.ReactNode; title: string; detail: string; state: string }) {
  return (
    <div className={`path-step ${state}`}>
      <div className="path-icon">{state === "complete" ? <Check size={17} /> : icon}</div>
      <div><strong>{title}</strong><span>{detail}</span></div>
      <span className="path-state">{state}</span>
    </div>
  );
}

function InstallationDetail({ installation }: { installation: Installation }) {
  return (
    <div className="record-detail">
      <div className="amount-readout"><span>Escrow amount</span><strong>{formatAtto(installation.amount_atto === "0" ? installation.payout_atto : installation.amount_atto)} <small>GEN</small></strong></div>
      <div className="detail-grid">
        <Detail label="Client" value={shortAddress(installation.client)} />
        <Detail label="Installer" value={shortAddress(installation.installer)} />
        <Detail label="Deadline" value={formatDate(installation.expires_at)} />
        <Detail label="Confidence" value={installation.confidence_bps ? `${(installation.confidence_bps / 100).toFixed(2)}%` : "pending"} />
      </div>
      <div className="record-copy"><span>SLA SPECIFICATION</span><p>{installation.sla_spec}</p></div>
      {installation.reason && <div className="record-copy reason"><span>CONSENSUS NOTE</span><p>{installation.reason}</p></div>}
      {installation.diagnostics_digest && <div className="digest-line"><span>evidence digest</span><code>{installation.diagnostics_digest}</code></div>}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div className="detail"><span>{label}</span><strong>{value}</strong></div>;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message.replace(/^Error:\s*/, "");
  if (typeof error === "string") return error;
  return fallback;
}
