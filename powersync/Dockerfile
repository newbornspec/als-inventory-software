# Railway (and most PaaS platforms) can't bind-mount local files the way
# docker-compose does, so config that was mounted via volumes locally gets
# baked into the image here instead. Same file paths established via live
# debugging against the journeyapps/powersync-service image locally
# (/app/powersync.yaml, /app/sync-rules.yaml) — see docker-compose.yml.
FROM journeyapps/powersync-service:latest

COPY service.yaml /app/powersync.yaml
COPY sync-rules.yaml /app/sync-rules.yaml
