# systemd units

The nightly collector's schedule. These live here rather than only in
`~/.config/systemd/user/` because until 2026-08-26 they existed on exactly one
machine, with no history and no way to recover a bad edit — while the data they
produce was being committed and pushed every night.

`~/.config/systemd/user/*.service|timer` are **symlinks into this directory**,
not copies. Editing a file here edits the live unit; there is no sync step and
no drift. systemd resolves symlinked unit files without complaint, and the
enablement symlink in `timers.target.wants/` resolves through them.

## Install on a new machine

    ln -sfn "$PWD/systemd/nq-collect.timer"          ~/.config/systemd/user/
    ln -sfn "$PWD/systemd/nq-collect.service"        ~/.config/systemd/user/
    ln -sfn "$PWD/systemd/nq-collect-failed@.service" ~/.config/systemd/user/
    systemctl --user daemon-reload
    systemctl --user enable --now nq-collect.timer
    loginctl enable-linger "$USER"   # or the timer only runs while logged in

## After editing a unit

    systemctl --user daemon-reload

## What runs

- `nq-collect.timer` — weekdays 18:30 America/New_York, after the 17:00 ET
  settlement. `Persistent=true`, so a run missed while the machine was asleep
  fires on resume; `collect.sh` waits for DNS because that catch-up otherwise
  beats the network, which is exactly how the 2026-08-25 run died.
- `nq-collect.service` — oneshot wrapper around `collect.sh`.
- `nq-collect-failed@.service` — `OnFailure=` target. Writes a marker file and
  fires a desktop notification, so a failed run is not silent. It was silent
  before this existed.
