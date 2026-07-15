---
name: xhs-device-operator
description: Safely compile, review, approve, and execute unified supervised Xiaohongshu tasks on an explicit capability-bounded set of phones while preserving deterministic read-only research and mandatory human stops.
---

# XHS device operator

## Operating contract

Use `xhs.cmd` as the sole entry point for every phone operation. Hermes may describe a goal and request a candidate plan, but only the deterministic compiler, an exact human-approved `planHash`, and the local executor may determine what is sent to a phone.

Within the implemented high-level registry, treat the exact approved task as the sole business-intent source for content source, selected machines, ordered actions, conditions, counts, finite budgets, content, and requested concurrency. Templates add defaults only and explicit task values take precedence. Capability evidence may reject an unimplemented or untested request, but no wrapper may silently narrow, reorder, or replace it.

Do not infer that a planned command exists. Before using `supervised_composite_v1`, verify that current `xhs.cmd` help exposes `capability status`, `capability accept`, and `task run`; verify the task compiler, preparation, approval, coordinator, workflow, Windows wrapper, and relevant device-adapter tests pass. Use `task run --spec <file> --dry-run` only for a non-executable offline candidate. A live invocation without `--confirm-plan-hash` performs selected-device read-only preparation and renders the complete plan. Only a second invocation carrying that exact rendered hash may execute. If the active capability or live adapter does not cover a compiled action, stop before device navigation and report the missing capability; do not fall back to a legacy executor.

## Common preflight

1. Read `AGENTS.md`, `docs/RESEARCH_AUTOMATION.md`, `docs/INPUT_METHOD_WORKFLOW.md`, and the approved plan/policy relevant to the run.
2. Load `config/local.psd1` and per-device profiles without displaying or committing real identifiers.
3. Run fresh `xhs.cmd doctor`, `xhs.cmd host status`, and `xhs.cmd device list` checks. Evaluate readiness only against capabilities required by the selected mode and exact compiled actions. A warning for an unused capability, such as Xiaowei text input during a read-only run, is diagnostic and must not block that run.
4. Refuse formal work until each selected phone has one unique two-digit machine number, a visible machine name, a current internal binding, an explicit group, and an online/result for every required capability. Other online phones are normal and are not a stop condition.
5. Address devices in consultations and reports by machine number plus visible name. Never expose internal aliases, serials, account IDs, tokens, or image paths.
6. Treat Xiaowei as projection, grouping, and human takeover. Use the production device adapter only through `xhs.cmd`; do not call raw ADB, internal scripts, private APIs, or the Xiaowei WebSocket directly.
7. When Windows desktop capture is incompatible, do not request or retry it. Use the approved phone screenshot and fresh Android UI hierarchy path through `xhs.cmd`.

## Mode routing

Choose exactly one of three formal modes and preserve its boundary:

- `research_read_only`: public-content research only. Continue to require `interactionPolicy=human_final` and reject state-changing fields.
- `feed_read_only`: existing V1.1 foreground batch. It remains strictly read-only while reachable; its historical device/count limits are legacy implementation details, not governance rules.
- `supervised_composite_v1`: the primary customization lane. It accepts an explicit finite machine list or deterministic idle-machine selection and a compiled, reviewed, approved high-level action plan. Its requested device count and concurrency come from the task and must fit the current tested, human-accepted capability evidence; the repository has no permanent numeric ceiling.

`trusted-10` is a deprecated compatibility template, not a fourth formal mode. New work uses `task run`. Until the compatibility conversion is deleted, its defaults cannot override explicit task values and it must never be used to evade a unified-task capability rejection.

Never use `feed_read_only` to execute interactions. Never silently translate an unsupported composite request into generic taps, raw swipes, or the legacy template.

## Supervised composite plan lifecycle

### 1. Accept capability profile

- Treat candidate profiles and synthetic fixtures as non-production input. A profile becomes active only through a separate explicit human acceptance operation.
- Store the production acceptance receipt in ignored local state. Bind `capabilityProfileId`, `capabilityProfileHash`, `acceptedBy=human`, acceptance time, acceptance-evidence hash, and the exact accepted device, concurrency, action, and throughput limits.
- A profile edit changes its hash and invalidates the receipt. A composition request may select an accepted profile ID but may not activate or supply an arbitrary profile path.

