import type { Transaction } from "../../shared/transaction.js";
import type { TenantRole } from "../../lib/database.js";

/**
 * ADR 027 / D3: a component may carry `visibility` (roles and/or groups, any match shows it). It is applied on the server
 * to every published document delivered to a viewer, so a hidden block never reaches the client and its rules are not
 * revealed (the key is stripped). It is a presentation control, not a data boundary: dataset access stays governed by dataset ACLs.
 * The Studio edits the draft, which is never filtered.
 */
export type DocumentViewer = { role: TenantRole; groupIds: ReadonlySet<string> } | null; // null = anonymous (public showcase)

type Visibility = { roles?: string[]; groupIds?: string[] } | undefined;
type Component = { id: string; type: string; props: Record<string, unknown>; visibility?: Visibility };
type Section = { components: Component[] };

const shown = (visibility: Visibility, viewer: DocumentViewer) => {
  if (!visibility) return true;
  if (!viewer) return false;
  return Boolean(visibility.roles?.includes(viewer.role) || visibility.groupIds?.some((id) => viewer.groupIds.has(id)));
};

export function filterDocumentForViewer<D extends { sections: Section[] }>(document: D, viewer: DocumentViewer): D {
  if (!document.sections.some((section) => section.components.some((component) => component.visibility))) return document;
  const sections = document.sections.map((section) => {
    const visible = section.components.filter((component) => shown(component.visibility, viewer));
    const ids = new Set(visible.map((component) => component.id));
    const components = visible.flatMap((component) => {
      const { visibility: _hidden, ...rest } = component;
      if (rest.type !== "panel_group") return [rest];
      // A group only keeps members that are still delivered; an empty group disappears.
      const items = ((rest.props.items as Array<{ componentId: string }> | undefined) ?? []).filter((item) => ids.has(item.componentId));
      return items.length ? [{ ...rest, props: { ...rest.props, items } }] : [];
    });
    return { ...section, components };
  });
  return { ...document, sections };
}

/** The viewer a member (or a read-only platform inspector, who sees what a Viewer sees) is for filtering purposes. */
export async function documentViewer(tx: Transaction, organizationId: string, userId: string): Promise<NonNullable<DocumentViewer>> {
  const membership = await tx.membership.findUnique({ where: { organizationId_userId: { organizationId, userId } }, select: { id: true, role: true } });
  const groups = membership ? await tx.organizationGroupMember.findMany({ where: { organizationId, membershipId: membership.id }, select: { groupId: true } }) : [];
  return { role: membership?.role ?? "VIEWER", groupIds: new Set(groups.map((item) => item.groupId)) };
}
