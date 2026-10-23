# The multiplayer server, run straight from TypeScript (Node strips the types).
FROM node:22-alpine
WORKDIR /app
COPY server/package.json server/package-lock.json server/
RUN cd server && npm ci --omit=dev
COPY shared shared
COPY server/index.ts server/
WORKDIR /app/server
ENV PORT=8080
EXPOSE 8080
CMD ["node", "index.ts"]
