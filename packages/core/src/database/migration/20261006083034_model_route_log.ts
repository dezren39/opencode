import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261006083034_model_route_log",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`route_attempt\` (
          \`id\` integer PRIMARY KEY AUTOINCREMENT,
          \`time_started\` integer NOT NULL,
          \`time_ended\` integer NOT NULL,
          \`session_id\` text,
          \`assistant_message_id\` text,
          \`route_id\` text NOT NULL,
          \`provider_id\` text NOT NULL,
          \`model_id\` text NOT NULL,
          \`variant\` text,
          \`outcome\` text NOT NULL,
          \`error_tag\` text,
          \`error_code\` text,
          \`error_status\` integer,
          \`error_message\` text,
          \`error_body\` text,
          \`retryable\` integer,
          \`output_started\` integer NOT NULL,
          \`failed_over_to\` text,
          \`first_token_ms\` real,
          \`response_ms\` real,
          \`tokens_per_second\` real,
          \`tokens_input\` integer,
          \`tokens_output\` integer,
          \`tokens_reasoning\` integer,
          \`tokens_cache_read\` integer,
          \`tokens_cache_write\` integer,
          \`quota\` text
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`route_decision\` (
          \`id\` integer PRIMARY KEY AUTOINCREMENT,
          \`time\` integer NOT NULL,
          \`session_id\` text,
          \`route_id\` text NOT NULL,
          \`selection\` text NOT NULL,
          \`variant\` text,
          \`candidates\` text NOT NULL,
          \`chosen\` text,
          \`reason\` text NOT NULL,
          \`detail\` text
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`route_health\` (
          \`id\` integer PRIMARY KEY AUTOINCREMENT,
          \`time\` integer NOT NULL,
          \`route_id\` text,
          \`provider_id\` text NOT NULL,
          \`model_id\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`reason\` text,
          \`until\` integer
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`route_note\` (
          \`id\` integer PRIMARY KEY AUTOINCREMENT,
          \`time\` integer NOT NULL,
          \`text\` text NOT NULL,
          \`interpreted\` text,
          \`expires\` integer
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`route_attempt_target_time_idx\` ON \`route_attempt\` (\`provider_id\`,\`model_id\`,\`time_started\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`route_attempt_route_time_idx\` ON \`route_attempt\` (\`route_id\`,\`time_started\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`route_attempt_session_idx\` ON \`route_attempt\` (\`session_id\`,\`time_started\`);`,
      )
      yield* tx.run(`CREATE INDEX \`route_decision_route_time_idx\` ON \`route_decision\` (\`route_id\`,\`time\`);`)
      yield* tx.run(`CREATE INDEX \`route_decision_session_idx\` ON \`route_decision\` (\`session_id\`,\`time\`);`)
      yield* tx.run(
        `CREATE INDEX \`route_health_target_time_idx\` ON \`route_health\` (\`provider_id\`,\`model_id\`,\`time\`);`,
      )
      yield* tx.run(`CREATE INDEX \`route_note_time_idx\` ON \`route_note\` (\`time\`);`)
    })
  },
}

export default migration
