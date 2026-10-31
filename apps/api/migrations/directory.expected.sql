-- table audit_log
CREATE TABLE audit_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor_id TEXT,
  act_chain TEXT CHECK (act_chain IS NULL OR json_valid(act_chain)),
  action TEXT NOT NULL,
  target_id TEXT,
  details TEXT CHECK (details IS NULL OR json_valid(details)),
  request_id TEXT
, archived_at INTEGER);

-- table audit_segments
CREATE TABLE audit_segments (
  segment_id INTEGER PRIMARY KEY,
  first_at INTEGER NOT NULL,
  from_seq INTEGER NOT NULL,
  to_seq INTEGER NOT NULL CHECK (to_seq >= from_seq),
  r2_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('pending', 'archived')),
  created_at INTEGER NOT NULL,
  archived_at INTEGER
) STRICT;

-- table deployment_settings
CREATE TABLE deployment_settings (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

-- table dpop_proofs
CREATE TABLE dpop_proofs (
  jkt TEXT NOT NULL,
  jti TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (jkt, jti)
) STRICT;

-- table email_admissions
CREATE TABLE email_admissions (
  nonce TEXT PRIMARY KEY,
  at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

-- table email_attempts
CREATE TABLE email_attempts (
  day INTEGER PRIMARY KEY,
  used INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

-- table email_confirmations
CREATE TABLE email_confirmations (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
  email_id TEXT NOT NULL,
  address_key TEXT NOT NULL,
  claim TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  reap_at INTEGER NOT NULL
) STRICT;

-- table email_counters
CREATE TABLE email_counters (
  scope TEXT NOT NULL CHECK (scope IN ('user_hour', 'mailbox_day')),
  key TEXT NOT NULL,
  period INTEGER NOT NULL,
  sent INTEGER NOT NULL,
  PRIMARY KEY (scope, key, period)
) STRICT, WITHOUT ROWID;

-- table email_deliveries
CREATE TABLE email_deliveries (
  principal_id TEXT NOT NULL,
  event_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('sending', 'sent', 'unknown', 'refused', 'retry', 'exhausted')),
  attempts INTEGER NOT NULL,
  address_id TEXT NOT NULL,
  provider_id TEXT,
  next_attempt_at INTEGER,
  at INTEGER NOT NULL,
  PRIMARY KEY (principal_id, event_key)
) STRICT, WITHOUT ROWID;

-- table email_mailboxes
CREATE TABLE email_mailboxes (
  address_key TEXT PRIMARY KEY,
  claim TEXT NOT NULL,
  idle_since INTEGER
) STRICT, WITHOUT ROWID;

-- table email_preferences
CREATE TABLE email_preferences (
  principal_id TEXT PRIMARY KEY REFERENCES principals (id),
  direct INTEGER NOT NULL CHECK (direct IN (0, 1)),
  participating INTEGER NOT NULL CHECK (participating IN (0, 1)),
  watching INTEGER NOT NULL CHECK (watching IN (0, 1)),
  updated_at INTEGER NOT NULL
) STRICT;

-- table email_spend
CREATE TABLE email_spend (
  scope TEXT NOT NULL CHECK (scope IN ('day', 'month')),
  period INTEGER NOT NULL,
  used INTEGER NOT NULL,
  PRIMARY KEY (scope, period)
) STRICT, WITHOUT ROWID;

-- table email_suppressions
CREATE TABLE email_suppressions (
  address_key TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  suppression_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('bounce', 'complaint', 'manual')),
  suppressed INTEGER NOT NULL CHECK (suppressed IN (0, 1)),
  rev INTEGER NOT NULL,
  next_check_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

-- table email_unsubscribes
CREATE TABLE email_unsubscribes (
  email_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('direct', 'participating', 'watching')),
  at INTEGER NOT NULL,
  PRIMARY KEY (email_id, scope)
) STRICT, WITHOUT ROWID;

-- table grants
CREATE TABLE grants (
  id TEXT PRIMARY KEY,
  -- The user acted for (the root grant's grantor, on every grant of its tree).
  grantor_id TEXT NOT NULL REFERENCES principals (id),
  agent_id TEXT NOT NULL REFERENCES principals (id),
  parent_id TEXT REFERENCES grants (id),
  root_id TEXT NOT NULL,
  depth INTEGER NOT NULL CHECK (depth IN (1, 2)),
  -- JSON array of permission names; never empty (a grant is always narrowed).
  scopes TEXT NOT NULL CHECK (json_valid(scopes) AND json_array_length(scopes) > 0),
  -- JSON array of repo ids; NULL means every repo the grantor can reach.
  repo_ids TEXT CHECK (repo_ids IS NULL OR json_valid(repo_ids)),
  expires_at INTEGER NOT NULL,
  created_by TEXT NOT NULL REFERENCES principals (id),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  CHECK ((depth = 1) = (parent_id IS NULL)),
  CHECK ((depth = 1) = (root_id = id))
) STRICT;

-- table handle_reservations
CREATE TABLE handle_reservations (
  handle TEXT PRIMARY KEY COLLATE NOCASE,
  principal_id TEXT NOT NULL,
  until INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

-- table idempotency_keys
CREATE TABLE idempotency_keys (
  token_id TEXT NOT NULL,
  key TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  op_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running', 'done')),
  status INTEGER,
  response TEXT,
  -- For an answer that carried a secret: the resource it made, not the secret.
  resource_id TEXT,
  started_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (token_id, key)
) STRICT;

-- table live_admissions
CREATE TABLE live_admissions (
  principal_id TEXT NOT NULL,
  day INTEGER NOT NULL,
  n INTEGER NOT NULL, issued INTEGER NOT NULL DEFAULT 0 CHECK (issued BETWEEN 0 AND 60),
  PRIMARY KEY (principal_id, day)
) STRICT, WITHOUT ROWID;

-- table live_budget_days
CREATE TABLE live_budget_days (
  day INTEGER PRIMARY KEY CHECK (day >= 0),
  do_requests INTEGER NOT NULL DEFAULT 0 CHECK (do_requests BETWEEN 0 AND 9007199254740991),
  do_rows_read INTEGER NOT NULL DEFAULT 0 CHECK (do_rows_read BETWEEN 0 AND 9007199254740991),
  do_rows_written INTEGER NOT NULL DEFAULT 0 CHECK (do_rows_written BETWEEN 0 AND 9007199254740991),
  do_duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (do_duration_ms BETWEEN 0 AND 9007199254740991),
  d1_rows_read INTEGER NOT NULL DEFAULT 0 CHECK (d1_rows_read BETWEEN 0 AND 9007199254740991),
  d1_rows_written INTEGER NOT NULL DEFAULT 0 CHECK (d1_rows_written BETWEEN 0 AND 9007199254740991),
  queue_ops INTEGER NOT NULL DEFAULT 0 CHECK (queue_ops = 0),
  protected_do_requests INTEGER NOT NULL DEFAULT 0 CHECK (protected_do_requests BETWEEN 0 AND do_requests),
  protected_do_rows_read INTEGER NOT NULL DEFAULT 0 CHECK (protected_do_rows_read BETWEEN 0 AND do_rows_read),
  protected_do_rows_written INTEGER NOT NULL DEFAULT 0 CHECK (protected_do_rows_written BETWEEN 0 AND do_rows_written),
  protected_do_duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (protected_do_duration_ms BETWEEN 0 AND do_duration_ms),
  protected_d1_rows_read INTEGER NOT NULL DEFAULT 0 CHECK (protected_d1_rows_read BETWEEN 0 AND d1_rows_read),
  protected_d1_rows_written INTEGER NOT NULL DEFAULT 0 CHECK (protected_d1_rows_written BETWEEN 0 AND d1_rows_written),
  protected_queue_ops INTEGER NOT NULL DEFAULT 0 CHECK (protected_queue_ops BETWEEN 0 AND queue_ops),
  escrow TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(escrow) AND json_type(escrow) = 'array' AND json_array_length(escrow) <= 64
  ),
  retain_until INTEGER NOT NULL CHECK (
    retain_until >= 0 AND retain_until <= (day + 5) * 86400000
  ),
  cleanup_debt TEXT NOT NULL CHECK (coalesce(
      json_valid(cleanup_debt)
      AND json(cleanup_debt) = json_object('do_requests', json_extract(cleanup_debt, '$.do_requests'), 'do_rows_read', json_extract(cleanup_debt, '$.do_rows_read'), 'do_rows_written', json_extract(cleanup_debt, '$.do_rows_written'), 'do_duration_ms', json_extract(cleanup_debt, '$.do_duration_ms'), 'd1_rows_read', json_extract(cleanup_debt, '$.d1_rows_read'), 'd1_rows_written', json_extract(cleanup_debt, '$.d1_rows_written'), 'queue_ops', json_extract(cleanup_debt, '$.queue_ops'))
      AND json_type(cleanup_debt, '$.do_requests') = 'integer'
      AND json_extract(cleanup_debt, '$.do_requests') BETWEEN 0 AND 9007199254740991
      AND json_type(cleanup_debt, '$.do_rows_read') = 'integer'
      AND json_extract(cleanup_debt, '$.do_rows_read') BETWEEN 0 AND 9007199254740991
      AND json_type(cleanup_debt, '$.do_rows_written') = 'integer'
      AND json_extract(cleanup_debt, '$.do_rows_written') BETWEEN 0 AND 9007199254740991
      AND json_type(cleanup_debt, '$.do_duration_ms') = 'integer'
      AND json_extract(cleanup_debt, '$.do_duration_ms') BETWEEN 0 AND 9007199254740991
      AND json_type(cleanup_debt, '$.d1_rows_read') = 'integer'
      AND json_extract(cleanup_debt, '$.d1_rows_read') BETWEEN 0 AND 9007199254740991
      AND json_type(cleanup_debt, '$.d1_rows_written') = 'integer'
      AND json_extract(cleanup_debt, '$.d1_rows_written') BETWEEN 0 AND 9007199254740991
      AND json_type(cleanup_debt, '$.queue_ops') = 'integer'
      AND json_extract(cleanup_debt, '$.queue_ops') BETWEEN 0 AND 9007199254740991
      AND json_extract(cleanup_debt, '$.queue_ops') = 0,
      0
    ))
, reserve_used_ms INTEGER NOT NULL DEFAULT 0
  CHECK (reserve_used_ms BETWEEN 0 AND 9007199254740991), debt_withheld_ms INTEGER NOT NULL DEFAULT 0
  CHECK (debt_withheld_ms BETWEEN 0 AND 9007199254740991), duration_breach INTEGER NOT NULL DEFAULT 0
  CHECK (duration_breach IN (0, 1))) STRICT;

-- table live_budget_receipts
CREATE TABLE live_budget_receipts (
  seq INTEGER PRIMARY KEY CHECK (seq BETWEEN 1 AND 9007199254740991),
  operation_id TEXT NOT NULL UNIQUE,
  mint TEXT NOT NULL,
  incarnation TEXT NOT NULL CHECK (length(incarnation) = 32),
  recipient_type TEXT NOT NULL CHECK (recipient_type IN ('UserDO', 'OrgDO', 'MaintenanceDO')),
  recipient TEXT NOT NULL CHECK (length(recipient) > 0),
  kind TEXT NOT NULL,
  class TEXT NOT NULL CHECK (class IN ('ordinary', 'cleanup')),
  epoch INTEGER NOT NULL CHECK (epoch >= 0),
  produces_local INTEGER NOT NULL CHECK (produces_local IN (0, 1)),
  valid_from INTEGER NOT NULL CHECK (valid_from >= 0),
  valid_until INTEGER NOT NULL CHECK (
    valid_until > valid_from AND valid_until - valid_from <= 86400000
  ),
  granted_at INTEGER NOT NULL CHECK (granted_at >= 0),
  plan TEXT NOT NULL CHECK (json_valid(plan) AND json_type(plan) = 'object'),
  directory_cleanup_debt TEXT NOT NULL CHECK (coalesce(
      json_valid(directory_cleanup_debt)
      AND json(directory_cleanup_debt) = json_object('do_requests', json_extract(directory_cleanup_debt, '$.do_requests'), 'do_rows_read', json_extract(directory_cleanup_debt, '$.do_rows_read'), 'do_rows_written', json_extract(directory_cleanup_debt, '$.do_rows_written'), 'do_duration_ms', json_extract(directory_cleanup_debt, '$.do_duration_ms'), 'd1_rows_read', json_extract(directory_cleanup_debt, '$.d1_rows_read'), 'd1_rows_written', json_extract(directory_cleanup_debt, '$.d1_rows_written'), 'queue_ops', json_extract(directory_cleanup_debt, '$.queue_ops'))
      AND json_type(directory_cleanup_debt, '$.do_requests') = 'integer'
      AND json_extract(directory_cleanup_debt, '$.do_requests') BETWEEN 0 AND 9007199254740991
      AND json_type(directory_cleanup_debt, '$.do_rows_read') = 'integer'
      AND json_extract(directory_cleanup_debt, '$.do_rows_read') BETWEEN 0 AND 9007199254740991
      AND json_type(directory_cleanup_debt, '$.do_rows_written') = 'integer'
      AND json_extract(directory_cleanup_debt, '$.do_rows_written') BETWEEN 0 AND 9007199254740991
      AND json_type(directory_cleanup_debt, '$.do_duration_ms') = 'integer'
      AND json_extract(directory_cleanup_debt, '$.do_duration_ms') BETWEEN 0 AND 9007199254740991
      AND json_type(directory_cleanup_debt, '$.d1_rows_read') = 'integer'
      AND json_extract(directory_cleanup_debt, '$.d1_rows_read') BETWEEN 0 AND 9007199254740991
      AND json_type(directory_cleanup_debt, '$.d1_rows_written') = 'integer'
      AND json_extract(directory_cleanup_debt, '$.d1_rows_written') BETWEEN 0 AND 9007199254740991
      AND json_type(directory_cleanup_debt, '$.queue_ops') = 'integer'
      AND json_extract(directory_cleanup_debt, '$.queue_ops') BETWEEN 0 AND 9007199254740991
      AND json_extract(directory_cleanup_debt, '$.queue_ops') = 0,
      0
    )),
  settle_until INTEGER NOT NULL CHECK (settle_until >= valid_until),
  expires_at INTEGER NOT NULL CHECK (
    expires_at >= valid_until + 172800000 AND expires_at >= settle_until
  ),
  settled_at INTEGER,
  completion TEXT CHECK (
    completion IS NULL OR (json_valid(completion) AND json_type(completion) = 'object')
  ),
  settlement_mint TEXT, released_owners TEXT NOT NULL DEFAULT '[]' CHECK (
  json_valid(released_owners) AND json_type(released_owners) = 'array'
    AND json_array_length(released_owners) <= 1
),
  CHECK (
    (settled_at IS NULL AND completion IS NULL AND settlement_mint IS NULL)
    OR (settled_at IS NOT NULL AND completion IS NOT NULL AND settlement_mint IS NOT NULL)
  ),
  CHECK (produces_local = 0 OR (class = 'ordinary' AND recipient_type = 'UserDO'))
) STRICT;

-- table live_budget_state
CREATE TABLE live_budget_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  incarnation TEXT NOT NULL CHECK (length(incarnation) = 32),
  grant_seq INTEGER NOT NULL DEFAULT 0 CHECK (grant_seq BETWEEN 0 AND 9007199254740991),
  last_mint TEXT,
  last_mint_at INTEGER NOT NULL DEFAULT 0 CHECK (last_mint_at >= 0),
  debt_do_requests INTEGER NOT NULL DEFAULT 0 CHECK (debt_do_requests BETWEEN 0 AND 9007199254740991),
  debt_do_rows_read INTEGER NOT NULL DEFAULT 0 CHECK (debt_do_rows_read BETWEEN 0 AND 9007199254740991),
  debt_do_rows_written INTEGER NOT NULL DEFAULT 0 CHECK (debt_do_rows_written BETWEEN 0 AND 9007199254740991),
  debt_do_duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (debt_do_duration_ms BETWEEN 0 AND 9007199254740991),
  debt_d1_rows_read INTEGER NOT NULL DEFAULT 0 CHECK (debt_d1_rows_read BETWEEN 0 AND 9007199254740991),
  debt_d1_rows_written INTEGER NOT NULL DEFAULT 0 CHECK (debt_d1_rows_written BETWEEN 0 AND 9007199254740991),
  debt_queue_ops INTEGER NOT NULL DEFAULT 0 CHECK (debt_queue_ops = 0)
, duration_debt_ms INTEGER NOT NULL DEFAULT 0
  CHECK (duration_debt_ms BETWEEN 0 AND 9007199254740991), debt_service_day INTEGER NOT NULL DEFAULT 0
  CHECK (debt_service_day >= 0), owner_mint TEXT, duration_reserve_ms INTEGER NOT NULL DEFAULT 0
  CHECK (duration_reserve_ms BETWEEN 0 AND 9007199254740991), ordinary_duration_blocked INTEGER NOT NULL DEFAULT 0
  CHECK (ordinary_duration_blocked IN (0, 1))) STRICT;

-- table live_duration_owners
CREATE TABLE live_duration_owners (
  owner_id TEXT PRIMARY KEY CHECK (length(owner_id) BETWEEN 1 AND 400),
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 300),
  object_type TEXT NOT NULL CHECK (object_type IN ('UserDO', 'OrgDO', 'MaintenanceDO')),
  object_id TEXT NOT NULL CHECK (length(object_id) > 0),
  parent_id TEXT,
  class TEXT NOT NULL CHECK (class IN ('ordinary', 'cleanup')),
  epoch INTEGER NOT NULL CHECK (epoch >= 0),
  incarnation TEXT NOT NULL CHECK (length(incarnation) = 32),
  dispatch_from INTEGER NOT NULL CHECK (dispatch_from >= 0),
  dispatch_until INTEGER NOT NULL CHECK (dispatch_until > dispatch_from),
  holds TEXT NOT NULL CHECK (
    json_valid(holds) AND json_type(holds) = 'array' AND json_array_length(holds) <= 2
  ),
  status TEXT NOT NULL CHECK (
    status IN ('reserved', 'dispatched', 'uncertain', 'observing', 'accounted')
  ),
  instance TEXT,
  started_at INTEGER CHECK (started_at IS NULL OR started_at >= 0),
  finished_at INTEGER,
  charged_through INTEGER,
  cursor INTEGER CHECK (cursor IS NULL OR cursor >= 0),
  accounting_mint TEXT,
  admitted_at INTEGER NOT NULL CHECK (admitted_at >= 0),
  CHECK ((status = 'reserved') = (instance IS NULL AND started_at IS NULL)),
  CHECK (
    (finished_at IS NULL AND charged_through IS NULL AND cursor IS NULL)
    OR (finished_at >= started_at AND charged_through >= finished_at AND cursor IS NOT NULL)
  ),
  CHECK ((status IN ('observing', 'accounted')) = (finished_at IS NOT NULL))
) STRICT, WITHOUT ROWID;

