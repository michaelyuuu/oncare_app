import type { GatewayDown, GatewayUp, Heartbeat } from "@oncare/contracts";

export interface RobotLink { send(msg: GatewayDown): void }
export interface RobotStatus { connected: boolean; lastHeartbeat: Heartbeat | null; lastSeenAt: string | null }
type UpListener = (robotId: string, msg: GatewayUp) => void;

export class GatewayHub {
  private links = new Map<string, RobotLink>();
  private heartbeats = new Map<string, { hb: Heartbeat; at: string }>();
  private listeners = new Set<UpListener>();

  attach(robotId: string, link: RobotLink): void { this.links.set(robotId, link); }

  // When `link` is given, only remove it if it's still the currently-attached
  // link (identity check). This guards against a superseded connection's
  // stale `close` handler detaching a newer, live connection for the same
  // robot id. The no-arg form is kept for callers that always want an
  // unconditional removal.
  detach(robotId: string, link?: RobotLink): void {
    if (link !== undefined && this.links.get(robotId) !== link) return;
    this.links.delete(robotId);
  }

  send(robotId: string, msg: GatewayDown): boolean {
    const link = this.links.get(robotId);
    if (!link) return false;
    link.send(msg);
    return true;
  }

  recordHeartbeat(robotId: string, hb: Heartbeat, at: string): void { this.heartbeats.set(robotId, { hb, at }); }

  status(robotId: string): RobotStatus {
    const h = this.heartbeats.get(robotId);
    return { connected: this.links.has(robotId), lastHeartbeat: h?.hb ?? null, lastSeenAt: h?.at ?? null };
  }

  onUp(listener: UpListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  receive(robotId: string, msg: GatewayUp): void {
    if (msg.type === "heartbeat") this.recordHeartbeat(robotId, msg, new Date().toISOString());
    for (const l of this.listeners) l(robotId, msg);
  }
}
