# Documentation

Reference documentation for the CRAYvings aquaculture monitoring system. Six
topic-based documents, each self-contained:

| Document | Read it when you need to… |
|---|---|
| **[ARCHITECTURE.md](ARCHITECTURE.md)** | Understand how the pieces fit: topology, data flow, SSE, offline handling, alerting, the full API map, frontend structure, env vars, debugging |
| **[DATABASE.md](DATABASE.md)** | Know a table, column, index or FK; write a migration; read the ERD |
| **[DEVICES.md](DEVICES.md)** | Register, rename, hide, archive or restore a device; rotate a device secret; understand the star topology and the health poller |
| **[TESTING.md](TESTING.md)** | Verify a change — static checks, the mock simulator, a ten-device fleet rehearsal, the hardware/star-topology run, and the automated suites |
| **[INTEGRATIONS.md](INTEGRATIONS.md)** | Set up or debug SMS delivery through HTTPSMS |
| **[STRESS_TEST_PROCEDURE.md](STRESS_TEST_PROCEDURE.md)** | Run a measured stress test of the API and dashboard against a throwaway database |

## Capstone defense package

Topic documents for the capstone presentation, written against the live database after
migrations `000` + `022`–`025` (verified 2026-10-18). Index, readiness verdict and
score table: **[capstone/README.md](capstone/README.md)**.

| Document | Deliverable |
|---|---|
| **[capstone/01_data_dictionary.md](capstone/01_data_dictionary.md)** | Data dictionary — all 16 tables, every column with type, nullability, default, constraints, real example |
| **[capstone/02_erd.md](capstone/02_erd.md)** | Three Crow's Foot ERDs (subject areas) + 9-relationship master list with cardinality, participation, enforcement |
| **[capstone/03_business_rules.md](capstone/03_business_rules.md)** | Four actors, eleven business rules, `owner`-not-a-role footnote |
| **[capstone/04_normalization.md](capstone/04_normalization.md)** | UNF → 1NF → 2NF → 3NF from a real Fleet Status Report SMS, with 3NF check and defense sentence |
| **[capstone/05_mapping.md](capstone/05_mapping.md)** | Normalized relations vs actual tables (mapping table + completeness check) |
| **[capstone/06_panel_qa.md](capstone/06_panel_qa.md)** | Fifteen likely panel questions with catalog/code-verified answers |
| **[capstone/07_hostile_defense_audit.md](capstone/07_hostile_defense_audit.md)** | Three-examiner hostile defense drill — findings table, 30 panel questions, fix plan, self-quiz, with a dated status addendum for findings resolved by `000`/`022`–`025` |

Verification records (point-in-time, kept for history):
**[TESTING_SCHEMA_FIX.md](TESTING_SCHEMA_FIX.md)** — the checklist that proved
migrations 019–021 were applied and the then-changed deletion-flow code worked end
to end (the flow now archives accounts); its status note explains which literals
have since drifted.

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