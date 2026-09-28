#!/usr/bin/env bash
# Squorli Server: interactive installer for a Linux host (Docker Compose with the published image, no source checkout).
#
#   curl -fsSL https://raw.githubusercontent.com/danielklessa/squorli-server/main/deploy/install.sh -o install.sh
#   sudo bash install.sh
#
# Asks for domain, proxy setup, directory and owner, installs Docker if it is missing (get.docker.com, after asking),
# downloads the deploy files, writes .env with fresh secrets, starts the stack and checks it. Running it again on an
# existing installation updates it or changes its settings; secrets and data are kept.
# It also writes <dir>/squorli, a small wrapper around docker compose with the right profile and overlays
# (squorli update | autoupdate | status | logs | backup | restore | doctor | restart | down | <any compose command>). Its services are
# server, postgres, livekit and caddy; the server's old name "app" is still understood.
#
# Environment: SQUORLI_DIR (installation directory, default /opt/squorli), SQUORLI_LANG (de/en),
# SQUORLI_REF (git ref of the deploy files, default main), SQUORLI_RAW_BASE (base URL of the files; tests use file://).
# Details: deploy/AGENTS.md, README.md.

set -Eeuo pipefail

REF="${SQUORLI_REF:-main}"
RAW_BASE="${SQUORLI_RAW_BASE:-https://raw.githubusercontent.com/danielklessa/squorli-server/$REF}"
DEFAULT_IMAGE="ghcr.io/danielklessa/squorli-server:latest"
DEFAULT_DIRECTORY="https://directory.squorli.com"
DEFAULT_TRUSTED="172.16.0.0/12,10.0.0.0/8,192.168.0.0/16,127.0.0.1"
DEPLOY_FILES=(deploy/compose.yml deploy/caddy/Caddyfile deploy/livekit/livekit.yaml deploy/proxies/nginx.ports.yml
  deploy/proxies/remote-proxy.ports.yml deploy/proxies/nginx.conf deploy/proxies/Caddyfile.external deploy/proxies/README.md)

if [ -t 1 ]; then
  B=$'\e[1m'; D=$'\e[2m'; RED=$'\e[31m'; GRN=$'\e[32m'; YEL=$'\e[33m'; R=$'\e[0m'
  # Squorli blue (#6397FF) where the terminal takes 24-bit colors, else the palette's bright blue
  case "${COLORTERM:-}" in truecolor|24bit) BLU=$'\e[38;2;99;151;255m' ;; *) BLU=$'\e[94m' ;; esac
else B=; D=; RED=; GRN=; YEL=; R=; BLU=; fi
# Block characters and lines only where the terminal speaks UTF-8
case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in *[Uu][Tt][Ff]-8*|*[Uu][Tt][Ff]8*) UTF=1 ;; *) UTF=0 ;; esac
L=en
# t "German" "English"
t() { if [ "$L" = de ]; then printf '%s' "$1"; else printf '%s' "$2"; fi; }
step() { local line='────'; [ "$UTF" = 1 ] || line='===='; printf '\n\n%s%s%s %s%s%s\n' "$BLU" "$line" "$R" "$B" "$1" "$R"; }
ok() { printf '%s  ok%s %s\n' "$GRN" "$R" "$1"; }
warn() { printf '%s  !  %s%s\n' "$YEL" "$1" "$R"; }
note() { printf '%s     %s%s\n' "$D" "$1" "$R"; }
die() { printf '\n%sx %s%s\n' "$RED" "$1" "$R" >&2; exit 1; }
trap 'printf "\n%sx %s (line %s): %s%s\n" "$RED" "$(t "Abgebrochen" "Aborted")" "$LINENO" "$BASH_COMMAND" "$R" >&2' ERR

# ---- Input: with "curl ... | sudo bash" stdin is the script itself, so questions read from the terminal.
IN=0
setup_input() {
  if [ -t 0 ]; then IN=0
  elif [ -r /dev/tty ] && (: </dev/tty) 2>/dev/null; then exec 3</dev/tty; IN=3
  else IN=0; fi
}
trim() { local s="$1"; s="${s#"${s%%[![:space:]]*}"}"; printf '%s' "${s%"${s##*[![:space:]]}"}"; }
# ask VAR "question" ["default"]. Every question gets a blank line before it (ASK_GAP) and a blue mark (ASK_MARK);
# choose() sets both locally for its "Choice" line.
ASK_GAP=1; ASK_MARK='?'
ask() {
  local __ask_in __ask_def="${3-}"
  [ "$ASK_GAP" = 1 ] && printf '\n'
  printf '%s%s%s %s%s%s' "$BLU" "$ASK_MARK" "$R" "$B" "$2" "$R"
  if [ -n "$__ask_def" ]; then printf ' %s[%s]%s: ' "$D" "$__ask_def" "$R"; else printf ': '; fi
  IFS= read -r -u "$IN" __ask_in || die "$(t "Keine Eingabe mehr (stdin geschlossen)" "No more input (stdin closed)")"
  __ask_in="$(trim "$__ask_in")"
  printf -v "$1" '%s' "${__ask_in:-$__ask_def}"
}
# confirm "question" y|n  -> exit code
confirm() {
  local a def="$2" hint
  if [ "$def" = y ]; then hint="$(t "J/n" "Y/n")"; else hint="$(t "j/N" "y/N")"; fi
  while :; do
    ask a "$1 ($hint)"
    a="$(printf '%s' "${a:-$def}" | tr '[:upper:]' '[:lower:]')"
    case "$a" in y|yes|j|ja) return 0 ;; n|no|nein) return 1 ;; esac
  done
}
# choose VAR "question" default "option 1" "option 2" ...  -> VAR = number of the option
choose() {
  local __var="$1" __q="$2" __def="$3" __i=1 __a ASK_GAP=0 ASK_MARK='  >'; shift 3
  [ "$UTF" = 1 ] && ASK_MARK='  ›'
  printf '\n%s?%s %s%s%s\n' "$BLU" "$R" "$B" "$__q" "$R"
  for o in "$@"; do printf '  %s%s)%s %s\n' "$BLU" "$__i" "$R" "$o"; __i=$((__i + 1)); done
  while :; do
    ask __a "$(t "Auswahl" "Choice")" "$__def"
    if [[ "$__a" =~ ^[0-9]+$ ]] && [ "$__a" -ge 1 ] && [ "$__a" -le $# ]; then printf -v "$__var" '%s' "$__a"; return; fi
  done
}

# ---- .env helpers (no sourcing: the file is data)
# env_get FILE KEY -> value of the last active KEY= line, surrounding quotes removed
env_get() {
  [ -f "$1" ] || return 0
  K="$2" awk 'BEGIN { k = ENVIRON["K"]; q = sprintf("%c", 39) }
    index($0, k "=") == 1 { v = substr($0, length(k) + 2) }
    END { n = length(v); if (n >= 2 && ((substr(v,1,1) == q && substr(v,n,1) == q) || (substr(v,1,1) == "\"" && substr(v,n,1) == "\""))) v = substr(v, 2, n - 2); printf "%s", v }' "$1"
}
# env_set FILE KEY VALUE: replaces the first active KEY= line (drops further ones), else the first "#KEY=" line, else appends.
# Values outside a safe character set are single-quoted, which Compose reads literally (no $ interpolation).
env_set() {
  local v="$3"
  if [[ ! "$v" =~ ^[A-Za-z0-9._:/@+,=-]*$ ]]; then v="'$v'"; fi
  K="$2" V="$v" awk 'BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"] }
    NR == FNR { if (index($0, k "=") == 1) active = 1; next }
    !done && index($0, k "=") == 1 { print k "=" v; done = 1; next }
    active && index($0, k "=") == 1 { next }
    !active && !done && (index($0, "#" k "=") == 1 || index($0, "# " k "=") == 1) { print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }' "$1" "$1" > "$1.tmp"
  cat "$1.tmp" > "$1" && rm -f "$1.tmp"
}

secret() { if command -v openssl >/dev/null 2>&1; then openssl rand -hex 32; else head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; fi; }
is_ipv4() { [[ "$1" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; }
# probe URL CODE: waits up to 30 s until URL answers with the HTTP status CODE
probe() {
  for _ in $(seq 1 15); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$1" 2>/dev/null || true)" = "$2" ] && return 0
    sleep 2
  done
  return 1
}
port_busy() { # port_busy tcp|udp PORT
  command -v ss >/dev/null 2>&1 || return 1
  if [ "$1" = tcp ]; then ss -ltnH "sport = :$2" 2>/dev/null | grep -q .; else ss -lunH "sport = :$2" 2>/dev/null | grep -q .; fi
}

# ---- Steps
banner() {
  local art
  if [ "$UTF" = 1 ]; then
    art=$(cat <<'EOF'
          █▄▄▄▄▄▄███████▄▄
          █████████████████
         ▄██████████████████▄▄
        ████████████████████▀███▄
       ▄█████▀▀▀▀▀█████████  █████
       ███▀▀         ▀▀▀▀    ██████
       ██ ▄▄▄                ███████▄▄
       ▄███████▄            ▄████████▀
      ██████████         ▄▄█████████
      ██████████       ▄███████████▀
      ██████████▄     ▄████████████
       ██████████▄    ▀███████████
        ▀██████████▄▄  ▀████████▀
          ▀█████████████▄█▀▀▀▀▀
            ███████████▀▀
            ▀█▀
EOF
)
  else
    art=$(cat <<'EOF'
          .##:.::##########:
          .##################:
          ####################::.
         #####################:###:
        ###################### :####:
       :#####.      .:######.  .######
       :##:                    .#######:.
       .#######:               ###########
      .##########.           .##########.
      ###########:        .:###########.
      ############       #############:
      .###########.     :#############
       .###########.    :############
         ############:.. :#########:
          .#################:###:.
            .#############:.
             ###:......
EOF
)
  fi
  printf '\n%s%s%s\n\n' "$BLU" "$art" "$R"
  local dot='·'; [ "$UTF" = 1 ] || dot='-'
  printf '      %sSquorli Server%s   %sInstaller %s Linux%s\n' "$B" "$R" "$D" "$dot" "$R"
}

choose_language() {
  case "${SQUORLI_LANG:-}" in de|en) L="$SQUORLI_LANG"; return ;; esac
  local def=en a
  case "${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}" in de*) def=de ;; esac
  while :; do
    ask a "Sprache / Language (de/en)" "$def"
    case "$a" in de|DE|d) L=de; return ;; en|EN|e) L=en; return ;; esac
  done
}

