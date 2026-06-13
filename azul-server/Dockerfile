# ---------------------------------------------------------------------------
# azul-server — multi-stage Dockerfile
# Stage 1: build — compiles the Rust server binary.
# Stage 2: runtime — minimal Debian image running the binary as a non-root user.
# ---------------------------------------------------------------------------

# ── Build stage ─────────────────────────────────────────────────────────────
FROM rust:1-slim AS build

WORKDIR /app

COPY . .

RUN cargo build --release -p azul-server

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM debian:bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/target/release/azul-server /usr/local/bin/azul-server

RUN useradd --system --no-create-home azul
USER azul

EXPOSE 8080

ENV PORT=8080

CMD ["azul-server"]
