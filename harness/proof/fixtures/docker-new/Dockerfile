FROM node:22-bookworm AS build
WORKDIR /app
COPY . .
FROM build
CMD ["node", "-e", "console.log('illustrative')"]
