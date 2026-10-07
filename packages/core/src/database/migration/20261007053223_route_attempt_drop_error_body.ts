import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261007053223_route_attempt_drop_error_body",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`route_attempt\` DROP COLUMN \`error_body\`;`)
    })
  },
}

export default migration
