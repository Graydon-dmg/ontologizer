# Service mode in a container: `ontologizer serve` on 0.0.0.0:8787 with the maps in /data.
# It refuses to start without tokens (by design): create one first, into the same /data:
#   docker run --rm -v "$PWD/data:/data" ontologizer token create --name me
# The server speaks plain HTTP: tokens and cookies are unencrypted on the wire. Publish the port on
# loopback only and put an HTTPS reverse proxy in front (name its host with ONTOLOGIZER_ALLOW_HOST):
#   docker run -p 127.0.0.1:8787:8787 -v "$PWD/data:/data" ontologizer
FROM node:22-slim

ENV NODE_ENV=production \
    ONTOLOGIZER_HOME=/data \
    ONTOLOGIZER_KEYRING=none \
    ONTOLOGIZER_NO_UPDATE_CHECK=1

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
COPY web ./web
COPY fixtures ./fixtures
COPY LICENSE README.md THIRD_PARTY_NOTICES.md TRADEMARKS.md ./

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787

ENTRYPOINT ["node", "src/cli/index.js"]
CMD ["serve", "--host", "0.0.0.0", "--port", "8787"]