-- table live_recovery_targets
CREATE TABLE live_recovery_targets (
  feed TEXT PRIMARY KEY CHECK (length(feed) > 0),
  incarnation TEXT NOT NULL CHECK (length(incarnation) = 32),
  through_seq INTEGER NOT NULL CHECK (through_seq BETWEEN 1 AND 9007199254740991),
  next_attempt_at INTEGER NOT NULL CHECK (next_attempt_at >= 0),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 7),
  local_cleanup_debt TEXT NOT NULL CHECK (coalesce(
      json_valid(local_cleanup_debt)
      AND json(local_cleanup_debt) = json_object('do_requests', json_extract(local_cleanup_debt, '$.do_requests'), 'do_rows_read', json_extract(local_cleanup_debt, '$.do_rows_read'), 'do_rows_written', json_extract(local_cleanup_debt, '$.do_rows_written'), 'do_duration_ms', json_extract(local_cleanup_debt, '$.do_duration_ms'), 'd1_rows_read', json_extract(local_cleanup_debt, '$.d1_rows_read'), 'd1_rows_written', json_extract(local_cleanup_debt, '$.d1_rows_written'), 'queue_ops', json_extract(local_cleanup_debt, '$.queue_ops'))
      AND json_type(local_cleanup_debt, '$.do_requests') = 'integer'
      AND json_extract(local_cleanup_debt, '$.do_requests') BETWEEN 0 AND 9007199254740991
      AND json_type(local_cleanup_debt, '$.do_rows_read') = 'integer'
      AND json_extract(local_cleanup_debt, '$.do_rows_read') BETWEEN 0 AND 9007199254740991
      AND json_type(local_cleanup_debt, '$.do_rows_written') = 'integer'
      AND json_extract(local_cleanup_debt, '$.do_rows_written') BETWEEN 0 AND 9007199254740991
      AND json_type(local_cleanup_debt, '$.do_duration_ms') = 'integer'
      AND json_extract(local_cleanup_debt, '$.do_duration_ms') BETWEEN 0 AND 9007199254740991
      AND json_type(local_cleanup_debt, '$.d1_rows_read') = 'integer'
      AND json_extract(local_cleanup_debt, '$.d1_rows_read') BETWEEN 0 AND 9007199254740991
      AND json_type(local_cleanup_debt, '$.d1_rows_written') = 'integer'
      AND json_extract(local_cleanup_debt, '$.d1_rows_written') BETWEEN 0 AND 9007199254740991
      AND json_type(local_cleanup_debt, '$.queue_ops') = 'integer'
      AND json_extract(local_cleanup_debt, '$.queue_ops') BETWEEN 0 AND 9007199254740991
      AND json_extract(local_cleanup_debt, '$.queue_ops') = 0,
      0
    ))
) STRICT, WITHOUT ROWID;