### 2. Prepare

- Run a dedicated read-only `xhs.cmd` preparation operation for the exact finite machine list.
- If the user requests an idle test phone instead of naming one, select deterministically from currently online, unlocked, idle machines using the configured preference order, then freeze that exact machine in the candidate plan. Do not treat other online machines as a conflict and do not substitute another machine after approval.
- Perform fresh unique-online inventory and only the capability checks required by the requested actions. Derive account-state readiness from the accepted capability profile, selected-device snapshot, and exact approved action; do not require a separate static per-device business-action allowlist. Write the accepted profile ID/hash, `inventorySnapshotHash`, `capabilitySnapshotHash`, creation/expiry, and required per-device versions into the snapshot.
- Do not navigate the App, create workers, or send App/UI actions during preparation. The compiler consumes the snapshot file and never loads a device adapter.

### 3. Compile

- Accept a strict composition request that names a finite list of exact machine numbers, finite read/interaction budgets, the permitted high-level action pool, and a deterministic completion condition.
- Use a versioned seeded algorithm to realize any requested variation before execution. Save the seed, algorithm version, stable candidate-ordering rule, selected action order, every conditional branch, fallback, and hard cap.
- Runtime randomness is forbidden. Never randomize coordinates, touch offsets, dwell time, gesture speed, retry timing, targets after failure, or behavior for human imitation/evasion.
- Reject unknown fields and any action outside the closed registry. The request language must not expose generic tap/swipe/input/shell/ADB/HTTP/URL/loop/expression operations.
- Canonicalize the compiled plan, pin policy/capability versions, accepted `capabilityProfileId`/`capabilityProfileHash`, and both preparation snapshot hashes, then compute its SHA-256 `planHash`.

### 4. Review

Render a human-readable plan from the exact canonical plan. It must show:

- machines and task IDs;
- visit/read budgets;
- the realized order of Feed, image, video, comment, return, like, and favorite actions;
- seeded selection ordinals and bounded fallbacks;
- all comment-count branches and their caps;
- all account-state targets/rules and the shared total state-change budget;
- stop, local-failure, and global-fuse behavior;
- accepted capability profile ID/hash and inventory/capability snapshot hashes;
- the exact `planHash`.

Do not hide conditional branches behind a summary. The human approves the full plan, not a goal description. State explicitly that this review is the run's single confirmation boundary, execution will continue through compiled bounded recovery/fallbacks without intermediate confirmation, and the attempt will produce one terminal completion or blocked report.

### 5. Approve

- Record a separate one-shot approval for the exact `planHash` only after the user explicitly confirms it.
- Bind approval to policy hash, selected machines, accepted capability-profile ID/hash, inventory/capability snapshot hashes, expiry, and execution nonce.
- Hermes may relay the user's explicit confirmation into the approval tool, but it cannot create approval by adding a field to the plan.
- A changed plan, machine identity, capability snapshot, policy, expiry, or reused nonce invalidates approval.

### 6. Execute

