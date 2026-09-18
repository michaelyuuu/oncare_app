# Staff camera control

`POST /visits/:id/camera` accepts `{ "paused": true }` to pause and `{ "paused": false }` to resume. Only staff can call it, while the visit is connecting or active. The API targets camera video tracks published by the iPad device paired with the visit's robot and resident. It does not mute microphones, disconnect participants, end calls, or send robot commands.

Success is `{ "ok": true, "cameraState": "paused" | "on" }`, after the provider confirms each camera track's requested mute state. It writes and broadcasts a visit audit note with fixed reason `staff_camera_paused` or `staff_camera_resumed`, null `fromState`/`toState`, and visit-id correlation.

Errors: 400 `bad_request`; 403 `forbidden`; 404 `not_found`; 409 `not_callable` or `camera_unavailable`; 503 `camera_control_failed`. A missing device, participant, or camera track is unavailable. A failed or refused provider operation never returns success. A multi-track failure can leave a partial change; refresh the queue to observe current state before retrying.

`GET /queue` adds `cameraState` to each active visit: `on` if any camera track is unmuted, `paused` if all camera tracks are muted, `unavailable` if there are no camera tracks (or the call is ending), and `unknown` if the provider query fails. The existing `streaming` field describes the connecting/active call lifecycle, including an audio call with a paused camera. The resident camera indicator follows LiveKit local track mute/unmute events.

## LiveKit deployment

Remote unmute is disabled by default. In LiveKit Cloud project settings enable **Admins can remotely unmute tracks** for staff resume to work. Self-hosted deployments use `room.enable_remote_unmute: true`. See [LiveKit participant management](https://docs.livekit.io/intro/basics/rooms-participants-tracks/participants/). This setting and real camera behavior must be verified in the deployment; automated tests use fakes and stubbed SDK boundaries, with no real LiveKit room or hardware action.

If resume fails, keep the camera's observed paused/unknown state and show a retry message directing staff to check the video service's remote-unmute setting. Pause applies to the current published tracks, not a durable privacy lock across new tracks or a new call. Staff can end the call if video must remain off. The fake video provider defaults to unavailable and needs an explicit camera fixture; token issuance alone does not imply a camera exists.