-- table live_socket_deps
CREATE TABLE live_socket_deps (
  dependency TEXT NOT NULL,
  socket_id TEXT NOT NULL,
  PRIMARY KEY (dependency, socket_id)
) STRICT, WITHOUT ROWID;

-- table live_sockets
CREATE TABLE live_sockets (
  socket_id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL UNIQUE,
  feed TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'open')),
  pending_until INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;

-- table memberships
CREATE TABLE memberships (
  org_id TEXT NOT NULL REFERENCES principals (id),
  principal_id TEXT NOT NULL REFERENCES principals (id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, principal_id)
) STRICT;

-- table oauth_clients
CREATE TABLE oauth_clients (
  client_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('registered', 'metadata_document')),
  client_name TEXT,
  -- JSON array of the exact redirect URIs it may use.
  redirect_uris TEXT NOT NULL CHECK (json_valid(redirect_uris)),
  created_at INTEGER NOT NULL,
  -- When a user last authorized it (at most hourly): a registration never or long unused is pruned.
  last_used_at INTEGER,
  -- A metadata document's, when it was last fetched (it is fetched again past its cache time).
  fetched_at INTEGER
) STRICT;

-- table oauth_requests
CREATE TABLE oauth_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES principals (id),
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  -- JSON array of permission names.
  scopes TEXT NOT NULL CHECK (json_valid(scopes)),
  resource TEXT NOT NULL,
  state TEXT,
  dpop_jkt TEXT,
  expires_at INTEGER NOT NULL,
  -- Set once the user consents; the code is good once, until code_expires_at.
  code_hash TEXT UNIQUE CHECK (code_hash IS NULL OR length(code_hash) = 64),
  code_expires_at INTEGER,
  -- The redemption that claimed the code (one wins), and the refresh family it began.
  used_at INTEGER,
  used_by TEXT,
  family_id TEXT
) STRICT;

