-- SHARK Home becomes an ordinary CONTENT panel so it can be opened in the Views studio and edited; it no longer answers
-- "System panel content is implementation-backed". Its document is provisioned afterwards with scripts/provision-home.mjs; until
-- it is published, NORTH keeps rendering the built-in organization Home for it.
-- Rollback: UPDATE "NorthPanel" SET "resourceKind" = 'SYSTEM' WHERE id = (the SHARK home panel below).
UPDATE "NorthPanel" p SET "resourceKind" = 'CONTENT'
FROM "NorthSubcategory" s
JOIN "NorthCategory" c ON c.id = s."categoryId"
JOIN "Organization" o ON o.id = c."organizationId"
WHERE p."subcategoryId" = s.id AND o.slug = 'shark' AND c.slug = 'home' AND c."resourceKind" = 'SYSTEM' AND p.slug = 'home' AND p."resourceKind" = 'SYSTEM';
