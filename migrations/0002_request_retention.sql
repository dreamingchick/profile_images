ALTER TABLE requests ADD COLUMN deletion_pending INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_requests_cleanup ON requests(deletion_pending, created_at);
CREATE VIEW active_requests AS
SELECT * FROM requests
WHERE deletion_pending=0 AND created_at > unixepoch() - 604800;