-- table passkeys
CREATE TABLE passkeys (
  -- The credential id, base64url.
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES principals (id),
  public_key TEXT NOT NULL CHECK (json_valid(public_key)),
  alg INTEGER NOT NULL CHECK (alg IN (-7, -8, -257)),
  sign_count INTEGER NOT NULL DEFAULT 0,
  name TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
) STRICT;

-- table principal_lifecycle
CREATE TABLE principal_lifecycle (
  principal_id TEXT NOT NULL REFERENCES principals (id),
  gen INTEGER NOT NULL,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  at INTEGER NOT NULL,
  actor_id TEXT,
  request_id TEXT,
  PRIMARY KEY (principal_id, gen)
) STRICT, WITHOUT ROWID;

-- table principals
CREATE TABLE principals (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('user', 'org', 'agent', 'installation')),
  handle TEXT,
  display_name TEXT,
  -- Agents and installations belong to a user or an org.
  owner_id TEXT REFERENCES principals (id),
  is_instance_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_instance_admin IN (0, 1)),
  created_at INTEGER NOT NULL,
  disabled_at INTEGER, require_dpop INTEGER NOT NULL DEFAULT 0
  CHECK (require_dpop IN (0, 1)), lifecycle TEXT NOT NULL DEFAULT 'active'
  CHECK (lifecycle IN ('active', 'suspended', 'deleting', 'deleted')), lifecycle_gen INTEGER NOT NULL DEFAULT 0, lifecycle_claim TEXT, suspended_at INTEGER, suspended_by TEXT, suspended_reason TEXT
  CHECK (suspended_reason IS NULL OR length(suspended_reason) <= 200),
  CHECK ((type IN ('agent', 'installation')) = (owner_id IS NOT NULL)),
  CHECK (type = 'installation' OR handle IS NOT NULL)
) STRICT;

