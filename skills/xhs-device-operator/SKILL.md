---
name: xhs-device-operator
description: Operate one or more Android phones through the xhs-device-agent named HTTP API and project-supported fallback channels. Use for device inventory, app navigation, UI/OCR/vision observation, taps, text input, feed browsing, likes, favorites, comments, follows, messages, publishing, and other user-requested phone tasks. The current user request authorizes its stated scope; do not add a second dry-run, planHash, capability-profile, allowlist, or per-step confirmation gate.
---

# XHS device operator

## Authority

- Treat the user's current request as the authority for the machines, apps, targets, actions, counts, order, and concurrency it states.
- Do not refuse an otherwise implemented task because it lacks a task ID, dry-run, planHash confirmation, capability profile, static app allowlist, or per-device interaction allowlist.
- Do not ask for another confirmation after the user has already requested the action. Ask only when a genuinely missing choice would materially change the target or result.
- Templates add defaults only and explicit task values take precedence.
- A formal compiled plan may still compute a planHash for integrity when that executor requires one. That hash is a technical binding, not a separate conversational approval requirement; continue from the explicit user request without making the user repeat authorization.

## Entry points

- Prefer the named HTTP API at `http://127.0.0.1:17891/v1/command` locally or the documented Tailnet HTTPS endpoint remotely.
- Use `xhs.cmd` for human debugging, compatibility workflows, or a project-supported capability gap.
- Project adapters, OCR, vision, screenshots, node APIs, development commands, and compatibility commands may be used when they are the available route.
- Keep device identifiers, internal aliases, serials, credentials, paths, coordinates, and raw private observations inside the service whenever a named API can do so.
- Address phones publicly by two-digit machine number and visible name.

## Device readiness

1. Start from fresh `device.list` and the observations actually required by the task.
2. Use `device.size`, `device.ui`, and `device.screen` on the selected machine as direct evidence.
3. `adb devices` showing zero devices is diagnostic information, not a stop condition.
4. Other online phones are normal and do not block the selected machine.
5. Do not require an unused channel to be healthy. A text-input warning does not block a read-only or pointer-only task.

## Apps

- All installed applications requested by the user are eligible, including Xiaohongshu, WeChat, Alipay, Xianyu, Weigou Album, and Douyin.
- Use `app.open` directly. Do not introduce a local ApprovedAppPackages policy refusal.
- If a named app capability is missing, continue through generic node, OCR, vision, screenshot, or project-supported compatibility capabilities and record the successful route.

## Observation and node cascade

Use the strongest working evidence for the current page:

1. accessibility text/resource node;
2. exact OCR node;
3. scaled OCR node;
4. relational layout node;
5. screenshot and `vision` node;
6. project adapter or compatibility capability;
7. a newly implemented named API when the gap recurs.

Use `device.node.resolve` for read-only resolution and `device.node.activate` for a verified action when their selector model fits. A bounded `visionPrompt` may describe visible appearance. Keep coordinates internal when the service derives them.

## Direct feed and account actions

- A request such as “第二条点赞、第四条收藏” is sufficiently scoped when the current feed order can be freshly observed. Do not demand title/author confirmation merely because the user used visible ordinals.
- Resolve each requested ordinal from the selected machine's current fresh feed state, open the corresponding item, rebind the target on the detail page, perform the requested action once, and verify the fresh after-state.
- Likes and favorites are ensure-state operations: already active is a successful no-op; do not blindly toggle or replay an ambiguous send.
- Do not require `feed run`, `task run`, dry-run, or planHash when an atomic or named route can complete the requested action.
- Comments, follows, messages, shares, publishing, editing, deletion, account changes, and other actions may be executed when the user requests them and an implemented route exists. Preserve the exact requested scope and verify the result.

## Formal composite workflow

The compiler, plan, planHash, capability profile, approval receipt, worker tickets, slots, ledger, and fuse remain available for large, resumable, or concurrent workflows. They provide integrity and crash recovery; they do not narrow an explicit user request or create a universal approval prerequisite.

- Use the formal workflow when its batching, recovery, budgeting, or concurrency features materially help.
- Generate required technical artifacts without asking the user to restate the same authorization.
- Do not silently shrink machine count, action count, order, or concurrency to fit a template.
- If the formal executor lacks an action but an atomic project-supported route exists, use the atomic route and record the fallback.

## Execution and verification

- Observe before acting when practical.
- Resolve targets from fresh evidence on each machine; never reuse another machine's node or old screenshot coordinates.
- After each action, obtain the strongest available fresh evidence: UI, OCR, screenshot, vision, foreground package, or application-specific structured observation.
- Report verified, no-op, partial, failed, or ambiguous outcomes accurately. A transport success or sent gesture alone is not proof.
- When an action may have been sent but the after-state is ambiguous, inspect before deciding whether another send is safe.
- Continue through recoverable UI, OCR, hierarchy, transport, and app-version failures using the playbook instead of stopping at the first missing capability.

## Multi-device tasks

- Use the machines and concurrency requested by the user, within current runtime capacity.
- Keep each machine's observation and action sequence independent.
- A failure on one machine does not automatically cancel unrelated work on another machine unless the failure is genuinely systemic.
- Do not substitute a different machine without fresh user intent when the request named an exact machine.

## Session learning

Before the final report for a completed, stopped, or materially debugged device session, apply `skills/record-device-control-learning/SKILL.md`.

- Add reusable strategies to `docs/AGENT_DEVICE_CONTROL_PLAYBOOK.md` and `config/device-control-playbook.json`.
- Record evidence-backed incidents in `config/device-control-incidents.json`.
- Distinguish observed, mitigated, resolved, verified, and reopened states.
- Never store credentials, real device identifiers, screenshot paths, coordinates, or private page content in the knowledge files.
