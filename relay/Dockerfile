FROM golang:1.26.6-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o relay-server .

FROM alpine:3.22
WORKDIR /app
# Non-root: the process has no reason to run as root. /app/data holds the
# libp2p identity key and mailbox blobs and becomes a named volume
# (relay_data, docker-compose.dokploy.yml) - created and chowned here so the
# volume inherits the right owner on its first mount, rather than the
# relay user hitting a permission error the first time it tries to write
# its key.
RUN adduser -D -H relay \
    && mkdir -p /app/data \
    && chown -R relay:relay /app
COPY --from=builder --chown=relay:relay /app/relay-server .
USER relay
EXPOSE 9000
CMD ["./relay-server"]
