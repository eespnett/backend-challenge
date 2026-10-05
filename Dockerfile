FROM oven/bun:1.4.2
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run typecheck
USER bun
EXPOSE 3000
CMD ["bun", "src/main.ts"]
