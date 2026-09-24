CREATE TABLE `assistance_request` (
	`id` text PRIMARY KEY NOT NULL,
	`resident_id` text NOT NULL,
	`device_id` text NOT NULL,
	`facility_id` text NOT NULL,
	`category` text NOT NULL,
	`note` text,
	`idempotency_key` text NOT NULL,
	`persistence_state` text DEFAULT 'recorded' NOT NULL,
	`delivery_state` text DEFAULT 'pending' NOT NULL,
	`handling_state` text DEFAULT 'open' NOT NULL,
	`withdrawal_state` text DEFAULT 'none' NOT NULL,
	`escalation_state` text DEFAULT 'none' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`delivery_at` text,
	`acknowledged_at` text,
	`resolved_at` text,
	`withdrawal_at` text,
	FOREIGN KEY (`resident_id`) REFERENCES `resident`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`device_id`) REFERENCES `device`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`facility_id`) REFERENCES `facility`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assistance_request_device_idempotency` ON `assistance_request` (`device_id`,`idempotency_key`);