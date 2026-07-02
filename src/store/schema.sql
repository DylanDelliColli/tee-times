-- AvailabilityStore schema.
--
-- One row per (course_id, date, rank). rank 0 is the current (latest)
-- snapshot; rank 1 is the immediately-prior one. This gives an exact 2-deep
-- retention per (course_id, date) (gap G6): putSnapshot rotates rank 0 -> 1
-- (dropping any existing rank 1) and inserts the new snapshot at rank 0.
--
-- Slots are stored as a JSON array (TEXT) of normalized Slot objects
-- (see src/core/slot.ts). Slot identity (slotKey) is a Slot-level concern,
-- not a DB concern, so we don't explode slots into their own rows/columns —
-- the whole array round-trips as-is.
CREATE TABLE IF NOT EXISTS snapshots (
  course_id  TEXT    NOT NULL,
  date       TEXT    NOT NULL,
  rank       INTEGER NOT NULL CHECK (rank IN (0, 1)),
  slots_json TEXT    NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (course_id, date, rank)
);

CREATE INDEX IF NOT EXISTS idx_snapshots_course_date
  ON snapshots (course_id, date);
