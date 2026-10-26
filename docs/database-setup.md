# Keep data across deployments

The Node app supports MySQL and PostgreSQL. It stores account settings, aliases,
sessions, security configuration, drafts, mail metadata, profile pictures and
encrypted cached message bodies in the configured database.

## Configure the live Node app

1. Create a MySQL or PostgreSQL database, or reuse the database previously used
   by this application. It must be reachable from the Node hosting service.
2. Set DATABASE_URL in the Node hosting dashboard's environment variables:
   mysql://USER:PASSWORD@HOST:3306/DATABASE
   or postgres://USER:PASSWORD@HOST:5432/DATABASE.
   Percent-encode reserved characters in the username/password.
3. Set DATABASE_SSL=true if required by the database provider.
4. Keep the existing JWT_SECRET unchanged in the same environment settings.
   It is required to decrypt existing authenticator secrets and cached mail.
5. Keep MAIL_TRANSPORT=bridge and the existing PHP bridge environment settings.
6. Restart Node and check the log for '[store] using the mysql database' or
   '[store] using the postgres database'. A database failure stops startup; the
   app does not fall back to an empty local database.
7. Keep the same DATABASE_URL and JWT_SECRET across every deployment.

The database user needs permission to create and read/write app_state, app_files
and app_mail_cache. Tables are created automatically. Do not use the PHP bridge's
settings file for these variables: DATABASE_URL belongs to the Node application.

## Preserve existing data before redeploying

Before replacing the current live deployment, back up its server/data/db.json
(or configured DATA_FILE), server/data/avatars and JWT_SECRET. Do not include
these private backups in public repositories or downloadable web folders.

When an EMPTY SQL database is configured, startup imports the local JSON state
and avatars if they are still present beside the running application. Existing
populated SQL data is retained. For an ephemeral host, take the backup BEFORE a
deployment erases the old files; restore it privately on the host before the
first database-backed startup. Do not put secrets or private user data in the
normal application ZIP. If the previous data has already been erased, it can
only be recovered from a hosting/database backup. IMAP sync restores mail, not
deleted app accounts, drafts or security settings.

## Production guard

NODE_ENV=production now requires DATABASE_URL and a stable JWT_SECRET. If you
intentionally use a persistent disk rather than SQL, configure DATA_FILE to that
disk and explicitly set ALLOW_FILE_STORAGE=true. This option is not appropriate
for a directory replaced by each build. Local development can continue using
the JSON file without extra configuration.