- After the one-shot exact approval is valid, run the entire finite approved plan autonomously without asking for confirmation between ordinary steps. Pause only for a mandatory stop, explicit human interrupt, invalidated approval, or an action that the policy classifies as human-final.
- Recompute the canonical hash before creating workers. Any mismatch means zero device operations.
- Execute only actions and runtime branches already represented in the approved plan.
- Apply `startup_strict -> runtime_light -> account_state_strict`. Before App navigation, fully validate and bind the accepted profile/snapshots, plan/policy/approval, inventory/device identity/task-required capabilities, locks, parent epoch, worker ticket, and execution slot into one immutable in-memory worker context.
- GO opens scheduling only. A worker may navigate or call CPA/device operations only while it holds both a current parent-issued authorization ticket and a current execution-slot lease. The ticket binds attempt/worker/machine/task, plan/approval/policy hashes, accepted profile/snapshot hashes, allowed step/operation IDs, expiry, and nonce; the lease binds parent epoch, worker, ticket, slot, issuance/expiry, and state.
- After startup, authorize ordinary read-only sends with an O(1) in-memory fast gate over attempt/worker identity, current parent epoch, fuse, active slot, and allowed step. Do not reread/re-hash immutable files, repeat device/provider preflight, call CPA, or synchronously flush complete evidence merely to authorize a read-only send.
- Repeat full startup validation only after restart/resume, parent epoch/lease replacement, ticket/slot renewal, device identity/capability drift, immutable artifact change, or a new worker context. Immediately before/after like or favorite, always refresh UI, rebind the exact target, durably reserve intent, send once, and persist the verified or ambiguous after-state.
- Execution-slot transitions are atomic `available -> issued -> active -> released | revoked | expired`. Give every potential state-changing action a unique, non-transferable `operationId` and `budgetSlotId` with atomic `available -> reserved -> closed_noop | closed_skipped | sent`, then `sent -> closed_verified | closed_unresolved` transitions; no closed/unresolved slot becomes available again.
- Keep each worker serial. Persist step intent before a state-changing action and verify a fresh post-state before committing it.
- Reuse one immutable UI snapshot for consecutive pure read-only decisions only when no device send or human input intervened and the capability-profile reuse window remains valid. Refresh after every UI mutation and for every account-state transition.
- Buffer bounded read-only events/evidence and flush by profile interval/count, semantic checkpoint, terminal state, or final summary. Keep state-changing intent/ledger/result, fuse creation, and terminal summary synchronous.
- If execution stops after `sent` but before `verified`, inspect current state on recovery and never replay the action.
- Emit one terminal completion or blocked report for the attempt. Do not automatically rerun an unchanged blocked preflight, repeat the same diagnostic report, switch tools, or switch phones. Wait only when a mandatory stop or genuinely required human intervention remains.

## Closed composite action registry

Only these semantic actions are eligible in `supervised_composite_v1`:

| Action | Required boundary |
| --- | --- |
| `feed.scroll` | Scroll only the current verified Feed container. |
| `feed.open_visible` | Choose a seeded ordinal within the plan's finite, capability-approved set of freshly verified semantic cards; the initial default may be four. |
| `search.open_results` | Open results only for the approved query reference after exact text-entry verification. |
| `search.open_result` | Open the approved ordered search-result ordinal without substituting another result. |
| `content.open_xhs_url` | Open only an approved Xiaohongshu URL reference and verify the resulting public detail binding. |
| `detail.inspect` | Bind the current public-detail fingerprint before further action. |
| `detail.evaluate_title_rule` | Evaluate one compiled normalized-title rule and return a typed active/inactive observation. |
| `image.scroll_content` | Scroll only the verified image-note content container and keep the same detail identity. |
| `video.advance` | Swipe once on a verified current video surface; require a different verified video identity afterward. |
| `comments.observe_count` | Use the frozen perception cascade and return a typed count observation. |
| `comments.open` | Open a verified public comment entry and prove `COMMENT_PANEL` for the same detail. |
| `comments.collect` | Scroll only a verified comment container within a frozen budget; deidentify and deduplicate snippets. |
| `comments.close` | Close the verified panel and prove return to the same detail. |
| `navigation.return_to_feed` | Return and prove the Feed state. |
| `navigation.return_to_source` | Return and prove the exact approved search-results source. |
| `wait.for_condition` | Bounded foreground UI-state verification only. |
| `recover.to_feed` | Bounded semantic recovery with the existing two-failure limit. |
| `engagement.ensure_liked` | Ensure active on the currently bound target; never toggle blindly. |
| `engagement.ensure_favorited` | Ensure active on the currently bound target; never toggle blindly. |

If the requested behavior cannot be represented by this registry, stop at planning and report the missing capability. Do not improvise a lower-level gesture.

The registry is versioned, not permanently frozen. Add a new high-level action only with strict parameters, allowed page states, before/after verification, risk class, evidence, crash recovery, policy version, tests, rendered-plan disclosure, and explicit user approval. Never smuggle a new action through a generic primitive or fallback.

