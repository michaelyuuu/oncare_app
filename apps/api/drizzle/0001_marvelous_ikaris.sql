CREATE TABLE `__new_robot_command` (
	`id` text PRIMARY KEY NOT NULL,
	`robot_id` text NOT NULL,
	`task_id` text,
	`visit_id` text,
	`correlation_id` text NOT NULL,
	`intent` text NOT NULL,
	`issued_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`acked_at` text,
	`result` text,
	FOREIGN KEY (`robot_id`) REFERENCES `robot`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `task_request`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`visit_id`) REFERENCES `visit_session`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_robot_command` (`id`, `robot_id`, `task_id`, `visit_id`, `correlation_id`, `intent`, `issued_at`, `expires_at`, `acked_at`, `result`)
SELECT `id`, `robot_id`, `task_id`, `visit_id`, COALESCE(`visit_id`, (SELECT `correlation_id` FROM `task_request` WHERE `task_request`.`id` = `robot_command`.`task_id`)), `intent`, `issued_at`, `expires_at`, `acked_at`, `result`
FROM `robot_command`;
--> statement-breakpoint
DROP TABLE `robot_command`;
--> statement-breakpoint
ALTER TABLE `__new_robot_command` RENAME TO `robot_command`;