preflight() {
  step "$(t "Voraussetzungen" "Requirements")"
  [ "$(uname -s)" = Linux ] || die "$(t "Dieses Skript läuft nur unter Linux." "This script only runs on Linux.")"
  [ "$(id -u)" -eq 0 ] || die "$(t "Bitte als root starten: sudo bash install.sh" "Please run as root: sudo bash install.sh")"
  command -v curl >/dev/null 2>&1 || die "$(t "curl fehlt (z. B. apt install curl)." "curl is missing (e.g. apt install curl).")"
  local arch; arch="$(uname -m)"
  if [ "$arch" != x86_64 ] && [ "$arch" != amd64 ]; then
    warn "$(t "Das veröffentlichte Image gibt es nur für x86_64 (amd64), dieser Rechner ist $arch. Auf ARM muss das Image aus dem Quellcode gebaut werden (README, \"Building from source\")." \
      "The published image exists for x86_64 (amd64) only, this machine is $arch. On ARM the image has to be built from source (README, \"Building from source\").")"
    confirm "$(t "Trotzdem fortfahren?" "Continue anyway?")" n || exit 1
  fi
  local os; os="$(sed -n 's/^PRETTY_NAME=//p' /etc/os-release 2>/dev/null | tr -d '"' || true)"
  ok "${os:-Linux} ($arch)"
}

ensure_docker() {
  step "Docker"
  if ! command -v docker >/dev/null 2>&1; then
    warn "$(t "Docker ist nicht installiert." "Docker is not installed.")"
    confirm "$(t "Docker jetzt mit dem offiziellen Skript von get.docker.com installieren?" "Install Docker now with the official script from get.docker.com?")" y \
      || die "$(t "Ohne Docker geht es nicht: https://docs.docker.com/engine/install/" "Docker is required: https://docs.docker.com/engine/install/")"
    local tmp; tmp="$(mktemp)"
    curl -fsSL https://get.docker.com -o "$tmp"
    sh "$tmp"; rm -f "$tmp"
    if command -v systemctl >/dev/null 2>&1; then systemctl enable --now docker >/dev/null 2>&1 || true; fi
  fi
  docker info >/dev/null 2>&1 || die "$(t "Der Docker-Dienst antwortet nicht (systemctl start docker?)." "The Docker daemon does not answer (systemctl start docker?).")"
  docker compose version >/dev/null 2>&1 || die "$(t "Das Compose-Plugin fehlt (Paket docker-compose-plugin)." "The Compose plugin is missing (package docker-compose-plugin).")"
  ok "$(docker --version | head -n1); $(docker compose version | head -n1)"
}

