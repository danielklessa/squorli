#!/usr/bin/env bash
# Tests the reference proxy configurations of deploy/proxies/ against the real stack (docs/features/proxy-tests.md):
# the production compose.yml in external mode, a real nginx, Traefik or Caddy in front of it with a test certificate for
# chat.test, and checks through the proxy the way a browser and the server's own setup check see it.
#
#   deploy/proxies/test/run.sh [nginx|traefik|caddy]...     (default: all three, one after the other)
#
# APP_IMAGE=<image> tests that image; unset, the script builds the Dockerfile's target "app" as squorli/app:proxytest.
# Needs docker with compose and openssl. Publishes nothing but the media ports 17881/tcp and 17882/udp on the host.
# CI: .github/workflows/ci.yml, job "proxies".
set -euo pipefail
# Git Bash on Windows would turn container paths such as /certs/ca.pem into Windows paths; docker gets only relative host paths here.
export MSYS_NO_PATHCONV=1

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
DOMAIN=chat.test
PROJECT=squorli-proxytest
MAX_UPLOAD_MB=25
PROXIES=("$@")
[ ${#PROXIES[@]} -gt 0 ] || PROXIES=(nginx traefik caddy)

WORK="$(mktemp -d)"
FAILED=0
CREATED_NETWORK=0
OVERLAYS=()

say() { printf '\n== %s\n' "$*"; }
ok() { printf '  ok    %s\n' "$*"; }
bad() { printf '  FAIL  %s\n' "$*"; FAILED=1; }

dc() { (cd "$WORK/deploy" && docker compose -p "$PROJECT" --env-file ../.env -f compose.yml "${OVERLAYS[@]}" --profile external "$@"); }
# curl as the browser: from the client container, trusting the test CA
ccurl() { dc exec -T client curl -sS --connect-timeout 5 --max-time 20 --cacert /certs/ca.pem "$@"; }

cleanup() {
  if [ "${KEEP:-}" = 1 ]; then echo "KEEP=1: stack left running, work directory $WORK"; return; fi
  if [ ${#OVERLAYS[@]} -gt 0 ]; then dc down -v --remove-orphans >/dev/null 2>&1 || true; fi
  if [ "$CREATED_NETWORK" = 1 ]; then docker network rm proxy >/dev/null 2>&1 || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

# ---- the image ----
if [ -z "${APP_IMAGE:-}" ]; then
  say "Building the app image (APP_IMAGE unset)"
  (cd "$REPO" && docker build -q --target app -t squorli/app:proxytest . >/dev/null)
  APP_IMAGE=squorli/app:proxytest
fi

# ---- an installation directory like /opt/squorli ----
mkdir -p "$WORK/deploy/livekit" "$WORK/deploy/caddy" "$WORK/deploy/proxies" "$WORK/deploy/proxytest" "$WORK/certs"
cp "$REPO/deploy/compose.yml" "$WORK/deploy/"
cp "$REPO/deploy/livekit/livekit.yaml" "$WORK/deploy/livekit/"
cp "$REPO/deploy/caddy/Caddyfile" "$WORK/deploy/caddy/"
cp "$REPO"/deploy/proxies/*.yml "$REPO"/deploy/proxies/nginx.conf "$REPO"/deploy/proxies/Caddyfile.external "$WORK/deploy/proxies/"
cp "$HERE"/*.yml "$WORK/deploy/proxytest/"

env_set() { # KEY VALUE: replace "KEY=" or "#KEY=" in .env, append when missing
  if grep -qE "^#?$1=" "$WORK/.env"; then sed -i -E "s|^#?$1=.*|$1=$2|" "$WORK/.env"; else echo "$1=$2" >> "$WORK/.env"; fi
}
cp "$REPO/.env.example" "$WORK/.env"
env_set APP_IMAGE "$APP_IMAGE"
env_set PUBLIC_DOMAIN "$DOMAIN"
env_set PROXY_MODE external
env_set POSTGRES_PASSWORD proxytestpassword
env_set LIVEKIT_API_KEY squorli
env_set LIVEKIT_API_SECRET proxytest-secret-proxytest-secret-proxytest
env_set LIVEKIT_NODE_IP 127.0.0.1
env_set LIVEKIT_TCP_PORT 17881
env_set LIVEKIT_UDP_PORT 17882
env_set DIRECTORY_URL ""
env_set MAX_UPLOAD_MB "$MAX_UPLOAD_MB"

# ---- a test CA and a certificate for chat.test ----
(
  cd "$WORK/certs"
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=Squorli proxy test CA" -keyout ca.key -out ca.pem 2>/dev/null
  openssl req -newkey rsa:2048 -nodes -subj "/CN=$DOMAIN" -keyout key.pem -out cert.csr 2>/dev/null
  printf 'subjectAltName=DNS:%s\nextendedKeyUsage=serverAuth\n' "$DOMAIN" > ext.cnf
  openssl x509 -req -in cert.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 2 -extfile ext.cnf -out cert.pem 2>/dev/null
  chmod 644 ./*.pem
)

# ---- each proxy's configuration, adapted the way its header comment says ----
sed -e "s/chat\.example\.org/$DOMAIN/g" -e 's/127\.0\.0\.1:3000/app:3000/g' -e 's/127\.0\.0\.1:7880/livekit:7880/g' \
  -e 's|#[[:space:]]*ssl_certificate[[:space:]].*|ssl_certificate /certs/cert.pem;|' \
  -e 's|#[[:space:]]*ssl_certificate_key[[:space:]].*|ssl_certificate_key /certs/key.pem;|' \
  "$REPO/deploy/proxies/nginx.conf" > "$WORK/deploy/proxytest/site.conf"
sed -e "s/chat\.example\.org {/$DOMAIN {\n\ttls \/certs\/cert.pem \/certs\/key.pem/" -e 's/127\.0\.0\.1:3000/app:3000/g' -e 's/127\.0\.0\.1:7880/livekit:7880/g' \
  "$REPO/deploy/proxies/Caddyfile.external" > "$WORK/deploy/proxytest/Caddyfile"
cat > "$WORK/deploy/proxytest/traefik-tls.yml" <<'EOF'
tls:
  stores:
    default:
      defaultCertificate:
        certFile: /certs/cert.pem
        keyFile: /certs/key.pem
EOF

# ---- the checks ----
check_proxy() {
  local proxy=$1 code body ip seen client_ips i
  say "$proxy: starting the stack"
  dc up -d --no-build --quiet-pull >/dev/null 2>&1 || { dc up -d --no-build; bad "$proxy: stack did not start"; return; }

  for i in $(seq 1 60); do
    code="$(ccurl -o /dev/null -w '%{http_code}' "https://$DOMAIN/api/health" 2>/dev/null || true)"
    [ "$code" = 200 ] && break
    sleep 2
  done
  if [ "$code" != 200 ]; then bad "https://$DOMAIN/api/health never answered 200 (last: $code)"; ccurl -v "https://$DOMAIN/api/health" 2>&1 | tail -n 15 || true; dc logs --tail=30 proxy app || true; return; fi

  body="$(ccurl "https://$DOMAIN/api/health?probe=$proxy")"
  if grep -q '"proxyMode":"external"' <<<"$body"; then ok "health through the proxy, proxyMode external"; else bad "health answered $body"; fi

  if [ "$proxy" != traefik ]; then   # Traefik's redirect is the operator's entrypoint config, not ours
    code="$(ccurl -o /dev/null -w '%{http_code} %{redirect_url}' "http://$DOMAIN/api/health" || true)"
    case "$code" in 301\ https://$DOMAIN/*|308\ https://$DOMAIN/*) ok "http redirects to https ($code)" ;; *) bad "http -> https redirect: $code" ;; esac
  fi

  code="$(ccurl -o /dev/null -w '%{http_code}' "https://$DOMAIN/rtc/validate" || true)"
  if [ "$code" = 401 ]; then ok "/rtc reaches LiveKit (401 without a token)"; else bad "/rtc/validate answered $code instead of 401"; fi

  # The WebSocket upgrade as a browser sends it (HTTP/1.1); curl waits on the open socket until --max-time.
  code="$(ccurl --http1.1 -o /dev/null -w '%{http_code}' --max-time 4 -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "https://$DOMAIN/api/ws" 2>/dev/null || true)"
  if [ "$code" = 101 ]; then ok "WebSocket upgrade on /api/ws (101)"; else bad "WebSocket upgrade on /api/ws answered $code"; fi

  # The app has to see the client's address (X-Forwarded-For from a trusted proxy), not the proxy's.
  seen="$(dc logs --no-log-prefix app 2>/dev/null | grep "probe=$proxy" | grep -o '"remoteAddress":"[^"]*"' | head -n1 | cut -d'"' -f4 || true)"
  client_ips="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$(dc ps -q client)")"
  if [ -n "$seen" ] && grep -qw -- "$seen" <<<"$client_ips"; then ok "the app sees the client's address ($seen)"
  else bad "the app saw '$seen', the client has $client_ips (X-Forwarded-For or TRUSTED_PROXIES)"; fi

  # An attachment of MAX_UPLOAD_MB plus the multipart overhead must reach the app (401 without a session), not stop at the proxy (413).
  code="$(dc exec -T client sh -c "head -c $((MAX_UPLOAD_MB * 1024 * 1024)) /dev/zero > /tmp/big && curl -sS --max-time 120 --cacert /certs/ca.pem -o /dev/null -w '%{http_code}' -F file=@/tmp/big https://$DOMAIN/api/attachments" 2>/dev/null || true)"
  case "$code" in 401) ok "an upload of $MAX_UPLOAD_MB MB passes the proxy" ;; *) bad "an upload of $MAX_UPLOAD_MB MB answered $code (413 = the proxy's body limit)" ;; esac

  # The server's own setup check (squorli doctor): it reaches https://chat.test through the proxy.
  local report
  report="$(dc exec -T app node -e '
    fetch("http://127.0.0.1:3000/api/doctor", { signal: AbortSignal.timeout(90000) }).then((r) => r.json()).then((d) => {
      for (const c of d.checks) console.log(c.id + " " + c.status + " " + c.text.en);
    }).catch((e) => { console.log("request fail " + e.message); });' 2>&1 || true)"
  for i in self websocket rtc livekit; do
    if grep -q "^$i ok " <<<"$report"; then ok "doctor: $i"; else bad "doctor: $(grep "^$i " <<<"$report" || echo "$i missing")"; fi
  done

  if [ "$FAILED" = 1 ]; then dc logs --tail=20 proxy || true; fi
  [ "${KEEP:-}" = 1 ] || dc down -v --remove-orphans >/dev/null 2>&1 || true
}

for proxy in "${PROXIES[@]}"; do
  case "$proxy" in
    nginx) OVERLAYS=(-f proxytest/common.yml -f proxytest/nginx.yml) ;;
    caddy) OVERLAYS=(-f proxytest/common.yml -f proxytest/caddy.yml) ;;
    traefik)
      if ! docker network inspect proxy >/dev/null 2>&1; then docker network create proxy >/dev/null; CREATED_NETWORK=1; fi
      OVERLAYS=(-f proxies/traefik.labels.yml -f proxytest/common.yml -f proxytest/traefik.yml) ;;
    *) echo "unknown proxy: $proxy (nginx, traefik, caddy)"; exit 2 ;;
  esac
  check_proxy "$proxy"
done

if [ "$FAILED" = 0 ]; then say "all proxy checks passed (${PROXIES[*]})"; else say "proxy checks FAILED"; exit 1; fi
