# Remote access: what exists, what can be embedded, and the choice that is left

Task 3.8. The plan's working assumption is that "complete remote view/control" means a Noctis panel
you drive the home desktop from, not a button that launches AnyDesk. This document is the discovery
that assumption asked for: the real hosts, the real network path, a measured baseline, and an honest
answer to the one question that decides 3.9 — can any maintained remote-desktop backend be _embedded_
in the client Noctis actually ships.

Everything below marked **measured** was read off this machine on 2026-09-22. Everything marked
**expected** is a claim to verify on the route during 3.9/3.10, not a result.

## 1. The hosts and the path

**Measured**, on `zarrarpc` (this home PC):

| Fact      | Value                                                                 |
| --------- | --------------------------------------------------------------------- |
| OS        | Windows 11 **Pro** 10.0.26200                                         |
| Machine   | ASUS, 31.1 GB RAM                                                     |
| GPU       | NVIDIA GeForce RTX 5070 (+ AMD Radeon iGPU)                           |
| Displays  | two — 2560×1440 @ 180 Hz and 1920×1080 @ 165 Hz                       |
| Wired NIC | Realtek PCIe 2.5GbE, link up at 2.5 Gbps, `192.168.1.163/24`, gw `.1` |
| Wi-Fi     | MediaTek MT7922, disconnected                                         |

Windows 11 **Pro** matters more than anything else in that table: the RDP _host_ is licensed and
present on this machine. It is currently off — `fDenyTSConnections = 1`, `TermService` stopped, and
all three "Remote Desktop" firewall rules disabled. Turning it on is an owner activation, not a
detail (see §5).

The tailnet, **measured** from `tailscale status` (Tailscale 1.102.2):

| Node              | Tailnet IP       | OS      | Role                       |
| ----------------- | ---------------- | ------- | -------------------------- |
| `mushafzarrar`    | `100.89.64.5`    | Windows | work PC — the Noctis core  |
| `zarrarpc`        | `100.70.27.11`   | Windows | home PC — node agent, this |
| `iphone183`       | `100.117.126.94` | iOS     | the phone front door       |
| `mushafs-macbook` | `100.94.61.54`   | macOS   | laptop                     |

No subnet routers and no exit nodes are advertised. Work → home is a **direct** connection
(`86.188.221.114:41641`), not a DERP relay, which is the difference between a usable remote desktop
and a slideshow.

**Measured** round-trip, work PC over the tailnet, eight samples: `6, 6, 6, 6, 6, 6, 7, 6` ms —
min 6, mean 6.1, max 7. A 6 ms path leaves the entire latency budget to the encoder and the decoder.
Nothing here is network-bound.

## 2. The AnyDesk baseline

**Measured:** AnyDesk 6.0.8 is installed at `C:\Program Files (x86)\AnyDesk\AnyDesk.exe` and its
service is `Running / Automatic`. Running as a service is why it works before anyone logs in and why
it survives a reboot — any replacement has to match that or it is a downgrade.

What it does that is easy to take for granted, and that §4 turns out to hinge on: AnyDesk attaches to
the **console session**. It shows the desktop that is already there, on the monitor that is already
on, with whatever the node agent is doing on it still visible. It does not evict the logged-in
session.

Not measured: AnyDesk's frame rate, its latency, or its behaviour at 2560×1440 over this tailnet.
Those are the numbers 3.9 has to beat, and the plan is explicit that the thresholds are agreed here
rather than invented: **record AnyDesk's own numbers on this exact path before building anything**,
because a candidate that loses to AnyDesk on the route is not a candidate.

## 3. What "embedded" has to mean here

Noctis ships two clients, and they are both a web page:

- the **desktop shell** — Tauri 2.11.5, which on Windows is WebView2, i.e. Chromium, rendering
  `apps/web`;
- the **PWA** — the same `apps/web` in Safari or Chrome over Tailscale Serve.