-- table read_model_barriers
CREATE TABLE read_model_barriers (
  shard TEXT PRIMARY KEY,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  phase TEXT NOT NULL CHECK (phase IN ('running', 'pausing', 'paused', 'recovering')),
  since INTEGER NOT NULL,
  bookmark TEXT,
  protocol_version INTEGER NOT NULL CHECK (protocol_version >= 1),
  executor_version INTEGER NOT NULL DEFAULT 0 CHECK (executor_version >= 0),
  read_model_protocol_since TEXT
, token_previous TEXT, token_next TEXT, token_completed TEXT) STRICT, WITHOUT ROWID;

-- table read_model_preservation_pages
CREATE TABLE read_model_preservation_pages (
  recovery_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  page INTEGER NOT NULL CHECK (page >= 0),
  object_key TEXT NOT NULL,
  digest TEXT NOT NULL,
  rows INTEGER NOT NULL CHECK (rows >= 0),
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  last_key TEXT CHECK (last_key IS NULL OR json_valid(last_key)),
  PRIMARY KEY (recovery_id, table_name, page)
) STRICT;

-- table read_model_recoveries
CREATE TABLE read_model_recoveries (
  shard TEXT PRIMARY KEY,
  recovery_id TEXT NOT NULL UNIQUE,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  stage TEXT NOT NULL CHECK (stage IN ('preserving', 'awaiting_restore', 'importing', 'fencing',
    'resuming', 'complete')),
  cursor TEXT CHECK (cursor IS NULL OR json_valid(cursor)),
  manifest TEXT CHECK (manifest IS NULL OR json_valid(manifest)),
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
, restore_bookmark TEXT, undo_bookmark TEXT, usage_rows INTEGER NOT NULL DEFAULT 0
  CHECK (usage_rows >= 0), usage_reads INTEGER NOT NULL DEFAULT 0
  CHECK (usage_reads >= 0)) STRICT;

-- table read_model_writers
CREATE TABLE read_model_writers (
  lease_id TEXT PRIMARY KEY,
  shard TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  protocol_version INTEGER NOT NULL CHECK (protocol_version >= 1),
  mode TEXT NOT NULL CHECK (mode IN ('ordinary', 'maintenance')),
  until INTEGER NOT NULL CHECK (until > 0)
) STRICT, WITHOUT ROWID;

-- table refresh_tokens
CREATE TABLE refresh_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  family_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES principals (id),
  client_id TEXT NOT NULL,
  scopes TEXT NOT NULL CHECK (json_valid(scopes)),
  resource TEXT NOT NULL,
  dpop_jkt TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  -- The family's end, the same on all its tokens (no token outlives it): rows are pruned by it.
  family_expires_at INTEGER NOT NULL,
  used_at INTEGER,
  replaced_by TEXT,
  revoked_at INTEGER
) STRICT;

-- table repo_deletion_cleanups
CREATE TABLE repo_deletion_cleanups (
  repo_id TEXT NOT NULL REFERENCES repo_deletions (repo_id),
  cleanup TEXT NOT NULL,
  done_at INTEGER NOT NULL, gen INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (repo_id, cleanup)
) STRICT, WITHOUT ROWID;

