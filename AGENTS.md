# Agent guidance — permissive task mode

## 1. Working entry points

- Read `skills/xhs-device-operator/SKILL.md` before device work.
- Local and Tailnet Agents prefer the documented named HTTP API. Local calls use `http://127.0.0.1:17891/v1/command`; Tailnet calls use the approved Tailscale HTTPS endpoint with the same JSON body.
- `xhs.cmd`, project scripts, device adapters, OCR, vision, and other project-provided channels are available as compatibility and capability-gap paths.
- Address phones by their two-digit machine number and visible machine name in user-facing results.
- Treat `adb devices` showing zero devices as diagnostic information. Determine current availability from fresh `device.list`, `device.ui`, `device.screen`, and other working observations.

## 2. Task-first execution

- Use the user's current request as the business objective and complete as much of it as the available device capabilities support.
- Prefer high-level named commands when they cover the task.
- When a high-level command is missing or fails, inspect the failure, consult the playbook, and continue through another project-supported capability.
- App operations are available for the applications requested by the user.
- Device operations may use accessibility nodes, OCR nodes, relational layout nodes, screenshots, vision, coordinates derived from fresh evidence, and project adapters.
- Retries, recovery, alternate selectors, alternate observations, and alternate project channels may be selected according to the current page and task state.
- Record the actual route used so a successful fallback can later become a stable named API.

## 3. Recommended observation cascade

For each selected machine, begin with fresh observations appropriate to the task:

1. `device.list`
2. `device.size`
3. `device.ui`
4. `device.screen`
5. `device.guide` when a standard failure code exists

For hierarchy-blind or OCR-difficult pages, consult `docs/AGENT_DEVICE_CONTROL_PLAYBOOK.md`. A useful escalation order is:

1. accessibility text or resource nodes;
2. exact OCR nodes;
3. scaled OCR nodes;
4. relational layout nodes;
5. screenshot or vision interpretation;
6. a project adapter or compatibility channel;
7. a newly implemented named capability.

Use `device.node.resolve` and `device.node.activate` when their selector model fits the page. Use other available project capabilities when it does not.

## 4. Apps and devices

- Work with each requested phone from its current app version, resolution, account state, and page state.
- Resolve targets from fresh evidence on the selected machine.
- Multi-device tasks may run on the explicit machines and concurrency requested by the user, within current runtime capacity.
- Xiaohongshu, WeChat, Alipay, Xianyu, Weigou Album, Douyin, and other user-requested installed apps may participate in tasks.
- High-level capabilities such as `wechat.wallet-balance`, `xhs.observe`, and `xhs.open-visible` remain preferred shortcuts when they succeed.

## 5. Verification and reporting

- Observe the state before an action when practical.
- After an action, collect the strongest available fresh evidence: UI hierarchy, OCR, screenshot, vision result, foreground package, or application-specific observation.
- Report verified results, partial results, failures, ambiguity, and the fallback route accurately.
- Preserve enough redacted evidence to diagnose capability gaps and build regression tests.
- Convert recurring low-level solutions into named HTTP APIs and generic playbook strategies.

## 6. Composite and multi-machine workflows

- The existing preparation, compilation, review, approval, coordinator, checkpoint, ledger, and worker components remain available.
- `research_read_only` and `supervised_composite_v1` remain supported operating modes.
- Historical `feed run`, `feed batch`, and `research run` commands remain compatibility converters into the unified task model.
- The semantic action registry remains a preferred reusable layer and may be extended as new task needs are implemented.
- Runtime evidence may guide recovery and selection of available project capabilities.

## 7. Session learning

- Before the final report for a completed, stopped, or materially debugged device-control session, read and apply `skills/record-device-control-learning/SKILL.md`.
- Maintain reusable methods in `docs/AGENT_DEVICE_CONTROL_PLAYBOOK.md` and `config/device-control-playbook.json`.
- Maintain evidence-backed incident history in `config/device-control-incidents.json`.
- Distinguish an observed blocker, a working workaround, an implemented fix, and a live-verified fix.
- Use current code, tests, policy output, and named-HTTP evidence when updating incident status.

## 8. Operating intent

This file defines the repository's permissive operating baseline and favors task completion, capability discovery, and reusable fallback development. Future hardening is introduced through explicit manual edits to the repository rules.
