# Documentation

Reference documentation for the CRAYvings aquaculture monitoring system. Five
topic-based documents, each self-contained:

| Document | Read it when you need to… |
|---|---|
| **[ARCHITECTURE.md](ARCHITECTURE.md)** | Understand how the pieces fit: topology, data flow, SSE, offline handling, alerting, the full API map, frontend structure, env vars, debugging |
| **[DATABASE.md](DATABASE.md)** | Know a table, column, index or FK; write a migration; read the ERD |
| **[DEVICES.md](DEVICES.md)** | Register, rename, hide, archive or restore a device; rotate a device secret; understand the star topology and the health poller |
| **[TESTING.md](TESTING.md)** | Verify a change — static checks, the mock simulator, a ten-device fleet rehearsal, the hardware/star-topology run, and the automated suites |
| **[INTEGRATIONS.md](INTEGRATIONS.md)** | Set up or debug SMS delivery through HTTPSMS |

## Where to start

| You are… | Start here |
|---|---|
| Setting up for the first time | [README § Quick Start](../README.md#quick-start) → [TESTING.md § 1](TESTING.md#part-1--static-checks-no-db-no-server) |
| Adding a new tank | [DEVICES.md](DEVICES.md) → [TESTING.md § 2](TESTING.md#part-2--mock-simulator-no-hardware) |
| Changing the schema | [DATABASE.md](DATABASE.md), then read `../AGENTS.md` § SQL/migrations |
| Changing an endpoint or a page | [ARCHITECTURE.md § API Map](ARCHITECTURE.md#api-map) |
| Reviewing before a commit | [TESTING.md § Part 5](TESTING.md#part-5--automated-suites) |
| Deploying | [ARCHITECTURE.md § Security](ARCHITECTURE.md#security-considerations) — read the `VITE_API_BASE` warning first |

## Diagrams

- [ARCHITECTURE.md § Architecture Diagram](ARCHITECTURE.md#architecture-diagram)
  renders the layered system diagram inline, in both Mermaid and ASCII, so it
  reads in a terminal, on GitHub, and in an editor.
- `BLOCK_DIAGRAM.drawio` is the **editable source** for that diagram. Open it in
  [diagrams.net](https://app.diagrams.net) and export SVG/PNG to replace the
  rendered image. It is not maintained as Markdown on purpose — two editable
  copies of the same picture is one too many.

## Conventions in these documents

- Facts describe the code as it is today. Where an older statement was wrong,
  the current behaviour is documented and the discrepancy is listed in a
  **Doc corrections** table at the end of that document, so the history is not
  lost.
- Line references (`server.cjs:969`) are accurate as of 2026-10 and will drift as
  code changes. Prefer symbol or route names when precision matters.
- Commands are Windows PowerShell 5.1 friendly (`curl.exe`); translate freely.
- Placeholders are written `<like_this>`, `YOUR_VALUE`, or `+639XXXXXXXXXX`.
  No live credentials, keys or phone numbers appear in this folder.
- Paths are repository-relative unless the document says otherwise.

## Related, outside this folder

| File | Purpose |
|---|---|
| [../README.md](../README.md) | Project overview, feature list, full API reference, troubleshooting |
| [../AGENTS.md](../AGENTS.md) | Conventions and constraints for anyone (human or AI) changing this repo |
| [../TESTING_GUIDE.md](../TESTING_GUIDE.md) | The ordered A–H manual verification procedure |