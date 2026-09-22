# Waking the home PC: what the hardware allows, and the two things that are missing

Task 5.3, pulled forward with 3.8 because remote access to a sleeping machine is remote access to
nothing. This is the topology inspection the task asked for, not a capability and not an
implementation. Everything marked **measured** was read off `zarrarpc` on 2026-09-22.

The conclusion first, so nobody reads six sections to find it: **the hardware is ready and the
software is not.** Waking is blocked on two named things — an always-on device on the home LAN to
send the packet, and a node agent that starts without a human logging in. Neither is a purchase
decision yet, and the second is free.

## 1. The four states, kept apart on purpose

The plan insists these are distinct, and the inspection below shows why: this machine can be in any
of the first three while being useless in the fourth.

| State                    | Means                                                          | Observable as                                     |
| ------------------------ | -------------------------------------------------------------- | ------------------------------------------------- |
| **wake requested**       | a magic packet was sent to `30-C5-99-59-9A-DA` on the home LAN | the sender's own log, nothing more                |
| **reachable**            | the tailnet address answers                                    | `tailscale ping 100.70.27.11`                     |
| **worker authenticated** | the node agent has dialled the core and holds its lease        | the core's node status — the only one Noctis owns |
| **desktop ready**        | a session is logged in and a desktop surface exists            | GUI tools work; RDP/AnyDesk shows a desktop       |

A wake that reaches "reachable" and stops there looks like success on the network and is worth
nothing to a turn. Any wake capability built later must time out against **worker authenticated**,
and report the earlier states as "still waking", not as done.

## 2. What the hardware allows

**Measured:**

| Fact                               | Value                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------- |
| NIC                                | Realtek PCIe 2.5GbE Family Controller, driver 1125.27.50.919 (2025-09-19) |
| MAC                                | `30-C5-99-59-9A-DA`                                                       |
| LAN                                | `192.168.1.163/24`, broadcast `192.168.1.255`, gateway `192.168.1.1`      |
| Link                               | wired, up at 2.5 Gbps; Wi-Fi disconnected                                 |
| `powercfg /a`                      | **S3 standby** and **Hibernate** available; **no S0 Modern Standby**      |
| `powercfg /devicequery wake_armed` | includes **Realtek PCIe 2.5GbE Family Controller**                        |
| Fast Startup                       | enabled (`HiberbootEnabled = 1`)                                          |

Two of those are better news than they look.

**No Modern Standby.** S0 Low Power Idle is the state that makes wake-on-LAN unreliable on modern
laptops — the NIC stays half-alive and the OS decides what counts as a wake. This board does classic
S3, which is the state magic packets were designed for.

**The NIC is already wake-armed.** Windows' side of wake-on-LAN is on right now, without anyone
configuring it. `Get-NetAdapterPowerManagement` throws "a device attached to the system is not
functioning" on this driver, so `WakeOnMagicPacket` could not be read directly — but the adapter's
presence in `wake_armed` is the same fact from the other side.

Not measured, and only the owner can: the UEFI setting (ASUS boards call it _Power On By PCI-E/PCI_,
under APM). Windows arming the NIC does not help if firmware cuts its power. Check it the next time
the machine is restarted; it is a read, not a change, until it turns out to be off.

## 3. The case that actually matters

**Measured:** last boot was 2026-09-16, and the System log shows repeated `Kernel-Power` 42/107
pairs through 20–21 September. This machine **sleeps; it does not get shut down.** Six days of
uptime with sleep cycles in between.

So the realistic wake case is S3 — the easy one, on a board that does S3 properly, with a NIC that is
already armed. Waking from a full power-off (S5) is the rare case here, and it is the one Fast
Startup complicates, because a "shutdown" with `HiberbootEnabled = 1` is a hibernation of the kernel
session and some NICs lose their wake arming through it. **Verify sleep and shutdown separately**, as
the task says, and expect them to differ — but do not let the S5 case block the S3 one, which is the
case that happens.

One observation worth recording rather than explaining away: several 42/107 pairs are two seconds
apart. Something is waking the machine immediately after it sleeps. That is not a wake-on-LAN
problem, but it will confuse any wake test that trusts "it is awake" as evidence the packet worked.

