# Deploying agentic-inbox

## Deploy from `main`

**As of 2026-08-19, `main` is the deploy branch.** Cut deploys from it.

### The history, because it will confuse you otherwise

Until that date, production was deployed from `feat/raft-oauth-session` and never
from `main` — an accident that hardened into a convention.

Verified 2026-08-19 — every known deployed SHA is on that branch and on neither
`main` nor any of its ancestors:

```
$ git merge-base --is-ancestor e124b2c origin/main                    # → no
$ git merge-base --is-ancestor e124b2c origin/feat/raft-oauth-session  # → YES
```
(same for `3d10d00` and `e973bbe`, the two deploys before it)

Nobody on the team could state this from memory, and it cost a deploy-time stop
while four people re-derived it — twice, in opposite directions. artin then asked
the obvious question nobody had ("shouldn't it just be merged?"), and the two
branches were converged. Hence this file, and hence the merge.

### Consequences

- **Historically** a commit landing on `main` did **not** ship: several
  mailbox-provisioning commits sat there undeployed while their authors
  reasonably believed otherwise. That is fixed — they were merged in — but it is
  the exact failure mode to watch for if the branches ever diverge again.
- `.github/workflows/deploy.yml` lives on `main` anyway, because GitHub only
  offers `workflow_dispatch` for workflows on the **default** branch. The
  workflow's `ref` input is what selects the code to deploy. **CI living on main
  does not mean deploys come from main.**
- As of 2026-08-19 the branches differ by `56 / 5`:
  ```
  $ git rev-list --left-right --count feat/raft-oauth-session...origin/main
  56    5      # left = only on the deploy branch, right = only on main
  ```
  The 5 on `main` touch only `wrangler.jsonc`, appending to `EMAIL_ADDRESSES`.
  Since mailbox creation became dynamic, `isAddressAllowed` accepts anything under
  `DOMAINS` (= mail.build), so those entries gate nothing for this domain — they
  are functional no-ops. Do not merge them just to make the branches look tidy.

### One-time note after the branch merge

The five mailbox addresses that had accumulated on `main` (`mobile-qa`, `hipp`,
`huazai`, `martin`, `deepsuck`) enter the live configuration for the first time on
the **next** deploy. They are still no-ops — `isAddressAllowed` passes anything
under `DOMAINS` — so behaviour does not change. Do not read "they took effect
after that deploy" as "those five commits had been working all along". They never
shipped; they merely finally came along for the ride. (Gogo, 2026-08-19.)

## Deploying

Manual only — a deploy is a decision, not a side effect of pushing.

1. Pick the target and **say which branch's HEAD it is and why**, not just a SHA.
   A bare SHA looks like it came from nowhere twelve minutes later.
2. Run the `deploy` workflow (Actions → deploy → Run workflow) with `ref` set to
   that SHA.
3. The workflow gates on typecheck + tests, builds as its own step (a bare
   `wrangler deploy` can ship a stale `build/` artifact), asserts the wrangler
   config in that ref targets the `agentic-inbox` worker, deploys, then **polls
   `/health` until the running version equals the deployed short SHA** and fails
   if it never converges.

### Before pressing the button

- **Resolve the identifier.** Confirm what the SHA points at *now*
  (`git rev-list --left-right --count <sha>...origin/main`). A precisely pinned
  expectation aimed at the wrong object produces a confident green.
- **Write the expected `/health` value down first**, as `==`, not "it changed".
- **Agree the rollback trigger before deploying**, not after something looks odd.

### Verifying an inbound-behaviour change

Test **both** directions — "rejected everything" and "rejected correctly" look
identical if you only test the rejecting half:

- **should be accepted** — a real *external* inbound to a known-good recipient.
  An internal API send does not exercise the SMTP path at all.
- **should be rejected** — an external sender to a nonexistent address; the
  evidence is the bounce **the sender receives** (expect a permanent 5xx), not
  anything readable from inside.
- A mailbox with no natural traffic cannot prove "nothing legitimate was
  rejected" by silence. Use an active probe.
