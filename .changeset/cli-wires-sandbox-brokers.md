---
'@adze/cli': minor
---

`adze run`, `adze chat`, and `adze doctor` now execute approved commands inside the OS-level boundary `@adze/sandbox` provides, instead of core's `NodeSubprocessBroker`, which is `gate-only` on every platform by construction.

On macOS with `sandbox-exec` on `PATH` and on Linux with usable bubblewrap, the CLI selects the Seatbelt or bubblewrap broker and reports `os-level` enforcement: writes outside the writable roots and network access are denied for the command and every descendant. Where no mechanism is usable — always on Windows, which has no mature open-source containment option — it reports `gate-only` with every degradation named, and the permission gate remains the only enforcement. The syscall surface is unrestricted everywhere, including under `os-level`, and that arrives as a degradation the surfaces print rather than filter.

This is user-visible: an approved command that used to run unconfined now runs confined, so a previously working command can become a refusal on macOS and Linux. Every containment claim `doctor`, `run`, and `chat` print is read from the plan the selected broker reports, so the startup banner cannot disagree with the boundary in force. `adze doctor --json` carries the same plan as data, including the full degradation list, for consumers gating on containment.
