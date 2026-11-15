# Structure
# The container will:
# - Poll queue.json every 300 seconds.
# - Find records with status: 0.
# - Process each record.
# - Change status from 0 to 1 only after successful processing.
# - Preserve failed records for retry.
# - Use atomic JSON updates and file locking.
# - Run as a non-root user.

```yaml
json-queue/
├── Dockerfile
├── compose.yaml
├── requirements.txt
├── src/
│   ├── worker.py
│   └── healthcheck.sh
└── data/
    └── queue.json
```
