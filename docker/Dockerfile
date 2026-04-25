# Multi-target build for every service. Targets: cpp (origin/consumer), node (collector/loadgen),
# web (dashboard at / and player at /player/, served by avs_origin).

# ---- C++: build + unit tests (GCC on Linux) ----------------------------------------------
FROM debian:bookworm-slim AS cpp-build
RUN apt-get update && apt-get install -y --no-install-recommends \
      cmake g++ ninja-build pkg-config librdkafka-dev ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY CMakeLists.txt CMakePresets.json ./
COPY cpp ./cpp
RUN cmake --preset release -DAVS_WITH_KAFKA=ON \
    && cmake --build --preset release \
    && ctest --preset release

FROM debian:bookworm-slim AS cpp
RUN apt-get update && apt-get install -y --no-install-recommends librdkafka1 curl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=cpp-build /src/build/release/avs_origin /src/build/release/avs_consumer /usr/local/bin/
EXPOSE 8080 8082

# ---- Node: workspace deps + sources ------------------------------------------------------
FROM node:22-bookworm-slim AS node
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/abr/package.json packages/abr/
COPY services/collector/package.json services/collector/
COPY services/loadgen/package.json services/loadgen/
COPY apps/player/package.json apps/player/
COPY apps/dashboard/package.json apps/dashboard/
COPY e2e/package.json e2e/
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY packages ./packages
COPY services ./services
COPY apps ./apps
CMD ["npx", "tsx", "services/collector/src/main.ts"]

FROM node AS web-build
RUN npm run build -w @avs/dashboard && npm run build -w @avs/player

FROM cpp AS web
COPY --from=web-build /app/apps/dashboard/dist /srv/web
COPY --from=web-build /app/apps/player/dist /srv/web/player
EXPOSE 8083
CMD ["avs_origin", "--root", "/srv/web", "--port", "8083"]
