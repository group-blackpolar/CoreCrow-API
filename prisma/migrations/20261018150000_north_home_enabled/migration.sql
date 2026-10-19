-- Enable the system Home in every organization: the client now renders an organization Home for it (it used to be an empty
-- implementation-backed panel, so some organizations hid it). SHARK also lands on its Home.
-- Rollback (values observed before this migration): UPDATE "NorthCategory" SET "navigationHidden" = true WHERE slug = 'home' AND "resourceKind" = 'SYSTEM' AND "organizationId" IN (SELECT id FROM "Organization" WHERE slug IN ('seminsa', 'shark'));
--   UPDATE "Organization" o SET "homePanelId" = (SELECT p.id FROM "NorthPanel" p WHERE p."organizationId" = o.id AND p.slug = 'overview' LIMIT 1) WHERE o.slug = 'shark';
UPDATE "NorthCategory" SET "navigationHidden" = false WHERE slug = 'home' AND "resourceKind" = 'SYSTEM' AND "navigationHidden";
UPDATE "Organization" o SET "homePanelId" = p.id
FROM "NorthPanel" p
JOIN "NorthSubcategory" s ON s.id = p."subcategoryId"
JOIN "NorthCategory" c ON c.id = s."categoryId"
WHERE o.slug = 'shark' AND p."organizationId" = o.id AND c.slug = 'home' AND c."resourceKind" = 'SYSTEM' AND p."resourceKind" = 'SYSTEM' AND p.slug = 'home';
