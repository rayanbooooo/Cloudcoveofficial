# Scalp City — production image: the API/trading server plus the built UI.
#
#   docker build -t scalp-city .
#   docker run -p 8787:8787 -e DATABASE_URL=... -e SESSION_SECRET=... scalp-city
#
# Configuration comes only from environment variables (see .env.example);
# no secrets are baked into the image. Run ONE instance per database: a
# second one waits in standby until the first stops (see InstanceLock).

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci --no-audit --no-fund
COPY packages ./packages
# Build everything, then reinstall only the server's runtime dependencies:
# the UI ships as static files, so its libraries (three.js etc.) stay out.
RUN npm run build \
 && npm ci --omit=dev --workspace=@scalp-city/server --no-audit --no-fund \
 && mkdir -p /out/packages/server /out/packages/web \
 && cp -a package.json node_modules /out/ \
 && cp -a packages/server/package.json packages/server/dist /out/packages/server/ \
 && if [ -d packages/server/node_modules ]; then cp -a packages/server/node_modules /out/packages/server/; fi \
 && cp -a packages/web/dist /out/packages/web/

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787
WORKDIR /app
COPY --from=build /out ./
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "packages/server/dist/index.js"]
