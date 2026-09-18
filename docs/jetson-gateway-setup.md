# Jetson gateway setup: prepared, not deployed

This is an owner-operated runbook. The service source and read-only tests are
prepared locally; no Jetson deployment, doctor run, robot connection, hardware
test or real capture has been performed. All committed fixtures remain synthetic.

## Authorization and attendance gate

Do not execute the Jetson commands below until the owner explicitly authorizes
the session, identifies the robot/map, and confirms an operator is physically
present with access to STOP. Run `./ontaru doctor` first and after any replug;
stop on failures and review warnings. The global attendance/preflight requirement
applies even to read-only checks. It overrides earlier plan prose suggesting
that an unattended session would be sufficient.

Starting this gateway is **not read-only**: it connects to the API and may accept
approved movement intents and queue lift rest after arrival at standby. Starting
the nav stack, installing/enabling the service, manually navigating for captures,
and changing robot service state each require the appropriate explicit owner
authorization. Do not use this document as permission to perform them.

## API and trusted network preparation

On the dev PC, use the repository's Node 24/npm setup, copy
`apps/api/.env.example` to the ignored `apps/api/.env`, and configure a real
JWT secret outside a disposable demo. The API seeds its demo database on boot.

```sh
npm install
npm run dev -w @oncare/api
```

Expected source log messages include `api listening on :3000` and
`video provider: fake` or `video provider: livekit`; these are expectations,
not captured deployment evidence. The API binds 0.0.0.0. Limit access to the
approved private LAN/Tailscale network; do not expose demo credentials publicly.
Use authenticated TLS (`wss://`) for non-demo deployments; plain `ws://` exposes
the bearer robot token on the network. Do not paste token-bearing URLs into logs.

For the staff UI, use the existing Vite/API proxy configuration or set
`VITE_API_BASE` to the intended API origin when building the staff app. Confirm
browser/API origin permissions and private-network access before the attended
session. See the existing root README for demo staff credentials and PIN.

## Clean system Python environment on the Jetson

Clone the owner-approved `oncare_app` repository/revision to `~/oncare_app`;
only `robot_gateway/` is needed at runtime. This unit assumes the account home
is `/home/<user>`; adjust reviewed paths if the deployment differs. Do not clone
over an existing working tree or replace an existing venv without inspecting it.

Sibling `docs/OPERATING.md`, section 3, warns that bare `python3` can resolve to
conda while `PYTHONPATH` points at ROS. Use a clean, unsourced shell and the
system Python 3.12 explicitly, not the ROS shell, tidybot2 or teleop interpreter.
If `/usr/bin/python3.12` is absent or is not 3.12, stop and ask the owner to
prepare the correct interpreter; do not silently substitute conda.

```sh
cd ~/oncare_app/robot_gateway
env -u PYTHONPATH -u PYTHONHOME /usr/bin/python3.12 --version
env -u PYTHONPATH -u PYTHONHOME /usr/bin/python3.12 -m venv .venv
env -u PYTHONPATH -u PYTHONHOME .venv/bin/python -m pip install -e '.[dev]'
env -u PYTHONPATH -u PYTHONHOME .venv/bin/python -c 'import sys; print(sys.executable); print(sys.version)'
```

The dev extra is for verification; runtime-only installs can use `-e .` after
verification. Never source ROS into this venv or add sibling code to PYTHONPATH.
The systemd source also unsets Python/conda environment overrides and disables
user-site packages.

Copy `config.example.toml` to ignored `config.toml`, set file permissions to
owner read/write (`chmod 600 config.toml`), and edit without exposing credentials:

```toml
api_url = "ws://<dev-pc-lan-or-tailscale-ip>:3000"
robot_token = "robot-demo-token" # disposable seeded demo only; rotate for real use
adapter = "navweb"
heartbeat_ms = 1000
tick_ms = 250
navweb_base_url = "http://127.0.0.1:5804"
health_base_url = "http://127.0.0.1:5808"
goal_timeout_s = 120
```

Replace the IP placeholder before use. A rotated token must match the API's
stored robot token hash; changing only this file is not rotation. Never commit
a real token/config. Production robot HTTP origins are fixed to loopback ports
5804/5808; ephemeral constructor ports exist only for local tests.

## Attended preflight and read-only checks (not run yet)

The owner uses the actual installed sibling checkout, following its OPERATING
runbook. Never start a second nav stack. With the gateway still stopped:

```sh
cd ~/on_software
./ontaru doctor
# Only after a successful doctor and explicit bring-up approval:
./ontaru up nav ~/maps/OWNER_APPROVED_MAP.yaml
curl --fail --silent --show-error --max-time 2 http://127.0.0.1:5804/state | head -c 300
curl --fail --silent --show-error --max-time 2 http://127.0.0.1:5808/health.json | head -c 300
```

The truncated curl output is a quick inspection only, not a fixture capture.
Owner must confirm localization, a stationary robot, no soft e-stop, nav stack
up, and base_rpc tile `state=ok,value=up`. Do not release STOP merely to make a
test pass; if the area is unsafe or the state is unexpected, abort verification.

Default pytest excludes hardware. To inspect selection without any robot I/O:

```sh
cd ~/oncare_app/robot_gateway
.venv/bin/python -m pytest --collect-only -q
.venv/bin/python -m pytest --collect-only -m hardware tests/test_hardware_navweb.py -q
```

Only after the above authorization/preflight, on the Jetson itself:

```sh
env -u PYTHONPATH -u PYTHONHOME .venv/bin/python -m pytest -m hardware tests/test_hardware_navweb.py -q -s
```

