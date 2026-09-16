# Phase 0 — verification report

The report owed at the end of Phase 0. What changed, what is now authoritative,
what is not, and what is still unproven.

Written against the working tree. **Nothing is committed** — a `git diff` shows
the whole change set.

---

## 1. Invariants, and whether they actually hold

The ten Phase 0 invariants, answered honestly. "Enforced" means something rejects
a violation; "prepared" means the mechanism exists but nothing consumes it yet.

| Invariant | State | Where |
|---|---|---|
| One authoritative financial mutation path | **prepared** | `ledger.service.append` built; no writer points at it |
| No duplicate money mutations | **partially enforced** | deposits already were; webhook amount now checked; ledger key unique index **not yet built** |
| No silently lost money | **enforced** | all 10 swallowing sites now write `failed_financial_operations` |
| No unauthorized financial mutation | **recorded, not yet refused** | 13 money routes gated, tolerant mode by default |
| One partner cannot receive conflicting work | **enforced behind a flag** | QC now claims the lock; `UNIFIED_DISPATCH_ENABLED` still off |
| Negative balance represented correctly | **prepared** | ledger records it; `recordTransaction`'s throw not yet removed |
| Identity cannot be incorrectly merged | **unchanged** | untouched deliberately — dry-run never ran |
| Duplicate provider events are harmless | **partially** | order flag was already idempotent; ledger call still is not |
| Customer wallet history not duplicated | **enforced** | merge implemented + pinned; the route was not live |
| Every critical mutation auditable | **partially** | `admin_audits` records authorization + HTTP outcome, not the money move |

**Four of ten fully hold. Nothing claimed here is stronger than what the code does.**

---

## 2. What changed

### Behaviour changed in production paths — one item only

**P0-13 — the food Razorpay webhook accepted any captured amount.** A ₹1 capture
marked a ₹900 order paid and dispatched it. The quick-commerce fork has validated
this since it was written; the food handler never got the fix. Both now share
`core/payments/capturedAmount.js`.

*Visible effect*: orders whose `pricing.total` changed after checkout will now log
`AMOUNT MISMATCH` and be marked failed instead of silently settling. Mismatches
return **200** — a non-200 makes Razorpay retry an event that can never succeed.

### Behind a flag — no effect until switched on

| Change | Flag | Default |
|---|---|---|
| QC takes the cross-vertical busy-lock | `UNIFIED_DISPATCH_ENABLED` | off |
| Financial routes refuse unauthorized admins | `FINANCE_PERMISSIONS_ENFORCED` | off |
| Eligibility engine measured against all 3 dispatchers | `ELIGIBILITY_SHADOW_ENABLED` | off |

### Additive — new, read by nothing

`core/assignment/*`, `core/finance/{eligibilityRules, eligibility.service,
eligibilityShadow, idempotencyKeys, ledgerEntry.model, partnerBalance.model,
ledger.service, deadLetter, failedFinancialOperation.model}`,
`core/admin/{financeAuthz, requireFinancePermission.middleware, models/adminAudit}`,
`core/payments/{capturedAmount, mergeWalletHistory}`,
`scripts/backfill-wallet-idempotency-keys.js`.

### Converged — two writers became one

- `adminService.adjustDriverWallet` → `applyDriverWalletAdjustment`. Removes a
  read-compute-write that **lost updates** under concurrency, and a second block
  rule that disagreed with the first.
- `driverAssignmentService.reconcileDriverAssignment` → `reconcileAssignments`.
  Same signature, both callers untouched; now vertical-aware.

### Corrected

- Cash tips wrote `amount = tip` with an unchanged balance. Folding the ledger
  would have overstated every driver's balance by their lifetime tips. Now
  `amount: 0` with the figure in `metadata.tipAmount`; **both driver-earnings
  aggregations updated** so tip reporting did not silently drop to zero.
- `getUserWalletForFrontend` concatenated two transaction stores under a comment
  promising deduplication that was never written.

---

## 3. What is now authoritative

| Concept | Authoritative | No longer authoritative |
|---|---|---|
| Captured-amount rule | `capturedAmount.capturedAmountMatches` | food's absent check; QC's inline copy |
| Busy-lock / concurrency | `core/assignment/assignment.service` | `driverAssignmentService`'s own impl; QC's `partnerHasActiveDelivery` |
| Terminal-status tables | `core/assignment` (per vertical) | the food-only copy in `driverAssignmentService` |
| Taxi wallet mutation | `applyDriverWalletAdjustment` | `adminService`'s read-compute-write |
| Idempotency keys | `core/finance/idempotencyKeys` | ad-hoc `metadata.referenceKey` strings |
| Financial authorization | `core/admin/financeAuthz` | bare `role === 'ADMIN'` on 13 routes |
| Eligibility (once cut over) | `core/finance/eligibilityRules` | 3 dispatcher-local calculations |
| Balance (once cut over) | `ledger_entries` fold | 5 divergent sources |

---

## 4. Migrations and backfills required

**None of the shipped changes needs a migration to deploy.** These are
preconditions for the *next* phase.

1. **`node scripts/backfill-wallet-idempotency-keys.js`** — dry-run by default,
   writes nothing (verified: the only write is `COMMIT`-guarded). Its collision
   report is the gate: two rows sharing `(driverId, referenceKey)` mean the old
   check-then-act dedupe **already double-credited someone**. Those rows are not
   stamped; they need a decision. The unique index cannot build until it reports
   clean.
