-- The exact command an approval's summary describes. The summary is now a
-- sentence a person reads first; this is what they open to check it.
ALTER TABLE approvals ADD COLUMN consequence_detail TEXT;
