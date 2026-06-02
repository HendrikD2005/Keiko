# Security Boundaries

Keiko is a local coding assistant. It is designed for reviewable work in regulated engineering environments, not for unattended code changes.

## Enforced Controls

| Area              | Boundary                                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| UI                | Binds to `127.0.0.1` and rejects non-loopback hosts.                                                     |
| Credentials       | Loaded from local config, local environment, or the first-run UI flow; never accepted through CLI flags. |
| Browser responses | Never return API tokens or raw provider credentials.                                                     |
| Workspace reads   | Stay inside the selected local project path with deny-list and realpath checks.                          |
| Commands          | Use an allowlist, run without a shell, and write redacted evidence for supported surfaces.               |
| Patches           | Dry-run by default and require explicit local review before application.                                 |
| Evidence          | Redacted before writing and kept in contained local paths.                                               |

## User Responsibilities

- Run Keiko only on repositories you are allowed to inspect.
- Keep tokens, gateway config files, `.env`, and `.keiko/` out of version control.
- Review every proposed diff before applying it.
- Treat evidence as project review material and handle it according to your delivery process.
- Stop immediately if a credential appears in output or evidence.

## Known Limits

- Keiko is not a sandbox and does not provide OS-level isolation.
- Verification can run repository-authored scripts, such as project test commands.
- Evidence files are ordinary local files; they are not encrypted or tamper-evident.
- Keiko does not authenticate multiple users and is not a hosted web service.
- Offline evaluation does not prove model quality for every repository.

## Practical Rule

Use Keiko as an assistant that prepares reviewable work. Do not use it as an autonomous release, merge, or approval system.
