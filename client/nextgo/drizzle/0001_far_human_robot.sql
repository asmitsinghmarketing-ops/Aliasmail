CREATE TABLE `customers` (
	`id` text PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`visitor_id` text NOT NULL,
	`name` text,
	`email` text,
	`phone` text,
	`consent_version` text NOT NULL,
	`consented_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customers_store_visitor_unique` ON `customers` (`store_id`,`visitor_id`);--> statement-breakpoint
CREATE INDEX `customers_store_updated_idx` ON `customers` (`store_id`,`updated_at`);