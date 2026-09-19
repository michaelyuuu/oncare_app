ALTER TABLE `user` ADD `facility_id` text REFERENCES facility(id);
--> statement-breakpoint
ALTER TABLE `user` ADD `active` integer DEFAULT true NOT NULL;
--> statement-breakpoint
UPDATE `user` SET `facility_id` = (SELECT `id` FROM `facility` ORDER BY `id` LIMIT 1) WHERE `role` = 'staff';
--> statement-breakpoint
ALTER TABLE `resident` ADD `active` integer DEFAULT true NOT NULL;
--> statement-breakpoint
CREATE TABLE `device` (
	`id` text PRIMARY KEY NOT NULL,
	`facility_id` text NOT NULL,
	`robot_id` text,
	`kind` text NOT NULL,
	`resident_id` text NOT NULL,
	`device_token_hash` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`assignment_version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`facility_id`) REFERENCES `facility`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`robot_id`) REFERENCES `robot`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resident_id`) REFERENCES `resident`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `device` (`id`, `facility_id`, `robot_id`, `kind`, `resident_id`, `device_token_hash`, `active`, `assignment_version`)
SELECT `robot_device`.`id`, `robot`.`facility_id`, `robot_device`.`robot_id`, `robot_device`.`kind`, `robot_device`.`resident_id`, `robot_device`.`device_token_hash`, 1, 1
FROM `robot_device` JOIN `robot` ON `robot`.`id` = `robot_device`.`robot_id`;
--> statement-breakpoint
DROP TABLE `robot_device`;
--> statement-breakpoint
CREATE TABLE `staff_assignment` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`resident_id` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resident_id`) REFERENCES `resident`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `staff_assignment_user_resident` ON `staff_assignment` (`user_id`,`resident_id`);
--> statement-breakpoint
-- Existing staff saw every resident in 0.1.0. Assign them to every resident of their facility so an upgrade changes nothing.
INSERT INTO `staff_assignment` (`id`, `user_id`, `resident_id`, `active`, `created_at`)
SELECT 'sa_' || `user`.`id` || '_' || `resident`.`id`, `user`.`id`, `resident`.`id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `user` JOIN `resident` ON `resident`.`facility_id` = `user`.`facility_id`
WHERE `user`.`role` = 'staff';
--> statement-breakpoint
CREATE TABLE `pending_action` (
	`id` text PRIMARY KEY NOT NULL,
	`principal_kind` text NOT NULL,
	`principal_id` text NOT NULL,
	`tool` text NOT NULL,
	`input` text NOT NULL,
	`summary` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`status` text NOT NULL
);