# Sets DIR, MODE (fresh|update|reconfigure), OLD_SETUP
choose_dir() {
  step "$(t "Installationsverzeichnis" "Installation directory")"
  local def="${SQUORLI_DIR:-/opt/squorli}" running=""
  # A stack of the Compose project "squorli" that runs from elsewhere (e.g. installed by hand following the README)
  running="$(docker ps -q --filter label=com.docker.compose.project=squorli | head -n1)"
  if [ -n "$running" ] && [ -z "${SQUORLI_DIR:-}" ]; then
    local wd; wd="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' "$running" 2>/dev/null || true)"
    if [ -n "$wd" ] && [ -f "$(dirname "$wd")/.env" ]; then
      def="$(dirname "$wd")"
      warn "$(t "Hier läuft schon ein Squorli-Server aus $def." "A Squorli server already runs here from $def.")"
    fi
  fi
  while :; do
    ask DIR "$(t "Verzeichnis" "Directory")" "$def"
    [[ "$DIR" = /* ]] && break
    warn "$(t "Bitte einen absoluten Pfad angeben." "Please give an absolute path.")"
  done
  DIR="${DIR%/}"
  OLD_SETUP=""
  if [ -f "$DIR/.env" ]; then
    OLD_SETUP="$(sed -n 's/^# setup: \([a-z]*\)$/\1/p' "$DIR/squorli" 2>/dev/null | head -n1 || true)"
    if [ -z "$OLD_SETUP" ]; then
      if [ "$(env_get "$DIR/.env" PROXY_MODE)" = bundled ]; then OLD_SETUP=bundled; else OLD_SETUP=local; fi
    fi
    local c
    choose c "$(t "In $DIR gibt es schon eine Installation. Was soll passieren?" "$DIR already holds an installation. What should happen?")" 1 \
      "$(t "Aktualisieren (neues Image und Deploy-Dateien, Einstellungen bleiben)" "Update (new image and deploy files, settings stay)")" \
      "$(t "Einstellungen ändern (Geheimnisse und Daten bleiben)" "Change settings (secrets and data stay)")" \
      "$(t "Abbrechen" "Abort")"
    case "$c" in 1) MODE=update ;; 2) MODE=reconfigure ;; *) exit 0 ;; esac
  else
    MODE=fresh
  fi
}

# Sets DOMAIN SERVER_NAME SETUP IMAGE DIRECTORY OWNER OWNER_CODE NODE_IP BIND_IP PROXY_IP PG_PASSWORD
configure() {
  local envf="$DIR/.env" c
  step "$(t "Einstellungen" "Settings")"

  local d_domain d_name d_image d_dir d_owner d_code d_node
  d_domain="$(env_get "$envf" PUBLIC_DOMAIN)"; [ "$d_domain" = chat.example.org ] && d_domain=""
  d_name="$(env_get "$envf" SERVER_NAME)"; d_name="${d_name:-Community}"
  d_image="$(env_get "$envf" APP_IMAGE)"; d_image="${d_image:-$DEFAULT_IMAGE}"
  d_dir="$DEFAULT_DIRECTORY"; [ "$MODE" = reconfigure ] && d_dir="$(env_get "$envf" DIRECTORY_URL)"
  d_owner="$(env_get "$envf" OWNER_PUBLIC_KEY)"
  d_code="$(env_get "$envf" OWNER_SETUP_CODE)"
  d_node="$(env_get "$envf" LIVEKIT_NODE_IP)"

  while :; do
    ask DOMAIN "$(t "Domain, unter der der Server erreichbar ist (z. B. chat.example.org)" "Domain the server is reached under (e.g. chat.example.org)")" "$d_domain"
    DOMAIN="$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]')"; DOMAIN="${DOMAIN#https://}"; DOMAIN="${DOMAIN#http://}"; DOMAIN="${DOMAIN%%/*}"
    [ "$DOMAIN" = localhost ] && break
    [[ "$DOMAIN" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$ ]] && break
    warn "$(t "Das ist kein gültiger Hostname." "That is not a valid hostname.")"
  done
  check_dns

  # SERVER_NAME only names a new database; afterwards the name lives in the admin panel
  SERVER_NAME="$d_name"
  if [ "$MODE" = fresh ]; then
    while :; do
      ask SERVER_NAME "$(t "Name des Servers (später im Adminbereich änderbar)" "Name of the server (can be changed later in the admin panel)")" "$d_name"
      if [ "${#SERVER_NAME}" -le 64 ] && [[ "$SERVER_NAME" != *"'"* ]]; then break; fi
      warn "$(t "Höchstens 64 Zeichen, kein Apostroph." "At most 64 characters, no apostrophe.")"
    done
  fi

  local d_setup=1
  case "$OLD_SETUP" in local) d_setup=2 ;; remote) d_setup=3 ;; esac
  [ "$DOMAIN" = localhost ] && [ -z "$OLD_SETUP" ] && d_setup=2
  local insist=0
  while :; do
    choose c "$(t "Wer kümmert sich um HTTPS?" "Who takes care of HTTPS?")" "$d_setup" \
      "$(t "Squorli selbst: mitgelieferter Caddy mit Let's-Encrypt-Zertifikat (braucht Port 80 und 443)" "Squorli itself: bundled Caddy with a Let's Encrypt certificate (needs ports 80 and 443)")" \
      "$(t "Ein Reverse Proxy auf diesem Rechner (nginx, Apache, Plesk ...): App und LiveKit nur auf 127.0.0.1" "A reverse proxy on this machine (nginx, Apache, Plesk ...): app and LiveKit on 127.0.0.1 only")" \
      "$(t "Ein Reverse Proxy auf einem anderen Rechner (z. B. Nginx Proxy Manager): App und LiveKit im LAN/VPN" "A reverse proxy on another machine (e.g. Nginx Proxy Manager): app and LiveKit in the LAN/VPN")"
    case "$c" in 1) SETUP=bundled ;; 2) SETUP=local ;; 3) SETUP=remote ;; esac
    [ "$SETUP" = bundled ] || break
    if [ "$DOMAIN" = localhost ]; then
      warn "$(t "Für localhost gibt es kein Let's-Encrypt-Zertifikat; bitte einen Reverse Proxy wählen." "Let's Encrypt issues no certificate for localhost; please choose a reverse proxy.")"
      d_setup=2; continue
    fi
    # Let's Encrypt checks the domain on 80 and serves on 443, so the bundled Caddy cannot move to other ports
    if [ "$OLD_SETUP" != bundled ] && [ "$insist" = 0 ] && { port_busy tcp 80 || port_busy tcp 443; }; then
      warn "$(t "Port 80 oder 443 ist schon belegt, vermutlich von einem Webserver. Caddy braucht beide für das Let's-Encrypt-Zertifikat." \
        "Port 80 or 443 is already in use, probably by a web server. Caddy needs both for the Let's Encrypt certificate.")"
      note "$(t "Wähle 2: Dein Webserver leitet dann an Squorli weiter (Vorlagen in deploy/proxies/). Nochmal 1 = trotzdem Caddy." \
        "Choose 2: your web server then forwards to Squorli (templates in deploy/proxies/). 1 again = Caddy anyway.")"
      d_setup=2; insist=1; continue
    fi
    break
  done

  BIND_IP=""; PROXY_IP=""
  if [ "$SETUP" = remote ]; then
    local d_bind; d_bind="$(env_get "$envf" PROXY_BIND_IP)"
    [ -z "$d_bind" ] && d_bind="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|100\.)' | head -n1 || true)"
    warn "$(t "Docker umgeht ufw/firewalld für veröffentlichte Ports. Binde die Ports für den Proxy deshalb an eine LAN- oder VPN-Adresse, nicht an 0.0.0.0." \
      "Docker bypasses ufw/firewalld for published ports. Bind the ports for the proxy to a LAN or VPN address, not to 0.0.0.0.")"
    while :; do
      ask BIND_IP "$(t "Adresse dieses Rechners, auf der App und LiveKit für den Proxy lauschen" "Address of this machine on which the app and LiveKit listen for the proxy")" "$d_bind"
      is_ipv4 "$BIND_IP" && break
      warn "$(t "Bitte eine IPv4-Adresse angeben." "Please give an IPv4 address.")"
    done
    while :; do
      ask PROXY_IP "$(t "IP-Adresse des Proxy-Rechners (für TRUSTED_PROXIES)" "IP address of the proxy machine (for TRUSTED_PROXIES)")"
      is_ipv4 "$PROXY_IP" && break
      warn "$(t "Bitte eine IPv4-Adresse angeben." "Please give an IPv4 address.")"
    done
  fi

  choose_ports

  local dd=1
  if [ "$MODE" = reconfigure ]; then
    if [ -z "$d_dir" ]; then dd=2; elif [ "$d_dir" != "$DEFAULT_DIRECTORY" ]; then dd=3; fi
  fi
  choose c "$(t "Squorli Directory (globale Handles, Freunde, verschlüsselte Direktnachrichten)?" "Squorli Directory (global handles, friends, encrypted direct messages)?")" "$dd" \
    "$(t "Ja, $DEFAULT_DIRECTORY" "Yes, $DEFAULT_DIRECTORY")" \
    "$(t "Nein, der Server arbeitet für sich allein (eigene Konten: ~name)" "No, the server works on its own (its own accounts: ~name)")" \
    "$(t "Ein anderes Directory" "Another directory")"
  case "$c" in
    1) DIRECTORY="$DEFAULT_DIRECTORY" ;;
    2) DIRECTORY="" ;;
    3) while :; do
         ask DIRECTORY "$(t "Adresse des Directory" "Address of the directory")" "$([ "$dd" = 3 ] && printf '%s' "$d_dir")"
         [[ "$DIRECTORY" =~ ^https?://[^[:space:]\'\"]+$ ]] && break
         warn "$(t "Bitte eine Adresse mit https:// angeben." "Please give an address with https://.")"
       done; DIRECTORY="${DIRECTORY%/}" ;;
  esac
  if [ -n "$DIRECTORY" ] && [ "$DOMAIN" = localhost ]; then
    warn "$(t "Ein Server auf localhost kann sich beim Directory nicht ausweisen; die Anmeldung mit Handle klappt dann nicht." \
      "A server on localhost cannot prove its host to the directory; signing in with a handle will not work.")"
  fi

  # Who becomes the owner (docs/features/local-accounts.md): a Squorli account by its key (with a directory only), a server
  # account that registers with a setup code this script makes, or whoever signs in first.
  say_owner_hint
  local ow ow_def=2
  [ -n "$d_owner" ] && [ -n "$DIRECTORY" ] && ow_def=1
  [ "$MODE" = reconfigure ] && [ -z "$d_owner" ] && [ -z "$d_code" ] && ow_def=3
  if [ -n "$DIRECTORY" ]; then
    choose ow "$(t "Wer wird Besitzer?" "Who becomes the owner?")" "$ow_def" \
      "$(t "Mein Squorli-Konto (@name): ich gebe seinen öffentlichen Schlüssel ein" "My Squorli account (@name): I enter its public key")" \
      "$(t "Ein Serverkonto (~name): ich registriere es mit einem Einrichtungscode, den dieses Skript erzeugt" "A server account (~name): I register it with a setup code this script makes")" \
      "$(t "Wer sich zuerst mit Konto anmeldet (dann gleich nach dem Start selbst anmelden)" "Whoever signs in first with an account (then sign in yourself right after the start)")"
  else
    [ "$ow_def" = 1 ] && ow_def=2
    choose ow "$(t "Wer wird Besitzer?" "Who becomes the owner?")" "$((ow_def - 1))" \
      "$(t "Ein Serverkonto (~name): ich registriere es mit einem Einrichtungscode, den dieses Skript erzeugt" "A server account (~name): I register it with a setup code this script makes")" \
      "$(t "Wer als Erster ein Serverkonto erstellt (dann gleich nach dem Start selbst registrieren)" "Whoever creates the first server account (then register yourself right after the start)")"
    ow=$((ow + 1))
  fi
  OWNER=""; OWNER_CODE=""
  case "$ow" in
    1) while :; do
         ask OWNER "$(t "Öffentlicher Schlüssel deines Squorli-Kontos (64 Hex-Zeichen, im Client unter Einstellungen > Konto)" "Public key of your Squorli account (64 hex characters, in the client under Settings > Account)")" "$d_owner"
         OWNER="$(printf '%s' "$OWNER" | tr '[:upper:]' '[:lower:]')"
         [[ "$OWNER" =~ ^[0-9a-f]{64}$ ]] && break
         warn "$(t "Genau 64 Zeichen 0-9 und a-f." "Exactly 64 characters 0-9 and a-f.")"
       done ;;
    2) OWNER_CODE="${d_code:-$(secret | cut -c1-24)}" ;;
  esac

  while :; do
    ask NODE_IP "$(t "Öffentliche IP für Sprache und Video (leer = LiveKit ermittelt sie selbst)" "Public IP for voice and video (empty = LiveKit detects it itself)")" "$d_node"
    [ -z "$NODE_IP" ] && break
    is_ipv4 "$NODE_IP" && break
    warn "$(t "Bitte eine IPv4-Adresse angeben oder leer lassen." "Please give an IPv4 address or leave it empty.")"
  done

  ask IMAGE "$(t "Container-Image (für Produktion am besten eine feste Version)" "Container image (for production preferably a fixed version)")" "$d_image"

  # The database password must match an existing data volume: Postgres only reads POSTGRES_PASSWORD on its first start.
  PG_PASSWORD="$(env_get "$envf" POSTGRES_PASSWORD)"
  if [ "$MODE" = fresh ] && docker volume inspect squorli_pgdata >/dev/null 2>&1; then
    warn "$(t "Es gibt schon eine Squorli-Datenbank (Docker-Volume squorli_pgdata). Sie behält ihr altes Passwort." \
      "A Squorli database already exists (Docker volume squorli_pgdata). It keeps its old password.")"
    ask PG_PASSWORD "$(t "Bisheriges POSTGRES_PASSWORD (leer = abbrechen)" "Previous POSTGRES_PASSWORD (empty = abort)")"
    [ -n "$PG_PASSWORD" ] || exit 1
  fi
}

say_owner_hint() {
  printf '\n'
  note "$(t "Jede Anmeldung braucht ein Konto: ein Squorli-Konto (@name) oder ein Serverkonto dieses Servers (~name)." \
    "Every sign-in needs an account: a Squorli account (@name) or a server account of this server (~name).")"
  note "$(t "Den Besitzer legst du hier fest: dein Squorli-Konto über seinen Schlüssel, oder ein Serverkonto, das sich mit einem" \
    "You choose the owner here: your Squorli account by its key, or a server account that registers with a setup code this")"
  note "$(t "Einrichtungscode aus diesem Skript registriert. Ohne beides wird Besitzer, wer sich zuerst anmeldet." \
    "script makes. Without either, whoever signs in first becomes the owner.")"
}

check_dns() {
  [ "$DOMAIN" = localhost ] && return
  local ips; ips="$(getent ahosts "$DOMAIN" 2>/dev/null | awk '{ print $1 }' | sort -u | tr '\n' ' ' || true)"
  if [ -z "$ips" ]; then
    warn "$(t "$DOMAIN löst (noch) nicht auf. Der DNS-Eintrag muss auf diesen Rechner zeigen, bevor ein Zertifikat ausgestellt werden kann." \
      "$DOMAIN does not resolve (yet). The DNS record has to point to this machine before a certificate can be issued.")"
  else
    ok "$DOMAIN -> $ips"
  fi
}

# ---- Host ports: APP_PORT and LK_HTTP_PORT (what a reverse proxy forwards to), LK_TCP_PORT and LK_UDP_PORT (media, open to
# everyone; LiveKit announces them to the clients, so host and container use the same number). The bundled Caddy keeps 80/443.
load_ports() {
  local envf="$DIR/.env"
  APP_PORT="$(env_get "$envf" APP_PORT)"; APP_PORT="${APP_PORT:-3000}"
  LK_HTTP_PORT="$(env_get "$envf" LIVEKIT_HTTP_PORT)"; LK_HTTP_PORT="${LK_HTTP_PORT:-7880}"
  LK_TCP_PORT="$(env_get "$envf" LIVEKIT_TCP_PORT)"; LK_TCP_PORT="${LK_TCP_PORT:-7881}"
  LK_UDP_PORT="$(env_get "$envf" LIVEKIT_UDP_PORT)"; LK_UDP_PORT="${LK_UDP_PORT:-7882}"
}
# port_owner VAR -> the port this installation already holds for VAR (empty when it holds none), so a rerun does not
# count its own containers as "in use"
port_owner() {
  case "$1" in
    APP_PORT|LK_HTTP_PORT) [ "$OLD_SETUP" = local ] || [ "$OLD_SETUP" = remote ] || return 0 ;;
    *) [ -n "$OLD_SETUP" ] || return 0 ;;
  esac
  case "$1" in APP_PORT) printf '%s' "$OLD_APP_PORT" ;; LK_HTTP_PORT) printf '%s' "$OLD_LK_HTTP_PORT" ;;
    LK_TCP_PORT) printf '%s' "$OLD_LK_TCP_PORT" ;; LK_UDP_PORT) printf '%s' "$OLD_LK_UDP_PORT" ;; esac
}
# port_problem VAR PROTO PORT -> prints why PORT cannot be used for VAR (nothing when it can)
port_problem() {
  local var="$1" proto="$2" port="$3" other
  if ! [[ "$port" =~ ^[0-9]+$ ]] || [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then t "keine Portnummer (1-65535)" "not a port number (1-65535)"; return; fi
  if [ "$proto" = tcp ] && [ "$SETUP" = bundled ] && { [ "$port" = 80 ] || [ "$port" = 443 ]; }; then t "gehört dem mitgelieferten Caddy" "belongs to the bundled Caddy"; return; fi
  for other in "${PORT_VARS[@]}"; do
    [ "$other" = "$var" ] && continue
    [ "$(port_proto "$other")" = "$proto" ] && [ "${!other}" = "$port" ] && { t "schon für $(port_label "$other") gewählt" "already chosen for $(port_label "$other")"; return; }
  done
  [ "$port" = "$(port_owner "$var")" ] && return
  port_busy "$proto" "$port" && t "belegt" "in use"
  return 0
}
port_proto() { if [ "$1" = LK_UDP_PORT ]; then printf udp; else printf tcp; fi; }
port_label() {
  case "$1" in
    APP_PORT) t "App-Server (Ziel des Proxys)" "app server (proxy target)" ;;
    LK_HTTP_PORT) t "LiveKit-Signalisierung (Ziel des Proxys für /rtc)" "LiveKit signaling (proxy target for /rtc)" ;;
    LK_TCP_PORT) t "Sprache und Video über TCP (offen für alle)" "voice and video over TCP (open to everyone)" ;;
    LK_UDP_PORT) t "Sprache und Video über UDP (offen für alle)" "voice and video over UDP (open to everyone)" ;;
  esac
}
# free_port VAR PROTO START -> the first usable port from START on
free_port() {
  local p="$3"
  while [ "$p" -le 65535 ] && [ -n "$(port_problem "$1" "$2" "$p")" ]; do p=$((p + 1)); done
  printf '%s' "$p"
}
choose_ports() {
  load_ports
  OLD_APP_PORT="$APP_PORT"; OLD_LK_HTTP_PORT="$LK_HTTP_PORT"; OLD_LK_TCP_PORT="$LK_TCP_PORT"; OLD_LK_UDP_PORT="$LK_UDP_PORT"
  PORT_VARS=(LK_TCP_PORT LK_UDP_PORT)
  [ "$SETUP" = bundled ] || PORT_VARS=(APP_PORT LK_HTTP_PORT "${PORT_VARS[@]}")
  step "Ports"
  [ "$SETUP" = bundled ] && note "$(t "80/tcp und 443/tcp für Caddy sind fest: Let's Encrypt prüft die Domain über diese Ports." "80/tcp and 443/tcp for Caddy are fixed: Let's Encrypt checks the domain over these ports.")"
  # Replace ports another service holds by the next free one from default + 10000 on
  local var proto why changed=0
  for var in "${PORT_VARS[@]}"; do
    proto="$(port_proto "$var")"
    why="$(port_problem "$var" "$proto" "${!var}")"
    if [ -n "$why" ]; then
      warn "${!var}/$proto $(t "ist" "is") $why"
      printf -v "$var" '%s' "$(free_port "$var" "$proto" $(( ${!var} + 10000 )))"; changed=1
    fi
  done
  for var in "${PORT_VARS[@]}"; do printf '  %s%6s/%s%s  %s
' "$B" "${!var}" "$(port_proto "$var")" "$R" "$(port_label "$var")"; done
  [ "$changed" = 1 ] && note "$(t "Belegte Ports sind durch freie ersetzt." "Ports in use were replaced by free ones.")"
  confirm "$(t "Diese Ports verwenden?" "Use these ports?")" y && return
  local v
  for var in "${PORT_VARS[@]}"; do
    proto="$(port_proto "$var")"
    while :; do
      ask v "$(port_label "$var"), $proto" "${!var}"
      why="$(port_problem "$var" "$proto" "$v")"
      [ -z "$why" ] && break
      warn "$v/$proto: $why"
    done
    printf -v "$var" '%s' "$v"
  done
}

summary() {
  step "$(t "Zusammenfassung" "Summary")"
  local how
  case "$SETUP" in
    bundled) how="$(t "mitgelieferter Caddy (Let's Encrypt)" "bundled Caddy (Let's Encrypt)")" ;;
    local) how="$(t "eigener Proxy auf diesem Rechner -> 127.0.0.1:$APP_PORT und 127.0.0.1:$LK_HTTP_PORT" "own proxy on this machine -> 127.0.0.1:$APP_PORT and 127.0.0.1:$LK_HTTP_PORT")" ;;
    remote) how="$(t "Proxy $PROXY_IP -> $BIND_IP:$APP_PORT und $BIND_IP:$LK_HTTP_PORT" "proxy $PROXY_IP -> $BIND_IP:$APP_PORT and $BIND_IP:$LK_HTTP_PORT")" ;;
  esac
  printf '  %-18s %s\n' "$(t "Verzeichnis" "Folder")" "$DIR" "Domain" "$DOMAIN" "$(t "Servername" "Server name")" "$SERVER_NAME" \
    "HTTPS" "$how" "Directory" "${DIRECTORY:-$(t "keins" "none")}" "$(t "Besitzer" "Owner")" "${OWNER:-$([ -n "$OWNER_CODE" ] && t "Serverkonto mit Einrichtungscode" "server account with setup code" || t "wer sich zuerst anmeldet" "whoever signs in first")}" \
    "LiveKit IP" "${NODE_IP:-$(t "automatisch" "automatic")}" "Image" "$IMAGE"
  printf '  %-18s %s\n' "$(t "Offene Ports" "Open ports")" "$([ "$SETUP" = bundled ] && printf '80/tcp 443/tcp ')$LK_TCP_PORT/tcp $LK_UDP_PORT/udp"
  confirm "$(t "So installieren?" "Install like this?")" y || exit 0
}

firewall() {
  local ports=("$LK_TCP_PORT/tcp" "$LK_UDP_PORT/udp")
  [ "$SETUP" = bundled ] && ports=(80/tcp 443/tcp "${ports[@]}")
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    if confirm "$(t "ufw ist aktiv. ${ports[*]} freigeben?" "ufw is active. Open ${ports[*]}?")" y; then
      for p in "${ports[@]}"; do ufw allow "$p" >/dev/null; done; ok "ufw: ${ports[*]}"
    fi
  elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    if confirm "$(t "firewalld ist aktiv. ${ports[*]} freigeben?" "firewalld is active. Open ${ports[*]}?")" y; then
      for p in "${ports[@]}"; do firewall-cmd --permanent --add-port="$p" >/dev/null; done
      firewall-cmd --reload >/dev/null; ok "firewalld: ${ports[*]}"
    fi
  fi
  printf '\n'
  note "$(t "Eine Firewall beim Hoster oder ein Router davor muss dieselben Ports durchlassen (bzw. weiterleiten)." \
    "A firewall at the hosting provider or a router in front has to let the same ports through (or forward them).")"
}

download_files() {
  step "$(t "Deploy-Dateien laden" "Downloading deploy files")"
  mkdir -p "$DIR/deploy/caddy" "$DIR/deploy/livekit" "$DIR/deploy/proxies"
  local f tmp
  for f in "${DEPLOY_FILES[@]}"; do
    tmp="$(mktemp)"
    curl -fsSL "$RAW_BASE/$f" -o "$tmp" || { rm -f "$tmp"; die "$(t "Download fehlgeschlagen" "Download failed"): $RAW_BASE/$f"; }
    # Keep a copy of local edits (e.g. a changed Caddyfile) before replacing a file
    if [ -f "$DIR/$f" ] && ! cmp -s "$tmp" "$DIR/$f"; then cp "$DIR/$f" "$DIR/$f.bak"; warn "$(t "$f geändert, alte Fassung: $f.bak" "$f changed, old version: $f.bak")"; fi
    cat "$tmp" > "$DIR/$f"; rm -f "$tmp"
  done
  ok "$RAW_BASE"
}

write_env() {
  step "$(t ".env schreiben" "Writing .env")"
  local envf="$DIR/.env"
  umask 077
  if [ ! -f "$envf" ]; then
    curl -fsSL "$RAW_BASE/.env.example" -o "$envf" || die "$(t "Download fehlgeschlagen" "Download failed"): $RAW_BASE/.env.example"
  else
    cp "$envf" "$envf.bak.$(date +%Y%m%d-%H%M%S)"
  fi
  chmod 600 "$envf"

  env_set "$envf" PUBLIC_DOMAIN "$DOMAIN"
  env_set "$envf" SERVER_NAME "$SERVER_NAME"
  env_set "$envf" APP_IMAGE "$IMAGE"
  env_set "$envf" PROXY_MODE "$([ "$SETUP" = bundled ] && printf bundled || printf external)"
  env_set "$envf" DIRECTORY_URL "$DIRECTORY"
  env_set "$envf" OWNER_PUBLIC_KEY "$OWNER"
  env_set "$envf" OWNER_SETUP_CODE "$OWNER_CODE"
  env_set "$envf" LIVEKIT_NODE_IP "$NODE_IP"
  env_set "$envf" LIVEKIT_TCP_PORT "$LK_TCP_PORT"
  env_set "$envf" LIVEKIT_UDP_PORT "$LK_UDP_PORT"
  if [ "$SETUP" != bundled ]; then env_set "$envf" APP_PORT "$APP_PORT"; env_set "$envf" LIVEKIT_HTTP_PORT "$LK_HTTP_PORT"; fi

  # Secrets: kept when present, generated when missing or still the template's placeholder
  local v
  v="$PG_PASSWORD"; if [ -z "$v" ] || [ "$v" = change-me ]; then v="$(secret)"; fi
  env_set "$envf" POSTGRES_PASSWORD "$v"
  v="$(env_get "$envf" LIVEKIT_API_KEY)"; if [ -z "$v" ] || [ "$v" = devkey ]; then env_set "$envf" LIVEKIT_API_KEY squorli; fi
  v="$(env_get "$envf" LIVEKIT_API_SECRET)"
  if [ "${#v}" -lt 32 ] || [ "$v" = change-me-to-at-least-32-random-characters ]; then env_set "$envf" LIVEKIT_API_SECRET "$(secret)"; fi

  if [ "$SETUP" = remote ]; then
    env_set "$envf" PROXY_BIND_IP "$BIND_IP"
    v="$(env_get "$envf" TRUSTED_PROXIES)"; v="${v:-$DEFAULT_TRUSTED}"
    case ",$v," in *",$PROXY_IP,"*) ;; *) v="$v,$PROXY_IP" ;; esac
    env_set "$envf" TRUSTED_PROXIES "$v"
  fi
  umask 022
  ok "$envf ($(t "nur für root lesbar" "readable by root only"))"
}

compose_args() {
  CARGS=(--env-file ../.env -f compose.yml)
  case "$SETUP" in local) CARGS+=(-f proxies/nginx.ports.yml) ;; remote) CARGS+=(-f proxies/remote-proxy.ports.yml) ;; esac
  CARGS+=(--profile "$([ "$SETUP" = bundled ] && printf bundled || printf external)")
}
dc() { (cd "$DIR/deploy" && docker compose "${CARGS[@]}" "$@"); }

write_helper() {
  local h="$DIR/squorli"
  {
    printf '#!/usr/bin/env bash\n'
    printf '# Written by the Squorli installer (deploy/install.sh); running the installer again rewrites it.\n'
    printf '# Runs docker compose for this installation with the right profile and overlays.\n'
    printf '# setup: %s\n' "$SETUP"
    printf '# lang: %s\n' "$L"
    printf 'ARGS=(%s)\n' "${CARGS[*]}"
    cat <<'EOF'
set -euo pipefail
here="$(dirname "$(readlink -f "$0")")"
cd "$here/deploy"
dc() { docker compose "${ARGS[@]}" "$@"; }
lang="$(sed -n 's/^# lang: \([a-z]*\)$/\1/p' "$0" | head -n1 || true)"; lang="${lang:-en}"
t() { if [ "$lang" = de ]; then printf '%s\n' "$1"; else printf '%s\n' "$2"; fi; }

app_image() { sed -n 's/^APP_IMAGE=//p' ../.env | tail -n1 | tr -d "'\"" || true; }
# The image a service's container should run: the one it was made from; for the server the one .env names now, which
# may be another since (latest became stable).
wanted_ref() {
  local ref=""
  if [ "$1" = server ]; then ref="$(app_image)"; fi
  if [ -z "$ref" ]; then ref="$(docker inspect -f '{{.Config.Image}}' "$2" 2>/dev/null || true)"; fi
  printf '%s\n' "$ref"
}
# The services whose container runs another image than the one its tag names now, that is after a pull. A service
# without a running container is left out: nobody starts what was stopped on purpose.
changed_services() {
  local s cid ref have want
  for s in $(dc config --services); do
    cid="$(dc ps -q "$s" 2>/dev/null | head -n1 || true)"
    [ -n "$cid" ] || continue
    have="$(docker inspect -f '{{.Image}}' "$cid" 2>/dev/null || true)"
    ref="$(wanted_ref "$s" "$cid")"
    want="$(docker image inspect -f '{{.Id}}' "$ref" 2>/dev/null || true)"
    if [ -n "$have" ] && [ -n "$want" ] && [ "$want" != "$have" ]; then printf '%s\n' "$s"; fi
  done
}
# What the server inside an image says about itself: "<version> <mark>". The mark is the version from which on an
# installation may update to this image by itself (apps/server/package.json, squorli.autoUpdateFrom), "-" when the image
# carries none. Nothing when the image cannot be asked.
server_says() {
  docker run --rm --entrypoint node "$1" -e 'const p = require("/app/package.json"); console.log(p.version + " " + ((p.squorli || {}).autoUpdateFrom || "-"));' 2>/dev/null || true
}
# Does the step from the running server to the image its tag names now ask for a person? It does when the running
# version is older than the new image's mark says and does not carry the same mark itself. BY_HAND names that mark.
by_hand() {
  local cid have want
  BY_HAND=""
  cid="$(dc ps -q server 2>/dev/null | head -n1 || true)"
  [ -n "$cid" ] || return 1
  have="$(server_says "$(docker inspect -f '{{.Image}}' "$cid")")"
  want="$(server_says "$(wanted_ref server "$cid")")"
  case "${want#* }" in [0-9]*.[0-9]*.[0-9]*) ;; *) return 1 ;; esac
  case "${have%% *}" in [0-9]*.[0-9]*.[0-9]*) ;; *) return 1 ;; esac
  [ "${have#* }" != "${want#* }" ] || return 1
  [ "${have%% *}" != "${want#* }" ] || return 1
  [ "$(printf '%s\n%s\n' "${have%% *}" "${want#* }" | sort -V | head -n1)" = "${have%% *}" ] || return 1
  BY_HAND="${want#* }"
}
# Database, files and .env into <folder>/<time>; BACKUP names the result. Half a backup is removed.
backup_to() {
  local dest
  dest="$1/$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$dest"; chmod 700 "$1" "$dest"
  if dc exec -T postgres pg_dump -U chat -d chat > "$dest/squorli-database.sql" \
    && dc exec -T server tar czf - -C /app/data . > "$dest/squorli-files.tar.gz" \
    && cp ../.env "$dest/env"; then
    chmod 600 "$dest"/*
    BACKUP="$(readlink -f "$dest")"
  else
    rm -rf "$dest"
    return 1
  fi
}
server_up() {
  local _
  for _ in $(seq 1 60); do
    if dc exec -T server node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}
# Automatic updates run at minute 17, so they do not meet everything that starts on the hour: every 24 hours means at
# 04:17, every n hours means counted from 00:17.
auto_words() {
  local h=0 times=""
  if [ "$1" -ge 24 ]; then t "einmal täglich um 04:17 Uhr" "once a day at 04:17"; return; fi
  if [ "$1" -eq 1 ]; then t "jede Stunde (zur Minute 17)" "every hour (at minute 17)"; return; fi
  while [ "$h" -lt 24 ]; do times="$times$(printf '%02d:17' "$h"), "; h=$((h + $1)); done
  t "alle $1 Stunden (${times%, })" "every $1 hours (${times%, })"
}
AUTO_TIMER=/etc/systemd/system/squorli-autoupdate.timer
AUTO_SERVICE=/etc/systemd/system/squorli-autoupdate.service
AUTO_CRON=/etc/cron.d/squorli-autoupdate
# The hours of the job that is set up; nothing when there is none.
auto_hours() {
  local f
  for f in "$AUTO_TIMER" "$AUTO_CRON"; do
    if [ -f "$f" ]; then sed -n 's/^# hours: \([0-9]*\)$/\1/p' "$f" | head -n1; return; fi
  done
}
# APP_IMAGE gets the tag stable, which names the newest published version; only when that image can be pulled.
use_stable() {
  if docker pull -q "$1" >/dev/null 2>&1; then
    cp -p ../.env "../.env.bak.$(date +%Y%m%d-%H%M%S)"
    sed -i "s|^APP_IMAGE=.*|APP_IMAGE=$1|" ../.env
    t "  ok APP_IMAGE=$1 ($here/.env). Das gilt mit dem nächsten Update; sofort: squorli update" \
      "  ok APP_IMAGE=$1 ($here/.env). It applies with the next update; at once: squorli update"
  else
    t "  !  $1 ließ sich nicht holen: APP_IMAGE bleibt, wie es ist." "  !  $1 could not be pulled: APP_IMAGE stays as it is."
  fi
}
auto_off() {
  if [ -f "$AUTO_TIMER" ] || [ -f "$AUTO_SERVICE" ]; then
    systemctl disable --now squorli-autoupdate.timer >/dev/null 2>&1 || true
    rm -f "$AUTO_TIMER" "$AUTO_SERVICE"
    systemctl daemon-reload >/dev/null 2>&1 || true
  fi
  rm -f "$AUTO_CRON"
}
# The app server's service was named "app" until 28 September 2026; whoever still types it means "server".
if [ $# -gt 1 ] && [ "$1" != backup ] && [ "$1" != restore ]; then
  cmd="$1"; shift; names=()
  for a in "$@"; do [ "$a" = app ] && a=server; names+=("$a"); done
  set -- "$cmd" "${names[@]}"
fi
case "${1:-help}" in
  update)
    # Pulls the images, backs up when one of them is new, and starts what changed: Compose leaves a container whose
    # image stayed the same as it is. --check: pull and say what is new, change nothing that runs (exit 10 when
    # something is new). --no-backup: without the backup. --auto: the run of the job (squorli autoupdate).
    shift; check=0; auto=0; backup=1; yes=0; BACKUP=""; stamp=""
    # What the run of the job says, with the time in front: its log holds one line per run that found nothing
    say() { printf '%s' "$stamp"; t "$1" "$2"; }
    for a in "$@"; do
      case "$a" in
        --check) check=1 ;;
        --auto) auto=1 ;;
        --no-backup) backup=0 ;;
        --yes) yes=1 ;;
        *) echo "squorli update [--check] [--no-backup] [--yes]" >&2; exit 1 ;;
      esac
    done
    if [ "$auto" = 1 ]; then
      log="$here/autoupdate.log"
      if [ -f "$log" ] && [ "$(wc -c < "$log")" -gt 1048576 ]; then tail -n 2000 "$log" > "$log.tmp" && mv "$log.tmp" "$log"; fi
      exec >> "$log" 2>&1
      stamp="$(date '+%Y-%m-%d %H:%M:%S')  "
      if ! said="$(dc pull -q 2>&1)"; then
        printf '%s\n' "$said"
        say "x Die Images ließen sich nicht holen." "x The images could not be pulled."
        exit 1
      fi
    else
      dc pull
    fi
    changed="$(changed_services | tr '\n' ' ')"; changed="${changed% }"
    if [ -z "$changed" ]; then
      say "Nichts Neues: jeder laufende Container hat das neueste Image." "Nothing new: every running container has the newest image."
      if [ "$check" = 1 ] || [ "$auto" = 1 ]; then exit 0; fi
      dc up -d --no-build --remove-orphans && dc ps
      exit 0
    fi
    say "Neue Images für: $changed" "New images for: $changed"
    hand=0
    case " $changed " in *" server "*) if by_hand; then hand=1; fi ;; esac
    if [ "$hand" = 1 ]; then
      say "!  Die neue Version von Squorli Server verlangt vorher Handarbeit, wenn die Installation älter ist als $BY_HAND, und wird nicht automatisch eingespielt. Versionshinweise, Abschnitt \"Before you update\": https://github.com/danielklessa/squorli-server/releases" \
        "!  The new version of Squorli Server asks for work by hand first when the installation is older than $BY_HAND, and is not installed automatically. Release notes, section \"Before you update\": https://github.com/danielklessa/squorli-server/releases"
      if [ "$auto" = 1 ]; then say "   Danach: squorli update" "   Then: squorli update"; exit 10; fi
    fi
    if [ "$check" = 1 ]; then t "Einspielen mit: squorli update" "Install them with: squorli update"; exit 10; fi
    if [ "$hand" = 1 ] && [ "$yes" != 1 ]; then
      read -r -p "$(t "Gelesen und erledigt? Dann ja eingeben: " "Read and done? Then type yes: ")" answer </dev/tty
      case "$answer" in yes|ja) ;; *) t "Abgebrochen." "Cancelled."; exit 1 ;; esac
    fi
    if [ "$backup" = 1 ]; then
      if backup_to ../backups; then echo "${stamp}Backup: $BACKUP"
      else
        say "x Die Sicherung ist fehlgeschlagen, das Update wurde nicht begonnen (squorli status). Ohne Sicherung: squorli update --no-backup" \
          "x The backup failed, the update was not begun (squorli status). Without a backup: squorli update --no-backup"
        exit 1
      fi
    fi
    dc up -d --no-build --remove-orphans
    if server_up; then
      if [ "$auto" != 1 ]; then dc ps; fi
      say "Aktualisiert: $changed. Der App-Server antwortet." "Updated: $changed. The app server answers."
    else
      dc ps || true
      say "x Aktualisiert: $changed, aber der App-Server antwortet nicht (squorli logs server). Sicherung von vorher: ${BACKUP:-keine}" \
        "x Updated: $changed, but the app server does not answer (squorli logs server). Backup from before: ${BACKUP:-none}"
      exit 1
    fi ;;
  autoupdate)
    # A job that runs "squorli update --auto" every 1 to 24 hours: a timer of systemd, or a file in /etc/cron.d.
    case "${2:-status}" in
      status)
        hours="$(auto_hours)"
        if [ -z "$hours" ]; then
          t "Automatische Updates: aus" "Automatic updates: off"
          t "Einschalten: squorli autoupdate on" "Switch on: squorli autoupdate on"
        else
          t "Automatische Updates: an, $(auto_words "$hours")" "Automatic updates: on, $(auto_words "$hours")"
          if [ -f "$AUTO_TIMER" ]; then
            next="$(systemctl show squorli-autoupdate.timer -p NextElapseUSecRealtime --value 2>/dev/null || true)"
            if [ -n "$next" ]; then t "Nächster Lauf: $next" "Next run: $next"; fi
          fi
        fi
        if [ -f "$here/autoupdate.log" ]; then
          echo
          t "Die letzten Läufe ($here/autoupdate.log):" "The last runs ($here/autoupdate.log):"
          tail -n 12 "$here/autoupdate.log" | sed 's/^/  /'
        fi ;;
      on)
        if [ "$(id -u)" != 0 ]; then t "Das geht nur als root (sudo squorli autoupdate on)." "This needs root (sudo squorli autoupdate on)." >&2; exit 1; fi
        echo
        t "Automatische Updates: bitte vorher lesen" "Automatic updates: please read this first"
        t "  !  Ein Update startet den App-Server neu, wann immer eine neue Version erscheint: wer gerade schreibt oder spricht, wird kurz getrennt." \
          "  !  An update restarts the app server whenever a new version appears: whoever is writing or talking is cut off for a moment."
        t "  !  Eine Version, die vorher Handarbeit verlangt, wird nicht automatisch eingespielt: Sie steht dann im Log und wartet auf squorli update." \
          "  !  A version that asks for work by hand first is not installed automatically: it stands in the log then and waits for squorli update."
        t "  !  Neue Images von PostgreSQL und Caddy kommen mit: dann startet auch die Datenbank oder der Proxy neu." \
          "  !  New images of PostgreSQL and Caddy come along: the database or the proxy restarts then, too."
        t "  !  Vor jedem Update wird gesichert. Die Sicherungen bleiben liegen und brauchen Platz: $here/backups" \
          "  !  Every update makes a backup first. The backups stay and take space: $here/backups"
        t "     Ein Update, das fehlschlägt, wird nicht zurückgenommen. Was geschah, steht in $here/autoupdate.log." \
          "     An update that fails is not taken back. What happened is in $here/autoupdate.log."
        t "     Empfohlen sind 24 Stunden: dann läuft die Suche einmal täglich um 04:17 Uhr." \
          "     Recommended are 24 hours: the search then runs once a day at 04:17."
        # What stands behind "on": the hours, and what to do with an image named latest
        hours=""; tag=""; words=0
        for a in "${@:3}"; do
          words=1
          case "$a" in
            --stable) tag=stable ;;
            --latest) tag=latest ;;
            -*) t "squorli autoupdate on [Stunden] [--stable]" "squorli autoupdate on [hours] [--stable]" >&2; exit 1 ;;
            *)
              hours="$a"
              case "$hours" in *[!0-9]*) hours=0 ;; esac
              if [ "${#hours}" -gt 2 ] || [ "$hours" -lt 1 ] || [ "$hours" -gt 24 ]; then
                t "'$a' ist kein Abstand in Stunden: eine ganze Zahl von 1 bis 24." "'$a' is no interval in hours: a whole number from 1 to 24." >&2; exit 1
              fi ;;
          esac
        done
        # The image the job follows
        image="$(app_image)"
        case "$image" in
          ""|*:stable) ;;
          *:latest)
            t "  !  APP_IMAGE nennt latest: Dieses Image ändert sich mit jeder Änderung in der Entwicklung, auch zwischen zwei Versionen. ${image%:latest}:stable nennt immer die neueste veröffentlichte Version." \
              "  !  APP_IMAGE names latest: this image changes with every change in development, between two versions too. ${image%:latest}:stable always names the newest published version."
            if [ -z "$tag" ] && [ "$words" = 0 ]; then
              echo
              read -r -p "$(t "? Auf stable umstellen? Der Server nimmt dann mit dem nächsten Update die neueste veröffentlichte Version. [J/n] " "? Switch to stable? The server then takes the newest published version with the next update. [Y/n] ")" answer </dev/tty
              case "$answer" in ""|j|J|ja|Ja|y|Y|yes|Yes) tag=stable ;; *) tag=latest ;; esac
            fi
            if [ "$tag" = stable ]; then use_stable "${image%:latest}:stable"
            elif [ -z "$tag" ]; then t "     Umstellen: squorli autoupdate on <Stunden> --stable" "     To switch: squorli autoupdate on <hours> --stable"; fi ;;
          *) t "  !  APP_IMAGE nennt eine feste Version ($image): eine neue Version von Squorli Server kommt so nie von selbst, nur neue Images der anderen Dienste. Für automatische Updates in $here/.env den Tag stable eintragen." \
               "  !  APP_IMAGE names a fixed version ($image): a new version of Squorli Server never arrives by itself this way, only new images of the other services. For automatic updates enter the tag stable in $here/.env." ;;
        esac
        if [ -z "$hours" ]; then
          while true; do
            echo
            read -r -p "$(t "? Alle wie viele Stunden nach einer neuen Version suchen (1-24)? [24] " "? Look for a new version every how many hours (1-24)? [24] ")" hours </dev/tty
            hours="${hours:-24}"
            case "$hours" in *[!0-9]*) hours=0 ;; esac
            if [ "${#hours}" -le 2 ] && [ "$hours" -ge 1 ] && [ "$hours" -le 24 ]; then break; fi
            t "  !  Bitte eine ganze Zahl von 1 bis 24." "  !  Please a whole number from 1 to 24."
          done
        fi
        hours=$((10#$hours))
        if [ "$hours" -ge 24 ]; then calendar='*-*-* 04:17:00'; when='17 4 * * *'
        else calendar="*-*-* 00/$hours:17:00"; when="17 */$hours * * *"; fi
        auto_off
        if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
          {
            printf '# Written by squorli autoupdate on; squorli autoupdate off removes it.\n'
            printf '[Unit]\nDescription=Squorli Server: look for a new version and install it\nAfter=docker.service network-online.target\nWants=network-online.target\n\n'
            printf '[Service]\nType=oneshot\nExecStart=%s update --auto\n' "$here/squorli"
          } > "$AUTO_SERVICE"
          {
            printf '# Written by squorli autoupdate on; squorli autoupdate off removes it.\n'
            printf '# hours: %s\n' "$hours"
            printf '[Unit]\nDescription=Squorli Server: automatic updates\n\n'
            printf '[Timer]\nOnCalendar=%s\nPersistent=true\n\n' "$calendar"
            printf '[Install]\nWantedBy=timers.target\n'
          } > "$AUTO_TIMER"
          systemctl daemon-reload
          systemctl enable --now squorli-autoupdate.timer >/dev/null 2>&1
        elif [ -d /etc/cron.d ]; then
          {
            printf '# Written by squorli autoupdate on; squorli autoupdate off removes it.\n'
            printf '# hours: %s\n' "$hours"
            printf 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n'
            printf '%s root %s update --auto\n' "$when" "$here/squorli"
          } > "$AUTO_CRON"
          chmod 644 "$AUTO_CRON"
        else
          t "Hier gibt es weder systemd noch /etc/cron.d. Diese Zeile in die Crontab von root eintragen (crontab -e):" \
            "There is neither systemd nor /etc/cron.d here. Put this line into root's crontab (crontab -e):" >&2
          echo "  $when $here/squorli update --auto" >&2
          exit 1
        fi
        echo
        t "  ok Automatische Updates sind an: $(auto_words "$hours")." "  ok Automatic updates are on: $(auto_words "$hours")."
        t "     Ausschalten: squorli autoupdate off   Stand und letzte Läufe: squorli autoupdate" \
          "     Switch off: squorli autoupdate off   State and last runs: squorli autoupdate" ;;
      off)
        if [ "$(id -u)" != 0 ]; then t "Das geht nur als root (sudo squorli autoupdate off)." "This needs root (sudo squorli autoupdate off)." >&2; exit 1; fi
        if [ -z "$(auto_hours)" ]; then t "  ok Automatische Updates waren schon aus." "  ok Automatic updates were off already."
        else auto_off; t "  ok Automatische Updates sind aus." "  ok Automatic updates are off."; fi ;;
      *)
        t "squorli autoupdate [on [Stunden] [--stable] | off]   (Stunden: 1 bis 24; --stable: APP_IMAGE von latest auf stable stellen; ohne Wort: der Stand)" \
          "squorli autoupdate [on [hours] [--stable] | off]   (hours: 1 to 24; --stable: set APP_IMAGE from latest to stable; without a word: the state)" >&2
        exit 1 ;;
    esac ;;
  status)  dc ps ;;
  logs)    shift; dc logs --tail=200 -f "$@" ;;
  restart) shift; dc restart "$@" ;;
  down)    dc down ;;
  backup)
    if backup_to "${2:-../backups}"; then echo "Backup: $BACKUP"
    else t "Die Sicherung ist fehlgeschlagen (squorli status: laufen postgres und server?)." "The backup failed (squorli status: are postgres and server running?)." >&2; exit 1; fi ;;
  restore)
    src="${2:-}"
    if [ -z "$src" ] || [ ! -f "$src/squorli-database.sql" ] || [ ! -f "$src/squorli-files.tar.gz" ]; then
      echo "squorli restore <dir> [--yes]   (a folder written by squorli backup)" >&2; exit 1
    fi
    src="$(readlink -f "$src")"
    echo "This replaces the database and all files of this installation with the backup in $src."
    if [ "${3:-}" != "--yes" ]; then
      read -r -p "Type yes to continue: " answer </dev/tty
      [ "$answer" = yes ] || { echo "Cancelled."; exit 1; }
    fi
    dc stop server
    dc up -d --wait postgres
    dc exec -T postgres psql -q -v ON_ERROR_STOP=1 -U chat -d postgres -c 'DROP DATABASE IF EXISTS chat WITH (FORCE)' -c 'CREATE DATABASE chat OWNER chat'
    dc exec -T postgres psql -q -v ON_ERROR_STOP=1 -U chat -d chat < "$src/squorli-database.sql" > /dev/null
    dc run --rm --no-deps -T --entrypoint sh server -c 'find /app/data -mindepth 1 -delete && tar xzf - -C /app/data' < "$src/squorli-files.tar.gz"
    dc up -d --no-build
    echo "Restored from $src. The .env was left as it is; the backup's copy is $src/env (PUBLIC_DOMAIN, OWNER_PUBLIC_KEY and DIRECTORY_URL should match it)." ;;
  doctor)
    # Setup check (docs/features/doctor.md): containers, DNS from this machine, then the app server's own report (it reaches its
    # public address, LiveKit and the directory; a directory repeats the address checks from outside). Exit 1 when a check fails.
    domain="$(sed -n 's/^PUBLIC_DOMAIN=//p' ../.env | tail -n1 | tr -d "'\"" || true)"
    if [ "$lang" = de ]; then echo "Container:"; else echo "Containers:"; fi
    dc ps
    if [ -n "$domain" ] && [ "$domain" != localhost ]; then
      ips="$(getent ahosts "$domain" 2>/dev/null | awk '{ print $1 }' | sort -u | tr '\n' ' ' || true)"
      echo
      if [ -n "$ips" ]; then echo "DNS: $domain -> $ips"
      elif [ "$lang" = de ]; then echo "DNS: $domain löst auf diesem Rechner nicht auf."
      else echo "DNS: $domain does not resolve on this machine."; fi
    fi
    echo
    if [ "$lang" = de ]; then echo "Prüfungen des App-Servers (aus dem Container heraus; ein Verzeichnis prüft zusätzlich von außen):"
    else echo "Checks of the app server (from inside the container; a directory also checks from outside):"; fi
    rc=0
    dc exec -T server node -e '
      const lang = process.argv[1]; const mark = { ok: "  ok  ", warn: "  !   ", fail: "  x   ", skip: "  -   " };
      fetch("http://127.0.0.1:3000/api/doctor").then(async (r) => {
        if (!r.ok) { console.log("  x   /api/doctor -> HTTP " + r.status); process.exit(1); }
        const d = await r.json();
        for (const c of d.checks) console.log(mark[c.status] + c.text[lang] + (c.detail ? "  (" + c.detail + ")" : ""));
        process.exit(d.checks.some((c) => c.status === "fail") ? 1 : 0);
      }).catch((e) => { console.log("  x   " + e.message); process.exit(1); });
    ' "$lang" || rc=$?
    echo
    if [ "$lang" = de ]; then echo "Ob Sprache und Video (UDP) ankommen, prüft nur ein Browser: Verwaltung > Server > Verbindung prüfen."
    else echo "Whether voice and video (UDP) arrive can only be checked from a browser: Verwaltung > Server > Check the connection."; fi
    exit $rc ;;
  help|-h|--help)
    echo "squorli update [--check] [--no-backup] [--yes] | autoupdate [on [hours] [--stable] | off] | status | logs [service] | restart [service] | down | backup [dir] | restore <dir> | doctor | <docker compose command>"
    echo "services: server, postgres, livekit, caddy" ;;
  *) dc "$@" ;;