-- table repo_deletions
CREATE TABLE repo_deletions (
  repo_id TEXT PRIMARY KEY REFERENCES repos (id),
  step TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
, requested_by TEXT, last_error TEXT, act_chain TEXT CHECK (act_chain IS NULL OR json_valid(act_chain)), request_id TEXT, tombstone TEXT CHECK (tombstone IS NULL OR json_valid(tombstone)), gen INTEGER NOT NULL DEFAULT 0, reopened_epoch INTEGER) STRICT;

-- table repo_redirects
CREATE TABLE repo_redirects (
  owner_id TEXT NOT NULL REFERENCES principals (id),
  name TEXT NOT NULL COLLATE NOCASE,
  repo_id TEXT NOT NULL REFERENCES repos (id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, name)
) STRICT;

-- table repo_transfers
CREATE TABLE repo_transfers (
  repo_id TEXT PRIMARY KEY REFERENCES repos (id),
  transfer_id TEXT NOT NULL,
  from_owner TEXT NOT NULL,
  from_name TEXT NOT NULL,
  to_owner TEXT NOT NULL,
  to_name TEXT NOT NULL,
  step TEXT NOT NULL CHECK (step IN
    ('freeze', 'directory', 'grants', 'fence', 'repo', 'done', 'cancelling', 'failed')),
  requested_by TEXT,
  lease_id TEXT,
  lease_until INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
, request_id TEXT) STRICT;

-- table repos
CREATE TABLE repos (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES principals (id),
  name TEXT NOT NULL,
  network_id TEXT NOT NULL,
  org_shard TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'internal', 'private')),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'deleting', 'deleted')),
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
, name_gen INTEGER NOT NULL DEFAULT 0, parent_id TEXT, is_template INTEGER NOT NULL DEFAULT 0 CHECK (is_template IN (0, 1)), generating_since INTEGER, created_by TEXT) STRICT;

-- table revocation_targets
CREATE TABLE revocation_targets (
  seq INTEGER NOT NULL,
  feed TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL,
  PRIMARY KEY (seq, feed)
) STRICT, WITHOUT ROWID;

-- table revocations
CREATE TABLE revocations (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  subject TEXT NOT NULL,
  at INTEGER NOT NULL,
  cursor TEXT,
  expanded INTEGER NOT NULL DEFAULT 0 CHECK (expanded IN (0, 1))
) STRICT;

-- table sessions
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  user_id TEXT NOT NULL REFERENCES principals (id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
) STRICT;

-- table source_epochs
CREATE TABLE source_epochs (
  source_id TEXT PRIMARY KEY,
  epoch_gen INTEGER NOT NULL CHECK (epoch_gen >= 1)
) STRICT;

-- table ssh_signing_keys
CREATE TABLE ssh_signing_keys (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals (id),
  title TEXT NOT NULL,
  key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

-- table stars
CREATE TABLE stars (
  user_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, repo_id)
) STRICT;

-- table thread_preferences
CREATE TABLE thread_preferences (
  principal_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  conversation TEXT NOT NULL,
  number INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('issue', 'pull')),
  root_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('subscribed', 'unsubscribed', 'none')),
  revision INTEGER NOT NULL,
  epoch_gen INTEGER NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (principal_id, repo_id, conversation)
) STRICT;

-- table tokens
CREATE TABLE "tokens" (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  type TEXT NOT NULL CHECK (type IN ('git', 'pat', 'ist', 'run', 'job', 'oat')),
  principal_id TEXT NOT NULL REFERENCES principals (id),
  scopes TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(scopes)),
  repo_ids TEXT CHECK (repo_ids IS NULL OR json_valid(repo_ids)),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER,
  grant_id TEXT REFERENCES grants (id),
  act_chain TEXT CHECK (act_chain IS NULL OR json_valid(act_chain)), audience TEXT, client_id TEXT, dpop_jkt TEXT, family_id TEXT, source_id TEXT,
  CHECK ((grant_id IS NULL) = (act_chain IS NULL))
) STRICT;

-- table user_deletions
CREATE TABLE user_deletions (
  user_id TEXT PRIMARY KEY REFERENCES principals (id),
  step TEXT NOT NULL
    CHECK (step IN ('repositories', 'accounts', 'stars', 'feeds', 'finalize', 'done')),
  requested_by TEXT,
  request_id TEXT,
  scan_until INTEGER NOT NULL,
  account_cursor INTEGER NOT NULL DEFAULT 0,
  batch_cursor INTEGER NOT NULL DEFAULT 0,
  feed_cursor INTEGER NOT NULL DEFAULT 0,
  blocked TEXT,
  next_attempt_at INTEGER NOT NULL,
  rearm_after INTEGER NOT NULL DEFAULT 0,
  lease_id TEXT,
  lease_until INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  released_handles TEXT NOT NULL CHECK (json_valid(released_handles)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

-- table user_emails
CREATE TABLE user_emails (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals (id),
  address TEXT NOT NULL CHECK (length(address) <= 254),
  address_key TEXT NOT NULL,
  verified_at INTEGER,
  created_at INTEGER NOT NULL,
  removed_at INTEGER
) STRICT;

-- table user_retirements
CREATE TABLE user_retirements (
  user_id TEXT NOT NULL REFERENCES user_deletions (user_id),
  principal_id TEXT NOT NULL,
  ord INTEGER NOT NULL,
  PRIMARY KEY (user_id, principal_id)
) STRICT, WITHOUT ROWID;

-- table watch_preferences
CREATE TABLE watch_preferences (
  principal_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  root_id TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('participating', 'watching', 'ignoring')),
  revision INTEGER NOT NULL,
  epoch_gen INTEGER NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (principal_id, repo_id)
) STRICT;

-- table webauthn_challenges
CREATE TABLE webauthn_challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('register', 'sign_in')),
  -- The registering user (none for a sign-in, which names its user by the credential).
  user_id TEXT REFERENCES principals (id),
  expires_at INTEGER NOT NULL,
  used_at INTEGER
) STRICT;