2. **`activeAssignment` → `activeAssignments[]`** — only needed before enabling
   stacking. The claim filter carries a legacy guard so un-backfilled drivers are
   handled correctly without it.
3. **Admin permission grants** — read `admin_audits` where
   `toleratedViolation: true`, grant `wallet.write` to the admins it names, confirm
   it stops growing, then set `FINANCE_PERMISSIONS_ENFORCED=true`.
4. **Identity** — nothing run, nothing changed. Deliberate.

---

## 5. What could still break

| Risk | Likelihood | Mitigation in place |
|---|---|---|
| Orders with post-checkout total changes now fail at the webhook | low | logged loudly as `AMOUNT MISMATCH`; 200 returned so no retry storm |
| Tip earnings misreported | very low | both aggregations read `$ifNull: [metadata.tipAmount, amount]`; old rows still work |
| Admin adjustment block threshold changed | low | deliberate convergence; documented at the call site |
| Dead-letter write slows a job during a Mongo outage | low | bounded to 2s (measured 2.3s) instead of mongoose's 10s buffer |
| Two new `Driver` indexes build on first connect | low | small collection; mirror index kept so dispatch queries are unaffected |
| `ledger.append` requires a replica set | **unknown** | fails loudly rather than degrading — **confirm production topology** |

---

## 6. What is NOT proven

Stated plainly, because the difference matters more than the line count.

**Proven** — everything with a check: the captured-amount rule (13), idempotency
key taxonomy (17), assignment matrix (29), finance authorization (21), eligibility
(38 across two files), ledger invariant (21), wallet history merge (15), shared
`users` schema behaviour (8). **40 check files, all passing.**

**Not proven, and it is the concurrency that matters:**

- `ledger.append` — guards verified, but the transaction, the E11000 rollback and
  the `$inc` under contention have never touched a database. Those are exactly the
  paths unit tests do not catch.
- The QC busy-lock claim under genuine concurrent accepts.
- Whether the eligibility engine's verdicts match reality — that is what shadow
  mode exists to answer.
- Every migration script. None has run.

**No database was reachable from the development machine** (`ECONNREFUSED
127.0.0.1:27017`), so no dry-run produced real numbers, and P0-9's safe /
ambiguous / conflicting counts remain unknown. I did not estimate them.

---

## 7. Six bugs the checks caught in my own code

Listed because they are the argument for writing the checks first.

1. **`Number.isFinite(Number(null))` is `true`.** Every unset policy value is
   null, so `maxDistanceKm: null` became a ceiling of **zero kilometres** and
   `minimumWalletBalance: null` became "block any balance ≤ 0" — which, given taxi
   encodes debt as a negative balance, would have blocked most of the fleet.
   Eleven checks failed at once.
2. **`pre('validate')` is skipped by `validateSync()`** — the ledger invariant
   would have looked enforced while validating nothing on every synchronous path,
   and `updateOne` skips such hooks entirely. Moved to a path validator.
3. **Unguarded release re-mirrored the legacy lock field**, so releasing a job a
   driver did not hold cleared a live lock belonging to a different job.
4. **`requireReason` defaulted independently of `enforcing`**, so tolerant mode
   passed the permission check and then returned 400 — breaking the very queue the
   staged rollout exists to keep working.
5. **`decide(null)` returned 401 regardless of enforcement**, which would have
   hard-locked any admin not in the `admins` collection out of the payout queue on
   the deploy that promises to change nothing.
6. **The tip change would have zeroed tip earnings** on the driver's screen —
   `driverController` summed `$amount`. Caught by tracing the reader before
   changing the writer.

And one measured rather than reasoned: the dead letter **blocked for 10 seconds**
with Mongo down, five times per job.

---

## 8. Recommended next actions, in order

1. **Run the backfill dry-run.** Read-only. Its output decides whether P0-4 is a
   day's work or an incident.
2. **Confirm the Razorpay webhook URL** configured in the dashboard. If only
   `/v1/payments/webhook` is live, quick-commerce orders have been reconciling
   solely via client-driven `/verify` — check for QC orders in `pending_payment`
   against a captured payment.
3. **Confirm the production MongoDB topology** is a replica set.
4. **`ELIGIBILITY_SHADOW_ENABLED=true`** in staging, then production for a week.
   Read the `WOULD_BLOCK` / `WOULD_ALLOW` lines. Expect genuine `WOULD_BLOCK` from
   taxi — it has never had a cash gate at candidate selection.
5. **Grant permissions** from `admin_audits`, then enforce.
6. **Enable `UNIFIED_DISPATCH_ENABLED`** per city once 4 and 5 are settled.

Only then: the ledger dual-write, the reconciler's fourteen clean nights, and the
cutover.

---

## 9. The final test, re-answered

> *"If I change a genuinely global business rule once, will all four verticals obey it?"*

**Still no — but the reason has changed.** It was "there is no one place to change
it." It is now "the one place exists, is tested, and nothing consumes it yet."

That is a smaller gap, and shadow mode is how it closes: not by trusting the new
engine, but by proving against a week of real traffic that its answer is the one
the platform should have been giving all along.
