FROM node:24-alpine

WORKDIR /app
COPY . .

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4173
ENV DATA_DIR=/data

VOLUME ["/data"]
EXPOSE 4173

CMD ["node", "server.mjs"]
