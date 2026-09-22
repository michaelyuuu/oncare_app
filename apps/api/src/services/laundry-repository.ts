import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/client";
import * as t from "../db/schema";

const STALE_AFTER_MS = 300_000;
const RECENTLY_WASHED_AFTER_MS = 24 * 60 * 60 * 1_000;

export type LaundryWarning = { kind: string; message?: string; count?: number };
export type GarmentStatus = "active" | "lost" | "discarded";
export type StationSyncStatus = "healthy" | "stale" | "unavailable" | "invalid";

export interface StationLedgerSnapshot {
  stationId: string;
  facilityId: string;
  sourceVersion: number;
  sourceUpdatedAt: string;
  warnings: LaundryWarning[];
  garments: Array<{
    sourceKey: string;
    residentId: string;
    name: string;
    category: string;
    color: string;
    status: GarmentStatus;
    washCount: number;
    lastSeen: string | null;
  }>;
}

export interface LaundryOverview {
  availability: "available" | "never_synced";
  total: number;
  active: number;
  lostOrDiscarded: number;
  recentlyWashed: number;
  syncedAt: string | null;
  stale: boolean;
  warnings: LaundryWarning[];
}

export interface GarmentFilters {
  residentId?: string;
  name?: string;
  category?: string;
  color?: string;
  status?: GarmentStatus;
}

