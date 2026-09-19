import { AccessToken, RoomServiceClient, TrackSource, TrackType, ServerError } from "livekit-server-sdk";

/** Observed media state, not a promise that a camera is publishing. */
export type CameraState = "on" | "paused" | "unavailable";

export interface VideoGrant {
  room: string;
  identity: string;
  name: string;
  canPublish: boolean;
  canSubscribe: boolean;
  ttlSeconds: number;
}

export interface VideoProvider {
  url: string;
  issueToken(grant: VideoGrant): Promise<string>;
  closeRoom(room: string): Promise<void>;
  cameraState(room: string, identity: string): Promise<CameraState>;
  setCameraPaused(room: string, identity: string, paused: boolean): Promise<CameraState>;
}

export function grantsFor(role: "family" | "device" | "staff"): { canPublish: boolean; canSubscribe: boolean } {
  return role === "staff"
    ? { canPublish: false, canSubscribe: true }
    : { canPublish: true, canSubscribe: true };
}

export class LiveKitProvider implements VideoProvider {
  private readonly rooms: RoomServiceClient;

  constructor(public readonly url: string, private readonly apiKey: string, private readonly apiSecret: string) {
    const httpUrl = url.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
    this.rooms = new RoomServiceClient(httpUrl, apiKey, apiSecret);
  }

  async issueToken(grant: VideoGrant): Promise<string> {
    const token = new AccessToken(this.apiKey, this.apiSecret, {
      identity: grant.identity,
      name: grant.name,
      ttl: grant.ttlSeconds,
    });
    token.addGrant({
      roomJoin: true,
      room: grant.room,
      canPublish: grant.canPublish,
      canSubscribe: grant.canSubscribe,
      canPublishData: false,
    });
    return await token.toJwt();
  }

  async closeRoom(room: string): Promise<void> {
    try {
      await this.rooms.deleteRoom(room);
    } catch (error) {
      if (!/not found|404/i.test(String(error))) throw error;
    }
  }

  private async cameraTracks(room: string, identity: string) {
    try {
      const participant = await this.rooms.getParticipant(room, identity);
      return participant.tracks.filter(track => track.source === TrackSource.CAMERA && track.type === TrackType.VIDEO);
    } catch (error) {
      if (error instanceof ServerError && error.code === "not_found") return [];
      throw error;
    }
  }

  async cameraState(room: string, identity: string): Promise<CameraState> {
    const tracks = await this.cameraTracks(room, identity);
    return tracks.length === 0 ? "unavailable" : tracks.every(track => track.muted) ? "paused" : "on";
  }

  async setCameraPaused(room: string, identity: string, paused: boolean): Promise<CameraState> {
    const tracks = await this.cameraTracks(room, identity);
    if (!tracks.length) return "unavailable";
    for (const track of tracks) {
      // Remote unmute must be enabled in the LiveKit project. A refusal is an error.
      const result = await this.rooms.mutePublishedTrack(room, identity, track.sid, paused);
      if (result.sid !== track.sid || result.muted !== paused) throw new Error("camera_control_failed");
    }
    return paused ? "paused" : "on";
  }
}

export class FakeVideoProvider implements VideoProvider {
  readonly url = "wss://fake.livekit.local";
  readonly issued: VideoGrant[] = [];
  readonly closed: string[] = [];
  readonly cameras = new Map<string, "on" | "paused">();

  async cameraState(room: string, identity: string): Promise<CameraState> {
    return this.cameras.get(`${room}:${identity}`) ?? "unavailable";
  }

  async setCameraPaused(room: string, identity: string, paused: boolean): Promise<CameraState> {
    const key = `${room}:${identity}`;
    if (!this.cameras.has(key)) return "unavailable";
    const state = paused ? "paused" : "on";
    this.cameras.set(key, state);
    return state;
  }

  async issueToken(grant: VideoGrant): Promise<string> {
    this.issued.push(grant);
    return `fake.${grant.room}.${grant.identity}.${grant.canPublish ? "pub" : "sub"}`;
  }

  async closeRoom(room: string): Promise<void> {
    this.closed.push(room);
    for (const key of this.cameras.keys()) if (key.startsWith(`${room}:`)) this.cameras.delete(key);
  }
}

export function videoProviderFromEnv(env: NodeJS.ProcessEnv): VideoProvider {
  const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = env;
  return LIVEKIT_URL && LIVEKIT_API_KEY && LIVEKIT_API_SECRET
    ? new LiveKitProvider(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
    : new FakeVideoProvider();
}