There is no third surface. So "embedded" means _something a web page can render_. That single fact
disqualifies more candidates than licensing, performance or cost do, and it is the reason the ORION
reference is not proof: ORION hands off to a native client and its own browser view is a snapshot
loop at 850 ms per frame. That is not interactive video, and the plan says so.

Tauri could in principle host a native child window, but nothing in this repo does it, Tauri 2 has no
supported API for it, and it would be desktop-only — the PWA would get nothing. Ruled out as an
unsupported transport rather than evaluated.

Two concrete integration costs follow from the client being a web page, both **measured** in this
repo:

1. `apps/desktop/src-tauri/tauri.conf.json` sets
   `default-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost`.
   A WASM client needs `script-src 'self' 'wasm-unsafe-eval'` and the target's socket in
   `connect-src`; an iframe route needs `frame-src`. Small diffs, but they widen the shell's CSP,
   which is a security decision, not a config tweak.
2. The core sets no CSP of its own (`grep` finds none in `apps/core`), so the PWA is unconstrained.
   The shell is the strict surface, not the browser.

## 4. The candidates

| Backend                                                                    | Licence                | Renders in a web page?                                                                   | Session it shows                 | Integration cost                                                                                                                          |
| -------------------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **IronRDP web** (`@devolutions/iron-remote-desktop` 0.11.0 + `-rdp` 0.7.0) | MIT OR Apache-2.0      | **Yes** — WASM web component, published 2026-05-27, shipped in Devolutions' own products | RDP session (**evicts console**) | enable the RDP host; run a WS→TCP forwarder (Devolutions Gateway, Apache-2.0/MIT, Windows installer, its own web app and auth); widen CSP |
| **Devolutions Gateway standalone web UI** in an iframe                     | Apache-2.0 / MIT       | Yes, as a cross-origin iframe                                                            | same as above                    | same listeners, but Noctis owns neither the session lifecycle nor the auth — a frame, not a panel                                         |
| **noVNC** (`@novnc/novnc` 1.7.0, updated 2026-09-07)                       | MPL-2.0                | **Yes** — canvas client, actively maintained                                             | console session ✔                | needs a Windows VNC server (no hardware encode, weak at 1440p) **and** websockify; slower than RDP                                        |
| **Sunshine + Moonlight**                                                   | GPL-3.0                | **No** — GameStream needs raw TCP/UDP; there is no official web client                   | console session ✔                | native client launch only; NVENC on the 5070 would be excellent, and none of it reaches the panel                                         |
| Community `moonlight-web-stream` WebRTC bridges                            | mixed, unofficial      | Yes, via a self-hosted bridge                                                            | console session ✔                | an unofficial fork re-wrapping the video — this is the custom transport 3.9 forbids                                                       |
| **AnyDesk** (incumbent)                                                    | proprietary, free tier | No                                                                                       | console session ✔                | zero — it already works, before login, as a service                                                                                       |

Two rows do the work.

**Nothing that embeds shows the console session.** IronRDP is the only maintained, permissively
licensed, genuinely embeddable option, and it speaks RDP — and on a Windows client SKU, connecting
over RDP takes the session over: the local console is logged out and the physical screen locks.
Microsoft's own answer forum states the constraint plainly ("Windows only allows one active session
at a time… if you log in using Remote Desktop, you will be logged out of the local session").

**Nothing that shows the console session embeds.** Sunshine, Moonlight and AnyDesk all share the
desktop that is already there, and all three are native clients a web page cannot host.

That is not a ranking problem. It is a fork, and 3.8 says to stop at one.

## 5. What the fork costs, in Noctis terms

Taking the RDP session over is not a cosmetic difference, because of what else runs on this machine.
The node agent drives GUI work on the console desktop — 3.1's Playwright profile, 3.2's Windows-MCP
click/type tools. A disconnected session has no desktop surface to inject input into. So:

