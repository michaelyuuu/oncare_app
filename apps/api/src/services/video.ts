import { AccessToken, RoomServiceClient } from "livekit-server-sdk";

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
}

export class FakeVideoProvider implements VideoProvider {
  readonly url = "wss://fake.livekit.local";
  readonly issued: VideoGrant[] = [];
  readonly closed: string[] = [];

  async issueToken(grant: VideoGrant): Promise<string> {
    this.issued.push(grant);
    return `fake.${grant.room}.${grant.identity}.${grant.canPublish ? "pub" : "sub"}`;
  }

  async closeRoom(room: string): Promise<void> {
    this.closed.push(room);
  }
}

export function videoProviderFromEnv(env: NodeJS.ProcessEnv): VideoProvider {
  const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = env;
  return LIVEKIT_URL && LIVEKIT_API_KEY && LIVEKIT_API_SECRET
    ? new LiveKitProvider(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
    : new FakeVideoProvider();
}
