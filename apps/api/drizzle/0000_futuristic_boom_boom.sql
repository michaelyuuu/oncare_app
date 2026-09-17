CREATE TABLE `audit_event` (
	`id` text PRIMARY KEY NOT NULL,
	`at` text NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`from_state` text,
	`to_state` text,
	`reason` text,
	`correlation_id` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `benchmark_run` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`entity_id` text NOT NULL,
	`started_at` text NOT NULL,
	`metrics` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `benchmark_trial` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`name` text NOT NULL,
	`value` real,
	`unit` text,
	`at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `benchmark_run`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `facility` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`timezone` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `family_relationship` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`resident_id` text NOT NULL,
	`label` text NOT NULL,
	`consent_video` integer DEFAULT false NOT NULL,
	`consent_robot_visit` integer DEFAULT false NOT NULL,
	`consent_item_delivery` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resident_id`) REFERENCES `resident`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `item` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`approved` integer DEFAULT false NOT NULL,
	`prohibited` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `location` (
	`id` text PRIMARY KEY NOT NULL,
	`facility_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`x` real NOT NULL,
	`y` real NOT NULL,
	`yaw` real NOT NULL,
	`approved` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`facility_id`) REFERENCES `facility`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `resident` (
	`id` text PRIMARY KEY NOT NULL,
	`facility_id` text NOT NULL,
	`display_name` text NOT NULL,
	`room_location_id` text NOT NULL,
	`availability` text DEFAULT 'available' NOT NULL,
	FOREIGN KEY (`facility_id`) REFERENCES `facility`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `robot` (
	`id` text PRIMARY KEY NOT NULL,
	`facility_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	FOREIGN KEY (`facility_id`) REFERENCES `facility`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `robot_command` (
	`id` text PRIMARY KEY NOT NULL,
	`robot_id` text NOT NULL,
	`task_id` text,
	`visit_id` text,
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
CREATE TABLE `robot_device` (
	`id` text PRIMARY KEY NOT NULL,
	`robot_id` text NOT NULL,
	`kind` text NOT NULL,
	`resident_id` text NOT NULL,
	`device_token_hash` text NOT NULL,
	FOREIGN KEY (`robot_id`) REFERENCES `robot`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resident_id`) REFERENCES `resident`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `task_approval` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`decision` text NOT NULL,
	`reason` text,
	`at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `task_request`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `task_request` (
	`id` text PRIMARY KEY NOT NULL,
	`visit_id` text,
	`requester_id` text NOT NULL,
	`resident_id` text NOT NULL,
	`proposal` text NOT NULL,
	`state` text NOT NULL,
	`mode` text NOT NULL,
	`correlation_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`visit_id`) REFERENCES `visit_session`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`requester_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resident_id`) REFERENCES `resident`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_request_correlation_id_unique` ON `task_request` (`correlation_id`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`role` text NOT NULL,
	`username` text NOT NULL,
	`display_name` text NOT NULL,
	`password_hash` text NOT NULL,
	`pin_hash` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_username_unique` ON `user` (`username`);--> statement-breakpoint
CREATE TABLE `visit_session` (
	`id` text PRIMARY KEY NOT NULL,
	`resident_id` text NOT NULL,
	`requester_id` text NOT NULL,
	`robot_id` text,
	`state` text NOT NULL,
	`livekit_room` text,
	`requested_at` text NOT NULL,
	`connected_at` text,
	`ended_at` text,
	FOREIGN KEY (`resident_id`) REFERENCES `resident`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`requester_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`robot_id`) REFERENCES `robot`(`id`) ON UPDATE no action ON DELETE no action
);
