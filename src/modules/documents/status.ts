import type { Permission } from "../authorization/policy.js";

export const documentStatuses = ["DRAFT", "READY", "SENT", "COMPLETED", "CANCELLED"] as const;
export type DocumentStatusValue = (typeof documentStatuses)[number];

/**
 * Workflow. COMPLETED and CANCELLED are terminal, so an issued document can never
 * be silently revived. Content can only change while DRAFT or READY.
 */
const transitions: Record<DocumentStatusValue, readonly DocumentStatusValue[]> = {
  DRAFT: ["READY", "CANCELLED"],
  READY: ["DRAFT", "SENT", "COMPLETED", "CANCELLED"],
  SENT: ["COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};

export const canTransition = (from: DocumentStatusValue, to: DocumentStatusValue) => transitions[from].includes(to);
export const allowedTransitions = (from: DocumentStatusValue) => transitions[from];
export const isEditable = (status: DocumentStatusValue) => status === "DRAFT" || status === "READY";
/** A document must be finished before it can leave the organization. */
export const isSendable = (status: DocumentStatusValue) => status === "READY" || status === "SENT" || status === "COMPLETED";

/** Marking a document SENT is a delivery decision; every other transition is an edit. */
export const permissionForTransition = (to: DocumentStatusValue): Permission => (to === "SENT" ? "documents.send" : "documents.update");

export const formatReference = (prefix: string, sequence: number) => `${prefix}-${String(sequence).padStart(6, "0")}`;
