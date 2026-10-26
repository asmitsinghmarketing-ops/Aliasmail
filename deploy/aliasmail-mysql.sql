-- AliasMail MySQL / MariaDB schema
-- In phpMyAdmin, select your existing database, then import this file.
-- Creates missing tables only. Does not erase or insert application data.
-- Configure DATABASE_URL on the Node host after importing.
-- Existing JSON data must be migrated separately; this is a schema, not a backup.

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS app_state (
    k VARCHAR(64) NOT NULL,
    v LONGTEXT NOT NULL,
    PRIMARY KEY (k)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS app_files (
    id VARCHAR(64) NOT NULL,
    type VARCHAR(100) NOT NULL,
    data LONGBLOB NOT NULL,
    PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS app_mail_cache (
    id VARCHAR(64) NOT NULL,
    touched BIGINT NOT NULL,
    data LONGBLOB NOT NULL,
    PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
