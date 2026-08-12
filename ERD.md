# CRAYvings Monitoring System - Entity Relationship Diagram

> Database: `crayvings_monitoring_system_db` (PostgreSQL)

## Mermaid ERD

```mermaid
erDiagram
    users ||--o{ activity_logs : "user_name = username (FK)"
    authorized_recipients ||--o{ sms_logs : "phone_number (FK)"
    sensors ||--o{ last_alerts : "derived from latest reading (logical)"

    users {
        int id PK
        varchar name
        varchar username UK
        varchar email UK
        varchar password_hash
        varchar role
        varchar token
        timestamp created_at
        timestamp updated_at
        timestamptz token_expires_at
    }

    sensors {
        int id PK
        varchar device_id
        numeric temperature
        numeric water_level
        numeric ammonia
        timestamp timestamp
    }

    sensor_settings {
        int id PK
        numeric temp_min
        numeric temp_max
        numeric water_level_min
        numeric water_level_max
        numeric ammonia_min
        numeric ammonia_max
        timestamp updated_at
    }

    system_logs {
        int id PK
        varchar action
        varchar parameter
        varchar old_value
        varchar new_value
        timestamp timestamp
    }

    activity_logs {
        int id PK
        varchar user_name
        varchar action_type
        text description
        varchar module
        timestamp timestamp
    }

    authorized_recipients {
        int id PK
        varchar phone_number UK
        varchar name
        boolean is_active
        timestamp created_at
        timestamp updated_at
    }

    sms_logs {
        int id PK
        varchar recipient_phone
        text message
        varchar status
        text error_message
        varchar sms_id
        timestamp sent_at
    }

    system_state {
        varchar key PK
        text value
    }

    last_alerts {
        varchar device_id PK
        varchar sensor_key PK
        varchar status
        numeric value
        timestamp timestamp
    }
```

## Notes on Relationships

- **Foreign keys (enforced):**
  - `activity_logs.user_name` → `users.username` (`ON UPDATE CASCADE ON DELETE RESTRICT`). Audit trail records the acting user's username.
  - `sms_logs.recipient_phone` → `authorized_recipients.phone_number` (`ON DELETE CASCADE`). Deleting a recipient also removes their SMS history.
- `last_alerts` is keyed by `(device_id, sensor_key)` so each device keeps its own alert state. It is *derived* from the latest `sensors` reading by the alert engine — no FK (a `sensors` row is a single reading, not a 1:1 match).
- `users.token` + `users.token_expires_at` implement 24-hour session authentication (validated in `server.cjs`).
- `sensor_settings`, `system_state`, and `system_logs` are standalone tables (no relationships).
