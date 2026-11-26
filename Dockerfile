FROM node:20-slim
WORKDIR /app
COPY server/package*.json server/
RUN cd server && npm ci --omit=dev && npm cache clean --force
COPY server server
COPY public public
ENV PORT=8080 DATA_DIR=/data NODE_ENV=production
VOLUME /data
EXPOSE 8080
HEALTHCHECK CMD node -e "fetch('http://localhost:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