-- index audit_log_archived
CREATE INDEX audit_log_archived ON audit_log (archived_at) WHERE archived_at IS NOT NULL;

-- index audit_log_unarchived
CREATE INDEX audit_log_unarchived ON audit_log (seq) WHERE archived_at IS NULL;

-- index audit_segments_archived
CREATE INDEX audit_segments_archived ON audit_segments (archived_at) WHERE state = 'archived';

-- index audit_segments_from
CREATE INDEX audit_segments_from ON audit_segments (from_seq);

-- index audit_segments_pending
CREATE INDEX audit_segments_pending ON audit_segments (from_seq) WHERE state = 'pending';

-- index audit_segments_to
CREATE INDEX audit_segments_to ON audit_segments (to_seq);

-- index dpop_proofs_expiry
CREATE INDEX dpop_proofs_expiry ON dpop_proofs (expires_at);

-- index email_admissions_at
CREATE INDEX email_admissions_at ON email_admissions (at);

-- index email_confirmations_email
CREATE INDEX email_confirmations_email ON email_confirmations (email_id);

-- index email_confirmations_reap
CREATE INDEX email_confirmations_reap ON email_confirmations (reap_at);

-- index email_counters_period
CREATE INDEX email_counters_period ON email_counters (scope, period);

-- index email_deliveries_at
CREATE INDEX email_deliveries_at ON email_deliveries (at);

-- index email_mailboxes_idle
CREATE INDEX email_mailboxes_idle ON email_mailboxes (idle_since) WHERE idle_since IS NOT NULL;

-- index email_suppressions_due
CREATE INDEX email_suppressions_due ON email_suppressions (next_check_at, address_key)
  WHERE suppressed = 1;

-- index grants_agent
CREATE INDEX grants_agent ON grants (agent_id);

-- index grants_grantor
CREATE INDEX grants_grantor ON grants (grantor_id);

-- index grants_parent
CREATE INDEX grants_parent ON grants (parent_id) WHERE parent_id IS NOT NULL;

-- index idempotency_keys_expiry
CREATE INDEX idempotency_keys_expiry ON idempotency_keys (expires_at);

-- index live_admissions_day
CREATE INDEX live_admissions_day ON live_admissions (day, principal_id);

-- index live_budget_receipts_expiry
CREATE INDEX live_budget_receipts_expiry ON live_budget_receipts (expires_at, seq);

-- index live_duration_owners_class
CREATE INDEX live_duration_owners_class ON live_duration_owners (class, status);

-- index live_duration_owners_object
CREATE INDEX live_duration_owners_object ON live_duration_owners (object_type, object_id, class);

-- index live_duration_owners_operation
CREATE UNIQUE INDEX live_duration_owners_operation ON live_duration_owners (operation_id);

-- index live_duration_owners_parent
CREATE INDEX live_duration_owners_parent ON live_duration_owners (parent_id)
  WHERE parent_id IS NOT NULL;

-- index live_recovery_targets_due
CREATE INDEX live_recovery_targets_due ON live_recovery_targets (next_attempt_at, feed);

-- index live_socket_deps_socket
CREATE INDEX live_socket_deps_socket ON live_socket_deps (socket_id);

-- index live_sockets_credential
CREATE INDEX live_sockets_credential ON live_sockets (credential_id);

-- index live_sockets_expiry
CREATE INDEX live_sockets_expiry ON live_sockets (expires_at);

-- index live_sockets_feed
CREATE INDEX live_sockets_feed ON live_sockets (feed);

-- index live_sockets_pending
CREATE INDEX live_sockets_pending ON live_sockets (pending_until) WHERE state = 'pending';

-- index memberships_principal
CREATE INDEX memberships_principal ON memberships (principal_id);

-- index oauth_clients_created
CREATE INDEX oauth_clients_created ON oauth_clients (created_at);

-- index oauth_requests_expiry
CREATE INDEX oauth_requests_expiry ON oauth_requests (expires_at);

-- index oauth_requests_pending
CREATE INDEX oauth_requests_pending ON oauth_requests (user_id, expires_at) WHERE code_hash IS NULL;

-- index oauth_requests_unconsumed_user
CREATE INDEX oauth_requests_unconsumed_user ON oauth_requests (user_id) WHERE used_at IS NULL;

-- index passkeys_user
CREATE INDEX passkeys_user ON passkeys (user_id);

-- index principals_handle
CREATE UNIQUE INDEX principals_handle ON principals (handle COLLATE NOCASE) WHERE handle IS NOT NULL;

-- index principals_owner
CREATE INDEX principals_owner ON principals (owner_id) WHERE owner_id IS NOT NULL;

-- index read_model_writers_drain
CREATE INDEX read_model_writers_drain ON read_model_writers (shard, generation, until, lease_id);

-- index refresh_tokens_family
CREATE INDEX refresh_tokens_family ON refresh_tokens (family_id);

-- index refresh_tokens_family_expiry
CREATE INDEX refresh_tokens_family_expiry ON refresh_tokens (family_expires_at);

-- index refresh_tokens_user
CREATE INDEX refresh_tokens_user ON refresh_tokens (user_id);

-- index repo_deletions_pending
CREATE INDEX repo_deletions_pending ON repo_deletions (updated_at) WHERE step <> 'done';

-- index repo_redirects_repo
CREATE INDEX repo_redirects_repo ON repo_redirects (repo_id);

-- index repo_transfers_leaving
CREATE INDEX repo_transfers_leaving ON repo_transfers (from_owner) WHERE step = 'grants';

-- index repo_transfers_pending
CREATE INDEX repo_transfers_pending ON repo_transfers (updated_at)
  WHERE step NOT IN ('done', 'failed');