esac
EOF
  } > "$h"
  chmod 755 "$h"
  if [ ! -e /usr/local/bin/squorli ] || [ "$(readlink -f /usr/local/bin/squorli 2>/dev/null)" = "$(readlink -f "$h")" ]; then
    ln -sf "$h" /usr/local/bin/squorli 2>/dev/null && HELPER=squorli || HELPER="$h"
  else
    HELPER="$h"
  fi
}

start_stack() {
  step "$(t "Container starten" "Starting containers")"
  # Leaving the bundled mode: Caddy belongs to the profile "bundled" only and would keep holding 80/443
  if [ "$OLD_SETUP" = bundled ] && [ "$SETUP" != bundled ]; then
    (cd "$DIR/deploy" && docker compose --env-file ../.env -f compose.yml --profile bundled rm -sf caddy) || true
  fi
  dc pull
  # An installation from before 28 September 2026 runs the app server as the service "app", which compose.yml no longer
  # knows: its container goes before the new one starts, or it would keep the port the new one needs; after the pull, so a pull that
  # fails leaves the old server running. The data volume stays.
  old="$(docker ps -aq --filter label=com.docker.compose.project=squorli --filter label=com.docker.compose.service=app)"
  if [ -n "$old" ]; then
    # shellcheck disable=SC2086
    docker rm -f $old >/dev/null
    note "$(t "Der Dienst des App-Servers heißt jetzt server (bisher app); der alte Container ist entfernt." "The app server's service is named server now (app before); the old container is removed.")"
  fi
  dc up -d --no-build --remove-orphans
}

