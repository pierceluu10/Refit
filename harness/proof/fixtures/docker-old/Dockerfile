FROM node:18-bookworm AS build
WORKDIR /app
COPY . .
FROM build
CMD ["node", "-e", "console.log('illustrative')"]
