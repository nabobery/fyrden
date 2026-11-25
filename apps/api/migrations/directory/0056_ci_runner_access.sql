-- Which jobs each runner may be given (src/runner/access.ts). The defaults are what every runner
-- had: the account's private and internal repositories, no public repository and no fork job.
-- Fork jobs need an ephemeral runner, so one leaves nothing behind for a later job.
ALTER TABLE ci_runners ADD COLUMN repository_access TEXT NOT NULL DEFAULT 'all'
  CHECK (repository_access IN ('all', 'selected'));
ALTER TABLE ci_runners ADD COLUMN allows_public INTEGER NOT NULL DEFAULT 0
  CHECK (allows_public IN (0, 1));
ALTER TABLE ci_runners ADD COLUMN allows_forks INTEGER NOT NULL DEFAULT 0
  CHECK (allows_forks IN (0, 1) AND (allows_forks = 0 OR ephemeral = 1));

-- When the directory recorded an ephemeral runner's one assignment: it is given no other, also
-- when its run refuses that one afterwards. Stamped by a trigger, so whichever Worker version
-- records the assignment, and created before the rows written so far are stamped.
ALTER TABLE ci_runners ADD COLUMN task_assigned_at INTEGER;
CREATE TRIGGER ci_tasks_recorded AFTER UPDATE OF task ON ci_tasks
WHEN NEW.task IS NOT NULL
BEGIN
  UPDATE ci_runners SET task_assigned_at = unixepoch() * 1000
    WHERE id = NEW.runner_id AND ephemeral = 1 AND task_assigned_at IS NULL;
END;
UPDATE ci_runners SET task_assigned_at = task_confirmed_at
  WHERE ephemeral = 1 AND task_confirmed_at IS NOT NULL;
UPDATE ci_runners SET task_assigned_at = o.at
  FROM (SELECT runner_id, min(created_at) AS at FROM ci_tasks WHERE task IS NOT NULL
        GROUP BY runner_id) o
  WHERE ci_runners.id = o.runner_id AND ephemeral = 1 AND task_assigned_at IS NULL;

-- The repositories of a runner limited to selected ones.
CREATE TABLE ci_runner_repos (
  runner_id INTEGER NOT NULL, repo_id TEXT NOT NULL,
  PRIMARY KEY (runner_id, repo_id)
) STRICT, WITHOUT ROWID;

-- Runners that opted in to public or fork jobs and were assigned none yet, for a run's check
-- before it reserves a job. It names no column a poll lease writes.
CREATE INDEX ci_runners_open ON ci_runners (account_id, id)
  WHERE task_assigned_at IS NULL AND (allows_public = 1 OR allows_forks = 1);
-- Runners revoked with access left, for maintenance to clear.
CREATE INDEX ci_runners_stale_access ON ci_runners (id)
  WHERE revoked_at IS NOT NULL AND (allows_public = 1 OR allows_forks = 1);

-- The access a registration token gives the runner it registers. `selected_repos` is a JSON array
-- of repository ids.
ALTER TABLE ci_runner_registrations ADD COLUMN repository_access TEXT NOT NULL DEFAULT 'all'
  CHECK (repository_access IN ('all', 'selected'));
ALTER TABLE ci_runner_registrations ADD COLUMN selected_repos TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(selected_repos) AND json_type(selected_repos) = 'array');
ALTER TABLE ci_runner_registrations ADD COLUMN allows_public INTEGER NOT NULL DEFAULT 0
  CHECK (allows_public IN (0, 1));
ALTER TABLE ci_runner_registrations ADD COLUMN allows_forks INTEGER NOT NULL DEFAULT 0
  CHECK (allows_forks IN (0, 1));
-- Unused tokens limited to selected repositories, by expiry, for a transfer to take its repository
-- out of those still good.
CREATE INDEX ci_runner_registrations_selected ON ci_runner_registrations (account_id, expires_at)
  WHERE consumed_at IS NULL AND repository_access = 'selected';
