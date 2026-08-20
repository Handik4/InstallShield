# InstallShield

**Consensus-verified escrow for commercial hardware installations, powered by GenLayer Intelligent Contracts.**

---

## Network Deployment

> **Live on GenLayer StudioNet.** The InstallShield Intelligent Contract is
> deployed and verifiable on the GenLayer network.

| Field | Value |
|---|---|
| **Network** | GenLayer StudioNet |
| **Contract Address** | `0xAfd506cbBFeb9F64d18233F448693b3812BBfD41` |
| **Explorer** | [View on GenLayer Explorer](https://genlayer-explorer.vercel.app/contracts/0xAfd506cbBFeb9F64d18233F448693b3812BBfD41) |
| **Status** | Deployed / Live |

Inspect the live contract, its state, and transaction history on the GenLayer
explorer:
**https://genlayer-explorer.vercel.app/contracts/0xAfd506cbBFeb9F64d18233F448693b3812BBfD41**

To point the frontend at this deployment, set the address in `app/.env.example`
(copy it to `app/.env`):

```bash
VITE_INSTALL_SHIELD_ADDRESS=0xAfd506cbBFeb9F64d18233F448693b3812BBfD41
```

---

## 1. Executive Summary

**InstallShield** is a GenLayer Intelligent Contract that settles payment disputes
between a **client** (who commissions a hardware installation) and an **installer**
(who performs the work) without a trusted third party and **without a traditional
oracle**.

In the real world, service-level agreements (SLAs) for physical installations --
security camera arrays, network cabling, industrial sensors, NVR deployments -- are
enforced by human inspectors, arbitration clauses, or after-the-fact litigation.
Each of these is slow, expensive, and subjective.

InstallShield replaces that friction with a single mechanism: the client locks
payment in escrow against a plain-language **SLA specification**; the installer
submits **diagnostics evidence** on completion; and a network of validator LLMs
independently evaluates whether the evidence satisfies the SLA. Funds are released
to the installer **only when the network reaches consensus** that the acceptance
criteria are met.

Because the verdict is produced by GenLayer's optimistic-democracy consensus rather
than a centralized data feed, InstallShield needs **no external oracle, no API key,
and no privileged referee**. The natural-language SLA *is* the acceptance contract,
and the validators are the referees.

| Property | Guarantee |
|---|---|
| Trust model | No trusted third party; verdict decided by validator consensus |
| Oracle dependency | **None** -- evaluation runs inside the contract via `gl.nondet` |
| Fund custody | Isolated internal vault, exact `atto`-unit accounting |
| Liveness | Client can always recover funds after the deadline |
| Value precision | 18-decimal (`atto`) native GEN, no rounding |

---

## 2. System Architecture (Coordinator-Vault Pattern)

InstallShield is deliberately split into **two logical subsystems inside one
contract**, separated by a strict internal API. This is the **Coordinator-Vault
pattern**, and it is the backbone of the contract's safety guarantees.

```
                    +------------------------------------------+
                    |            InstallShield Contract         |
                    |                                          |
  client / installer|   +----------------+   +---------------+ |
  -----------------> |   |  COORDINATOR   |   |     VAULT     | |
   public methods   |   |  (lifecycle)   |-->|  (accounting) | |
                    |   +----------------+   +---------------+ |
                    |   installations map     escrow / claimable|
                    |   consensus decisions   invariant-checked  |
                    +------------------------------------------+
```

### 2.1 The Coordinator

The **Coordinator** owns the *lifecycle and decision* state. It is the only layer a
caller interacts with directly:

- `owner`, `next_install_id`
- `installations: TreeMap[u256, Installation]` -- one record per installation,
  holding the parties, the SLA text, the immutable deadline, the status, and the
  consensus verdict (`decision`, `confidence_bps`, `diagnostics_digest`, `reason`).

The Coordinator decides *what should happen* (fund, verify, reject, reclaim) but
**never manipulates native-value balances directly**.

### 2.2 The Vault

The **Vault** owns every native-value accounting transition. It is expressed as a
set of **private methods** (`_vault_lock`, `_vault_credit`, `_vault_prepare_payout`,
`_vault_restore_failed_payout`) operating over dedicated ledgers:

- `escrow_balance_atto` -- value currently locked and undecided
- `claimable_atto: TreeMap[Address, u256]` -- pull-payment balances awaiting withdrawal
- `pending_payout_atto: TreeMap[Address, u256]` -- value in-flight during an external transfer
- `total_funded_atto`, `total_claimable_atto`, `total_claimed_atto`,
  `total_verified_atto`, `total_reclaimed_atto` -- aggregate counters

### 2.3 The Isolation Invariant

Every Vault method is bracketed by an assertion that must hold before and after each
transition:

```
escrow_balance_atto + total_claimable_atto + total_claimed_atto == total_funded_atto
```

This single invariant means **no atto of funded value can ever be double-spent,
silently lost, or conjured**. Every unit is provably in exactly one of three places:
locked in escrow, waiting to be claimed, or already dispatched. The Coordinator can
express *intent*, but the Vault mechanically refuses any transition that would break
conservation of value. Isolating accounting behind this boundary is what makes the
contract auditable at a glance.

---

## 3. Escrow Liveness & Security

A payment escrow is only as good as its worst-case exit. InstallShield is designed
so that **funds can never become permanently trapped**, regardless of installer
behavior or LLM availability.

### 3.1 The `expires_at` Deadline

Every installation is created with an **immutable `expires_at`** timestamp
(validated to be strictly in the future at funding time). This deadline is the
liveness anchor for the entire lifecycle. It cannot be changed after creation, so
neither party can grief the other by moving the goalposts.

### 3.2 `reclaim_funds`: Guaranteed Liveness

`reclaim_funds` is the **deterministic recovery path** and the core anti-lock
guarantee:

- It is **client-gated** -- only the original depositor may call it.
- It requires the deadline to have passed: `now >= expires_at`.
- It requires the installation to be **non-terminal** (not already `VERIFIED` or
  `RECLAIMED`).
- It needs **no installer cooperation and no LLM call whatsoever**.

This means that if the installer never submits evidence, or the diagnostics are
rejected, or the network's LLMs are unavailable, the client can *unilaterally and
deterministically* recover their funds once the deadline passes. There is **no
state in which value is stranded**:

| Status | Exit path |
|---|---|
| `FUNDED` (pre-deadline) | Installer verifies, or client waits |
| `FUNDED` / `REJECTED` (post-deadline) | Client `reclaim_funds` |
| `VERIFIED` | Installer `claim_funds` |
| `RECLAIMED` | Client `claim_funds` |

### 3.3 Strict CEI (Checks-Effects-Interactions)

The contract adheres rigorously to the **CEI pattern**. All external value movement
is concentrated in a single method, `claim_funds`, which follows CEI exactly:

1. **Checks / Effects** -- `_vault_prepare_payout` consumes the caller's entire
   `claimable_atto` balance, moves it to `pending_payout_atto`, and updates every
   aggregate counter.
2. **Interaction** -- only *after* all state is finalized does the contract perform
   the single external `emit_transfer`.

This ordering makes the payout path **reentrancy-safe**: there is no claimable
balance left to re-enter against by the time the outside world is touched.

### 3.4 Failed-Transfer Rollback

Because external native transfers execute on finalization and are not auto-refunded
on failure, InstallShield implements `__on_errored_message__`. If a payout transfer
fails, the hook invokes `_vault_restore_failed_payout`, which reverses the in-flight
accounting -- moving the amount from `pending_payout_atto` back to the recipient's
`claimable_atto` -- so the funds remain recoverable via a later `claim_funds`.

---

## 4. LLM Consensus Workflow

The heart of InstallShield is `verify_installation`, which turns an unstructured
diagnostics submission into a deterministic, consensus-backed payout decision.

### Step 1 -- Installer Submits Evidence

The installer calls `verify_installation(install_id, diagnostics_data)`. The contract
enforces preconditions **deterministically** before any nondeterministic work:

- Caller must be the registered `installer`.
- Installation must be non-terminal and **before** its deadline.
- `diagnostics_data` is length-bounded and sanitized.

### Step 2 -- State Isolation Boundary

Before defining any nondeterministic code, **all storage-derived values are copied
into local variables** (`sla_spec`, `installer`, `deadline`, `locked_amount`, and a
per-submission SHA-256 evidence fence). No contract state is mutated at this point.
The nondeterministic closures capture **only these locals** -- never `self` -- which
guarantees the LLM step is a pure function of its inputs.

### Step 3 -- Prompt Construction with an Untrusted-Evidence Fence

The prompt casts the SLA as the **acceptance contract** and the diagnostics as
**untrusted data**, wrapped in a unique SHA-256-derived delimiter. The auditor
instruction explicitly ignores any embedded instruction or role-change attempt
inside the evidence, hardening the contract against **prompt-injection** from
malicious diagnostics.

### Step 4 -- Leader Executes, Validators Verify (`gl.nondet`)

```
result = gl.vm.run_nondet(leader_fn, validator_fn)
```

- **`leader_fn`** calls `gl.nondet.exec_prompt(...)` to obtain the auditor's JSON
  verdict, then normalizes it into a small, consensus-bound object:
  `{ status, confidence_bps, diagnostics_digest, reason }`.
- **`validator_fn`** independently re-runs the same evaluation and **agrees only if
  its own status equals the leader's status**.

### Step 5 -- Deterministic Normalization & Equality Enforcement

Two rules make the verdict robust against a malicious or low-quality leader:

- **Confidence floor.** A `PASS` with `confidence_bps` below
  **`MIN_PASS_CONFIDENCE_BPS` (7,500 = 75%)** is canonically downgraded to `FAIL`
  *before* the equality check. A weak answer can never release funds.
- **Strict status equality.** Consensus succeeds only when
  `leader_status == validator_status`, so a leader cannot unilaterally alter the
  outcome.

### Step 6 -- Deterministic Settlement

After consensus returns, the contract **re-checks the deadline and locked amount**
using the pre-bound locals, then transitions state:

- **`PASS`** -> status `VERIFIED`; `_vault_credit` moves the locked amount to the
  installer's `claimable_atto`.
- **Not `PASS`** -> status `REJECTED`; funds remain in escrow and stay reclaimable
  by the client after the deadline.

The installer then withdraws via `claim_funds` (Section 3.3).

```
create_installation --> [FUNDED]
                           |
        verify(PASS) ------+------ verify(FAIL)
             |                          |
             v                          v
        [VERIFIED]                  [REJECTED]
             |                          |
             |                          | reclaim_funds (after deadline)
             |                          v
             |                     [RECLAIMED]
             |                          |
        claim_funds                 claim_funds
             |                          |
             v                          v
      installer paid              client refunded

Note: a [FUNDED] installation that is never verified can also be moved to
[RECLAIMED] directly by the client via reclaim_funds once expires_at passes.
```

---

## 5. Development & Testing Guide

### Prerequisites

- Python with the GenLayer test toolchain (`gltest`, `genvm-lint`).
- The contract pins its SDK version via the `Depends` header in
  `contracts/install_shield.py`.

### Static Validation

Run the GenVM linter's combined lint + semantic validation:

```bash
genvm-lint check contracts/install_shield.py
```

Run Pyright type checking with the GenLayer SDK configured:

```bash
genvm-lint typecheck contracts/install_shield.py
```

Both commands must report **0 errors and 0 warnings** before deployment.

### Test Suite

Direct-mode (fast, no server) tests cover the full escrow and consensus lifecycle:

```bash
gltest tests/ -v -s
```

Run a single test during development:

```bash
gltest tests/test_install_shield.py::test_name -v -s
```

Integration tests against a live GenLayer environment (full leader + validator
consensus):

```bash
gltest tests/ -v -s --network studionet
```

If you encounter stale-cache issues, clear the local cache and re-run:

```bash
rm -rf .gltest_cache
```

---

## Contract Surface

| Method | Kind | Purpose |
|---|---|---|
| `create_installation(installer, sla_spec, expires_at)` | write (payable) | Fund a new escrowed installation |
| `verify_installation(install_id, diagnostics_data)` | write | Run LLM consensus against the SLA |
| `reclaim_funds(install_id)` | write | Client recovery after the deadline |
| `claim_funds()` | write | Withdraw a verified payout or refund |
| `get_installation(install_id)` | view | Read full installation state |
| `get_claimable(account)` | view | Read an account's claimable balance |
| `get_accounting()` | view | Read the vault invariant and totals |

---

*InstallShield demonstrates a production-grade GenLayer pattern: a deterministic,
oracle-free escrow whose only source of subjective truth is LLM consensus, wrapped
in an invariant-checked vault that makes fund safety mechanically verifiable.*
