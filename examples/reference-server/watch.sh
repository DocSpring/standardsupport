#!/usr/bin/env bash
# Waits until a ticket changes, then prints one line and exits. An agent runs this in a background shell and is woken
# by the output; it then calls support_get_ticket to read the reply.
#
#   ./watch.sh <watch_url>
set -euo pipefail

url="$1"
etag=""
interval=60

while true; do
  headers="$(mktemp)"
  if [[ -n "$etag" ]]; then
    body="$(curl -fsS -D "$headers" -H "If-None-Match: $etag" "$url")"
  else
    body="$(curl -fsS -D "$headers" "$url")"
  fi
  status="$(awk 'NR==1 {print $2}' "$headers")"
  new_etag="$(awk 'tolower($1)=="etag:" {print $2}' "$headers" | tr -d '\r')"
  rm -f "$headers"

  if [[ "$status" == "200" ]]; then
    if [[ -n "$etag" && "$new_etag" != "$etag" ]]; then
      echo "The support ticket changed: $body. Call support_get_ticket to read it."
      exit 0
    fi
    etag="$new_etag"
    # Never poll more often than the server asks.
    asked="$(printf '%s' "$body" | sed -n 's/.*"min_interval_seconds":\([0-9]*\).*/\1/p')"
    if [[ -n "$asked" && "$asked" -gt "$interval" ]]; then interval="$asked"; fi
  fi
  sleep "$interval"
done
