-- Preserve every existing override and its ID; absent order keeps the old ranking.
ALTER TABLE surface_overrides ADD COLUMN slot_order INTEGER CHECK (slot_order >= 0);