## 4. Blocker one — nothing on the LAN can send the packet

A magic packet is a layer-2 broadcast. It has to originate **on the home LAN**. Tailscale cannot do
it: a sleeping machine has no tailnet address to route to, and — **measured** — `tailscale --help` on
1.102.2 has no `wake`/`wol` subcommand at all. There is no subnet router and no exit node advertised
on this tailnet either, so nothing bridges into `192.168.1.0/24` from outside.

**Measured**, the ARP table of the home LAN: the router at `192.168.1.1` (`74-12-13-49-26-98`), one
device at `192.168.1.139` with a randomised MAC — a phone — and nothing else. No NAS, no Pi, no
always-on server.

This is the blocker the plan predicted, and the plan is explicit about what it is not: _"Missing
relay is a named blocker, not permission to purchase hardware."_ Candidates, cheapest first, none
chosen:

1. **The router itself.** Many ISP routers have a scheduled or on-demand WoL page, and some can be
   reached over the tailnet if a device forwards to it. Unknown here — the admin page at
   `192.168.1.1` redirects to HTTPS with a self-signed certificate and was not opened. Worth one
   look before anything is bought.
2. **An existing always-on device.** There is none today.
3. **A small always-on host** running an existing WoL tool such as UpSnap, joined to the tailnet.
   This is the Tailscale guide's own answer, and it is a hardware purchase — owner decision, out of
   scope for this document.

Until one of these exists, remote wake is unavailable. That must not be read as a reason to delay
3.9: **an already-awake PC needs no relay**, and this machine is awake nearly all the time.

## 5. Blocker two — waking it does not bring the worker back

**Measured:** there is no Noctis autostart on this machine of any kind. No service matching
`noctis`, no scheduled task matching `noctis`, and nothing in `Win32_StartupCommand`. Tailscale and
AnyDesk both run as automatic services and both come back by themselves; the node agent does not.

So even a perfect wake lands on **reachable**, never **worker authenticated**. A remote wake whose
whole purpose is to let a turn run on the home PC would deliver a machine that cannot run one.

The fix is already named in the plan's production-capabilities constraint as default-off and needing
a fresh approval by name: _Windows service/autostart registration_. This is the concrete reason to
grant it. It costs nothing and no hardware, and it is worth doing **before** any relay is bought,
because it is the half of the problem that is free — and because a wake capability built on top of a
worker that never starts would report success and deliver nothing.

Note the ordering trap: registering autostart also means the node agent starts _before_ anyone logs
in, so its first moments run with no desktop. That is correct for headless turns and wrong for GUI
tools, which is the **desktop ready** state in §1 and a separate thing to report honestly.

## 6. What would have to be approved, and when

Nothing in this document changes any setting. If wake is pursued, in this order:

1. **Free, no hardware:** node-agent autostart registration on `zarrarpc` (needs the named approval
   above). Fixes blocker two and is useful with or without wake.
2. **Free, a read:** open `192.168.1.1` and look for a WoL feature; check the UEFI _Power On By
   PCI-E_ setting on the next restart.
3. **Only if both of those fail:** an always-on LAN relay. A purchase, and its own decision.

Activation or hardware changes need separate approval, per the task. Steps 1 and 2 are the whole of
what can be done without one.

## 7. What this document does not claim

- No magic packet has been sent and no wake has been attempted.
- The UEFI wake setting is unread; `wake_armed` is the OS's view, not the firmware's.
- Wake from S5 (shutdown) is untested and is expected to behave differently from S3 because of Fast
  Startup.
- Post-wake login/unlock limits are untested — whether the desktop comes back locked, and what a GUI
  tool sees on a locked session, is unknown here and matters to
  [remote access](./remote-access.md) §5.
- The router's WoL support is unknown. Its admin page was not opened.

## References

- [Tailscale wake-on-LAN with UpSnap](https://tailscale.com/blog/wake-on-lan-tailscale-upsnap)
- [Windows system power states](https://learn.microsoft.com/en-us/windows/win32/power/system-power-states)
