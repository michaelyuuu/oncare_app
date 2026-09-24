CREATE TABLE `visit_reservation` (
	`id` text PRIMARY KEY NOT NULL,
	`facility_id` text NOT NULL,
	`resident_id` text NOT NULL,
	`family_user_id` text NOT NULL,
	`robot_id` text NOT NULL,
	`proposer_kind` text NOT NULL,
	`proposer_id` text NOT NULL,
	`status` text NOT NULL,
	`start_at` text NOT NULL,
	`end_at` text NOT NULL,
	`time_zone` text NOT NULL,
	`expires_at` text NOT NULL,
	`reminder_at` text,
	`dispatch_at` text,
	`confirmed_at` text,
	`confirmed_by_kind` text,
	`confirmed_by_id` text,
	`cancelled_at` text,
	`cancelled_by_kind` text,
	`cancelled_by_id` text,
	`cancellation_reason` text,
	`supersedes_id` text,
	`visit_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`facility_id`) REFERENCES `facility`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resident_id`) REFERENCES `resident`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`family_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`robot_id`) REFERENCES `robot`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`supersedes_id`) REFERENCES `visit_reservation`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`visit_id`) REFERENCES `visit_session`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `visit_reservation_resident_start_status` ON `visit_reservation` (`resident_id`,`start_at`,`status`);--> statement-breakpoint
CREATE INDEX `visit_reservation_family_start_status` ON `visit_reservation` (`family_user_id`,`start_at`,`status`);--> statement-breakpoint
CREATE INDEX `visit_reservation_robot_start_status` ON `visit_reservation` (`robot_id`,`start_at`,`status`);--> statement-breakpoint
CREATE INDEX `visit_reservation_status_expires` ON `visit_reservation` (`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `visit_reservation_status_dispatch` ON `visit_reservation` (`status`,`dispatch_at`);--> statement-breakpoint
ALTER TABLE `visit_session` ADD `scheduled_start_at` text;--> statement-breakpoint
ALTER TABLE `visit_session` ADD `initiator_kind` text;--> statement-breakpoint
ALTER TABLE `visit_session` ADD `initiator_id` text;