FROM golang:1.26.1-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o relay-server .

FROM alpine:latest
WORKDIR /app
COPY --from=builder /app/relay-server .
EXPOSE 9000
CMD ["./relay-server"]
