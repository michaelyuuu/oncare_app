CREATE TABLE IF NOT EXISTS `garment_projection` (
	`id` text PRIMARY KEY NOT NULL,
	`source_key` text NOT NULL,
	`station_id` text NOT NULL,
	`facility_id` text NOT NULL,
	`resident_id` text NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`color` text NOT NULL,
	`status` text NOT NULL,
	`wash_count` integer NOT NULL,
	`last_seen` text,
	`source_updated_at` text NOT NULL,
	`synced_at` text NOT NULL,
	FOREIGN KEY (`station_id`) REFERENCES `rfid_station_sync`(`station_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`facility_id`) REFERENCES `facility`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resident_id`) REFERENCES `resident`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `garment_projection_station_source` ON `garment_projection` (`station_id`,`source_key`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `rfid_station_sync` (
	`station_id` text PRIMARY KEY NOT NULL,
	`facility_id` text NOT NULL,
	`source_version` integer,
	`last_attempt_at` text NOT NULL,
	`last_success_at` text,
	`status` text NOT NULL,
	`warnings` text NOT NULL,
	FOREIGN KEY (`facility_id`) REFERENCES `facility`(`id`) ON UPDATE no action ON DELETE no action
);