Every plan declares finite `targetValidVisitsPerDevice`, `maxVisitAttemptsPerDevice`, `maxSkippedTargetsPerDevice`, `maxFeedScrollsPerAttempt`, and `maxFeedScrollsTotalPerDevice`. The compiler expands or binds those finite attempts; exhausting a cap produces an honest partial result and never an implicit keep-searching loop.

## Target selection and state verification

- Resolve every phone independently from a fresh Android UI hierarchy. Prefer resource ID, then visible text/content description, then stable node relationships, then a versioned device override.
- Require two matching normalized UI fingerprints 500 ms apart within 8 seconds before a state-changing action.
- `feed.open_visible` sorts current semantic cards in stable visual order and applies the approved ordinal. If the ordinal is unavailable, use only the compiled fallback, such as one bounded Feed scroll followed by skip.
- After opening a detail, checkpoint a target fingerprint. Revalidate it before any like/favorite. Once bound for an engagement, the target may not be substituted.
- Treat `ensure_liked` and `ensure_favorited` as ensure-state operations. Already active is a successful no-op. An unknown before-state, identity mismatch, send timeout, or ambiguous after-state opens the global fuse and must never be retried.
- A tap, swipe, animation, toast, or delay is not proof. Only a fresh visible/UI postcondition can produce `verified`.

## Image, video, and comment behavior

- Keep image-content scrolling, video advancing, comment opening/scrolling, and Feed scrolling as distinct semantic actions.
- Never use a Feed or comment-container swipe as `video.advance`. Require a fresh `VIDEO_NOTE`, a verified video surface, a current snapshot, one gesture, and proof that detail identity changed while remaining on a non-sensitive video page.
- Close the comment panel before video advance. If the page or target identity is ambiguous after the gesture, stop that worker; do not resend the gesture.
- Observe comment count before collection using this fixed cascade:

  1. fresh UI hierarchy;
  2. local `numeric_count` OCR on a bounded crop;
  3. CPA `comment_count` through the typed TailAgent gateway;
  4. `unknown` shallow fallback.

- Freeze the comment budget after the first valid observation. A later observation may reduce confidence or stop the step but may not enlarge the budget.
- Default policy bands may represent `0 -> 0/0`, `1–5 -> 1/5`, `6–20 -> 3/20`, `21–99 -> 5/30`, `100+ -> 8/50`, and `unknown -> 1/5` as `max scrolls / max saved snippets`. They are defaults only; the compiled task freezes its finite budget within the accepted capability profile.
- Stop comment collection after two consecutive scrolls with no new deidentified snippet, an end marker, identity loss, the frozen cap, or a mandatory-stop page.

## CPA boundary

- CPA is a typed, read-only perception service, not an agent with execution authority.
- Send screenshot bytes or a bounded crop through the approved artifact request; do not give CPA a Mac/Windows path, remote URL, arbitrary prompt, provider choice, model choice, action request, or coordinate request.
- Hermes receives only the strict structured observation and never receives image bytes, base64, or local paths.
- The gateway must validate role, body/image size, MIME magic, dimensions, SHA-256, response Schema, timeout, concurrency, and audit redaction. It must not persist images or log image/base64/upstream free text.
- A CPA failure, low confidence, hash mismatch, extra field, or unavailable gateway becomes `unknown` with a shallow bounded path; it never expands device activity.
- Use the accepted capability profile's CPA workflow soft timeout; it must be shorter than the gateway/provider hard timeout and must degrade promptly to `unknown` instead of blocking the phone worker until the hard ceiling.
- CPA output cannot prove a like/favorite result and cannot add a runtime action.

## Capability-bounded multi-machine foreground execution

