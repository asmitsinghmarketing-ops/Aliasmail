-- Nextspace multi-tenant foundation for MySQL 8 / MariaDB 10.6+.
-- Additive only: it does not change or delete the existing app_* tables.
-- Run `npm run migrate:tenants --prefix server` after applying this migration.

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS ns_organizations (
    id CHAR(36) NOT NULL,
    name VARCHAR(160) NOT NULL,
    slug VARCHAR(80) NOT NULL,
    status ENUM('active', 'suspended') NOT NULL DEFAULT 'active',
    created_at DATETIME(3) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY ns_organizations_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ns_users (
    id CHAR(36) NOT NULL,
    organization_id CHAR(36) NOT NULL,
    email VARCHAR(254) NOT NULL,
    display_name VARCHAR(160) NOT NULL DEFAULT '',
    password_hash VARCHAR(255) NULL,
    role ENUM('owner', 'admin', 'user') NOT NULL DEFAULT 'user',
    active TINYINT(1) NOT NULL DEFAULT 1,
    mfa_json JSON NULL,
    created_at DATETIME(3) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY ns_users_org_email (organization_id, email),
    KEY ns_users_org (organization_id),
    CONSTRAINT ns_users_org_fk FOREIGN KEY (organization_id) REFERENCES ns_organizations (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ns_mailboxes (
    id CHAR(36) NOT NULL,
    organization_id CHAR(36) NOT NULL,
    address VARCHAR(254) NOT NULL,
    provider VARCHAR(40) NOT NULL DEFAULT 'imap-smtp',
    settings_json JSON NOT NULL,
    active TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME(3) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY ns_mailboxes_org_address (organization_id, address),
    KEY ns_mailboxes_org (organization_id),
    CONSTRAINT ns_mailboxes_org_fk FOREIGN KEY (organization_id) REFERENCES ns_organizations (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ns_aliases (
    id CHAR(36) NOT NULL,
    organization_id CHAR(36) NOT NULL,
    mailbox_id CHAR(36) NOT NULL,
    user_id CHAR(36) NULL,
    address VARCHAR(254) NOT NULL,
    type ENUM('personal', 'group') NOT NULL DEFAULT 'personal',
    display_name VARCHAR(160) NOT NULL DEFAULT '',
    active TINYINT(1) NOT NULL DEFAULT 1,
    metadata_json JSON NULL,
    created_at DATETIME(3) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY ns_aliases_org_address (organization_id, address),
    KEY ns_aliases_org (organization_id),
    KEY ns_aliases_mailbox (mailbox_id),
    CONSTRAINT ns_aliases_org_fk FOREIGN KEY (organization_id) REFERENCES ns_organizations (id),
    CONSTRAINT ns_aliases_mailbox_fk FOREIGN KEY (mailbox_id) REFERENCES ns_mailboxes (id),
    CONSTRAINT ns_aliases_user_fk FOREIGN KEY (user_id) REFERENCES ns_users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ns_audit_events (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    organization_id CHAR(36) NOT NULL,
    actor_user_id CHAR(36) NULL,
    action VARCHAR(100) NOT NULL,
    target VARCHAR(254) NULL,
    details_json JSON NULL,
    ip_address VARCHAR(45) NULL,
    created_at DATETIME(3) NOT NULL,
    PRIMARY KEY (id),
    KEY ns_audit_org_created (organization_id, created_at),
    CONSTRAINT ns_audit_org_fk FOREIGN KEY (organization_id) REFERENCES ns_organizations (id),
    CONSTRAINT ns_audit_user_fk FOREIGN KEY (actor_user_id) REFERENCES ns_users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
