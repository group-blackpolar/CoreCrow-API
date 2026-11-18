SELECT o.slug AS org, c.slug AS cat, s.slug AS sub, count(p.id) AS panels,
  string_agg(p.slug || '(' || p.status::text || ')', ', ') AS panel_list
FROM "NorthSubcategory" s
JOIN "NorthCategory" c ON c.id = s."categoryId"
JOIN "Organization" o ON o.id = s."organizationId"
LEFT JOIN "NorthPanel" p ON p."subcategoryId" = s.id
GROUP BY o.slug, c.slug, s.slug
ORDER BY 1, 2, 3;
