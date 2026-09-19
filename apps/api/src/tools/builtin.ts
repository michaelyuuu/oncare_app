import { z } from "zod";
import { defineTool, ToolForbidden, ToolInputError, type ToolDef } from "./registry";

export const listMyResidentsOrContacts = defineTool({
  name: "list_my_residents_or_contacts",
  description: "On a resident's iPad: the family members this resident can contact. For family, staff and managers: the residents this user may see, with availability and room.",
  roles: ["device", "family", "staff", "admin"],
  effect: "read",
  input: z.object({}).strict(),
  run: (ctx) => ctx.principal.kind === "device"
    ? { contacts: ctx.directory.familyContacts(ctx.principal.residentId) }
    : { residents: ctx.directory.residentSummaries(ctx.access.residentIdsVisibleTo(ctx.principal)) },
});

export const getResidentStatus = defineTool({
  name: "get_resident_status",
  description: "Current availability and room of one resident. On a resident's iPad the resident is implied; everyone else must pass residentId.",
  roles: ["device", "family", "staff", "admin"],
  effect: "read",
  input: z.object({ residentId: z.string().min(1).optional() }).strict(),
  run: (ctx, input) => {
    const residentId = input.residentId ?? (ctx.principal.kind === "device" ? ctx.principal.residentId : undefined);
    if (!residentId) throw new ToolInputError("residentId: Required");
    if (!ctx.access.canAccessResident(ctx.principal, residentId)) throw new ToolForbidden();
    return { resident: ctx.directory.residentSummaries([residentId])[0] ?? null };
  },
});

export const BUILTIN_TOOLS: ToolDef[] = [listMyResidentsOrContacts, getResidentStatus];
