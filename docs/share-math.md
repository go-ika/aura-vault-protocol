# Vault Share Math

This document explains the share pricing model used by Aura Vault: how shares are minted on deposit, burned on withdrawal, how yield increases the exchange rate, and how the design defends against inflation attacks.

---

## Table of Contents

1. [Core Concept](#1-core-concept)
2. [State Variables](#2-state-variables)
3. [First Deposit — Seed Ratio](#3-first-deposit--seed-ratio)
4. [Deposit Formula](#4-deposit-formula)
5. [Withdraw Formula](#5-withdraw-formula)
6. [Rounding Direction and Why Floor Protects the Vault](#6-rounding-direction-and-why-floor-protects-the-vault)
7. [Performance Fee](#7-performance-fee)
8. [Worked Example: 3 Depositors, 2 Harvests, Multiple Withdrawals](#8-worked-example-3-depositors-2-harvests-multiple-withdrawals)
9. [Inflation Attack — Scenario and Prevention](#9-inflation-attack--scenario-and-prevention)
10. [Summary of Invariants](#10-summary-of-invariants)

---

## 1. Core Concept

Aura Vault is a **share-based vault**. Instead of tracking each depositor's token balance directly, the vault tracks:

- `total_assets` — the total number of underlying tokens currently held by the vault (including accrued yield).
- `total_shares` — the total number of shares issued across all depositors.

A depositor's claim on the vault is:

```
user_tokens = floor(user_shares × total_assets / total_shares)
```

When yield is harvested, `total_assets` increases but `total_shares` does not. This means each existing share is now worth more tokens — all depositors benefit proportionally without any on-chain loop.

---

## 2. State Variables

| Variable | Storage | Type | Description |
|---|---|---|---|
| `total_assets` (a.k.a. `total_deposited`) | Instance | `i128` | Sum of all deposited tokens plus net harvested yield |
| `total_shares` | Instance | `i128` | Sum of all outstanding vault shares |
| `balance(addr)` | Persistent per address | `i128` | Share balance of a specific depositor |
| `perf_fee_bps` | Instance | `u32` | Performance fee in basis points (default: 1000 = 10%) |
| `decimals` | Instance (`DataKey::Decimals`) | `u32` | Number of decimal places used by vault shares (set at initialization, immutable; default: 7) |

All values are in **stroops** (1 token = 10^decimals base units, e.g. 10,000,000 stroops for a 7-decimal token like XLM or USDC on Stellar). The share precision is configured at initialization via `DataKey::Decimals` and exposed publicly via `decimals() -> u32`. The formulas operate on raw integer units scaled to `10^decimals`.

---

## 3. First Deposit — Seed Ratio

When the vault has no shares (`total_shares == 0`) or no assets (`total_assets == 0`), the first depositor receives shares **equal to their deposit amount**:

```
new_shares = amount          (when total_shares == 0 OR total_assets == 0)
```

This 1:1 seed ratio sets the initial exchange rate. For example, depositing 1,000,000 stroops (0.1 USDC) gives exactly 1,000,000 shares.

**Why 1:1?**  
Any other seed ratio is arbitrary. 1:1 is the natural choice: the exchange rate starts at exactly 1 token per share, making the initial state easy to reason about.

---

## 4. Deposit Formula

For all subsequent deposits (when `total_shares > 0` and `total_assets > 0`):

```
new_shares = floor(amount × total_shares / total_assets)
```

**Where:**
- `amount` — tokens being deposited (in stroops)
- `total_shares` — shares outstanding *before* this deposit
- `total_assets` — tokens in vault *before* this deposit

**Implementation (from `lib.rs`):**

```rust
let numerator = amount
    .checked_mul(total_shares)
    .ok_or(VaultError::MathOverflow)?;
let new_shares = numerator
    .checked_div(total_deposited)
    .ok_or(VaultError::MathOverflow)?;
```

The `floor` is implicit in integer division (Rust's `/` operator truncates toward zero for positive integers).

**Zero-share guard:**  
If `new_shares == 0` after the calculation (possible when `amount` is very small relative to `total_assets`), the deposit is rejected with `VaultError::ZeroAmount`. This prevents dust deposits that would gift value to existing shareholders.

---

## 5. Withdraw Formula

Burning `shares` redeems:

```
redeem_amount = floor(shares × total_assets / total_shares)
```

**Where:**
- `shares` — number of shares being burned
- `total_assets` — tokens in vault *before* this withdrawal
- `total_shares` — shares outstanding *before* this withdrawal

**Implementation (from `lib.rs`):**

```rust
let numerator = shares
    .checked_mul(total_deposited)
    .ok_or(VaultError::MathOverflow)?;
let redeem_amount = numerator
    .checked_div(total_shares)
    .ok_or(VaultError::MathOverflow)?;
```

After computing `redeem_amount`, the contract:
1. Subtracts `shares` from `user_balance` and `total_shares`.
2. Subtracts `redeem_amount` from `total_assets`.
3. Transfers `redeem_amount` tokens to the caller.

---

## 6. Rounding Direction and Why Floor Protects the Vault

Both formulas use **floor (truncation toward zero)**. This is intentional and critical.

### Deposit — floor on `new_shares`

When rounding down the shares minted, the depositor receives slightly *fewer* shares than their exact proportional contribution. The tiny remainder stays in the vault, slightly benefiting existing shareholders. This is acceptable and standard.

If instead we rounded **up** on deposit, the depositor could receive shares representing slightly *more* than they deposited, draining fractional value from the vault over many deposits.

### Withdraw — floor on `redeem_amount`

When rounding down the tokens redeemed, the caller receives slightly *fewer* tokens than the exact value of their shares. The tiny remainder stays in the vault.

If instead we rounded **up** on withdrawal, repeated micro-withdrawals could slowly drain more than the depositor is owed.

### The invariant

Floor rounding on both sides ensures:

```
total_assets ≥ sum of all individual redemption values
```

The vault can always satisfy all outstanding withdrawal claims. The small fractional dust accumulates as a rounding buffer that further protects solvency.

---

## 7. Performance Fee

When yield is harvested, a performance fee is deducted before crediting `total_assets`:

```
fee_amount     = floor(yield_amount × perf_fee_bps / 10000)
yield_net      = yield_amount - fee_amount
total_assets   += yield_net          (not += yield_amount)
fees_collected += fee_amount
```

The default `perf_fee_bps` is **1000** (10%). The fee accrues in a separate counter (`total_fees_collected`) and does not affect the share/asset ratio until the admin calls `withdraw_fees`, which transfers the accumulated fees to the treasury.

**Effect on exchange rate:**  
Only `yield_net` enters `total_assets`, so the 10% performance fee reduces the yield-driven appreciation of shares. With a 10% fee, a 100-token yield event increases `total_assets` by 90 tokens (and puts 10 tokens aside for the treasury).

---

## 8. Worked Example: 3 Depositors, 2 Harvests, Multiple Withdrawals

This example uses whole tokens (not stroops) for readability. All arithmetic is integer arithmetic with floor division. The performance fee is 10% (1000 bps).

### Initial state

```
total_assets = 0
total_shares = 0
```

---

### Event 1 — Alice deposits 1,000 tokens

Condition: `total_shares == 0` → seed ratio applies.

```
new_shares = 1,000

Alice's shares  = 1,000
total_shares    = 1,000
total_assets    = 1,000
exchange rate   = 1,000 / 1,000 = 1.000 token/share
```

---

### Event 2 — Bob deposits 500 tokens

```
new_shares = floor(500 × 1,000 / 1,000) = floor(500.000) = 500

Bob's shares    = 500
total_shares    = 1,500
total_assets    = 1,500
exchange rate   = 1,500 / 1,500 = 1.000 token/share
```

At equal exchange rate, Bob gets exactly proportional shares — expected.

---

### Event 3 — Harvest 1: keeper injects 150 tokens of yield

```
fee_amount   = floor(150 × 1000 / 10000) = floor(15.0) = 15
yield_net    = 150 - 15 = 135

total_assets  = 1,500 + 135 = 1,635
total_shares  = 1,500        (unchanged)
fees_collected = 15

exchange rate = 1,635 / 1,500 ≈ 1.090 token/share
```

Both Alice and Bob now hold shares worth more tokens. No new shares were minted.

---

### Event 4 — Carol deposits 300 tokens

```
new_shares = floor(300 × 1,500 / 1,635)
           = floor(450,000 / 1,635)
           = floor(275.229...)
           = 275

Carol's shares  = 275
total_shares    = 1,775
total_assets    = 1,935
exchange rate   = 1,935 / 1,775 ≈ 1.090 token/share
```

Carol pays the current (higher) exchange rate — she gets fewer shares per token than the early depositors did, correctly reflecting that she joined after yield accrued.

---

### Event 5 — Harvest 2: keeper injects 200 tokens of yield

```
fee_amount   = floor(200 × 1000 / 10000) = 20
yield_net    = 200 - 20 = 180

total_assets  = 1,935 + 180 = 2,115
total_shares  = 1,775
fees_collected = 15 + 20 = 35

exchange rate = 2,115 / 1,775 ≈ 1.191 token/share
```

---

### Event 6 — Alice withdraws all 1,000 shares

```
redeem_amount = floor(1,000 × 2,115 / 1,775)
              = floor(2,115,000 / 1,775)
              = floor(1,191.549...)
              = 1,191

Alice receives 1,191 tokens (deposited 1,000 → +19.1% net of fees)

total_shares  = 1,775 - 1,000 = 775
total_assets  = 2,115 - 1,191 = 924
exchange rate = 924 / 775 ≈ 1.192 token/share  (tiny rounding bump for remaining holders)
```

---

### Event 7 — Bob withdraws 200 shares (partial)

```
redeem_amount = floor(200 × 924 / 775)
              = floor(184,800 / 775)
              = floor(238.451...)
              = 238

Bob receives 238 tokens for 200 shares

total_shares  = 775 - 200 = 575
total_assets  = 924 - 238 = 686
exchange rate = 686 / 575 ≈ 1.193 token/share
```

Bob still holds 300 shares worth approximately `floor(300 × 686 / 575) = floor(357.9...) = 357` tokens.

---

### Event 8 — Admin withdraws fees

```
fees_collected = 35
Treasury receives 35 tokens.
fees_collected = 0
```

Note: Fees are tracked separately from `total_assets`. The `withdraw_fees` call transfers tokens from the vault balance to the treasury but does not alter `total_assets` (which was already net of fees from the harvest step).

---

### Final state summary

| Participant | Deposited | Shares held | Approx. tokens at exit | Net return |
|---|---|---|---|---|
| Alice | 1,000 | 0 (exited) | 1,191 | +19.1% |
| Bob | 500 | 300 | ~357 remaining | — |
| Carol | 300 | 275 | ~327 (est.) | — |
| Treasury (fees) | — | — | 35 | — |

---

## 9. Inflation Attack — Scenario and Prevention

### What is an inflation attack?

A share-vault inflation attack exploits the first-deposit seed ratio to manipulate the exchange rate before other depositors arrive. The classic attack:

1. Attacker is the **first depositor**. With `total_shares == 0`, they deposit 1 stroop and receive 1 share.
2. Attacker **directly sends** a large number of tokens to the vault contract address without calling `deposit`. This inflates `total_assets` without minting shares.
3. A victim deposits a normal amount (e.g., 100 tokens). The share formula computes `floor(100_tokens × 1_share / huge_total_assets)` → **0 shares**. The deposit is rejected or rounds to 0, and the attacker's single share now backs all the assets.

### How Aura Vault prevents it

Aura Vault uses a two-layer defense:

**Layer 1 — Flash loan guard (balance check)**

Before executing `deposit`, `withdraw`, or `harvest`, the contract reads the vault's actual on-chain token balance and compares it to `total_deposited`:

```rust
let balance_before = token.balance(&env.current_contract_address());
if balance_before != total_deposited {
    // emit suspicious event
    return Err(VaultError::BalanceMismatch);
}
```

If someone sends tokens directly to the contract (bypassing `deposit`), `balance_before > total_deposited`, the guard triggers, and all three entry points are blocked. This also blocks same-transaction flash loan manipulation.

**Layer 2 — Zero-share rejection fence**

Even if the guard were somehow bypassed, if the computed `new_shares == 0` (because the deposit amount rounds down to zero shares given the inflated exchange rate), the contract rejects the deposit:

```rust
if new_shares <= 0 {
    return Err(VaultError::ZeroAmount);
}
```

This prevents the victim from silently losing their deposit.

### Defense in depth

| Attack vector | Blocked by |
|---|---|
| Direct token transfer to inflate `total_assets` | Flash loan guard (BalanceMismatch) |
| Flash loan to temporarily inflate balance | Flash loan guard (BalanceMismatch) |
| Tiny deposit that rounds to 0 shares | Zero-share rejection (ZeroAmount) |
| Arithmetic overflow in share computation | `checked_mul` / `checked_div` (MathOverflow) |

---

## 10. Summary of Invariants

The contract maintains the following invariants at the end of every transaction:

1. **Solvency:** `total_assets ≤ actual vault token balance + fees_collected`
2. **Share backing:** Every outstanding share is backed by `total_assets / total_shares` tokens.
3. **Balance consistency:** `actual_balance == total_assets + fees_collected` (guaranteed by the flash loan guard at the start of each mutating call).
4. **Monotonic exchange rate (during harvest):** Each harvest strictly increases `total_assets / total_shares` (net of fees), never decreasing it.
5. **No value extraction via rounding:** Floor division on both deposit and withdraw ensures dust stays in the vault, never gifting more than owed.

---

*Issues: [#386](https://github.com/soterika/aura-vault-protocol/issues/386)*

---

## 11. Edge Case Analysis

This section provides a detailed analysis of five edge cases in the share calculation formula. Each case includes a numerical worked example and the corresponding Rust implementation using checked arithmetic.

---

### 11.1 First Depositor — 1:1 Seed Ratio (`total_shares = 0`)

**Scenario:** The vault is freshly initialised. No deposits have been made. `total_shares == 0` and `total_assets == 0`.

**Why this is an edge case:**  
The general deposit formula `floor(amount × total_shares / total_assets)` would produce `0 / 0`, which is undefined. The code must special-case this to set a meaningful initial exchange rate.

**Formula applied:**

```
new_shares = amount          // when total_shares == 0 OR total_assets == 0
```

**Numerical example:**

Alice is the first depositor and deposits 5,000,000 stroops (0.5 USDC with 7-decimal precision):

```
Before:
  total_assets  = 0
  total_shares  = 0

Deposit amount  = 5,000,000

Since total_shares == 0 → seed ratio
  new_shares    = 5,000,000

After:
  total_assets  = 5,000,000
  total_shares  = 5,000,000
  exchange rate = 5,000,000 / 5,000,000 = 1.000 token/share
```

**Rust implementation (from `lib.rs`):**

```rust
let (new_shares, new_total_deposited, new_total_shares) =
    if total_shares == 0 || total_deposited == 0 {
        // Seed ratio: first depositor gets shares equal to deposit amount
        let new_total = total_deposited
            .checked_add(amount)
            .ok_or(VaultError::MathOverflow)?;
        (amount, new_total, amount)
    } else {
        // General formula: floor(amount × total_shares / total_deposited)
        let numerator = amount
            .checked_mul(total_shares)
            .ok_or(VaultError::MathOverflow)?;
        let ns = numerator
            .checked_div(total_deposited)
            .ok_or(VaultError::MathOverflow)?;
        if ns <= 0 {
            return Err(VaultError::ZeroAmount);
        }
        let new_total = total_deposited
            .checked_add(amount)
            .ok_or(VaultError::MathOverflow)?;
        let new_ts = total_shares
            .checked_add(ns)
            .ok_or(VaultError::MathOverflow)?;
        (ns, new_total, new_ts)
    };
```

**Key invariant:** The 1:1 seed ratio sets the initial exchange rate at exactly 1.0. This makes reasoning about early-vault state straightforward. Any subsequent deposits use the general formula and will preserve proportional fairness.

---

### 11.2 Tiny Deposit That Rounds to 0 Shares — `ZeroAmount` Error

**Scenario:** The vault has accrued significant yield, raising the exchange rate far above 1.0. A depositor submits a very small amount that, when run through the share formula, floors to zero.

**Why this is an edge case:**  
If `new_shares == 0` were allowed, the depositor would lose their tokens to the vault with no shares to show for it. Their deposit would silently inflate the value of existing shareholders — equivalent to a gift. The contract rejects this.

**Formula:**

```
new_shares = floor(amount × total_shares / total_assets)
           = floor(1 × 10,000,000 / 50,000,000)
           = floor(0.2)
           = 0  → REJECTED with VaultError::ZeroAmount
```

**Numerical example:**

State: exchange rate has grown to 5.0 tokens per share (total_assets = 50,000,000, total_shares = 10,000,000).

```
total_assets  = 50,000,000  (5 USDC)
total_shares  = 10,000,000
exchange rate = 50,000,000 / 10,000,000 = 5.0 tokens/share

Depositor attempts: amount = 3 stroops

new_shares = floor(3 × 10,000,000 / 50,000,000)
           = floor(30,000,000 / 50,000,000)
           = floor(0.6)
           = 0

→ VaultError::ZeroAmount returned. Deposit rejected.
```

**Minimum safe deposit at this exchange rate:**

```
Minimum amount to receive 1 share:
  1 = floor(amount × 10,000,000 / 50,000,000)
  amount ≥ ceil(50,000,000 / 10,000,000) = 5 stroops

So deposit of 5 stroops → new_shares = floor(5 × 10,000,000 / 50,000,000) = floor(1.0) = 1 ✓
```

**Rust implementation (from `lib.rs`):**

```rust
let numerator = amount
    .checked_mul(total_shares)
    .ok_or(VaultError::MathOverflow)?;
let new_shares = numerator
    .checked_div(total_deposited)
    .ok_or(VaultError::MathOverflow)?;

if new_shares <= 0 {
    return Err(VaultError::ZeroAmount);
}
```

**Practical implication:** As the vault accumulates yield and the exchange rate rises, the minimum economically meaningful deposit increases proportionally. This is the expected behaviour for a yield-bearing vault — dust deposits become unviable as the share price grows.

---

### 11.3 Very Large Deposit Approaching `i128::MAX` — Overflow Check

**Scenario:** A whale attempts to deposit an amount that, when multiplied by `total_shares`, exceeds `i128::MAX`. The intermediate product overflows even before the division can occur.

**`i128::MAX` value:**

```
i128::MAX = 170,141,183,460,469,231,731,687,303,715,884,105,727
          ≈ 1.70 × 10^38
```

**Numerical example — triggering overflow:**

Suppose total_shares = 10^18 (a large but realistic number after many deposits and years of 7-decimal precision).

```
total_shares  = 1,000,000,000,000,000,000  (10^18)
total_assets  = 1,000,000,000,000,000,000  (10^18, exchange rate = 1.0)

Deposit attempt: amount = 2 × 10^20

Intermediate: amount × total_shares
  = 2 × 10^20 × 10^18
  = 2 × 10^38
  > i128::MAX (≈ 1.70 × 10^38)

→ checked_mul returns None
→ VaultError::MathOverflow returned
```

**Numerical example — safe large deposit:**

Using the same state, a deposit of `10^19` is safe:

```
amount = 10,000,000,000,000,000,000  (10^19)

Intermediate: 10^19 × 10^18 = 10^37 < i128::MAX ✓

new_shares = floor(10^37 / 10^18) = 10^19

After deposit:
  total_assets  = 2 × 10^19
  total_shares  = 2 × 10^19
  exchange rate = 1.0 (unchanged, deposit at current rate)
```

**Rust implementation (overflow-safe):**

```rust
// Cargo.toml profile: overflow-checks = true ensures debug AND release
// catch integer overflow with a panic in tests, but the contract code
// uses checked_* explicitly so it returns an Err rather than panicking.

let numerator: i128 = amount
    .checked_mul(total_shares)
    .ok_or(VaultError::MathOverflow)?;  // Returns Err if product > i128::MAX

let new_shares: i128 = numerator
    .checked_div(total_deposited)
    .ok_or(VaultError::MathOverflow)?;  // Returns Err on division by zero
```

**Cargo.toml release profile setting:**

```toml
[profile.release]
overflow-checks = true   # Soroban requirement; panics are caught by the runtime
```

**Safe operating range:** With 7-decimal precision (stroops), `i128::MAX / 10^7 ≈ 1.7 × 10^31` tokens. The vault can safely handle deposits up to roughly `10^15` tokens even if `total_shares` has grown to `10^15`. Real-world TVL of even $10 billion (10^16 micro-USDC stroops) leaves ample headroom.

---

### 11.4 Share Price After Many Small Harvests — Precision Drift

**Scenario:** Many small yield harvests accumulate. Each harvest is small enough that the integer ratio `total_assets / total_shares` increases by only a fraction of a stroop, never completing a full integer step. Over thousands of iterations, the share price grows correctly, but the per-harvest rounding means no individual harvest may visibly move the ratio.

**Why this is an edge case:**  
Integer arithmetic means the "observable" share price (expressed as an integer) lags slightly behind the true fractional price. After N harvests of yield `y` each, the true price should be `(total_assets + N×y×(1-fee)) / total_shares`. Due to truncation in the integer ratio, the observable price may be slightly lower.

**Numerical example — 1,000 micro-harvests:**

```
Initial state:
  total_assets  = 1,000,000,000  (1,000 USDC in stroops)
  total_shares  = 1,000,000,000
  exchange rate = 1.0000000 tokens/share

Each harvest injects yield_amount = 100 stroops (0.00001 USDC)
Performance fee: 10% → yield_net = 90 stroops per harvest

After 1 harvest:
  total_assets = 1,000,000,090
  exchange rate = 1,000,000,090 / 1,000,000,000 = 1.000000090 tokens/share
  (observable integer: floor(1,000,000,090 / 1,000,000,000) = 1 — no visible change in integer ratio)

After 100 harvests (cumulative yield_net = 9,000 stroops):
  total_assets = 1,000,009,000
  exchange rate = 1,000,009,000 / 1,000,000,000 ≈ 1.000009 tokens/share
  (still rounds to 1 in integer price)

After 1,000 harvests (cumulative yield_net = 90,000 stroops):
  total_assets = 1,000,090,000
  exchange rate = 1,000,090,000 / 1,000,000,000 ≈ 1.0000900 tokens/share
  (observable price = 1; fractional accumulation visible only on withdraw)

Redemption value of 1,000,000,000 shares:
  floor(1,000,000,000 × 1,000,090,000 / 1,000,000,000)
= floor(1,000,090,000)
= 1,000,090,000 stroops  ← correct; the yield DID accrue, just not as integer price change
```

**Key insight:** Precision drift manifests as a gap between the *displayed* integer price-per-share and the actual redeemable value. The yield is faithfully tracked in `total_assets` — it is only the human-readable "price per share" metric that appears to lag. On withdrawal, the full accrued value is correctly redeemed via `floor(shares × total_assets / total_shares)`.

**Rust example — tracking accumulated yield correctly:**

```rust
// The observable price_per_share helper (used in analytics, not in share math):
fn price_per_share(total_assets: i128, total_shares: i128) -> i128 {
    if total_shares == 0 {
        return 0;
    }
    // Multiply by 10^7 for 7 decimal places of precision in the display value
    total_assets
        .checked_mul(10_000_000)
        .and_then(|n| n.checked_div(total_shares))
        .unwrap_or(0)
}

// At 1,000 harvests of 90 stroops each:
// price_per_share(1_000_090_000, 1_000_000_000)
// = floor(1_000_090_000 × 10_000_000 / 1_000_000_000)
// = floor(10_000_900_000_000 / 1_000_000_000)
// = 10_000_900  (represents 1.0000900 tokens/share)
```

**Mitigation:** For display purposes, always scale the ratio by at least `10^7` (one full stroop precision factor) to expose sub-stroop price movement. The `price_per_share` helper above achieves this. The share math itself remains correct regardless.

---

### 11.5 Withdraw When `total_assets` Slightly Mismatches Due to Rounding

**Scenario:** After a sequence of deposits and partial withdrawals, the sum of all individual redemption values may be slightly less than `total_assets` (due to accumulated floor rounding). When the last depositor withdraws, they may receive a slightly larger redemption than expected — the accumulated rounding dust flows to them.

**Why this is an edge case:**  
The vault guarantees solvency (`total_assets ≥ sum of all redeemable values`) but not exact atomisation. The last withdrawer mops up any rounding buffer.

**Numerical example — rounding dust accumulation:**

```
Three depositors, each holds 333 shares out of 999 total.
total_assets = 1,000 tokens (exchange rate slightly > 1.0)

Each depositor redeems 333 shares:
  redeem_1 = floor(333 × 1,000 / 999) = floor(333,000 / 999) = floor(333.333...) = 333
  redeem_2 = floor(333 × 667 / 666)                    -- state after first withdrawal
           = floor(333 × 667 / 666)

Let's track state transitions:

Step 1 — Depositor A withdraws 333 shares:
  redeem_A = floor(333 × 1,000 / 999) = 333
  total_assets → 1,000 - 333 = 667
  total_shares → 999 - 333 = 666

Step 2 — Depositor B withdraws 333 shares:
  redeem_B = floor(333 × 667 / 666) = floor(222,111 / 666) = floor(333.500...) = 333
  total_assets → 667 - 333 = 334
  total_shares → 666 - 333 = 333

Step 3 — Depositor C withdraws last 333 shares:
  redeem_C = floor(333 × 334 / 333) = floor(111,222 / 333) = floor(334.0) = 334
  total_assets → 334 - 334 = 0
  total_shares → 333 - 333 = 0

Summary:
  A deposited 333 tokens (via proportional claim), redeemed 333 (± dust)
  B deposited 333 tokens, redeemed 333
  C deposited 334 tokens (via proportional claim), redeemed 334

Total redeemed = 333 + 333 + 334 = 1,000 ✓  (equals total_assets, rounding dust collected by last withdrawer)
```

**The key observation:** Depositor C receives 334 rather than 333. The single extra token is the rounding dust from depositors A and B. This is the expected and correct behaviour — the vault is always fully solvent and always distributes exactly `total_assets` in total.

**Rust implementation (from `lib.rs`):**

```rust
// Withdraw: burn shares, compute redemption with floor division
let numerator = shares
    .checked_mul(total_deposited)
    .ok_or(VaultError::MathOverflow)?;
let redeem_amount = numerator
    .checked_div(total_shares)
    .ok_or(VaultError::MathOverflow)?;

// CEI: update state before transfer
let new_balance = caller_balance
    .checked_sub(shares)
    .ok_or(VaultError::InsufficientShares)?;
let new_total_shares = total_shares
    .checked_sub(shares)
    .ok_or(VaultError::MathOverflow)?;
let new_total_deposited = total_deposited
    .checked_sub(redeem_amount)
    .ok_or(VaultError::InsufficientUnderlying)?;

set_balance(&env, &caller, new_balance);
set_total_shares(&env, new_total_shares);
set_total_deposited(&env, new_total_deposited);

// Then transfer — safe because state already updated (CEI)
token.transfer(&env.current_contract_address(), &caller, &redeem_amount);
```

**Invariant maintained:** `total_assets` is decremented by exactly `redeem_amount` (the floored value). If `total_assets` was already slightly larger than the sum of all individually-floored redemptions, the last withdrawer absorbs that difference. This is the correct behaviour and is consistent with ERC-4626.

---

## 12. ERC-4626 Comparison

ERC-4626 is the Ethereum standard for tokenised yield vaults. Aura Vault shares the same mathematical foundations but diverges in implementation details suited to the Soroban/Stellar environment.

### Formula Equivalence

| Operation | ERC-4626 | Aura Vault |
|---|---|---|
| **Deposit shares** | `floor(assets × totalSupply / totalAssets)` | `floor(amount × total_shares / total_deposited)` |
| **Withdraw assets** | `floor(shares × totalAssets / totalSupply)` | `floor(shares × total_assets / total_shares)` |
| **First deposit** | Virtual shares/assets offset | 1:1 seed ratio |
| **Rounding direction** | Assets round down (deposit favours vault) | Floor on both sides (favours vault) |
| **Integer type** | `uint256` (EVM 256-bit unsigned) | `i128` (Soroban 128-bit signed) |

### Inflation Attack Prevention

| Mechanism | ERC-4626 | Aura Vault |
|---|---|---|
| **Primary defence** | Virtual shares/assets (`_decimalsOffset`) | Flash loan guard (`BalanceMismatch` error) |
| **Secondary defence** | `previewDeposit` reverts if shares == 0 | Zero-share rejection (`ZeroAmount` error) |
| **Approach** | Add virtual 1 share + 1 asset to denominator | Check actual on-chain balance matches tracked state |

ERC-4626's virtual offset approach adds `10^decimalsOffset` to both `totalSupply` and `totalAssets` in every preview calculation, making the initial exchange rate effectively `1 / 10^offset` instead of `∞`. Aura Vault achieves the same result by verifying the on-chain balance is never manipulated between calls.

### Rounding Direction

Both ERC-4626 and Aura Vault round in favour of the vault (floor) on both deposit and withdrawal. This is the only rounding direction that maintains solvency — rounding up on either side could allow incremental value extraction from the vault.

ERC-4626 specifies this formally:
> "MUST round down towards 0. This does not include any fees that are charged against assets in the Vault."

Aura Vault follows the same convention via Rust's integer division truncation.

### Overflow Safety

| Aspect | ERC-4626 / EVM | Aura Vault / Soroban |
|---|---|---|
| **Integer width** | `uint256` (340 undecillion max) | `i128` (170 undecillion max) |
| **Overflow behaviour** | Reverts via Solidity's built-in overflow check (0.8+) | `checked_mul`/`checked_div` returning `VaultError::MathOverflow` |
| **Risk level** | Very low for practical token amounts | Low; safe operating range ≈ 10^19 tokens at 7-decimal precision |

The smaller `i128` type means Aura Vault must be more careful about intermediate products. The `checked_mul` guard before every division catches any overflow before it can corrupt state.

### Preview Functions

ERC-4626 mandates `previewDeposit`, `previewWithdraw`, `previewMint`, and `previewRedeem` — read-only functions that simulate the outcome of a vault operation including fees.

Aura Vault's equivalent is the `balance_of` + `total_assets` view functions, which together allow off-chain callers to compute the same estimates. A formal `preview_deposit` / `preview_withdraw` interface is tracked in the roadmap.

### Key Differences Summary

| Feature | ERC-4626 | Aura Vault |
|---|---|---|
| **Platform** | Ethereum (EVM) | Stellar (Soroban/WASM) |
| **Token standard** | ERC-20 | SEP-41 |
| **Share token** | ERC-20 (transferable) | Internal ledger (`balance(addr)`) |
| **Fee handling** | Implementation-defined | 10% performance fee on harvest |
| **Governance** | Implementation-defined | 3-of-5 multi-sig timelock |
| **Emergency stop** | Implementation-defined | `pause()` / `unpause()` |
| **Audit trail** | On-chain events | On-chain events + off-chain `contract_events` table |

---

*Edge cases added in: [#974](https://github.com/soterika/aura-vault-protocol/issues/974)*