- **If the embedded panel is chosen (RDP):** 3.10's "pause the agent, take over, resume" becomes a
  hard exclusive handover — while a human is in the panel, GUI automation on that host is _stopped_,
  not paused, and headless work (runtimes, file edits, Playwright in an isolated profile) continues.
  That is a cleaner authority story than sharing a mouse, and it is a real capability loss.
- **If console sharing is chosen (Sunshine/AnyDesk):** the panel stays a launcher, 3.9's working
  assumption is not met, and the honest wording is "Noctis shows you the host and hands you a
  client", with 3.10's handover being genuine cooperative pausing.

Also owed to the owner before either path starts, under the "no listeners on workers" constraint: the
RDP path opens **two** listeners on the home PC (RDP itself, plus the Gateway), each of which needs
tailnet-only exposure, documented auth, and a named activation approval. AnyDesk's listener already
exists and is already approved by use; the ones RDP needs are new.

## 6. Recommendation

Take the RDP path — `@devolutions/iron-remote-desktop-rdp` in `apps/web`, Devolutions Gateway on the
target host as the WS→TCP forwarder — **and accept the exclusive handover** as the 3.10 model.
Reasons, in order:

1. It is the only path that satisfies the stated requirement at all, and it satisfies it on _both_
   clients: the same component runs in the shell's WebView2 and in the phone's PWA. Every alternative
   is desktop-only by construction.
2. Both packages are permissively licensed and maintained by a vendor shipping them in production; no
   fork, no codec, no custom transport.
3. The 6 ms path means RDP's own encoder is the only variable, and RDP at 1440p over 6 ms is a
   known-good combination.
4. Exclusive handover is the more defensible authority model regardless: one owner of the input
   surface at a time is what 3.10 asks for, and RDP enforces it in the OS instead of in our code.

Keep AnyDesk installed and running throughout. It is the fallback, and it is also the only way to
recover the machine if the RDP path locks someone out of it.

## 7. The owner decision this stops for

> Embedding a remote desktop in the Noctis panel means RDP, and RDP logs the home PC's console
> session out for as long as you are connected — so agent GUI automation on that host stops while you
> are in the panel, and the physical screen is locked. The alternative is to keep sharing the console
> with Sunshine or AnyDesk, which cannot be embedded in a web page at all and leaves 3.9 as a
> launcher.
>
> **Embedded panel with exclusive handover, or console sharing with a launcher?**

Answering "embedded" also authorises, by name, before 3.9 starts:

- enabling the Windows RDP host on `zarrarpc` (`fDenyTSConnections = 0`, `TermService` automatic,
  firewall rules enabled **on the Tailscale interface only**, never on the LAN or public profile);
- installing Devolutions Gateway on `zarrarpc` as a second listener, bound to the tailnet;
- widening the desktop shell's CSP with `'wasm-unsafe-eval'` and the gateway origin.

## 8. What this document does not claim

- No latency, frame-rate or resolution result for **any** backend. The 6 ms is the network only.
- The AnyDesk baseline is not measured, and until it is, no candidate can be called equivalent.
- Devolutions Gateway's exact listener ports and auth configuration are read from its documentation,
  not from an install here.
- Locked-screen, logged-out and post-reboot behaviour on the RDP path is untested.
- Whether Windows-MCP input injection fails outright or merely misbehaves on a disconnected session
  is **expected**, not verified. 3.9 should verify it early, because §5 rests on it.

## References

- [IronRDP web client](https://github.com/Devolutions/IronRDP/tree/master/web-client),
  [Devolutions Gateway](https://github.com/Devolutions/devolutions-gateway)
- [noVNC](https://github.com/novnc/noVNC),
  [Sunshine](https://docs.lizardbyte.dev/projects/sunshine/latest/),
  [Moonlight FAQ](https://github.com/moonlight-stream/moonlight-docs/wiki/Frequently-Asked-Questions)
  (no official web client; GameStream needs raw sockets)
- [Windows single interactive session](https://learn.microsoft.com/en-us/answers/questions/4181174/use-remote-desktop-while-also-logged-in-windows-11)
