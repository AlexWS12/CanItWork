# One container serves the API and the built web app on PORT (default 8787).
# Keys come from an env file at run time and never go into the image: docker run --env-file .env ...
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY . .
RUN npm run build -w @tv/web

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
EXPOSE 8787
CMD ["npm", "start", "-w", "@tv/server"]
