# In-environment load generator for levels 2-4 (benchmark environment ONLY).
#
# BENCHMARK TOOL, NOT A PRODUCT FEATURE: it runs inside the benchmark environment's private network, where
# there is no Railway edge, so it can set a different X-Real-Ip per simulated restaurant (the backend trusts
# CLIENT_IP_HEADER=x-real-ip). That is only so one load generator can emulate several venues without
# collapsing them into a single rate-limit bucket. External clients cannot do this: the public edge
# overwrites X-Real-Ip (verified against bench-backend on 2026-10-15 with an audited request).
#
# Build context must contain a `benchmark/` directory (see runner/stage.sh, which assembles a clean one
# without fixtures or reports). No public domain, no bucket, no production reference.
#
# k6 image pinned to an exact version AND digest, verified against Docker Hub on 2026-10-15:
#   grafana/k6:2.3.0  -> index sha256:9c2dee7f...  (linux/amd64 sha256:98305727...)  built from github.com/grafana/k6 v2.3.0
# The official image installs the static Go binary at /usr/bin/k6.
FROM grafana/k6:2.3.0@sha256:9c2dee7f8ed74d317e4027c06a10f169b625638189de8d4555d0b3486a5aeb34 AS k6

FROM node:24-slim
WORKDIR /app
COPY --from=k6 /usr/bin/k6 /usr/bin/k6
RUN npm init -y >/dev/null && npm install --omit=dev --no-audit --no-fund pg@8 && k6 version
COPY benchmark ./benchmark
RUN test ! -e benchmark/.out && chmod +x benchmark/runner/entrypoint.sh
CMD ["sh", "benchmark/runner/entrypoint.sh"]
