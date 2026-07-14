# Agent rules

- Read `skills/xhs-device-operator/SKILL.md` before operating devices.
- Use `xhs.cmd` as the only device-operation entry point. Do not call internal scripts, raw ADB, or the Xiaowei WebSocket directly for device actions.
- Address phones in operator conversations, commands, and reports by their two-digit machine number and visible machine name. The number is primary because names may repeat. Internal aliases and raw identifiers stay inside ignored configuration and execution code.
- Prefer fresh Android UI hierarchy and semantic selectors over fixed coordinates. Treat every phone as an independent layout, identity, and version profile.
- Allowed without extra confirmation: inventory, screenshots for diagnosis, UI dumps, opening the app, navigating to the local user's own profile, deterministic read-only research, and syncing approved public/device fields.
- A physically supervised `trusted-10` run may perform only one like at item 5 and one favorite at item 7 after explicit approval for that run. It must be single-machine, foreground-only, evidence-backed, and stop on an ambiguous action state.
- Require separate human-final handling for following, commenting, messaging, sharing, publishing, deleting, account changes, login challenges, payments, or any other external communication.
- Never bypass CAPTCHAs, platform restrictions, risk controls, identity verification, membership restrictions, or system permission prompts.
- Bounded dwell times in a reviewed acceptance template are allowed only for foreground-state verification; never use them for evasion, account warming, or device/network identity manipulation.
- Never commit `.env`, `config/local.psd1`, `data/`, screenshots, UI XML, OAuth tokens, SSH keys, or real device/account identifiers.
- Stop a machine after two consecutive navigation failures. Stop immediately on login, CAPTCHA, risk-control, payment, private-message, contact, or permission pages and report the current screenshot and hierarchy paths.