verify() {
  step "$(t "Prüfen" "Checking")"
  local up=0
  for _ in $(seq 1 60); do
    if dc exec -T server node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" >/dev/null 2>&1; then up=1; break; fi
    sleep 2
  done
  if [ "$up" != 1 ]; then
    dc ps || true; dc logs --tail=40 server || true
    die "$(t "Der App-Server antwortet nicht. Logs: $HELPER logs server" "The app server does not answer. Logs: $HELPER logs server")"
  fi
  ok "$(t "App-Server läuft" "App server is running")"

  case "$SETUP" in
    bundled)
      local health="" code=""
      for _ in $(seq 1 12); do
        health="$(curl -fsS --max-time 10 "https://$DOMAIN/api/health" 2>/dev/null || true)"
        [ -n "$health" ] && break; sleep 5
      done
      if [ -n "$health" ]; then
        ok "https://$DOMAIN/api/health"
        code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$DOMAIN/rtc/validate" || true)"
        if [ "$code" = 401 ]; then ok "https://$DOMAIN/rtc/validate -> 401"; else warn "https://$DOMAIN/rtc/validate -> $code ($(t "erwartet 401" "expected 401"))"; fi
      else
        dc logs --no-log-prefix --tail=50 caddy 2>/dev/null | grep '"level":"error"' | tail -n 3 || true
        warn "$(t "https://$DOMAIN antwortet noch nicht. Meist fehlt der DNS-Eintrag oder Port 80/443 ist von außen nicht erreichbar; Caddy versucht es weiter ($HELPER logs caddy)." \
          "https://$DOMAIN does not answer yet. Usually the DNS record is missing or port 80/443 is not reachable from outside; Caddy keeps trying ($HELPER logs caddy).")"
      fi ;;
    local|remote)
      local host=127.0.0.1; [ "$SETUP" = remote ] && host="$BIND_IP"
      if probe "http://$host:$APP_PORT/api/health" 200; then ok "http://$host:$APP_PORT/api/health"; else warn "http://$host:$APP_PORT $(t "nicht erreichbar" "not reachable")"; fi
      if probe "http://$host:$LK_HTTP_PORT/rtc/validate" 401; then ok "http://$host:$LK_HTTP_PORT/rtc/validate -> 401"; else warn "http://$host:$LK_HTTP_PORT $(t "nicht erreichbar" "not reachable")"; fi ;;
  esac
}