-- index repos_created_by
CREATE INDEX repos_created_by ON repos (created_by) WHERE created_by IS NOT NULL AND state = 'active';

-- index repos_expiry
CREATE INDEX repos_expiry ON repos (expires_at) WHERE expires_at IS NOT NULL AND state = 'active';

-- index repos_forks
CREATE INDEX repos_forks ON repos (parent_id, owner_id, created_at, id)
  WHERE parent_id IS NOT NULL AND state = 'active';

-- index repos_generating
CREATE INDEX repos_generating ON repos (generating_since)
  WHERE generating_since IS NOT NULL AND state = 'active';

-- index repos_network
CREATE INDEX repos_network ON repos (network_id);

-- index repos_owner
CREATE INDEX repos_owner ON repos (owner_id, id);

-- index repos_owner_name
CREATE UNIQUE INDEX repos_owner_name ON repos (owner_id, name COLLATE NOCASE) WHERE state <> 'deleted';

-- index revocation_targets_due
CREATE INDEX revocation_targets_due ON revocation_targets (next_attempt_at, seq, feed);

-- index revocations_at
CREATE INDEX revocations_at ON revocations (at);

-- index revocations_open
CREATE INDEX revocations_open ON revocations (seq) WHERE expanded = 0;

-- index sessions_expiry
CREATE INDEX sessions_expiry ON sessions (expires_at);

-- index sessions_user
CREATE INDEX sessions_user ON sessions (user_id);

-- index ssh_signing_keys_fingerprint
CREATE UNIQUE INDEX ssh_signing_keys_fingerprint ON ssh_signing_keys (fingerprint);

-- index ssh_signing_keys_principal
CREATE INDEX ssh_signing_keys_principal ON ssh_signing_keys (principal_id, created_at, id);

-- index stars_repo
CREATE INDEX stars_repo ON stars (repo_id);

-- index stars_user
CREATE INDEX stars_user ON stars (user_id, created_at, repo_id);

-- index thread_preferences_repo
CREATE INDEX thread_preferences_repo
  ON thread_preferences (repo_id, kind, principal_id, conversation);

-- index tokens_family
CREATE INDEX tokens_family ON tokens (family_id) WHERE family_id IS NOT NULL;

-- index tokens_grant
CREATE INDEX tokens_grant ON tokens (grant_id) WHERE grant_id IS NOT NULL;

-- index tokens_oat_expiry
CREATE INDEX tokens_oat_expiry ON tokens (expires_at) WHERE type = 'oat';

-- index tokens_principal
CREATE INDEX tokens_principal ON tokens (principal_id);

-- index user_deletions_rearm
CREATE INDEX user_deletions_rearm ON user_deletions (rearm_after, user_id) WHERE step <> 'done';

-- index user_emails_live
CREATE UNIQUE INDEX user_emails_live ON user_emails (principal_id, address_key)
  WHERE removed_at IS NULL;

-- index user_emails_mailbox
CREATE INDEX user_emails_mailbox ON user_emails (address_key);

-- index user_emails_principal
CREATE INDEX user_emails_principal ON user_emails (principal_id);

-- index user_emails_removed
CREATE INDEX user_emails_removed ON user_emails (removed_at, id) WHERE removed_at IS NOT NULL;

-- index user_retirements_principal
CREATE INDEX user_retirements_principal ON user_retirements (principal_id);

-- index watch_preferences_listed
CREATE INDEX watch_preferences_listed ON watch_preferences (principal_id, level, repo_id);

-- index watch_preferences_repo
CREATE INDEX watch_preferences_repo ON watch_preferences (repo_id, principal_id);

-- index webauthn_challenges_expiry
CREATE INDEX webauthn_challenges_expiry ON webauthn_challenges (expires_at);

-- trigger grants_revoked
CREATE TRIGGER grants_revoked AFTER UPDATE OF revoked_at ON grants
WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
BEGIN
  INSERT INTO revocations (subject, at) VALUES ('grant:' || NEW.id, NEW.revoked_at);
END;

-- trigger principals_disabled
CREATE TRIGGER principals_disabled AFTER UPDATE OF disabled_at ON principals
WHEN OLD.disabled_at IS NULL AND NEW.disabled_at IS NOT NULL
BEGIN
  INSERT INTO revocations (subject, at)
  VALUES ('principal:' || NEW.id || ':' || OLD.lifecycle_gen, NEW.disabled_at);
END;

-- trigger principals_lifecycle_insert
CREATE TRIGGER principals_lifecycle_insert BEFORE INSERT ON principals
WHEN (NEW.lifecycle <> 'active' AND NEW.disabled_at IS NULL)
  OR (NEW.type = 'user' AND NEW.lifecycle = 'active' AND NEW.disabled_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'a principal''s lifecycle and disabled_at disagree');
END;

-- trigger principals_lifecycle_update
CREATE TRIGGER principals_lifecycle_update BEFORE UPDATE OF lifecycle, disabled_at ON principals
WHEN (NEW.lifecycle <> 'active' AND NEW.disabled_at IS NULL)
  OR (NEW.type = 'user' AND NEW.lifecycle = 'active' AND NEW.disabled_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'a principal''s lifecycle and disabled_at disagree');
END;

-- trigger sessions_revoked
CREATE TRIGGER sessions_revoked AFTER UPDATE OF revoked_at ON sessions
WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
BEGIN
  INSERT INTO revocations (subject, at) VALUES ('credential:' || NEW.id, NEW.revoked_at);
END;

-- trigger tokens_revoked
CREATE TRIGGER tokens_revoked AFTER UPDATE OF revoked_at ON tokens
WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
BEGIN
  INSERT INTO revocations (subject, at) VALUES ('credential:' || NEW.id, NEW.revoked_at);
END;
