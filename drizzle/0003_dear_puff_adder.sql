CREATE TABLE `stack_parents` (
	`parent_stack_id` integer NOT NULL,
	`child_stack_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`parent_stack_id`, `child_stack_id`),
	FOREIGN KEY (`parent_stack_id`) REFERENCES `stacks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`child_stack_id`) REFERENCES `stacks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_stack_parents_parent_stack_id` ON `stack_parents` (`parent_stack_id`);--> statement-breakpoint
CREATE INDEX `idx_stack_parents_child_stack_id` ON `stack_parents` (`child_stack_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `stack_parents_child_stack_unique` ON `stack_parents` (`child_stack_id`);