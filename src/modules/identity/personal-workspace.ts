import { fail } from "../../shared/errors.js";

/**
 * Accounts created by an organization (login alias name@<slug>.bp, no real verified mailbox) have no Personal Workspace:
 * they must register and verify a real email address to get one. Server-side gate for personal-scope operations.
 */
export function requirePersonalWorkspace(user: { createdByOrganizationId: string | null }) {
  if (user.createdByOrganizationId)
    fail(403, "PERSONAL_WORKSPACE_UNAVAILABLE", "Accounts created by an organization have no Personal Workspace; register with a real email");
}
