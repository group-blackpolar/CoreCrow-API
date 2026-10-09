-- Organization brand colors for the NORTH shell. Nullable and additive; the API validates #RRGGBB and the CHECK repeats it.
-- Rollback: ALTER TABLE "Organization" DROP COLUMN "brandPrimary", DROP COLUMN "brandAccent";
ALTER TABLE "Organization" ADD COLUMN "brandPrimary" TEXT, ADD COLUMN "brandAccent" TEXT;
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_brand_colors_check" CHECK (
  ("brandPrimary" IS NULL OR "brandPrimary" ~ '^#[0-9A-F]{6}$') AND ("brandAccent" IS NULL OR "brandAccent" ~ '^#[0-9A-F]{6}$')
);
