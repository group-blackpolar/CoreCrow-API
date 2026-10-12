-- The organization's built-in (SYSTEM) categories, subcategories and panels were created with the English label in both languages.
-- Give them their Spanish name; only rows still carrying the untouched English default are updated.
UPDATE "NorthCategory" SET "name" = '{"es":"Inicio","en":"Home"}'::jsonb WHERE "resourceKind" = 'SYSTEM' AND "slug" = 'home' AND "name"->>'es' = 'Home';
UPDATE "NorthCategory" SET "name" = '{"es":"Administración","en":"Administration"}'::jsonb WHERE "resourceKind" = 'SYSTEM' AND "slug" = 'admin' AND "name"->>'es' = 'Administration';
UPDATE "NorthSubcategory" SET "name" = '{"es":"Resumen","en":"Overview"}'::jsonb WHERE "resourceKind" = 'SYSTEM' AND "slug" = 'overview' AND "name"->>'es' = 'Overview';
UPDATE "NorthSubcategory" SET "name" = '{"es":"Configuración","en":"Settings"}'::jsonb WHERE "resourceKind" = 'SYSTEM' AND "slug" = 'settings' AND "name"->>'es' = 'Settings';
UPDATE "NorthPanel" SET "name" = '{"es":"Inicio","en":"Home"}'::jsonb WHERE "resourceKind" = 'SYSTEM' AND "slug" = 'home' AND "name"->>'es' = 'Home';
UPDATE "NorthPanel" SET "name" = '{"es":"Administración","en":"Administration"}'::jsonb WHERE "resourceKind" = 'SYSTEM' AND "slug" = 'administration' AND "name"->>'es' = 'Administration';