/** Public read model. Internal projection IDs and station source keys are intentionally absent. */
export interface GarmentResult {
  residentId: string;
  residentName: string;
  name: string;
  category: string;
  color: string;
  status: GarmentStatus;
  washCount: number;
  lastSeen: string | null;
  syncedAt: string;
  stale: boolean;
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

export function createLaundryRepository(db: Db, opts: { now?: () => Date } = {}) {
  const now = opts.now ?? (() => new Date());

  function isStale(syncedAt: string, currentTime: number): boolean {
    const elapsed = currentTime - Date.parse(syncedAt);
    return !Number.isFinite(elapsed) || elapsed >= STALE_AFTER_MS;
  }

  function registerStation(input: { stationId: string; facilityId: string }): void {
    db.transaction((tx) => {
      const existing = tx.select({ facilityId: t.rfidStationSync.facilityId })
        .from(t.rfidStationSync)
        .where(eq(t.rfidStationSync.stationId, input.stationId)).get();
      if (existing) {
        if (existing.facilityId !== input.facilityId) throw new Error("rfid_station_facility_conflict");
        return;
      }
      tx.insert(t.rfidStationSync).values({
        stationId: input.stationId,
        facilityId: input.facilityId,
        sourceVersion: null,
        lastAttemptAt: now().toISOString(),
        lastSuccessAt: null,
        status: "stale",
        warnings: [],
      }).run();
    });
  }

  function replaceStation(input: StationLedgerSnapshot): void {
    const syncedAt = now().toISOString();
    db.transaction((tx) => {
      tx.insert(t.rfidStationSync).values({
        stationId: input.stationId,
        facilityId: input.facilityId,
        sourceVersion: input.sourceVersion,
        lastAttemptAt: syncedAt,
        lastSuccessAt: syncedAt,
        status: "healthy",
        warnings: input.warnings,
      }).onConflictDoUpdate({
        target: t.rfidStationSync.stationId,
        set: {
          facilityId: input.facilityId,
          sourceVersion: input.sourceVersion,
          lastAttemptAt: syncedAt,
          lastSuccessAt: syncedAt,
          status: "healthy",
          warnings: input.warnings,
        },
      }).run();

      tx.delete(t.garmentProjection).where(eq(t.garmentProjection.stationId, input.stationId)).run();
      if (input.garments.length > 0) {
        tx.insert(t.garmentProjection).values(input.garments.map((garment) => ({
          id: `${input.stationId}:${garment.sourceKey}`,
          sourceKey: garment.sourceKey,
          stationId: input.stationId,
          facilityId: input.facilityId,
          residentId: garment.residentId,
          name: garment.name,
          category: garment.category,
          color: garment.color,
          status: garment.status,
          washCount: garment.washCount,
          lastSeen: garment.lastSeen,
          sourceUpdatedAt: input.sourceUpdatedAt,
          syncedAt,
        }))).run();
      }
    });
  }

  function recordFailure(
    stationId: string,
    status: Exclude<StationSyncStatus, "healthy">,
    warning: LaundryWarning,
  ): void {
    db.update(t.rfidStationSync).set({
      lastAttemptAt: now().toISOString(),
      status,
      warnings: [warning],
    }).where(eq(t.rfidStationSync.stationId, stationId)).run();
  }

  function overview(facilityId: string, residentId?: string): LaundryOverview {
    const syncRows = db.select().from(t.rfidStationSync)
      .where(eq(t.rfidStationSync.facilityId, facilityId))
      .orderBy(asc(t.rfidStationSync.stationId)).all();
    const successfulSyncs = syncRows
      .map((row) => row.lastSuccessAt)
      .filter((value): value is string => value !== null)
      .sort();
    if (successfulSyncs.length === 0) {
      return {
        availability: "never_synced",
        total: 0,
        active: 0,
        lostOrDiscarded: 0,
        recentlyWashed: 0,
        syncedAt: null,
        stale: false,
        warnings: syncRows.flatMap((row) => row.warnings),
      };
    }

    const clauses = [eq(t.garmentProjection.facilityId, facilityId)];
    if (residentId !== undefined) clauses.push(eq(t.garmentProjection.residentId, residentId));
    const garments = db.select({
      status: t.garmentProjection.status,
      lastSeen: t.garmentProjection.lastSeen,
    }).from(t.garmentProjection).where(and(...clauses)).all();
    const currentTime = now().getTime();
    const recentlyWashed = garments.filter((garment) => {
      if (garment.lastSeen === null) return false;
      const elapsed = currentTime - Date.parse(garment.lastSeen);
      return Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= RECENTLY_WASHED_AFTER_MS;
    }).length;
    const syncedAt = successfulSyncs[0]!;
    return {
      availability: "available",
      total: garments.length,
      active: garments.filter((garment) => garment.status === "active").length,
      lostOrDiscarded: garments.filter((garment) => garment.status === "lost" || garment.status === "discarded").length,
      recentlyWashed,
      syncedAt,
      stale: syncRows.some((row) => row.lastSuccessAt === null || isStale(row.lastSuccessAt, currentTime)),
      warnings: syncRows.flatMap((row) => row.warnings),
    };
  }

  function find(facilityId: string, filters: GarmentFilters): GarmentResult[] {
    const currentTime = now().getTime();
    const clauses: SQL[] = [eq(t.garmentProjection.facilityId, facilityId)];
    if (filters.residentId !== undefined) clauses.push(eq(t.garmentProjection.residentId, filters.residentId));
    if (filters.name !== undefined) {
      clauses.push(sql`lower(trim(${t.garmentProjection.name})) like ${`%${escapeLike(normalize(filters.name))}%`} escape '\\'`);
    }
    if (filters.category !== undefined) {
      clauses.push(sql`lower(trim(${t.garmentProjection.category})) = ${normalize(filters.category)}`);
    }
    if (filters.color !== undefined) {
      clauses.push(sql`lower(trim(${t.garmentProjection.color})) = ${normalize(filters.color)}`);
    }
    if (filters.status !== undefined) clauses.push(eq(t.garmentProjection.status, filters.status));

    return db.select({
      residentId: t.garmentProjection.residentId,
      residentName: t.resident.displayName,
      name: t.garmentProjection.name,
      category: t.garmentProjection.category,
      color: t.garmentProjection.color,
      status: t.garmentProjection.status,
      washCount: t.garmentProjection.washCount,
      lastSeen: t.garmentProjection.lastSeen,
      syncedAt: t.garmentProjection.syncedAt,
    }).from(t.garmentProjection)
      .innerJoin(t.resident, eq(t.resident.id, t.garmentProjection.residentId))
      .where(and(...clauses))
      .orderBy(
        asc(t.garmentProjection.residentId),
        sql`lower(trim(${t.garmentProjection.name}))`,
        asc(t.garmentProjection.id),
      )
      .limit(20).all()
      .map((row) => ({ ...row, stale: isStale(row.syncedAt, currentTime) }));
  }

  return { registerStation, replaceStation, recordFailure, overview, find };
}

export type LaundryRepository = ReturnType<typeof createLaundryRepository>;
