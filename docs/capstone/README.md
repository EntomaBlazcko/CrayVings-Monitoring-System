# CRAYvings Capstone — Database Documentation Package

Post-migration source of truth: `crayvings_monitoring_system_db`, PostgreSQL 18.3,
exported 2026-10-18 (`full_schema.sql`, repository root) after migrations `000` + `022`–`025`.

## Readiness verdict: READY (2026-10-18)

| Area | Status | Notes |
|---|---|---|
| Keys and relationships | Pass | 16/16 PKs; 8 enforced FKs; 1 trigger (`trg_sms_logs_recipient`) |
| Naming consistency | Pass (documented) | Audit-snapshot columns (`user_name`, `*_by`) intentional — see dictionary |
| Data types | Pass | 0 timezone-naive columns; sensor columns nullable, no fake-0 defaults |
| Constraints | Pass | 7 migration-new CHECKs + 10 pre-existing; enum domains bounded |
| 1NF | Pass | No multi-valued or repeating columns |
| 2NF | Pass | Sole composite key `last_alerts(device_id, sensor_key)` fully dependent |
| 3NF | Pass with justifications | Log snapshots + `devices.last_seen` cache documented as deliberate |
| ERD clarity | Pass | Split into three Crow's Foot subject-area diagrams |
| Test suites | Pass | devices 104/104 · secrets 65/65 · regression all · sessions 60/60 |

Migration ledger: `000`–`025`, 26 rows, no gaps.

## Contents

| File | Deliverable |
|---|---|
| [01_data_dictionary.md](01_data_dictionary.md) | Data dictionary, all 16 tables, every column |
| [02_erd.md](02_erd.md) | Three Crow's Foot ERDs (subject areas) + relationship list with cardinality, participation, enforcement |
| [03_business_rules.md](03_business_rules.md) | Four actors, 11 business rules, `owner` footnote |
| [04_normalization.md](04_normalization.md) | UNF → 1NF → 2NF walkthrough from a real report, 3NF check + defense sentence |
| [05_mapping.md](05_mapping.md) | Normalized result vs actual database mapping table |
| [06_panel_qa.md](06_panel_qa.md) | Likely panel questions with honest answers |
| [07_hostile_defense_audit.md](07_hostile_defense_audit.md) | Three-examiner hostile defense drill: findings table, 30 panel questions, fix plan, self-quiz — with a dated status addendum marking findings resolved by migrations `000`/`022`–`025` |

## Conventions used across the package

- **Crow's Foot notation** for all ERDs (Mermaid `erDiagram`).
- Values shown in examples are **real rows** from the live database with secrets
  (`password_hash`, `token`, `device_secret`, OTP material) never displayed.
- **ASSUMPTION** marks any meaning not provable from code or catalog alone.
- Failed sensor readings are stored as `NULL`, never `0` (migration 022).
- Two entity states, kept distinct everywhere: **hide** (`is_active = false`,
  reversible) vs **archive** (`archived_at` set, terminal, keeps history).
