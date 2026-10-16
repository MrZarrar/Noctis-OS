# Owner decisions and discussion: 16 October 2026

Each item is marked **Decided**, **Built**, **Open** or **Deferred**.

## 1. Knowing when a glucose swing was the gym

**Open.** glycolens needs to tell a gym-driven high or low apart from a dosing one. Its only exercise signal today is
the pump's `exercise_mode` event, which only exists when the owner remembers to switch it on. Options raised earlier:
guess from time and day (usually 19:00 to 22:00), log it by hand, or use the pump's activity mode.

**Owner's idea:** let the phone's location log it. Arriving at the gym records a gym visit with the time.

### Proposal

- **Trigger:** an iOS Shortcuts personal automation, "Arrive" and "Leave" at the gym, set to run immediately. Each
  one POSTs `{ place: "gym", transition: "arrive" | "leave", at }` to the core over Tailscale. The geofence lives on
  the phone, so the core never sees coordinates, only "arrived at gym". The phone's own timestamp is used, so a late
  delivery still lands at the right time.
- **A visit is an arrive and leave pair** at least 20 minutes apart. Driving past does not count, and the pair gives
  the session length, not just a start.
- **Confirm on arrival:** a push, "Gym logged 19:12. Not the gym? Undo". The same push can remind the owner to turn on
  Exercise Activity on the pump. Noctis never touches the pump.
- **Drop the time-of-day guess.** It labels every 19:00 to 22:00 swing as gym, including rest days, which poisons the
  rules it is meant to clean up.
- **Sources rank:** location visit, then pump `exercise_mode`, then a manual log or undo from the phone. Any one of
  them marks the window.
- **glycolens use:** gym windows become events (`gym_visit` with start and end). Correction and meal windows that
  overlap a visit, or follow one within a set hold-off, are excluded from the ISF and carb ratio rules, the way
  `exercise_mode` already is for ISF. The existing behaviour rule, a low within 6 h after exercise, then fires on
  real gym visits too. Delayed lows after training can run overnight, so the hold-off length is a tuning knob, not
  a constant.
- **Hand-off:** Noctis never imports glycolens. The weekly `health.run` writes the visits for the window to a JSON
  file and passes it to the CLI, or drops it in the glycolens drop folder.

### Location triggers across Noctis

One generic `presence` event (place, transition, at) that other parts of Noctis can react to, with gym as the first
consumer. Ideas: arrive home wakes the home PC (Wake-on-LAN), leave work sends a summary of pending approvals, arrive
home queues heavy jobs for the home PC. This belongs with Phase 13 Sense / Automations. Every automation stays
default-off and deterministic: the location is a fact, code decides what happens.

### Risks

- iOS geofences are coarse (about 100 to 200 m) and can fire minutes late. Fine for a session that lasts an hour.
- If Tailscale is down on the phone when the trigger fires, the Shortcut fails and the visit is lost. The pump mode
  and the undo push cover gaps. If loss turns out common, OwnTracks (region enter and leave, buffers offline) is the
  fallback.
- The endpoint needs its own token that can only write presence events, not a full session token, since the
  Shortcut stores it in plain text.

### Questions for the owner

1. Is there an Apple Watch? Workouts from it would give start, end and intensity, better than location.
2. How often is Exercise Activity switched on now?
3. One gym, or several places to name?
4. Is the arrival push, with the pump reminder, wanted?