1. Require an explicit finite list of unique, online machine numbers. Other online machines are not blockers. `maxParallel` is positive, comes from the approved task, does not exceed the selected count, and must fit the current tested capability profile.
2. Use one foreground parent. Each machine gets one serial worker, unique task ID, device/task locks, checkpoint, event log, and evidence scope.
3. Admit workers through the plan's closed startup policy: `all_ready`, or `ready_subset_after_deadline` with finite `readyDeadlineMs` and `minReady`. Every admitted worker must pass lock-ready and capability-ready before GO; an unready worker is terminal `skipped_not_ready`, cannot join later, and transfers no work or budget. Below `minReady`, perform zero App/UI operations. GO opens deterministic scheduling only; it is not device authority.
4. Maintain a current parent lease/epoch, monotonic global fuse, one shared atomic state-change ledger, and at most `maxParallel` lease-backed execution slots. Require a current parent-issued worker ticket plus a current execution-slot lease before any navigation or CPA/device call; bind both artifacts to the exact attempt, worker, machine/task, hashes, expiry, and nonce/slot state so neither can cross workers.
5. Fully verify ticket/slot/lease/hashes once before slot activation. Thereafter each ordinary send checks only the immutable in-memory binding plus current parent epoch, fuse, active slot, and allowed step; account-state sends additionally require the exact operation slot and fresh target/before-state validation.
6. Do not discover, reassign, substitute, or fail over devices. Do not move an unfinished target to another worker, and never transfer an unused/no-op/skipped `operationId` or `budgetSlotId`.
7. A worker-local read-only navigation failure may stop only that worker. An ambiguous engagement, sensitive/identity page, plan or approval mismatch, parent lease loss, evidence/budget corruption, human interrupt, forbidden action, or the policy's systemic-failure quorum opens the global fuse for all workers.
8. Ctrl-C opens the fuse first, revokes every execution slot, prevents new issuance, and terminates the entire process tree. A stale ticket, execution-slot lease, or parent lease makes every worker stop before its next sent action.
9. The plan declares one finite batch-wide account-state budget, shown in the human review and enforced atomically through unique non-transferable operation slots. There is no permanent repository-wide numeric ceiling; the approved value must fit the current capability profile. Compatibility templates provide defaults only and never override explicit task values.

## Existing read-only and legacy lanes

### `research_read_only`

Continue to run the strict research task contract and `Run-TopicResearch` path only through `xhs.cmd`. Keep AI event-driven, privacy-gated, and bounded. Comments are public observation only; no interaction controls enter the research target set.

### `feed_read_only` V1.1

Run `xhs.cmd feed batch --spec <path> --dry-run` before the foreground execution. The legacy spec names exact machine numbers and unique task IDs. Preserve its readiness barriers, current parent lease, locks, global fuse, committed-item accounting, and interaction-field rejection until this command becomes a unified-task compatibility converter.

This lane remains read-only even after composite execution is implemented.

### Legacy single-machine `trusted-10`

Do not select `trusted-10` for new work. While the compatibility command remains reachable, treat its count and positions as defaults only, preserve its existing checkpoint protections, and never use it after a unified task is rejected. Its removal is gated on compatibility-converter and no-device acceptance completion.

## Human-final and mandatory stops

Automated engagement is limited to ensure-like and ensure-favorite inside an approved composite plan or the current legacy trusted-10 template.

Sending comments/replies, private messages, shares, follows, profile/account/privacy/security changes, publishing, editing or deleting public content, login/recovery/identity verification, granting system permissions, and payments remain human-final or prohibited. They do not exist in the composite action registry.

Stop immediately on login, CAPTCHA, challenge, risk control, account restriction, payment, private/restricted page, message/contact page, permission prompt, identity mismatch affecting the selected device or a required execution channel, different target/account/device, or any unverified state-changing result. An unrelated degraded capability is not a mandatory stop. Preserve the current state; do not dismiss, accept, bypass, retry through, or switch device channels.

## Hard boundaries

- Never bypass CAPTCHAs, risk controls, platform limits, authentication, identity/membership checks, or permissions.
- Never implement random dwell, random coordinates, simulated-human behavior, automated account warming, engagement farming, or device/network identity manipulation.
- Never share coordinates across phones or treat model output as an executable coordinate.
- Never call raw ADB, internal scripts, private APIs, or the Xiaowei WebSocket for device actions; use `xhs.cmd` so preflight, evidence, idempotency, lease, fuse, and approval gates stay active.
- Never commit or expose `.env`, `config/local.psd1`, `data/`, screenshots, UI XML, tokens, cookies, SSH keys, cloud keys, real device/account identifiers, private-message contents, or contacts.
- Report only verified, failed, ambiguous, skipped, or human-final outcomes. Never report a sent gesture as success.
