import { eq } from "drizzle-orm";
import { DEMO_CATALOGUE } from "@oncare/core";
import { hashSecret } from "../auth/password";
import type { Db } from "./client";
import * as t from "./schema";

export const SEED_IDS = {
  facility: "facility_demo", resident: "resident_demo_01", familyUser: "family_demo_01", staffUser: "staff_demo_01", adminUser: "admin_demo_01",
  robot: "robot_demo_01", device: "ipad_demo_01", roomLocation: "room_demo_01", pickupLocation: "pickup_station_demo", standbyLocation: "standby_demo",
} as const;

export const SEED_SECRETS = {
  familyPassword: "family-demo-pass", staffPassword: "staff-demo-pass", adminPassword: "admin-demo-pass", staffPin: "2468",
  deviceToken: "device-demo-token", robotToken: "robot-demo-token",
} as const;

export async function seed(db: Db): Promise<void> {
  if (db.select().from(t.facility).where(eq(t.facility.id, SEED_IDS.facility)).get()) return;
  db.insert(t.facility).values({ id: SEED_IDS.facility, name: "Demo Care House", timezone: "Asia/Taipei" }).run();
  db.insert(t.location).values([
    { id: SEED_IDS.roomLocation, facilityId: SEED_IDS.facility, name: "Demo room", kind: "resident_room", x: 0, y: 0, yaw: 0, approved: true },
    { id: SEED_IDS.pickupLocation, facilityId: SEED_IDS.facility, name: "Nurse station", kind: "pickup_station", x: 0, y: 0, yaw: 0, approved: true },
    { id: SEED_IDS.standbyLocation, facilityId: SEED_IDS.facility, name: "Standby", kind: "standby", x: 0, y: 0, yaw: 0, approved: true },
  ]).run();
  db.insert(t.resident).values({ id: SEED_IDS.resident, facilityId: SEED_IDS.facility, displayName: "Demo Resident", roomLocationId: SEED_IDS.roomLocation }).run();
  db.insert(t.user).values([
    { id: SEED_IDS.familyUser, role: "family", username: "family", displayName: "Demo Daughter", passwordHash: await hashSecret(SEED_SECRETS.familyPassword), pinHash: null, facilityId: null },
    { id: SEED_IDS.staffUser, role: "staff", username: "staff", displayName: "Demo Nurse", passwordHash: await hashSecret(SEED_SECRETS.staffPassword), pinHash: await hashSecret(SEED_SECRETS.staffPin), facilityId: SEED_IDS.facility },
    { id: SEED_IDS.adminUser, role: "admin", username: "admin", displayName: "Demo Manager", passwordHash: await hashSecret(SEED_SECRETS.adminPassword), pinHash: await hashSecret(SEED_SECRETS.staffPin), facilityId: SEED_IDS.facility },
  ]).run();
  db.insert(t.staffAssignment).values({ id: "sa_demo_01", userId: SEED_IDS.staffUser, residentId: SEED_IDS.resident, createdAt: new Date(0).toISOString() }).run();
  db.insert(t.familyRelationship).values({ id: "rel_demo_01", userId: SEED_IDS.familyUser, residentId: SEED_IDS.resident, label: "daughter", consentVideo: true, consentRobotVisit: true, consentItemDelivery: true }).run();
  db.insert(t.robot).values({ id: SEED_IDS.robot, facilityId: SEED_IDS.facility, name: "Demo Robot", tokenHash: await hashSecret(SEED_SECRETS.robotToken) }).run();
  db.insert(t.device).values({ id: SEED_IDS.device, facilityId: SEED_IDS.facility, robotId: SEED_IDS.robot, kind: "ipad", residentId: SEED_IDS.resident, deviceTokenHash: await hashSecret(SEED_SECRETS.deviceToken) }).run();
  db.insert(t.item).values([
    ...DEMO_CATALOGUE.approvedItems.map((id) => ({ id, label: id.replace(/_/g, " "), approved: true, prohibited: false })),
    ...DEMO_CATALOGUE.prohibitedItems.map((id) => ({ id, label: id.replace(/_/g, " "), approved: false, prohibited: true })),
  ]).run();
}
