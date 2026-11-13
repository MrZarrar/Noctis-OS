# Handoff: smart lights on the node agent

Read `AGENTS.md` first and follow it (TDD: write the failing test, see it fail, then the code). Do not commit or
push; leave the work in the tree for review. Do not touch `apps/core` or `apps/web` (someone else is editing them).

## Goal

The home PC's node agent drives the owner's lights: three Tuya (Smart Life) lights through Tuya's cloud and one
Tapo L530E bulb over the LAN (KLAP). It serves two new node capabilities and gives agents on the PC a lights tool.

The contract is done: `packages/contracts/src/lights.ts` (`lights.state`, `lights.set`, `LightsConfigSchema`,
`LightsSetPayloadSchema`, `LightsEvidenceSchema`, `LightChangeSchema`) and the registration in
`packages/contracts/src/node.ts`. `npx tsc -b` currently fails only because `apps/node-agent/src/adapters.ts` has no
`lights.state` / `lights.set` adapters. Do not change the contract without saying why in your report.

## What to build (in `apps/node-agent/src/lights/`)

1. `config.ts`: read `lights.json` from the node home (`NOCTIS_NODE_HOME`, else `~/.noctis`, same rule as
   `credential.ts`), parse with `LightsConfigSchema`. Missing file: the adapters refuse with `AdapterRefused("no
   lights.json on this PC")`.
2. `secrets.ts`: the logins are DPAPI-protected PowerShell `Export-Clixml` PSCredential files, default
   `%LOCALAPPDATA%\noctis-secrets\tuya.xml` (UserName = Tuya Access ID, password = Access Secret) and `tapo.xml`
   (UserName = Tapo email, password = Tapo password); `config.secrets` overrides the paths. Decrypt by spawning
   `powershell.exe -NoProfile -NonInteractive -Command` with `Import-Clixml` and printing JSON on stdout (pass the
   path as an argument or env var, never interpolate it into the script unescaped). Cache in memory for the
   process; never log or return the values. Tests swap in a fake reader.
3. `tuya.ts`: Tuya OpenAPI client with `fetch`. Verified today against the real account:
   - Token `GET /v1.0/token?grant_type=1`; cache until `expire_time` (s) minus a margin; on code 1010/1011
     refresh once.
   - Sign: HMAC-SHA256 hex UPPERCASE of `client_id + access_token(empty for the token call) + t +
     stringToSign`, where `stringToSign = METHOD\n + sha256hex(body or "") + "\n" + "\n" + pathWithQuery`. Headers
     `client_id`, `sign`, `t` (ms string), `sign_method: HMAC-SHA256`, `access_token`, JSON content type on POST.
   - Status `GET /v1.0/iot-03/devices/{id}/status`; commands `POST /v1.0/iot-03/devices/{id}/commands` with
     `{"commands":[{"code":"switch_led","value":true}]}`. Online flag from `GET /v1.0/iot-03/devices/{id}`.
   - Category `dj` codes: `switch_led`, `work_mode` (`white`/`colour`), `bright_value_v2` (10..1000),
     `temp_value_v2` (0..1000, warm to cool), `colour_data_v2` `{"h":0..360,"s":0..1000,"v":0..1000}`. Some bulbs
     use the v1 codes (`bright_value` 25..255, `temp_value` 0..255, `colour_data` with s/v 0..255); read
     `GET /v1.0/iot-03/devices/{id}/functions` once per device to pick codes and ranges. Map to the contract's
     percent / Kelvin (2500..6500 linear) / hue / saturation.
4. `tapo.ts`: KLAP client for the L530E (firmware 1.4.4, verified working today). Write it from this description;
   do NOT copy python-kasa (GPL).
   - `auth_hash = sha256(sha1(user) + sha1(password))`.
   - handshake1 `POST http://<host>/app/handshake1` body = 16 random bytes `local_seed`; reply = `remote_seed`(16)
     + `server_hash`(32); require `server_hash == sha256(local_seed + remote_seed + auth_hash)` else wrong
     credentials. Keep the `TP_SESSIONID` cookie.
   - handshake2 `POST /app/handshake2` with the cookie, body `sha256(remote_seed + local_seed + auth_hash)`.
   - `ls = local_seed + remote_seed + auth_hash`; `key = sha256("lsk"+ls)[0:16]`; `iv = sha256("iv"+ls)`,
     `ivPrefix = iv[0:12]`, `seq = iv[28:32]` signed big-endian; `sig = sha256("ldk"+ls)[0:28]`.
   - Request: `seq += 1`; AES-128-CBC PKCS7 with iv `ivPrefix + int32BE(seq)`; `signature = sha256(sig +
     int32BE(seq) + cipher)`; body `signature + cipher`; `POST /app/request?seq=<seq>` with the cookie. Reply:
     decrypt `body[32:]` with the same key and iv.
   - `{"method":"get_device_info"}` gives `device_on`, `brightness`, `hue`, `saturation`, `color_temp` (0 when in
     colour mode). `{"method":"set_device_info","params":{...}}` takes the same names. `error_code` 0 is ok.
   - Re-handshake once on HTTP 403 or a session error; sessions last about a day.
   - Test it against an in-test fake KLAP server (`node:http`) that implements the server side, so the crypto is
     checked both ways without a bulb.
5. `index.ts`: `createLightsAdapters(options)` returning `"lights.state"` and `"lights.set"` adapters (see the
   glycolens adapters in `apps/node-agent/src/health/glycolens.ts` for the pattern) and wire them in
   `adapters.ts`. Both answer `LightsEvidence` (every light after the change, plus scene names). A set resolves a
   `scene` from `config.scenes`; unknown light or scene names refuse. One light failing marks that light's
   `error` and the others still apply. Serialise jobs so two sets never interleave on the same bulb. A wrong
   login stops further tries for that brand until the process restarts (no account lockouts).
6. Agent tool `noctis_lights` for the runtimes on this PC: add it to the in-process MCP server in
   `apps/node-agent/src/runtimes/claude.ts` and to the stdio server `apps/node-agent/src/noctis-mcp.ts` (Codex).
   Input: `{ scene }`, `{ changes }` or `{}` (read only). It calls the same lights module directly (no core round
   trip) and returns the evidence as JSON text. Register it only when lights.json exists and `agents: true`;
   otherwise do not register it at all. Describe it in one or two sentences (what it does, that light names come
   from the state call). If a runtime's identity card lists tools, mention it there too
   (`apps/node-agent/src/runtimes/identity.ts`).

## Done when

- `npx vitest run apps/node-agent/src/lights` passes, and `npx tsc -b --pretty false` is clean.
- `npx eslint apps/node-agent/src/lights` and prettier are clean.
- Report: files changed, test results, anything unverified, and any contract change you needed.
