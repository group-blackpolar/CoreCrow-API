# NORTH panel documents, immutable revisions, and publication

- Status: Accepted
- Date: 2026-09-28
- Scope: CORECROW NORTH content authority

## Decision

Editable CONTENT panels use immutable, whole-panel revision snapshots. A document
contains no more than 50 sections and 100 total components, uses a validated
12-column desktop/tablet/mobile grid, and carries explicit default and fallback
locale metadata. A snapshot is independently reconstructible; sections and
components are not live shared resources in TASK 8.

The v1 registry contains exactly `heading`, `rich_text`, `image`, `video`,
`link`, `file`, `table`, `card`, `list`, `metric`, `divider`, and `embed`, each
at schema version 1. Registry entries reserve a migration hook. Unknown types,
unknown versions, invalid props, executable content, invalid grids, unapproved
embed domains, unresolved bindings, and unvalidated/cross-tenant assets fail
closed with stable 422 errors. Rich text is structured JSON with allowlisted
nodes and marks; arbitrary HTML, CSS, JavaScript, event handlers, SQL, and
credentials are not stored.

Panels point independently at a draft revision and an exact published revision.
Autosave creates a new immutable revision and moves only the draft pointer.
Publishing moves the published pointer to the exact current draft. Restoring an
older snapshot creates another revision and never rewrites history. Reserved
`publishAt` and `unpublishAt` timestamps do not imply a scheduler.

Draft reads, revision history, and revision detail require
`north.panel.preview`. Draft mutation and restore require `north.panel.update`;
publication requires `north.panel.publish`. Published resolution separately
requires panel/content read, active membership, and the panel audience. Private
or unauthorized route resolution returns 404 and never returns draft content.

Every update that depends on current draft state uses a strong ETag and
`If-Match`. A stale or omitted validator returns `409 REVISION_CONFLICT` with
the current revision number and ETag. PostgreSQL composite foreign keys prevent
a panel from pointing at another panel's revision. Revision creation, restore,
and publication are audited inside the same serializable transaction.

## Compatibility

The migration, routes, response fields, and error detail fields are additive.
Existing SYSTEM panels remain implementation-backed and may have null revision
pointers. CONTENT panels must be published through the revision endpoint before
content resolution succeeds; directly changing metadata status to `PUBLISHED`
does not create content. Clients editing an existing draft must now send its
strong ETag in `If-Match`.

TASK 8E object storage and asset rows are intentionally not introduced here.
Asset-bearing documents fail closed until the asset validator is wired. Dynamic
bindings likewise require an authorized resolver; neither stores source
credentials or client-provided SQL.
