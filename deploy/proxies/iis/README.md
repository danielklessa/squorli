# IIS in front of Squorli (Windows Server, external mode)

For a Windows Server whose IIS holds ports 80 and 443 already. IIS terminates TLS and forwards to the Squorli services of the same machine: `/rtc*` to LiveKit (`127.0.0.1:7880`), everything else to the app server (`127.0.0.1:3000`). The setup (`install.ps1`) is run with "a reverse proxy on this machine"; it names the two ports at its end. The general rules for every proxy are in [../README.md](../README.md).

**Status: not tested.** The file follows the documentation of URL Rewrite and Application Request Routing; it has not run against a real IIS yet (docs/features/windows.md). The checks at the end tell whether it works.

## Once per server

1. Windows feature **WebSocket Protocol** (Server Manager > Add roles and features > Web Server (IIS) > Application Development), or in an administrator's PowerShell:
   ```powershell
   Install-WindowsFeature Web-WebSockets
   ```
2. The IIS modules **URL Rewrite** (https://www.iis.net/downloads/microsoft/url-rewrite) and **Application Request Routing 3** (https://www.iis.net/downloads/microsoft/application-request-routing). Restart the IIS Manager afterwards.
3. Switch the proxy on and keep the host name and the client's address. In an administrator's PowerShell:
   ```powershell
   $appcmd = "$env:SystemRoot\System32\inetsrv\appcmd.exe"
   # ARR forwards at all
   & $appcmd set config -section:system.webServer/proxy /enabled:"True" /commit:apphost
   # Squorli checks sign-ins against the host name the browser used, not 127.0.0.1
   & $appcmd set config -section:system.webServer/proxy /preserveHostHeader:"True" /commit:apphost
   # X-Forwarded-For without the port behind the address
   & $appcmd set config -section:system.webServer/proxy /includePortInXForwardedFor:"False" /commit:apphost
   # Squorli's own addresses in answers stay as they are
   & $appcmd set config -section:system.webServer/proxy /reverseRewriteHostInResponseHeaders:"False" /commit:apphost
   # The rules may set X-Forwarded-Proto
   & $appcmd set config -section:system.webServer/rewrite/allowedServerVariables /+"[name='HTTP_X_FORWARDED_PROTO']" /commit:apphost
   ```
   ARR's time limit for an answer is 120 seconds by default, which is enough: Squorli's connections send a ping every 30 seconds.

## The site

1. A site for `chat.example.org` with an empty folder as its physical path (for example `C:\inetpub\squorli`), bindings for http (80) and https (443) with the certificate for the domain. A Let's Encrypt client for IIS (win-acme, Certify the Web) gets and renews the certificate.
2. Copy [web.config](web.config) into that folder. Replace `3000` and `7880` when the setup chose other ports.
3. The application pool of the site needs no managed code (".NET CLR version": "No Managed Code").

Squorli's `.env` (`C:\ProgramData\Squorli\.env`) needs nothing special: `TRUSTED_PROXIES=127.0.0.1` is the default, and IIS reaches the services from 127.0.0.1.

## Firewall

Open `80/tcp` and `443/tcp` for IIS as usual, and `7881/tcp` and `7882/udp` for media (the setup offers the two media rules); 3000 and 7880 stay closed, they listen on 127.0.0.1 only. Media never goes through IIS.

## Check

```powershell
# {"ok":true,"proxyMode":"external", ... "domain":"chat.example.org"}
(Invoke-WebRequest https://chat.example.org/api/health -UseBasicParsing).Content
# 401 = the request reached LiveKit (expected without a token)
try { Invoke-WebRequest https://chat.example.org/rtc/validate -UseBasicParsing } catch { [int]$_.Exception.Response.StatusCode }
# Squorli's own check: the WebSocket upgrade, /rtc, the client's address
squorli doctor
```

Then sign in in the browser, join a voice channel and look at the debug view (`?debug`).

| What you see | Usual cause |
|---|---|
| 404.4 or 502.3 on every address | ARR's proxy is not switched on (step 3), or the services do not run (`squorli status`) |
| 500.50 with "HTTP_X_FORWARDED_PROTO" | the server variable is not allowed (last line of step 3) |
| Sign-in fails with `signature_invalid` | `preserveHostHeader` is off: Squorli sees `127.0.0.1` as the host |
| The page loads, but it never connects (`/api/ws`) | the feature WebSocket Protocol is missing, or ARR is older than version 3 |
| Joining a voice channel fails at once | `/rtc` does not reach LiveKit: check the second rule and the port |
| Joined, but no sound, dropped after 15 seconds | 7881/tcp and 7882/udp are not open, or LiveKit does not know its public address (`LIVEKIT_NODE_IP`) |
| Uploads above a few MB fail with 404.13 or 413 | `maxAllowedContentLength` in `web.config` |
| Every member shares one address in the rate limits | `X-Forwarded-For` does not arrive or carries a port: `includePortInXForwardedFor` |