These three tests only GET `/state`, `/health.json`, `/map.bin`. A test-side
transport guard rejects every other operation, including POST. They wait for
the async adapter's first ready snapshot, require stationary ready/finite pose,
validate map geometry, and require the current pose point to be a known free
cell. They issue no goal, cancel, resume or lift request, including cleanup.
Expected result is three passes with printed state/map; **no result is recorded
yet**. A failed readiness/map assertion means investigate the real source/schema,
not weaken it to `ready in (True, False)`. A free point is not proof of a safe
path or complete robot footprint.

## Real captures are a separate, gated follow-up

Do not remove `_synthetic` from hand-authored JSON or label `map_small.bin` real.
The small map is a deterministic unit-test fixture. Stage raw live observations
in a new, timestamped capture directory first, preserving current fixtures.
Capture complete GET bodies (no `head`) and record robot identity, repository
revisions, map identity, operator, doctor result and capture state separately.

Required future observations: idle `/state`, `/map.bin`, healthy `/health.json`,
`/state` during an owner-authorized manual nav_web goal, `/state` after the owner
presses nav_web STOP, and `/health.json` during a separately approved base-down
condition. The latter three involve changes to physical/service state and are
**not** part of the read-only tests. Do not create those conditions unattended or
stop another owner's base service just to obtain a fixture. Never automate a
movement or STOP-release sequence for capture from this runbook.

Review/redact raw capture metadata as appropriate, compare real formats against
the parser, and run all nonhardware tests before any deliberate fixture update.
Replace a synthetic fixture only when genuine capture evidence and the affected
test assumptions have both been reviewed; preserve raw evidence and provenance.
No captures or replacement commits exist from this local preparation task.

## Service installation and activation (not performed)

Review approved coordinates first: seeded demo locations are all at zero and
are not validated physical destinations. Use the staff location editor/API
under the attended location-recording workflow; Use robot position saves
immediately, manual fields require Save. Verify approval intentionally. Clear
or reconcile pending cloud tasks/commands before connecting a real gateway.

The tracked source is `robot_gateway/deploy/oncare-gateway.service`, but `%i`
requires installation as the template `oncare-gateway@.service`, not as the
non-template filename. `health-web.service` is only an ordering hint; verify
the actual installed health service name locally. The unit does not start or
replace the sibling robot stack.

After explicit install/start authorization, as the intended non-root account:

```sh
cd ~/oncare_app/robot_gateway
gateway_user=$(id -un)
test "$gateway_user" != root
sudo install -m 0644 deploy/oncare-gateway.service /etc/systemd/system/oncare-gateway@.service
sudo systemctl daemon-reload
sudo systemd-analyze verify /etc/systemd/system/oncare-gateway@.service
# Only after validation and explicit activation approval:
sudo systemctl enable --now "oncare-gateway@${gateway_user}.service"
systemctl status "oncare-gateway@${gateway_user}.service" --no-pager
journalctl -u "oncare-gateway@${gateway_user}.service" -f
```

These are future owner instructions, not evidence of an installation. Preserve
any existing unit/config before changing it; inspect conflicts instead of
overwriting an unknown deployment. The `test` line is an operator check: stop
if it fails, do not continue commands manually as root.

Expected gateway log vocabulary is `transport connected to ws://.../gateway`,
`link down: <exception type> (...)`, or `connection closed: ...`; the URL omits
its token query. A transport-connected log alone does not establish readiness.
In staff Robot, verify Connected, current finite pose, non-simulated adapter
and Ready only when source nav/base checks pass. Pose capture becomes disabled
after six seconds without a fresh heartbeat. Do not infer robot readiness from
the HTTP queue succeeding or the WebSocket merely staying open.

The navweb gateway emits `oncare_gateway` UDP heartbeats with the exact source
envelope. **Visible health-page tile acceptance is blocked:** current sibling
health_web renders only fixed names and has no generic/oncare_gateway tile.
Do not claim a tile exists, modify the sibling, or spoof another component name.
A separate authorized renderer change and real validation are required.

## Stop, rollback and evidence

With the owner present and robot state observed:

```sh
sudo systemctl stop "oncare-gateway@${gateway_user}.service"
sudo systemctl disable "oncare-gateway@${gateway_user}.service"
systemctl is-active "oncare-gateway@${gateway_user}.service"
journalctl -u "oncare-gateway@${gateway_user}.service" --since "10 minutes ago" --no-pager
```

Stopping this instance does not stop/reconfigure the sibling stack, delete maps,
or change other robot services. Restart=always does not override an explicit
systemctl stop. Retain the unit/config and logs for diagnosis; if replacing a
prior deployment, restore only its explicitly identified backup after approval.

Adapter safety-stop and no-progress timeout latch `/cancel` only; ordinary
cancel is cancel then resume. Shutdown invalidates unsent work and attempts a
latching cancel for active/possibly issued navigation. One in-flight HTTP call
may delay STOP by up to the configured total two-second request deadline;
cancel has its own deadline. Adapter join is bounded at 4.5 seconds at defaults,
and systemd allows 30 seconds for process shutdown/connection teardown.
Scheduling, an unreachable endpoint, a hard kill or power loss prevent a
physical-stop guarantee. An uncertain command/failing cancel remains locally
latched; observe the robot and use the owner's physical emergency procedure.
Never treat service-stop logs alone as proof of physical stationarity.

For a future executed session, preserve actual command exits, timestamps,
redacted journal excerpts, API/staff observations, three hardware test outputs
and capture provenance. Clearly separate expected behavior from observed
results. No dated rehearsal measurements are supplied here.
