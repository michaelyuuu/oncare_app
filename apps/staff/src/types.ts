export interface Visit {
    id: string;
    residentId: string;
    requesterId: string;
    state: string;
    streaming?: boolean;
    cameraState?: "on" | "paused" | "unavailable" | "unknown";
}
export interface Task {
    id: string;
    residentId: string;
    state: string;
    proposal?: {
        item?: string;
    } | null;
}
export interface AuditRow {
    id: string;
    at: string;
    actorType: string;
    actorId: string;
    entityType: string;
    entityId: string;
    fromState: string | null;
    toState: string | null;
    reason: string | null;
    correlationId: string;
}
export interface Robot {
    robotId: string;
    connected: boolean;
    lastSeenAt?: string | null;
    lastHeartbeat?: {
        robotReady?: boolean;
        adapter?: string;
        pose?: {
            x: number;
            y: number;
            yaw: number;
        } | null;
        navState?: string;
        estop?: boolean;
        battery?: number | "unknown";
        activeCorrelationId?: string | null;
    } | null;
}
export interface QueueData {
    visitsAwaitingApproval: Visit[];
    tasksAwaitingApproval: Task[];
    tasksAwaitingLoad: Task[];
    tasksAwaitingHandoff: Task[];
    activeVisits: Visit[];
    caregiverCalls: Array<AuditRow & { residentId?: string | null }>;
    robot: Robot | null;
}
export type Action = (path: string, body?: unknown) => Promise<void>;