finish() {
  step "$(t "Fertig" "Done")"
  case "$SETUP" in
    local|remote)
      local host=127.0.0.1; [ "$SETUP" = remote ] && host="$BIND_IP"
      printf '%s\n' "$(t "Jetzt den Reverse Proxy einrichten (TLS für $DOMAIN, WebSockets an):" "Now set up the reverse proxy (TLS for $DOMAIN, WebSockets on):")" \
        "  https://$DOMAIN/      -> http://$host:$APP_PORT" "  https://$DOMAIN/rtc*  -> http://$host:$LK_HTTP_PORT" \
        "$(t "Vorlagen und Anleitung: $DIR/deploy/proxies/ (README.md, nginx.conf, Caddyfile.external)" "Templates and guide: $DIR/deploy/proxies/ (README.md, nginx.conf, Caddyfile.external)")"
      [ "$SETUP" = remote ] && [ -n "$PROXY_IP" ] && printf '%s\n' "$(t "Ports $APP_PORT und $LK_HTTP_PORT nur für $PROXY_IP öffnen." "Open ports $APP_PORT and $LK_HTTP_PORT to $PROXY_IP only.")"
      echo ;;
  esac
  if [ "$LK_TCP_PORT" != 7881 ] || [ "$LK_UDP_PORT" != 7882 ]; then
    printf '%s\n\n' "$(t "Sprache und Video laufen über $LK_TCP_PORT/tcp und $LK_UDP_PORT/udp: diese Nummern in Firewall und Router freigeben bzw. weiterleiten (auf dieselbe Nummer)." \
      "Voice and video use $LK_TCP_PORT/tcp and $LK_UDP_PORT/udp: open or forward these numbers in firewall and router (to the same number).")"
  fi
  [ "$DOMAIN" = localhost ] || printf '%s %shttps://%s%s\n' "$(t "Adresse:" "Address:")" "$B" "$DOMAIN" "$R"
  if [ -n "$OWNER_CODE" ]; then
    printf '%s%s%s\n' "$YEL" "$(t "Besitzer werden: auf https://$DOMAIN ein Serverkonto (~name) registrieren und dabei diesen Einrichtungscode eingeben:" "To become the owner: register a server account (~name) on https://$DOMAIN and enter this setup code:")" "$R"
    printf '  %s%s%s\n' "$B" "$OWNER_CODE" "$R"
    printf '%s\n' "$(t "Der Code steht auch in $DIR/.env (OWNER_SETUP_CODE); sobald es einen Besitzer gibt, wirkt er nicht mehr." "The code is also in $DIR/.env (OWNER_SETUP_CODE); once there is an owner it has no effect any more.")"
  elif [ -z "$OWNER" ] && [ "$MODE" = fresh ]; then
    if [ -n "$DIRECTORY" ]; then
      printf '%s%s%s\n' "$YEL" "$(t "Wer sich als Erster mit Konto anmeldet, wird Besitzer: jetzt gleich selbst anmelden (mit @name, oder ein Serverkonto erstellen, wenn du es in der Verwaltung erlaubst)." "Whoever signs in first with an account becomes the owner: sign in yourself right now (with @name).")" "$R"
    else
      printf '%s%s%s\n' "$YEL" "$(t "Wer als Erster ein Serverkonto erstellt, wird Besitzer: jetzt gleich selbst registrieren (~name und Passwort)." "Whoever creates the first server account becomes the owner: register yourself right now (~name and password).")" "$R"
    fi
  fi
  printf '%s\n' "$(t "Verwalten:" "Manage:")" \
    "  $HELPER status      $(t "Container anzeigen" "show containers")" \
    "  $HELPER logs server $(t "Logs verfolgen" "follow logs")" \
    "  $HELPER update      $(t "neue Images holen und neu starten, was sich geändert hat (sichert vorher)" "pull new images and restart what changed (backs up first)")" \
    "  $HELPER autoupdate  $(t "automatische Updates ein- und ausschalten (on, off)" "switch automatic updates on and off (on, off)")" \
    "  $HELPER backup      $(t "Datenbank, Dateien und .env nach $DIR/backups sichern" "back up database, files and .env to $DIR/backups")" \
    "  $HELPER restore <$(t "Ordner" "dir")>  $(t "eine Sicherung zurückspielen (ersetzt Datenbank und Dateien)" "restore a backup (replaces database and files)")" \
    "  $HELPER doctor      $(t "prüfen, was bei der Einrichtung am häufigsten schiefgeht (Domain, Proxy, LiveKit, Ports, Verzeichnis)" "check what goes wrong most often in a setup (domain, proxy, LiveKit, ports, directory)")" \
    "$(t "Einstellungen ändern: dieses Skript erneut ausführen, oder $DIR/.env bearbeiten und $HELPER up -d" \
      "Change settings: run this script again, or edit $DIR/.env and run $HELPER up -d")"
}

main() {
  setup_input
  banner
  choose_language
  preflight
  ensure_docker
  choose_dir
  HELPER="$DIR/squorli"

  if [ "$MODE" = update ]; then
    local envf="$DIR/.env"
    SETUP="$OLD_SETUP"; DOMAIN="$(env_get "$envf" PUBLIC_DOMAIN)"; OWNER="$(env_get "$envf" OWNER_PUBLIC_KEY)"; OWNER_CODE=""
    BIND_IP="$(env_get "$envf" PROXY_BIND_IP)"; PROXY_IP=""
    load_ports
    compose_args
    printf '%s%s%s\n' "$D" "$(t "Vorher sichern: $HELPER backup" "Back up first: $HELPER backup")" "$R"
    confirm "$(t "Jetzt aktualisieren?" "Update now?")" y || exit 0
    download_files
    write_helper
    start_stack
    verify
    finish
    return
  fi

  configure
  summary
  firewall
  compose_args
  download_files
  write_env
  write_helper
  start_stack
  verify
  finish
}

main "$@"
