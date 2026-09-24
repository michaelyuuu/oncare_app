export * from "./api";
export * from "./call";
export * from "./events";
export * from "./i18n";

export type IdentityOption = {
  residentId: string;
  displayName: string;
  relationship: "self" | "family" | "assignment" | "facility";
};

export type IdentityOptionsResponse = {
  principal: { kind: "device" } | { kind: "user"; role: "family" | "staff" | "admin" };
  identities: IdentityOption[];
};
